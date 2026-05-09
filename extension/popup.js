const startBtn  = document.getElementById('start');
const stopBtn   = document.getElementById('stop');
const popoutBtn = document.getElementById('popout');
const overlayToggleBtn = document.getElementById('overlay-toggle');
const logEl     = document.getElementById('log');
const preview   = document.getElementById('screen-preview');
const placeholder = document.getElementById('preview-placeholder');
const barTab    = document.getElementById('bar-tab');
const barMic    = document.getElementById('bar-mic');
const barSys    = document.getElementById('bar-sys');
const transcribeEndpointInput = document.getElementById('transcribe-endpoint');
const transcribeKeyInput = document.getElementById('transcribe-key');
const transcribeEnabledToggle = document.getElementById('transcribe-enabled');
const transcribeStatusEl = document.getElementById('transcribe-status');
const transcriptEl = document.getElementById('transcript');
const faceEnabledToggle = document.getElementById('face-enabled');
const faceStatusEl = document.getElementById('face-status');
const urlParams = new URLSearchParams(window.location.search);
const isDetachedWindow = urlParams.get('mode') === 'window';
const sourceTabId = Number(urlParams.get('sourceTabId'));

let screenStream  = null; // getDisplayMedia (video + optional system audio)
let tabStream     = null; // chrome.tabCapture  (tab audio)
let micStream     = null; // getUserMedia        (microphone)
let cameraStream  = null; // getUserMedia        (camera)

let audioCtx      = null;
let rafId         = null;
let frameInterval = null;
let recorders     = [];   // one MediaRecorder per stream
let packetSeq     = 0;    // monotonic packet id for media chunks

let eventSeq      = 0;
let lastLevelLogTs = 0;
let chunkStore     = {};
let objectUrls     = [];
let tabMonitorNodes = null;
let captureStartInFlight = false;

const transcribeQueues = {};
const transcribeInFlight = {};
const transcribeSeq = {};
const transcribeBuffers = {};
/** label -> timeout id (fixed-interval flush fallback, no silence wait) */
const transcribeTimers = {};
const lastRmsByLabel = { tab: 0, mic: 0, system_audio: 0 };
let transcribeConfig = {
  endpoint: '',
  apiKey: '',
  enabled: true,
};

let faceConfig = {
  enabled: false,
};

// WebM must exceed server's minimum WAV convert size (~32KB). Larger thresholds → fewer, bigger transcript chunks (no silence/pause detection).
const TRANSCRIBE_MIN_BYTES = 78000;
// If we never reach MIN_BYTES (quiet tab), flush whatever we have after this wait.
const TRANSCRIBE_MAX_INTERVAL_MS = 5000;
// Mic PCM → WAV periodic flush (~4.5s of audio typical at 48k buffer growth).
const TRANSCRIBE_PCM_INTERVAL_MS = 4500;

const FACE_CAPTURE_INTERVAL_MS = 3000;
const FEEDBACK_UPDATE_INTERVAL_MS = 3500;
const FACE_JPEG_QUALITY = 0.6;
const FACE_MAX_EDGE = 480;
const FEEDBACK_HISTORY_SIZE = 7;
const FEEDBACK_MIN_CONFIDENCE = 0.55;
const FEEDBACK_STRONG_CONFIDENCE = 0.8;
const FEEDBACK_STATE_CHANGE_VOTES = 3;
const FEEDBACK_STATE_SCORE_MARGIN = 0.65;

const TRANSCRIBE_MIN_RMS = 0.002;
let micTranscribeCtx = null;
let micTranscribeProcessor = null;
let micTranscribeSource = null;
let micTranscribeTimer = null;
let micPcmBuffer = [];
let micPcmSampleRate = 48000;

/** Latest insight keywords from the server; shown in the on-page overlay right panel. */
let lastOverlayInsight =
  'Meeting notes appear here as people speak.';
const OVERLAY_RIGHT_TEXT_ID = 'obli-overlay-right-text';
const OVERLAY_RIGHT_HEARD_ID = 'obli-overlay-right-heard';
const OVERLAY_LEFT_FEEDBACK_ID = 'obli-overlay-left-feedback';
const OVERLAY_LISTENING_BAR_ID = 'obli-overlay-listening-bar';
/** Tab id where the overlay was last shown; fixes tab resolution from the extension popup. */
let overlayInsightTabId = null;
/** Last finalized transcript shown at top of RHS overlay (red) so the user sees we are listening. */
let lastOverlayHeardSentence = 'Listening…';
let lastOverlayFeedbackText = 'Coach: camera idle. Start when ready.';
let lastOverlayFeedbackState = 'neutral';
let lastSpokenText = '';
let lastFeedbackUpdateTs = 0;
const feedbackHistory = [];
let acceptedFaceFeedback = null;

let cameraVideo = null;
let faceInterval = null;
const faceCanvas = document.createElement('canvas');
const faceCtx = faceCanvas.getContext('2d');
let lastFaceFrameB64 = '';

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[Logger]', msg);
}

function setTranscribeStatus(message, isError = false) {
  transcribeStatusEl.textContent = message;
  transcribeStatusEl.classList.toggle('error', Boolean(isError));
}

function setFaceStatus(message, isError = false) {
  faceStatusEl.textContent = message;
  faceStatusEl.classList.toggle('error', Boolean(isError));
}

function appendTranscriptLine(source, text, meta = '') {
  if (!text) return;
  const line = document.createElement('div');
  line.className = 'transcript-line';
  const stamp = new Date().toISOString().slice(11, 19);
  const suffix = meta ? ` (${meta})` : '';
  line.textContent = `[${stamp}] ${source}: ${text}${suffix}`;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function loadTranscribeConfig() {
  chrome.storage?.local?.get(['transcribeConfig'], (res) => {
    if (res?.transcribeConfig) {
      transcribeConfig = { ...transcribeConfig, ...res.transcribeConfig };
    }
    transcribeEndpointInput.value = transcribeConfig.endpoint || '';
    transcribeKeyInput.value = transcribeConfig.apiKey || '';
    transcribeEnabledToggle.checked = Boolean(transcribeConfig.enabled);
    setTranscribeStatus(transcribeConfig.enabled ? 'Idle' : 'Disabled');
  });
}

function saveTranscribeConfig() {
  transcribeConfig = {
    endpoint: transcribeEndpointInput.value.trim(),
    apiKey: transcribeKeyInput.value.trim(),
    enabled: Boolean(transcribeEnabledToggle.checked),
  };
  chrome.storage?.local?.set({ transcribeConfig }, () => {
    setTranscribeStatus(transcribeConfig.enabled ? 'Saved' : 'Disabled');
  });
}

function loadFaceConfig() {
  chrome.storage?.local?.get(['faceConfig'], (res) => {
    if (res?.faceConfig) {
      faceConfig = { ...faceConfig, ...res.faceConfig };
    }
    faceEnabledToggle.checked = Boolean(faceConfig.enabled);
    setFaceStatus(faceConfig.enabled ? 'Idle' : 'Disabled');
  });
}

function saveFaceConfig() {
  faceConfig = {
    enabled: Boolean(faceEnabledToggle.checked),
  };
  if (!faceConfig.enabled) resetFaceFeedbackSmoothing();
  chrome.storage?.local?.set({ faceConfig }, () => {
    setFaceStatus(faceConfig.enabled ? 'Saved' : 'Disabled');
  });
}

function ensureQueue(label) {
  if (!transcribeQueues[label]) transcribeQueues[label] = [];
  if (!transcribeSeq[label]) transcribeSeq[label] = 0;
  if (!transcribeInFlight[label]) transcribeInFlight[label] = false;
  if (!transcribeBuffers[label]) transcribeBuffers[label] = [];
}

function pcmSamplesRms(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    sum += x * x;
  }
  return Math.sqrt(sum / samples.length);
}

function enqueueTranscriptionChunk(label, blob, mimeType) {
  if (!blob || blob.size === 0) return;
  if (!transcribeConfig.enabled) return;
  if (!transcribeConfig.endpoint) {
    setTranscribeStatus('Missing endpoint URL', true);
    return;
  }

  ensureQueue(label);

  transcribeBuffers[label].push(blob);
  const totalBytes = transcribeBuffers[label].reduce((sum, b) => sum + (b?.size || 0), 0);

  const mt = mimeType || blob.type || 'audio/webm';

  if (totalBytes >= TRANSCRIBE_MIN_BYTES) {
    if (transcribeTimers[label]) {
      clearTimeout(transcribeTimers[label]);
      transcribeTimers[label] = null;
    }
    flushTranscriptionBuffer(label, mt);
    return;
  }

  if (!transcribeTimers[label]) {
    transcribeTimers[label] = setTimeout(() => {
      transcribeTimers[label] = null;
      flushTranscriptionBuffer(label, mt);
    }, TRANSCRIBE_MAX_INTERVAL_MS);
  }
}

function downsampleBuffer(buffer, inputRate, outputRate) {
  if (outputRate >= inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  let offset = 0;
  for (let i = 0; i < newLen; i++) {
    const nextOffset = Math.round((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = offset; j < nextOffset && j < buffer.length; j++) {
      sum += buffer[j];
      count += 1;
    }
    result[i] = count ? sum / count : 0;
    offset = nextOffset;
  }
  return result;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function flushMicPcm(label = 'mic', options = {}) {
  const tail = options.tail === true;
  if (!micPcmBuffer.length) return;

  const mergedLen = micPcmBuffer.reduce((sum, b) => sum + b.length, 0);
  const merged = new Float32Array(mergedLen);
  let offset = 0;
  micPcmBuffer.forEach((b) => {
    merged.set(b, offset);
    offset += b.length;
  });
  micPcmBuffer = [];

  const mergedRms = pcmSamplesRms(merged);
  if (mergedRms < TRANSCRIBE_MIN_RMS && !tail) return;

  const downsampled = downsampleBuffer(merged, micPcmSampleRate, 16000);
  const wavBlob = encodeWav(downsampled, 16000);
  enqueueTranscriptionChunk(label, wavBlob, 'audio/wav');
}

function startMicTranscription(stream) {
  if (micTranscribeCtx) return;
  micPcmBuffer = [];

  micTranscribeCtx = new AudioContext();
  micPcmSampleRate = micTranscribeCtx.sampleRate;
  micTranscribeSource = micTranscribeCtx.createMediaStreamSource(stream);
  micTranscribeProcessor = micTranscribeCtx.createScriptProcessor(4096, 1, 1);
  micTranscribeSource.connect(micTranscribeProcessor);
  micTranscribeProcessor.connect(micTranscribeCtx.destination);
  micTranscribeProcessor.onaudioprocess = (ev) => {
    const data = ev.inputBuffer.getChannelData(0);
    micPcmBuffer.push(new Float32Array(data));
  };
  micTranscribeTimer = setInterval(() => {
    flushMicPcm('mic');
  }, TRANSCRIBE_PCM_INTERVAL_MS);
}

function stopMicTranscription() {
  if (micTranscribeTimer) {
    clearInterval(micTranscribeTimer);
    micTranscribeTimer = null;
  }
  flushMicPcm('mic', { tail: true });
  if (micTranscribeProcessor) {
    micTranscribeProcessor.disconnect();
    micTranscribeProcessor = null;
  }
  if (micTranscribeSource) {
    micTranscribeSource.disconnect();
    micTranscribeSource = null;
  }
  if (micTranscribeCtx) {
    micTranscribeCtx.close();
    micTranscribeCtx = null;
  }
}

function flushTranscriptionBuffer(label, mimeType, options = {}) {
  const force = options.force === true;
  if (transcribeTimers[label]) {
    clearTimeout(transcribeTimers[label]);
    transcribeTimers[label] = null;
  }

  ensureQueue(label);
  const parts = transcribeBuffers[label];
  if (!parts?.length) return;

  const inferredType = mimeType || parts[0]?.type || 'audio/webm';
  const combined = new Blob(parts, { type: inferredType });

  if (!force && combined.size < TRANSCRIBE_MIN_BYTES) {
    transcribeTimers[label] = setTimeout(() => {
      transcribeTimers[label] = null;
      flushTranscriptionBuffer(label, inferredType);
    }, TRANSCRIBE_MAX_INTERVAL_MS);
    return;
  }

  transcribeBuffers[label] = [];

  transcribeSeq[label] += 1;
  transcribeQueues[label].push({
    seq: transcribeSeq[label],
    blob: combined,
    mimeType: combined.type || inferredType || 'audio/webm',
    ts: Date.now(),
  });
  drainTranscriptionQueue(label);
}

async function drainTranscriptionQueue(label) {
  if (transcribeInFlight[label]) return;
  const queue = transcribeQueues[label];
  if (!queue || queue.length === 0) return;

  const item = queue.shift();
  transcribeInFlight[label] = true;
  setTranscribeStatus(`Transcribing ${label} (chunk ${item.seq})`);

  const arrayBuffer = await item.blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const audioB64 = btoa(binary);
  const payload = {
    audioB64,
    filename: `${label}-${item.seq}.webm`,
    source: label,
    mimeType: item.mimeType,
    chunkIndex: item.seq,
    ts: item.ts,
  };
  payload.audioRms = lastRmsByLabel.mic || 0;
  if (lastSpokenText) {
    payload.recentTranscript = lastSpokenText;
  }
  if (faceConfig.enabled && lastFaceFrameB64) {
    payload.imageB64 = lastFaceFrameB64;
    payload.imageMimeType = 'image/jpeg';
  }

  const headers = { 'Content-Type': 'application/json' };
  if (transcribeConfig.apiKey) {
    headers[transcribeConfig.apiKey.startsWith('Bearer ') ? 'Authorization' : 'X-API-Key'] =
      transcribeConfig.apiKey;
  }

  try {
    const res = await fetch(transcribeConfig.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      setTranscribeStatus(`Transcription error: ${res.status}`, true);
      log(`Transcription error ${res.status}: ${errText}`, 'log-error');
    } else {
      const data = await res.json();
      const spoken = (data.text || '').trim();
      appendTranscriptLine(label, data.text || '', data.isFinal ? 'final' : 'partial');
      if (spoken) updateOverlayRightPanelHeard(spoken);
      if (spoken) lastSpokenText = spoken;
      const insight = data.insight != null ? String(data.insight).trim() : '';
      if (insight) updateOverlayRightPanelInsight(insight);
      if (data.face) {
        const stableFeedback = computeStableFaceFeedback(data.face);
        const now = Date.now();
        if (stableFeedback.shouldUpdate && now - lastFeedbackUpdateTs >= FEEDBACK_UPDATE_INTERVAL_MS) {
          lastFeedbackUpdateTs = now;
          updateOverlayLeftFeedback(stableFeedback.text, stableFeedback.state);
          setFaceStatus(stableFeedback.text);
        } else if (stableFeedback.statusText) {
          setFaceStatus(stableFeedback.statusText);
        }
      }
      setTranscribeStatus('Idle');
    }
  } catch (err) {
    setTranscribeStatus('Transcription network error', true);
    log(`Transcription network error: ${err?.message || err}`, 'log-error');
  } finally {
    transcribeInFlight[label] = false;
    if (queue.length) drainTranscriptionQueue(label);
  }
}

// Structured event ready to POST to a backend later.
function emitEvent(type, payload) {
  const event = { id: ++eventSeq, type, ts: Date.now(), ...payload };
  console.log('[Event]', JSON.stringify(event));

  // Stream every event to the extension service worker in real time.
  chrome.runtime.sendMessage({ type: 'ingest', event }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[Popup] Failed to send event to background:', chrome.runtime.lastError.message);
    }
  });

  // Keep popup log readable by sampling high-frequency level events.
  const now = Date.now();
  if (type !== 'audio_levels' || now - lastLevelLogTs >= 1000) {
    if (type === 'audio_levels') lastLevelLogTs = now;
    log(`Event ${event.id}: ${type} ${JSON.stringify(payload)}`, 'log-audio');
  }

  return event;
}

// UI bindings
transcribeEndpointInput.addEventListener('change', saveTranscribeConfig);
transcribeKeyInput.addEventListener('change', saveTranscribeConfig);
transcribeEnabledToggle.addEventListener('change', saveTranscribeConfig);
loadTranscribeConfig();

faceEnabledToggle.addEventListener('change', saveFaceConfig);
loadFaceConfig();

function normalizeCaptureError(err, step) {
  const name = err?.name || '';
  const message = String(err?.message || err || '');
  const msgLower = message.toLowerCase();

  if (step === 'microphone') {
    if (name === 'NotAllowedError' && msgLower.includes('dismissed')) {
      return [
        'Microphone permission was dismissed.',
        'Please click Start again and allow mic access in the prompt.',
        'If no prompt appears, reset mic permission for this extension in Chrome site settings, then retry.',
      ].join(' ');
    }
    if (name === 'NotAllowedError') {
      return [
        'Microphone permission was denied.',
        'Allow microphone for Chrome and this extension, then retry.',
      ].join(' ');
    }
    if (name === 'NotFoundError') {
      return 'No microphone was found. Connect/select an input device and retry.';
    }
    if (name === 'NotReadableError') {
      return 'Microphone is busy or unavailable. Close apps using it (Zoom/Meet) and retry.';
    }
  }

  if (step === 'camera') {
    if (name === 'NotAllowedError' && msgLower.includes('dismissed')) {
      return [
        'Camera permission was dismissed.',
        'Click Start again and allow camera access in the prompt.',
      ].join(' ');
    }
    if (name === 'NotAllowedError') {
      return 'Camera permission was denied. Allow camera access for this extension and retry.';
    }
    if (name === 'NotFoundError') {
      return 'No camera was found. Connect/select a camera and retry.';
    }
    if (name === 'NotReadableError') {
      return 'Camera is busy or unavailable. Close apps using it (Zoom/Meet) and retry.';
    }
  }

  if (step === 'tab_audio') {
    if (
      message.includes('active stream') ||
      message.includes('Cannot capture a tab') ||
      message.includes('tab with an active stream')
    ) {
      return [
        'This tab already has tab audio capture open (or a second Start ran while the first was still setting up).',
        'Click Stop in the extension, wait a second, then click Start once.',
        'If it persists, refresh the page you are capturing and try again.',
      ].join(' ');
    }
    if (name === 'PermissionDeniedError' || name === 'NotAllowedError') {
      return 'Tab audio capture was denied. Keep the target tab active and try Start again.';
    }
    if (message.includes('Extension has not been invoked for the current page')) {
      return [
        'Tab audio capture is not authorized for the selected tab.',
        'Open this extension from the tab you want to capture, then click "Open Detached Window" again.',
        'Chrome internal pages (chrome://, Web Store, Extensions) cannot be captured.',
      ].join(' ');
    }
  }

  if (step === 'screen') {
    if (name === 'NotAllowedError') {
      return 'Screen capture was denied or dismissed. Re-run Start and approve screen sharing.';
    }
    if (name === 'NotReadableError') {
      return 'Screen capture source became unavailable. Re-select the source and retry.';
    }
  }

  return `Unexpected ${step} error (${name || 'unknown'}): ${message}`;
}

async function getMicPermissionState() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return 'unknown';
  }
}

function getTabStreamByCapture() {
  return new Promise((res, rej) =>
    chrome.tabCapture.capture({ audio: true, video: false }, (s) =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(s)
    )
  );
}

function getTabMediaStreamId(targetTabId) {
  return new Promise((res, rej) =>
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) =>
      chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(streamId)
    )
  );
}

async function getTabStreamById(targetTabId) {
  const streamId = await getTabMediaStreamId(targetTabId);
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
}

async function captureTabAudioStream() {
  // In normal popup mode, activeTab context allows direct tabCapture.capture.
  if (!isDetachedWindow) {
    return getTabStreamByCapture();
  }

  // In detached window mode, bind to the originating tab via stream id.
  if (Number.isInteger(sourceTabId) && sourceTabId > 0) {
    return getTabStreamById(sourceTabId);
  }

  return getTabStreamByCapture();
}

function cleanupPartialCapture() {
  recorders.forEach(r => r.state !== 'inactive' && r.stop());
  recorders = [];

  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }
  stopFaceCapture();

  [screenStream, tabStream, micStream, cameraStream].forEach(s => s?.getTracks().forEach(t => t.stop()));
  screenStream = tabStream = micStream = cameraStream = null;
  packetSeq = 0;

  preview.srcObject = null;
  placeholder.style.display = '';
  barTab.style.width = barMic.style.width = barSys.style.width = '0%';

  startBtn.disabled = false;
  stopBtn.disabled  = true;
}

// ── Audio metering ────────────────────────────────────────────────────────────

function buildMeter(stream) {
  const src = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  return analyser;
}

function routeTabAudioToOutput(stream) {
  const src = audioCtx.createMediaStreamSource(stream);
  const gain = audioCtx.createGain();
  gain.gain.value = 1.0;
  src.connect(gain);
  gain.connect(audioCtx.destination);
  return { src, gain };
}

function rms(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// ── Screen frame extraction ───────────────────────────────────────────────────

const canvas  = document.createElement('canvas');
const ctx2d   = canvas.getContext('2d');

function captureFrame() {
  if (!preview.videoWidth) return;
  canvas.width  = preview.videoWidth;
  canvas.height = preview.videoHeight;
  ctx2d.drawImage(preview, 0, 0);

  // Log a small thumbnail as base64 (64 px wide) — swap for full frame when sending to backend
  const thumb = document.createElement('canvas');
  thumb.width  = 64;
  thumb.height = Math.round(64 * (preview.videoHeight / preview.videoWidth));
  thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
  const b64thumb = thumb.toDataURL('image/jpeg', 0.5).split(',')[1];

  const vt = screenStream.getVideoTracks()[0];
  const settings = vt ? vt.getSettings() : {};

  emitEvent('screen_frame', {
    width:     settings.width  ?? preview.videoWidth,
    height:    settings.height ?? preview.videoHeight,
    frameRate: settings.frameRate,
    thumbB64:  b64thumb,        // small JPEG thumbnail
  });
  log(`Frame ${settings.width}x${settings.height} @ ${(settings.frameRate ?? 0).toFixed(0)}fps`, 'log-screen');
}

function normalizeFaceState(state) {
  const normalized = String(state || 'neutral').toLowerCase();
  return ['bored', 'neutral', 'engaged'].includes(normalized) ? normalized : 'neutral';
}

function normalizeFaceConfidence(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function formatFaceFeedback(state, reason, feedbackText, confidence = 0.5) {
  const normalized = normalizeFaceState(state);
  const normalizedConfidence = normalizeFaceConfidence(confidence);
  const reasonText = reason ? ` ${reason}` : '';

  if (feedbackText) {
    return { state: normalized, confidence: normalizedConfidence, text: feedbackText };
  }

  if (normalized === 'bored') {
    return {
      state: 'bored',
      confidence: normalizedConfidence,
      text: `Coach: you are looking away and it feels like you are distracted. Come back to the main screen.${reasonText}`,
    };
  }
  if (normalized === 'engaged') {
    return {
      state: 'engaged',
      confidence: normalizedConfidence,
      text: `Coach: good focus. You are on the right track. Keep it up.${reasonText}`,
    };
  }
  return {
    state: 'neutral',
    confidence: normalizedConfidence,
    text: `Coach: you are almost there. Keep going and focus a bit more.${reasonText}`,
  };
}

function computeStableFaceFeedback(face) {
  const feedback = formatFaceFeedback(face?.state, face?.reason, face?.feedback, face?.confidence);
  feedbackHistory.push(feedback);
  if (feedbackHistory.length > FEEDBACK_HISTORY_SIZE) feedbackHistory.shift();

  const scores = { bored: 0, neutral: 0, engaged: 0 };
  const counts = { bored: 0, neutral: 0, engaged: 0 };
  feedbackHistory.forEach((item) => {
    if (scores[item.state] == null) return;
    scores[item.state] += Math.max(item.confidence, 0.25);
    counts[item.state] += 1;
  });

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const candidateState = ranked[0]?.[0] || feedback.state;
  const runnerUpScore = ranked[1]?.[1] || 0;
  const scoreMargin = scores[candidateState] - runnerUpScore;
  const recentSameCount = feedbackHistory
    .slice(-FEEDBACK_STATE_CHANGE_VOTES)
    .filter((item) => item.state === candidateState && item.confidence >= FEEDBACK_MIN_CONFIDENCE)
    .length;

  const hasAcceptedFeedback = Boolean(acceptedFaceFeedback);
  const confidentSameAsAccepted = hasAcceptedFeedback
    && candidateState === acceptedFaceFeedback.state
    && feedback.state === candidateState
    && feedback.confidence >= FEEDBACK_MIN_CONFIDENCE;
  const strongLatestMatch = feedback.state === candidateState && feedback.confidence >= FEEDBACK_STRONG_CONFIDENCE;
  const repeatedMatch = recentSameCount >= FEEDBACK_STATE_CHANGE_VOTES;
  const clearWindowWinner = counts[candidateState] >= FEEDBACK_STATE_CHANGE_VOTES && scoreMargin >= FEEDBACK_STATE_SCORE_MARGIN;
  const firstUsableFeedback = !hasAcceptedFeedback && (
    feedback.confidence >= FEEDBACK_MIN_CONFIDENCE ||
    feedbackHistory.length >= Math.min(3, FEEDBACK_HISTORY_SIZE)
  );

  const shouldAccept = confidentSameAsAccepted
    || firstUsableFeedback
    || strongLatestMatch
    || repeatedMatch
    || clearWindowWinner;

  if (shouldAccept) {
    const textSource = feedback.state === candidateState
      ? feedback
      : [...feedbackHistory].reverse().find((item) => item.state === candidateState) || feedback;
    acceptedFaceFeedback = {
      state: candidateState,
      text: textSource.text,
      confidence: textSource.confidence,
    };
    return {
      state: acceptedFaceFeedback.state,
      text: acceptedFaceFeedback.text,
      shouldUpdate: true,
      statusText: '',
    };
  }

  return {
    state: acceptedFaceFeedback?.state || lastOverlayFeedbackState || 'neutral',
    text: acceptedFaceFeedback?.text || lastOverlayFeedbackText,
    shouldUpdate: false,
    statusText: 'Watching for a stable face signal…',
  };
}

function resetFaceFeedbackSmoothing() {
  feedbackHistory.length = 0;
  acceptedFaceFeedback = null;
  lastFeedbackUpdateTs = 0;
}

function captureAndStoreFaceFrame() {
  if (!faceConfig.enabled || !cameraVideo) return;
  if (!cameraVideo.videoWidth || !cameraVideo.videoHeight) return;

  const srcW = cameraVideo.videoWidth;
  const srcH = cameraVideo.videoHeight;
  const scale = Math.min(1, FACE_MAX_EDGE / Math.max(srcW, srcH));
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  faceCanvas.width = dstW;
  faceCanvas.height = dstH;
  faceCtx.drawImage(cameraVideo, 0, 0, dstW, dstH);

  const dataUrl = faceCanvas.toDataURL('image/jpeg', FACE_JPEG_QUALITY);
  lastFaceFrameB64 = dataUrl.split(',')[1];
  if (!acceptedFaceFeedback && feedbackHistory.length === 0) {
    setFaceStatus('Camera active');
  }
}

async function startFaceCapture() {
  if (!faceConfig.enabled) return;
  if (cameraStream) return;
  if (!transcribeConfig.endpoint) {
    setFaceStatus('Missing endpoint URL', true);
    return;
  }
  resetFaceFeedbackSmoothing();
  setFaceStatus('Starting camera…');
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 360 },
    },
    audio: false,
  });
  cameraVideo = document.createElement('video');
  cameraVideo.autoplay = true;
  cameraVideo.muted = true;
  cameraVideo.playsInline = true;
  cameraVideo.srcObject = cameraStream;
  await cameraVideo.play();
  setFaceStatus('Camera active');
  captureAndStoreFaceFrame();
  faceInterval = setInterval(captureAndStoreFaceFrame, FACE_CAPTURE_INTERVAL_MS);
}

function stopFaceCapture() {
  if (faceInterval) {
    clearInterval(faceInterval);
    faceInterval = null;
  }
  if (cameraVideo) {
    cameraVideo.srcObject = null;
    cameraVideo = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  lastFaceFrameB64 = '';
  resetFaceFeedbackSmoothing();
  setFaceStatus('Idle');
}

// ── MediaRecorder setup ───────────────────────────────────────────────────────

function attachRecorder(stream, label) {
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  } catch {
    rec = new MediaRecorder(stream);
  }

  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  rec.ondataavailable = async (ev) => {
    if (!ev.data || ev.data.size === 0) return;

    packetSeq += 1;
    if (!chunkStore[label]) chunkStore[label] = [];
    chunkStore[label].push(ev.data);

    const payload = {
      packetId: packetSeq,
      label,
      size: ev.data.size,
      mimeType: rec.mimeType || ev.data.type || 'unknown',
      dataType: Object.prototype.toString.call(ev.data), // typically "[object Blob]"
      constructorName: ev.data.constructor?.name || 'unknown',
      isBlob: ev.data instanceof Blob,
    };
    emitEvent('media_chunk', payload);
    // Transcription is handled by PCM->WAV pipeline for mic.
    log(
      `Packet #${payload.packetId} [${label}] ${payload.size} bytes ` +
      `mime=${payload.mimeType} data=${payload.constructorName}`,
      'log-audio'
    );
  };
  rec.onstop = () => resolveStopped();
  rec.start(1000);
  recorders.push({ label, rec, stopped });
}

function finalizeRecordings() {
  // Placeholder for future recording UI; keep stop flow safe for now.
  Object.values(chunkStore).forEach((chunks) => {
    if (Array.isArray(chunks)) {
      chunks.length = 0;
    }
  });
  chunkStore = {};

  Object.keys(transcribeQueues).forEach((label) => {
    transcribeQueues[label].length = 0;
    transcribeInFlight[label] = false;
    transcribeBuffers[label] = [];
    if (transcribeTimers[label]) {
      clearTimeout(transcribeTimers[label]);
      transcribeTimers[label] = null;
    }
  });
  setTranscribeStatus('Idle');

  objectUrls.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // no-op
    }
  });
  objectUrls = [];
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

async function startCapture() {
  if (captureStartInFlight) {
    log('Setup already in progress — wait for it to finish or click Stop.', 'log-audio');
    return;
  }
  captureStartInFlight = true;
  startBtn.disabled = true;

  let currentStep = 'initialization';
  try {
    const micPermissionState = await getMicPermissionState();
    if (micPermissionState === 'denied') {
      log(
        'Microphone is currently blocked for this extension (no prompt will appear). ' +
        'Open Chrome site settings for this extension and allow Microphone, then retry.',
        'log-error'
      );
      startBtn.disabled = false;
      return;
    }
    if (micPermissionState === 'prompt') {
      log('Chrome should show a microphone permission prompt next.', 'log-audio');
    }

    // 1. Tab audio first — must happen before getDisplayMedia claims the tab
    currentStep = 'tab_audio';
    log('Requesting tab audio…', 'log-audio');
    tabStream = await captureTabAudioStream();
    emitEvent('capture_start', { source: 'tab_audio' });

    // 2. Microphone
    currentStep = 'microphone';
    log('Requesting microphone…', 'log-audio');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    emitEvent('capture_start', { source: 'microphone' });
    if (transcribeConfig.enabled) {
      startMicTranscription(micStream);
    }

    // 2.5 Camera (optional)
    if (faceConfig.enabled) {
      currentStep = 'camera';
      log('Requesting camera…', 'log-audio');
      await startFaceCapture();
      emitEvent('capture_start', { source: 'camera' });
    }

    // 3. Screen (video + system audio if the OS/browser allows it)
    currentStep = 'screen';
    log('Requesting screen capture…', 'log-screen');
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', frameRate: { ideal: 30 } },
      audio: true, // system audio — may be silently ignored on macOS
    });

    preview.srcObject = screenStream;
    placeholder.style.display = 'none';

    const vt = screenStream.getVideoTracks()[0];
    const settings = vt?.getSettings() ?? {};
    log(`Screen: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`, 'log-screen');
    emitEvent('capture_start', { source: 'screen', ...settings });


    // Audio metering
    audioCtx = new AudioContext();
    await audioCtx.resume();

    // tabCapture mutes tab playback unless we route captured audio back to output.
    tabMonitorNodes = routeTabAudioToOutput(tabStream);
    log('Tab audio monitor routed to speakers.', 'log-audio');

    const tabAnalyser = buildMeter(tabStream);
    const micAnalyser = micStream ? buildMeter(micStream) : null;
    const sysAudioTracks = screenStream.getAudioTracks();
    const sysAnalyser = sysAudioTracks.length
      ? buildMeter(new MediaStream(sysAudioTracks))
      : null;

    function meterLoop() {
      const tabRms = rms(tabAnalyser);
      const micRms = micAnalyser ? rms(micAnalyser) : 0;
      const sysRms = sysAnalyser ? rms(sysAnalyser) : 0;

      lastRmsByLabel.tab = tabRms;
      lastRmsByLabel.mic = micRms;
      lastRmsByLabel.system_audio = sysRms;

      barTab.style.width = Math.min(tabRms * 400, 100) + '%';
      barMic.style.width = Math.min(micRms * 400, 100) + '%';
      barSys.style.width = Math.min(sysRms * 400, 100) + '%';

      emitEvent('audio_levels', { tab: tabRms, mic: micRms, system: sysRms });
      rafId = requestAnimationFrame(meterLoop);
    }
    meterLoop();

    // Frame capture every 2 seconds
    frameInterval = setInterval(captureFrame, 2000);

    // MediaRecorders for raw chunk logging
    attachRecorder(tabStream,  'tab');
    if (micStream) {
      attachRecorder(micStream,  'mic');
    }
    if (sysAudioTracks.length) {
      attachRecorder(new MediaStream(sysAudioTracks), 'system_audio');
    }

    stopBtn.disabled  = false;
    log('All sources active.', 'log-audio');
  } catch (err) {
    console.error(err);
    cleanupPartialCapture();
    log('Error: ' + normalizeCaptureError(err, currentStep), 'log-error');
  } finally {
    captureStartInFlight = false;
  }
}

async function stopCapture() {
  try {
    const activeRecorders = [...recorders];
    activeRecorders.forEach(({ rec }) => rec.state !== 'inactive' && rec.stop());
    await Promise.allSettled(activeRecorders.map(({ stopped }) => stopped));
    recorders = [];

    Object.keys(transcribeBuffers).forEach((label) => {
      flushTranscriptionBuffer(label, undefined, { force: true });
    });

    finalizeRecordings();
  } catch (err) {
    console.error(err);
    log(`Stop encountered an issue: ${err?.message || err}`, 'log-error');
  } finally {
    stopFaceCapture();
    stopMicTranscription();
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (tabMonitorNodes) {
      try {
        tabMonitorNodes.src.disconnect();
        tabMonitorNodes.gain.disconnect();
      } catch {
        // no-op
      }
      tabMonitorNodes = null;
    }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }

    [screenStream, tabStream, micStream, cameraStream].forEach(s => s?.getTracks().forEach(t => t.stop()));
    screenStream = tabStream = micStream = cameraStream = null;
    packetSeq = 0;

    preview.srcObject = null;
    placeholder.style.display = '';
    barTab.style.width = barMic.style.width = barSys.style.width = '0%';

    startBtn.disabled = false;
    stopBtn.disabled  = true;
    emitEvent('capture_stop', {});
    log('Capture stopped.', 'log-audio');
  }
}

/**
 * Resolve the browser tab the user is likely looking at. `currentWindow` from a toolbar
 * popup often points at the wrong window; `lastFocusedWindow` matches the main browser window.
 */
function runOnActiveWebTab(callback) {
  if (isDetachedWindow && Number.isInteger(sourceTabId) && sourceTabId > 0) {
    chrome.tabs.get(sourceTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      callback(tab);
    });
    return;
  }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => callback(tabs?.[0]));
}

/** Prefer the tab where the overlay is injected so live insights hit the right page. */
function runOnInsightTargetTab(callback) {
  if (Number.isInteger(overlayInsightTabId) && overlayInsightTabId > 0) {
    chrome.tabs.get(overlayInsightTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        overlayInsightTabId = null;
        runOnActiveWebTab(callback);
        return;
      }
      callback(tab);
    });
    return;
  }
  runOnActiveWebTab(callback);
}

function injectOverlayTextById(tabId, tabUrl, elementId, content) {
  if (!Number.isInteger(tabId)) return;
  if (
    tabUrl.startsWith('chrome://') ||
    tabUrl.startsWith('chrome-extension://') ||
    tabUrl.startsWith('edge://') ||
    tabUrl.startsWith('about:')
  ) {
    return;
  }
  chrome.scripting.executeScript(
    {
      target: { tabId },
      func: (id, next) => {
        const el = document.getElementById(id);
        if (el) el.textContent = next;
      },
      args: [elementId, content],
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

/** Red line at top of RHS — latest transcribed sentence (confirms audio path is live). */
function updateOverlayRightPanelHeard(sentence) {
  const text = String(sentence || '').trim() || 'Listening…';
  lastOverlayHeardSentence = text;
  runOnInsightTargetTab((tab) => {
    injectOverlayTextById(tab?.id, tab?.url || '', OVERLAY_RIGHT_HEARD_ID, text);
  });
}

function updateOverlayRightPanelInsight(insightText) {
  const text = String(insightText || '').trim();
  if (!text) return;
  lastOverlayInsight = text;
  runOnInsightTargetTab((tab) => {
    injectOverlayTextById(tab?.id, tab?.url || '', OVERLAY_RIGHT_TEXT_ID, text);
  });
}

function updateOverlayLeftFeedback(feedbackText, feedbackState) {
  const text = String(feedbackText || '').trim();
  if (!text) return;
  lastOverlayFeedbackText = text;
  if (feedbackState) lastOverlayFeedbackState = feedbackState;
  runOnInsightTargetTab((tab) => {
    injectOverlayTextById(tab?.id, tab?.url || '', OVERLAY_LEFT_FEEDBACK_ID, text);
    setOverlayLeftFeedbackColor(tab?.id, tab?.url || '', lastOverlayFeedbackState);
  });
}

function setOverlayLeftFeedbackColor(tabId, tabUrl, state) {
  if (!Number.isInteger(tabId)) return;
  if (
    tabUrl.startsWith('chrome://') ||
    tabUrl.startsWith('chrome-extension://') ||
    tabUrl.startsWith('edge://') ||
    tabUrl.startsWith('about:')
  ) {
    return;
  }
  const color = state === 'engaged'
    ? '#5fe075'
    : state === 'bored'
      ? '#ff6b6b'
      : '#ffd54f';
  chrome.scripting.executeScript(
    {
      target: { tabId },
      func: (id, nextColor) => {
        const el = document.getElementById(id);
        if (el) el.style.color = nextColor;
      },
      args: [OVERLAY_LEFT_FEEDBACK_ID, color],
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function openDetachedWindow() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const activeId = tabs?.[0]?.id;
    const query = Number.isInteger(activeId) && activeId > 0
      ? `?mode=window&sourceTabId=${activeId}`
      : '?mode=window';
    chrome.windows.create(
      {
        url: chrome.runtime.getURL(`popup.html${query}`),
        type: 'popup',
        width: 380,
        height: 720,
        focused: true,
      },
      () => window.close()
    );
  });
}

function toggleOverlay() {
  const withTargetTab = (activeTab) => {
    const tabId = activeTab?.id;
    const capturedTabId = tabId;
    if (!Number.isInteger(tabId)) {
      log('No active tab found for overlay preview.', 'log-error');
      return;
    }
    const tabUrl = activeTab?.url || '';
    if (
      tabUrl.startsWith('chrome://') ||
      tabUrl.startsWith('chrome-extension://') ||
      tabUrl.startsWith('edge://') ||
      tabUrl.startsWith('about:')
    ) {
      log(
        'Overlay cannot be injected on browser internal pages. Open a normal website (for example https://example.com) and try again.',
        'log-error'
      );
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: (
          overlayTextLeft,
          overlayTextRight,
          leftTextId,
          rightTextId,
          heardTextId,
          heardInitial,
          listeningBarId
        ) => {
          const OVERLAY_ID = 'obli-overlay-poc';
          const existing = document.getElementById(OVERLAY_ID);
          if (existing) {
            existing.remove();
            return { state: 'removed' };
          }

          const overlay = document.createElement('div');
          overlay.id = OVERLAY_ID;
          Object.assign(overlay.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '2147483647',
            display: 'flex',
            flexDirection: 'column',
            pointerEvents: 'none',
          });

          const listeningBar = document.createElement('div');
          listeningBar.id = listeningBarId;
          listeningBar.textContent = 'Listening';
          Object.assign(listeningBar.style, {
            flex: '0 0 auto',
            width: '100%',
            padding: '8px 16px',
            boxSizing: 'border-box',
            background: 'rgba(0, 0, 0, 0.72)',
            color: 'rgba(255, 255, 255, 0.95)',
            fontFamily: 'Arial, sans-serif',
            fontSize: '11px',
            fontWeight: '700',
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            textAlign: 'center',
            borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
          });

          const gridShell = document.createElement('div');
          Object.assign(gridShell.style, {
            flex: '1',
            minHeight: '0',
            display: 'grid',
            gridTemplateColumns: '20vw 1fr 20vw',
          });

          const leftPanel = document.createElement('div');
          Object.assign(leftPanel.style, {
            height: '100%',
            background: 'rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          });

          const centerPanel = document.createElement('div');
          Object.assign(centerPanel.style, {
            height: '100%',
            background: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          });

          const rightPanel = document.createElement('div');
          Object.assign(rightPanel.style, {
            height: '100%',
            background: 'rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px',
            boxSizing: 'border-box',
          });

          const textBaseStyle = {
            padding: '16px 24px',
            borderRadius: '12px',
            background: 'rgba(0, 0, 0, 0.35)',
            color: '#ffffff',
            fontSize: '24px',
            fontFamily: 'Arial, sans-serif',
            fontWeight: '700',
            letterSpacing: '0.02em',
            textAlign: 'center',
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
          };

          const leftTextBox = document.createElement('div');
          leftTextBox.id = leftTextId;
          leftTextBox.textContent = overlayTextLeft;
          Object.assign(leftTextBox.style, textBaseStyle, {
            fontSize: 'clamp(13px, 1.25vw, 22px)',
            lineHeight: '1.35',
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          });

          const rightColumn = document.createElement('div');
          Object.assign(rightColumn.style, {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            justifyContent: 'center',
            gap: '10px',
            maxWidth: '100%',
            width: '100%',
          });

          const heardLine = document.createElement('div');
          heardLine.id = heardTextId;
          heardLine.textContent = heardInitial;
          Object.assign(heardLine.style, {
            ...textBaseStyle,
            color: '#ff5252',
            fontSize: 'clamp(12px, 1.15vw, 18px)',
            fontWeight: '600',
            letterSpacing: '0.01em',
            padding: '10px 14px',
            textAlign: 'left',
            borderLeft: '3px solid #ff5252',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: '1.35',
          });

          const rightTextBox = document.createElement('div');
          rightTextBox.id = rightTextId;
          rightTextBox.textContent = overlayTextRight;
          Object.assign(rightTextBox.style, textBaseStyle, {
            maxWidth: '100%',
            fontSize: 'clamp(13px, 1.25vw, 22px)',
            lineHeight: '1.35',
            fontWeight: '600',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            hyphens: 'auto',
            textAlign: 'left',
          });

          rightColumn.appendChild(heardLine);
          rightColumn.appendChild(rightTextBox);

          leftPanel.appendChild(leftTextBox);
          rightPanel.appendChild(rightColumn);
          gridShell.appendChild(leftPanel);
          gridShell.appendChild(centerPanel);
          gridShell.appendChild(rightPanel);
          overlay.appendChild(listeningBar);
          overlay.appendChild(gridShell);
          document.body.appendChild(overlay);
          return { state: 'added' };
        },
        args: [
          lastOverlayFeedbackText,
          lastOverlayInsight,
          OVERLAY_LEFT_FEEDBACK_ID,
          OVERLAY_RIGHT_TEXT_ID,
          OVERLAY_RIGHT_HEARD_ID,
          lastOverlayHeardSentence,
          OVERLAY_LISTENING_BAR_ID,
        ],
      },
      (results) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || 'Unknown script injection error.';
          if (tabUrl.startsWith('file://')) {
            log(
              `Overlay inject failed: ${msg} Enable "Allow access to file URLs" in chrome://extensions for this extension, or test on a regular website.`,
              'log-error'
            );
            return;
          }
          log(
            `Overlay inject failed: ${msg} Try a regular website (https://...) instead of a restricted page.`,
            'log-error'
          );
          return;
        }
        const state = results?.[0]?.result?.state;
        if (state === 'added') {
          overlayInsightTabId = capturedTabId;
          log('Transparent overlay preview shown on active tab.', 'log-screen');
          setOverlayLeftFeedbackColor(tabId, tabUrl, lastOverlayFeedbackState);
        } else if (state === 'removed') {
          overlayInsightTabId = null;
          log('Transparent overlay preview removed.', 'log-screen');
        }
      }
    );
  };

  // In detached mode, target the original tab that launched this window.
  if (isDetachedWindow && Number.isInteger(sourceTabId) && sourceTabId > 0) {
    chrome.tabs.get(sourceTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        log(
          'Could not find the original source tab. Re-open detached window from the tab you want to preview.',
          'log-error'
        );
        return;
      }
      withTargetTab(tab);
    });
    return;
  }

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    withTargetTab(tabs?.[0]);
  });
}

if (isDetachedWindow && popoutBtn) {
  popoutBtn.textContent = 'Detached Window Open';
  popoutBtn.disabled = true;
}

startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);
popoutBtn?.addEventListener('click', openDetachedWindow);
overlayToggleBtn?.addEventListener('click', toggleOverlay);
