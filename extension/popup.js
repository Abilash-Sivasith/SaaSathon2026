const startBtn  = document.getElementById('start');
const stopBtn   = document.getElementById('stop');
const popoutBtn = document.getElementById('popout');
const overlayToggleBtn = document.getElementById('overlay-toggle');
const preview   = document.getElementById('screen-preview');
const placeholder = document.getElementById('preview-placeholder');
const barTab    = document.getElementById('bar-tab');
const barMic    = document.getElementById('bar-mic');
const barSys    = document.getElementById('bar-sys');
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
let eventSeq      = 0;
let lastLevelLogTs = 0;
let tabMonitorNodes = null;
let captureStartInFlight = false;

const transcribeQueues = {};
const transcribeInFlight = {};
const transcribeSeq = {};
const transcribeBuffers = {};
/** label -> timeout id (fixed-interval flush fallback, no silence wait) */
const transcribeTimers = {};
const lastRmsByLabel = { tab: 0, mic: 0, system_audio: 0 };
const INGEST_ENDPOINT = 'http://localhost:8000/ingest';
const FACE_ENDPOINT = 'http://localhost:8000/face';
const MEETING_CONTEXT_ENDPOINT = 'http://localhost:8000/meeting-context';
const TRANSCRIBE_ENABLED = true;
const FACE_ENABLED = true;

// Audio throttle: fast path for live transcript + key-detail bullets.
const AUDIO_MIN_CHUNK_BYTES = 25000;
const AUDIO_MAX_WAIT_MS = 1600;
const AUDIO_PCM_FLUSH_MS = 1200;
const AUDIO_MAX_QUEUE_ITEMS = 1;

// Visual throttle: slower independent path for coaching, never blocks audio.
const VISUAL_FRAME_CAPTURE_MS = 3000;
const VISUAL_ANALYSIS_MS = 5000;
const FEEDBACK_UPDATE_INTERVAL_MS = 3500;
const FACE_JPEG_QUALITY = 0.6;
const FACE_MAX_EDGE = 480;
const FEEDBACK_HISTORY_SIZE = 7;
const FEEDBACK_MIN_CONFIDENCE = 0.55;
const FEEDBACK_STRONG_CONFIDENCE = 0.8;
const FEEDBACK_STATE_CHANGE_VOTES = 3;
const FEEDBACK_STATE_SCORE_MARGIN = 0.65;

/** RHS rolling hint panel: append blocks, expire after TTL, throttle new blocks. */
const HINT_FEED_TTL_MS = 20000;
const HINT_FEED_MIN_INTERVAL_MS = 2600;
const HINT_FEED_TICK_MS = 1000;
/** Throttle delivery-driven LHS meter repaints (semantic / tempo / wording) so captions change less often. */
const LHS_METER_FROM_DELIVERY_MS = 3200;

const TRANSCRIBE_MIN_RMS = 0.002;
let micTranscribeCtx = null;
let micTranscribeProcessor = null;
let micTranscribeSource = null;
let micTranscribeTimer = null;
let micPcmBuffer = [];
let micPcmSampleRate = 48000;

/** Latest insight keywords from the server (used when rebuilding overlay). */
let lastOverlayInsight = '';
const OVERLAY_RIGHT_TEXT_ID = 'obli-overlay-right-text';
const OVERLAY_RIGHT_HEARD_ID = 'obli-overlay-right-heard';
/** RHS scroll stack for rolling hints. */
const OVERLAY_RHS_HINT_STACK_ID = 'obli-overlay-rhs-hint-stack';
/** Presenter LHS meters (semantic / tempo / expression / wording) — same IDs as presenter-overlay.js. */
const LHS_SEMANTIC_FILL_ID = 'obli-overlay-lhs-semantic-fill';
const LHS_SEMANTIC_CAP_ID = 'obli-overlay-lhs-semantic-cap';
const LHS_TEMPO_FILL_ID = 'obli-overlay-lhs-tempo-fill';
const LHS_TEMPO_CAP_ID = 'obli-overlay-lhs-tempo-cap';
const LHS_EXPRESSION_FILL_ID = 'obli-overlay-lhs-expression-fill';
const LHS_EXPRESSION_CAP_ID = 'obli-overlay-lhs-expression-cap';
const LHS_LANGUAGE_FILL_ID = 'obli-overlay-lhs-language-fill';
const LHS_LANGUAGE_CAP_ID = 'obli-overlay-lhs-language-cap';
/** Tab id where the overlay was last shown; fixes tab resolution from the extension popup. */
let overlayInsightTabId = null;
/** Last finalized transcript shown in red so the user can confirm what was heard. */
let lastOverlayHeardSentence = 'Listening…';
/** Dedupe identical hint bullets only when the spoken chunk is unchanged (new speech → allow repeat cues). */
let lastPushedInsightRaw = '';
let lastPushedInsightForTranscript = '';
let pendingQueuedTranscript = '';
/** Last ingest `delivery` object from the server (semantic / tempo / language bars). */
let lastDeliverySnapshot = null;
/** `{ ts, bullets }` oldest → newest; pruned by age for the rolling RHS panel. */
let insightHintBlocks = [];
let lastHintAppendTs = 0;
let hintAppendTimer = null;
let pendingQueuedInsight = null;
let hintFeedTickTimer = null;
let lhsDeliveryFlushTimer = null;
let lastLhsDeliveryPaintTs = 0;
/** Facial expression meter (LHS), updated from `/face`; wording bar comes from ingest. */
let lastFacialLhs = { score: 68, label: 'Awaiting expression signal…' };
let lastSpokenText = '';
let lastFeedbackUpdateTs = 0;
const feedbackHistory = [];
let acceptedFaceFeedback = null;
/** Prevent stacked overlay inject / panel RPC clicks from odd Chrome timing. */
let overlayToggleInFlight = false;
let panelCloseInFlight = false;
let lastPanelCloseAt = 0;

let cameraVideo = null;
let faceInterval = null;
let faceAnalysisInterval = null;
const faceCanvas = document.createElement('canvas');
const faceCtx = faceCanvas.getContext('2d');
let lastFaceFrameB64 = '';
let lastFaceAnalysisSentTs = 0;
let faceAnalysisInFlight = false;

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg, cls = '') {
  if (cls === 'log-error') {
    console.error('[Logger]', msg);
    return;
  }
  console.log('[Logger]', msg);
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
  if (!TRANSCRIBE_ENABLED) return;

  ensureQueue(label);

  transcribeBuffers[label].push(blob);
  const totalBytes = transcribeBuffers[label].reduce((sum, b) => sum + (b?.size || 0), 0);

  const mt = mimeType || blob.type || 'audio/webm';

  if (totalBytes >= AUDIO_MIN_CHUNK_BYTES) {
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
    }, AUDIO_MAX_WAIT_MS);
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
  }, AUDIO_PCM_FLUSH_MS);
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

  if (!force && combined.size < AUDIO_MIN_CHUNK_BYTES) {
    transcribeTimers[label] = setTimeout(() => {
      transcribeTimers[label] = null;
      flushTranscriptionBuffer(label, inferredType);
    }, AUDIO_MAX_WAIT_MS);
    return;
  }

  transcribeBuffers[label] = [];

  transcribeSeq[label] += 1;
  if (transcribeQueues[label].length > AUDIO_MAX_QUEUE_ITEMS) {
    transcribeQueues[label].splice(0, transcribeQueues[label].length - AUDIO_MAX_QUEUE_ITEMS);
  }
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
  payload.audioRms = lastRmsByLabel[label] || 0;
  if (lastSpokenText) {
    payload.recentTranscript = lastSpokenText;
  }

  const headers = { 'Content-Type': 'application/json' };

  try {
    const res = await fetch(INGEST_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      log(`Transcription error ${res.status}: ${errText}`, 'log-error');
    } else {
      const data = await res.json();
      const spoken = (data.text || '').trim();
      if (spoken) updateOverlayRightPanelHeard(spoken);
      if (spoken) lastSpokenText = spoken;
      const insight = data.insight != null ? String(data.insight).trim() : '';
      if (insight) updateOverlayRightPanelInsight(insight, spoken);
      if (data.delivery) {
        lastDeliverySnapshot = data.delivery;
        scheduleLhsMetersFromDelivery();
      }
      if (data.coach) applySpeechCoachingResult(data.coach);
    }
  } catch (err) {
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

function getActiveCaptureTabId() {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ type: 'get_capture_target' }, (response) => {
      if (chrome.runtime.lastError) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
          if (chrome.runtime.lastError) {
            rej(chrome.runtime.lastError);
            return;
          }

          const tabId = tabs?.[0]?.id;
          if (Number.isInteger(tabId) && tabId > 0) {
            res(tabId);
            return;
          }

          rej(new Error('No active browser tab found for tab audio capture.'));
        });
        return;
      }

      const tabId = response?.tabId;
      if (Number.isInteger(tabId) && tabId > 0) {
        res(tabId);
        return;
      }

      rej(new Error(response?.error || 'No active browser tab found for tab audio capture.'));
    });
  });
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
  // Detached windows bind to the originating tab; side panels bind to the active tab.
  if (Number.isInteger(sourceTabId) && sourceTabId > 0) {
    return getTabStreamById(sourceTabId);
  }

  try {
    const activeTabId = await getActiveCaptureTabId();
    return await getTabStreamById(activeTabId);
  } catch (err) {
    if (isDetachedWindow) throw err;

    // Keep the old toolbar-popup path as a compatibility fallback.
    return getTabStreamByCapture();
  }
}

function cleanupPartialCapture() {
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (frameInterval) { clearInterval(frameInterval); frameInterval = null; }
  stopFaceCapture();

  [screenStream, tabStream, micStream, cameraStream].forEach(s => s?.getTracks().forEach(t => t.stop()));
  screenStream = tabStream = micStream = cameraStream = null;
  lastFaceAnalysisSentTs = 0;

  preview.srcObject = null;
  placeholder.style.display = '';
  barTab.style.width = barMic.style.width = barSys.style.width = '0%';

  lastDeliverySnapshot = null;
  lastOverlayInsight = '';
  lastPushedInsightRaw = '';
  lastPushedInsightForTranscript = '';
  pendingQueuedTranscript = '';
  stopHintFeedTicker();
  if (hintAppendTimer) {
    clearTimeout(hintAppendTimer);
    hintAppendTimer = null;
  }
  if (lhsDeliveryFlushTimer) {
    clearTimeout(lhsDeliveryFlushTimer);
    lhsDeliveryFlushTimer = null;
  }
  lastLhsDeliveryPaintTs = 0;
  insightHintBlocks = [];
  pendingQueuedInsight = null;
  pendingQueuedTranscript = '';
  lastHintAppendTs = 0;
  flushPresenterLhsMeters();
  runOnInsightTargetTab((tab) => {
    injectOverlayTextById(tab?.id, tab?.url || '', OVERLAY_RIGHT_TEXT_ID, '');
    injectOverlayHintFeed(tab?.id, tab?.url || '', OVERLAY_RHS_HINT_STACK_ID, []);
  });

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
  return ['bored', 'neutral', 'engaged', 'warning'].includes(normalized) ? normalized : 'neutral';
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

  if (normalized === 'warning') {
    return {
      state: 'warning',
      confidence: normalizedConfidence,
      text: 'Easy there—keep it professional.',
    };
  }
  if (normalized === 'bored') {
    return {
      state: 'bored',
      confidence: normalizedConfidence,
      text: `Look back.${reasonText}`,
    };
  }
  if (normalized === 'engaged') {
    return {
      state: 'engaged',
      confidence: normalizedConfidence,
      text: `Good focus.${reasonText}`,
    };
  }
  return {
    state: 'neutral',
    confidence: normalizedConfidence,
    text: `Stay focused.${reasonText}`,
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
    state: acceptedFaceFeedback?.state || 'neutral',
    text: acceptedFaceFeedback?.text || lastFacialLhs.label,
    shouldUpdate: false,
    statusText: 'Watching for a stable face signal…',
  };
}

function resetFaceFeedbackSmoothing() {
  feedbackHistory.length = 0;
  acceptedFaceFeedback = null;
  lastFeedbackUpdateTs = 0;
  lastFacialLhs = { score: 68, label: 'Awaiting expression signal…' };
}

function applyFaceAnalysisResult(face) {
  if (!face) return;
  if (normalizeFaceState(face.state) === 'warning') {
    applySpeechCoachingResult(face, { syncFacial: true });
    return;
  }
  const stableFeedback = computeStableFaceFeedback(face);
  const now = Date.now();
  const labelChanged = Boolean(stableFeedback.text && stableFeedback.text !== lastFacialLhs.label);
  const intervalOk = now - lastFeedbackUpdateTs >= FEEDBACK_UPDATE_INTERVAL_MS;
  if (stableFeedback.shouldUpdate && (intervalOk || labelChanged)) {
    lastFeedbackUpdateTs = now;
    const st = normalizeFaceState(stableFeedback.state);
    const scoreMap = { engaged: 91, neutral: 72, bored: 43, warning: 24 };
    lastFacialLhs = {
      score: scoreMap[st] ?? 66,
      label: stableFeedback.text || 'Stay present.',
    };
    flushPresenterLhsMeters();
  }
}

function applySpeechCoachingResult(coach, options = {}) {
  if (!coach) return;
  const feedback = formatFaceFeedback(
    coach.state || 'warning',
    coach.reason || '',
    coach.feedback || 'Easy there—keep it professional.',
    coach.confidence ?? 0.95
  );
  acceptedFaceFeedback = {
    state: 'warning',
    text: feedback.text,
    confidence: feedback.confidence,
  };
  feedbackHistory.push(acceptedFaceFeedback);
  if (feedbackHistory.length > FEEDBACK_HISTORY_SIZE) feedbackHistory.shift();
  lastFeedbackUpdateTs = Date.now();
  if (options.syncFacial) {
    lastFacialLhs = { score: 22, label: feedback.text };
  }
  flushPresenterLhsMeters();
}

function captureAndStoreFaceFrame() {
  if (!FACE_ENABLED || !cameraVideo) return;
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
}

async function analyzeLatestFaceFrame() {
  if (!FACE_ENABLED || faceAnalysisInFlight || !lastFaceFrameB64) return;
  const now = Date.now();
  if (lastFaceAnalysisSentTs && now - lastFaceAnalysisSentTs < VISUAL_ANALYSIS_MS) return;
  lastFaceAnalysisSentTs = now;
  faceAnalysisInFlight = true;

  const payload = {
    imageB64: lastFaceFrameB64,
    imageMimeType: 'image/jpeg',
    audioRms: lastRmsByLabel.mic || 0,
  };
  if (lastSpokenText) {
    payload.recentTranscript = lastSpokenText;
  }

  try {
    const res = await fetch(FACE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log(`Face analysis error ${res.status}: ${await res.text()}`, 'log-error');
      return;
    }
    const data = await res.json();
    if (data.face) applyFaceAnalysisResult(data.face);
  } catch (err) {
    log(`Face analysis network error: ${err?.message || err}`, 'log-error');
  } finally {
    faceAnalysisInFlight = false;
  }
}

async function startFaceCapture() {
  if (!FACE_ENABLED) return;
  if (cameraStream) return;
  resetFaceFeedbackSmoothing();
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
  captureAndStoreFaceFrame();
  faceInterval = setInterval(captureAndStoreFaceFrame, VISUAL_FRAME_CAPTURE_MS);
  analyzeLatestFaceFrame();
  faceAnalysisInterval = setInterval(analyzeLatestFaceFrame, VISUAL_ANALYSIS_MS);
}

function stopFaceCapture() {
  if (faceInterval) {
    clearInterval(faceInterval);
    faceInterval = null;
  }
  if (faceAnalysisInterval) {
    clearInterval(faceAnalysisInterval);
    faceAnalysisInterval = null;
  }
  faceAnalysisInFlight = false;
  if (cameraVideo) {
    cameraVideo.srcObject = null;
    cameraVideo = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  lastFaceFrameB64 = '';
  lastFaceAnalysisSentTs = 0;
  resetFaceFeedbackSmoothing();
}

function resetTranscriptionBuffers() {
  Object.keys(transcribeQueues).forEach((label) => {
    transcribeQueues[label].length = 0;
    transcribeInFlight[label] = false;
    transcribeBuffers[label] = [];
    if (transcribeTimers[label]) {
      clearTimeout(transcribeTimers[label]);
      transcribeTimers[label] = null;
    }
  });
}

/** Pull lines from context.txt-style body so the overlay can show facts before the first transcript. */
function extractMeetingContextBulletLines(text) {
  const lines = String(text || '').split(/\n+/);
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const dash = line.match(/^\s*[-*•]\s+(.+)/);
    if (dash) {
      const b = dash[1].trim();
      if (b.length >= 3) out.push(b);
    }
    if (out.length >= 12) break;
  }
  return out;
}

async function prefetchMeetingContextForOverlay() {
  try {
    const res = await fetch(MEETING_CONTEXT_ENDPOINT);
    if (!res.ok) return;
    const data = await res.json();
    const bullets = extractMeetingContextBulletLines(data.text || '');
    if (!bullets.length) return;
    ensureHintFeedTicker();
    pruneInsightHintBlocks();
    insightHintBlocks.push({ ts: Date.now(), bullets: bullets.slice(0, 8) });
    lastHintAppendTs = 0;
    renderOverlayHintFeed();
  } catch {
    // Server not running or blocked — overlay stays empty until first /ingest.
  }
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
    if (TRANSCRIBE_ENABLED) {
      startMicTranscription(micStream);
    }

    // 2.5 Camera
    if (FACE_ENABLED) {
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

    insightHintBlocks = [];
    lastHintAppendTs = 0;
    pendingQueuedInsight = null;
    if (hintAppendTimer) {
      clearTimeout(hintAppendTimer);
      hintAppendTimer = null;
    }
    void prefetchMeetingContextForOverlay();

    // Frame capture every 2 seconds
    frameInterval = setInterval(captureFrame, 2000);

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
  if (stopBtn.disabled) return;
  try {
    Object.keys(transcribeBuffers).forEach((label) => {
      flushTranscriptionBuffer(label, undefined, { force: true });
    });

    resetTranscriptionBuffers();
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
    lastFaceAnalysisSentTs = 0;

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

function splitInsightIntoBullets(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.includes('\n') || t.includes('•')) {
    return t
      .split(/\n+/)
      .map((line) => line.trim().replace(/^[-•]\s*/, ''))
      .filter(Boolean)
      .slice(0, 12);
  }
  return [t];
}

function insightTextIsSkipToken(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  return !t || t === 'ok' || t === 'okay';
}

function pruneInsightHintBlocks() {
  const now = Date.now();
  insightHintBlocks = insightHintBlocks.filter((b) => now - b.ts <= HINT_FEED_TTL_MS);
}

function ensureHintFeedTicker() {
  if (hintFeedTickTimer) return;
  hintFeedTickTimer = setInterval(() => {
    const prevLen = insightHintBlocks.length;
    pruneInsightHintBlocks();
    if (insightHintBlocks.length !== prevLen) {
      renderOverlayHintFeed();
    }
  }, HINT_FEED_TICK_MS);
}

function stopHintFeedTicker() {
  if (hintFeedTickTimer) {
    clearInterval(hintFeedTickTimer);
    hintFeedTickTimer = null;
  }
}

function scheduleLhsMetersFromDelivery() {
  const now = Date.now();
  if (!lastLhsDeliveryPaintTs || now - lastLhsDeliveryPaintTs >= LHS_METER_FROM_DELIVERY_MS) {
    if (lhsDeliveryFlushTimer) {
      clearTimeout(lhsDeliveryFlushTimer);
      lhsDeliveryFlushTimer = null;
    }
    lastLhsDeliveryPaintTs = Date.now();
    flushPresenterLhsMeters();
    return;
  }
  const delay = LHS_METER_FROM_DELIVERY_MS - (now - lastLhsDeliveryPaintTs);
  if (!lhsDeliveryFlushTimer) {
    lhsDeliveryFlushTimer = setTimeout(() => {
      lhsDeliveryFlushTimer = null;
      lastLhsDeliveryPaintTs = Date.now();
      flushPresenterLhsMeters();
    }, delay);
  }
}

function lastHintBlockBullets() {
  if (!insightHintBlocks.length) return null;
  return insightHintBlocks[insightHintBlocks.length - 1].bullets;
}

function bulletsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]).toLowerCase() !== String(b[i]).toLowerCase()) return false;
  }
  return true;
}

function flushQueuedInsightAppend() {
  hintAppendTimer = null;
  const raw = pendingQueuedInsight;
  const transcriptChunk = pendingQueuedTranscript;
  pendingQueuedInsight = null;
  pendingQueuedTranscript = '';
  if (!raw || insightTextIsSkipToken(raw)) return;

  const bullets = splitInsightIntoBullets(raw);
  if (!bullets.length) return;

  const prev = lastHintBlockBullets();
  const sameChunkAndInsight =
    prev &&
    bulletsEqual(prev, bullets) &&
    raw === lastPushedInsightRaw &&
    transcriptChunk === lastPushedInsightForTranscript;
  if (sameChunkAndInsight) return;

  pruneInsightHintBlocks();
  insightHintBlocks.push({ ts: Date.now(), bullets });
  lastHintAppendTs = Date.now();
  lastOverlayInsight = raw;
  lastPushedInsightRaw = raw;
  lastPushedInsightForTranscript = transcriptChunk;
  renderOverlayHintFeed();
}

function scheduleInsightHintAppend(text, transcriptChunk = '') {
  const raw = String(text || '').trim();
  if (!raw || insightTextIsSkipToken(raw)) return;

  ensureHintFeedTicker();
  pendingQueuedInsight = raw;
  pendingQueuedTranscript = String(transcriptChunk || '').trim();

  const now = Date.now();
  const elapsed = now - lastHintAppendTs;
  if (!lastHintAppendTs || elapsed >= HINT_FEED_MIN_INTERVAL_MS) {
    if (hintAppendTimer) {
      clearTimeout(hintAppendTimer);
      hintAppendTimer = null;
    }
    flushQueuedInsightAppend();
    return;
  }
  if (hintAppendTimer) clearTimeout(hintAppendTimer);
  hintAppendTimer = setTimeout(flushQueuedInsightAppend, HINT_FEED_MIN_INTERVAL_MS - elapsed);
}

function injectOverlayHintFeed(tabId, tabUrl, stackId, blocks) {
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
      func: (id, blocksArg) => {
        const stack = document.getElementById(id);
        if (!stack) return;
        stack.replaceChildren();
        blocksArg.forEach((bullets) => {
          const wrap = document.createElement('div');
          wrap.style.marginTop = '10px';
          wrap.style.paddingBottom = '8px';
          wrap.style.borderBottom = '1px solid rgba(255,255,255,0.12)';
          bullets.forEach((line) => {
            const row = document.createElement('div');
            row.textContent = `• ${line}`;
            row.style.marginBottom = '5px';
            row.style.fontWeight = '600';
            row.style.lineHeight = '1.38';
            wrap.appendChild(row);
          });
          stack.appendChild(wrap);
        });
        stack.scrollTop = stack.scrollHeight;
      },
      args: [stackId, blocks],
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function renderOverlayHintFeed() {
  pruneInsightHintBlocks();
  const ordered = insightHintBlocks.map((b) => b.bullets);
  runOnInsightTargetTab((tab) => {
    injectOverlayHintFeed(tab?.id, tab?.url || '', OVERLAY_RHS_HINT_STACK_ID, ordered);
  });
}

function flushPresenterLhsMeters() {
  const semantic = lastDeliverySnapshot?.semantic;
  const tempoRaw = lastDeliverySnapshot?.tempo;
  const language = lastDeliverySnapshot?.language;
  const facial = lastFacialLhs;
  let tempo = tempoRaw;
  if (tempoRaw && tempoRaw.wpm != null && tempoRaw.wpm !== '') {
    tempo = {
      ...tempoRaw,
      label: `${tempoRaw.label} (${tempoRaw.wpm} wpm)`,
    };
  }
  const payload = {
    semantic: semantic || { score: 52, label: 'Semantics — speak to score clarity' },
    tempo: tempo || { score: 52, label: 'Tempo — scored from words vs clip length' },
    language: language || { score: 86, label: 'Words — calm, professional language' },
    facial,
  };
  runOnInsightTargetTab((tab) => {
    const tabId = tab?.id;
    const tabUrl = tab?.url || '';
    if (!Number.isInteger(tabId)) return;
    if (
      tabUrl.startsWith('chrome://') ||
      tabUrl.startsWith('chrome-extension://') ||
      tabUrl.startsWith('edge://') ||
      tabUrl.startsWith('about:')
    ) {
      return;
    }
    const ids = {
      semFill: LHS_SEMANTIC_FILL_ID,
      semCap: LHS_SEMANTIC_CAP_ID,
      tempoFill: LHS_TEMPO_FILL_ID,
      tempoCap: LHS_TEMPO_CAP_ID,
      langFill: LHS_LANGUAGE_FILL_ID,
      langCap: LHS_LANGUAGE_CAP_ID,
      faceFill: LHS_EXPRESSION_FILL_ID,
      faceCap: LHS_EXPRESSION_CAP_ID,
    };
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: (pack, idMap) => {
          const paint = (fillId, capId, row) => {
            const pct = Math.max(0, Math.min(100, Number(row?.score) || 0));
            const fill = document.getElementById(fillId);
            const cap = document.getElementById(capId);
            if (fill) {
              fill.style.width = `${pct}%`;
              fill.style.background = pct >= 68 ? '#2e7d32' : pct >= 42 ? '#ef6c00' : '#c62828';
            }
            if (cap) cap.textContent = String(row?.label || '').trim();
          };
          paint(idMap.semFill, idMap.semCap, pack.semantic);
          paint(idMap.tempoFill, idMap.tempoCap, pack.tempo);
          paint(idMap.langFill, idMap.langCap, pack.language);
          paint(idMap.faceFill, idMap.faceCap, pack.facial);
        },
        args: [payload, ids],
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
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
        if (!el) return;
        const text = String(next || '').trim();
        if (!text) {
          el.textContent = '';
          return;
        }
        if (text.includes('\n') || text.includes('•')) {
          const bullets = text
            .split(/\n+/)
            .map((line) => line.trim().replace(/^[-•]\s*/, ''))
            .filter(Boolean)
            .slice(0, 3);
          el.replaceChildren();
          bullets.forEach((bullet) => {
            const row = document.createElement('div');
            row.textContent = `• ${bullet}`;
            row.style.marginBottom = '6px';
            el.appendChild(row);
          });
          return;
        }
        el.textContent = text;
      },
      args: [elementId, content],
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function updateOverlayRightPanelInsight(insightText, transcriptChunk = '') {
  scheduleInsightHintAppend(insightText, transcriptChunk);
}

function updateOverlayRightPanelHeard(sentence) {
  const text = String(sentence || '').trim() || 'Listening…';
  lastOverlayHeardSentence = text;
  runOnInsightTargetTab((tab) => {
    injectOverlayTextById(tab?.id, tab?.url || '', OVERLAY_RIGHT_HEARD_ID, text);
  });
}

function openDetachedWindow() {
  const openFallbackWindow = () => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const activeId = tabs?.[0]?.id;
      const query = Number.isInteger(activeId) && activeId > 0
        ? `?mode=window&sourceTabId=${activeId}`
        : '?mode=window';
      chrome.windows.create(
        {
          url: chrome.runtime.getURL(`dist/popup.html${query}`),
          type: 'popup',
          width: 380,
          height: 720,
          focused: true,
        },
        () => window.close()
      );
    });
  };

  if (chrome.sidePanel?.setOptions && chrome.sidePanel?.open) {
    chrome.sidePanel.setOptions(
      { path: 'dist/popup.html', enabled: true },
      () => {
        if (chrome.runtime.lastError) {
          log(`Side panel setup failed: ${chrome.runtime.lastError.message}`, 'log-error');
          openFallbackWindow();
          return;
        }
        chrome.windows.getCurrent((win) => {
          const windowId = win?.id;
          if (!Number.isInteger(windowId)) {
            openFallbackWindow();
            return;
          }
          const maybePromise = chrome.sidePanel.open({ windowId });
          if (maybePromise?.then) {
            maybePromise
              .then(() => window.close())
              .catch((err) => {
                log(`Side panel open failed: ${err?.message || err}`, 'log-error');
                openFallbackWindow();
              });
          } else {
            window.close();
          }
        });
      }
    );
    return;
  }

  openFallbackWindow();
}

function closeSidePanel() {
  const now = Date.now();
  if (panelCloseInFlight || now - lastPanelCloseAt < 450) return;
  panelCloseInFlight = true;
  lastPanelCloseAt = now;
  const release = () => {
    panelCloseInFlight = false;
  };
  const sendClose = (windowId) =>
    chrome.runtime.sendMessage({ type: 'close_side_panel', windowId }, () => {
      release();
      window.close();
    });
  if (chrome.windows?.getCurrent) {
    chrome.windows.getCurrent((win) => {
      if (chrome.runtime.lastError) {
        release();
        return;
      }
      sendClose(win?.id);
    });
    return;
  }
  sendClose();
}

function markSidePanelOpen() {
  if (isDetachedWindow) return;
  const sendOpen = (windowId) => chrome.runtime.sendMessage({ type: 'panel_opened', windowId }, () => {});
  if (chrome.windows?.getCurrent) {
    chrome.windows.getCurrent((win) => sendOpen(win?.id));
    return;
  }
  sendOpen();
}

function releaseOverlayToggleLock() {
  overlayToggleInFlight = false;
}

function setOverlayButtonStatus(text, restoreAfterMs = 0) {
  if (!overlayToggleBtn) return;
  const original = overlayToggleBtn.dataset.defaultText || overlayToggleBtn.textContent || 'Show Overlay';
  overlayToggleBtn.dataset.defaultText = original;
  overlayToggleBtn.textContent = text;
  if (restoreAfterMs > 0) {
    window.setTimeout(() => {
      overlayToggleBtn.textContent = overlayToggleBtn.dataset.defaultText || 'Show Overlay';
    }, restoreAfterMs);
  }
}

function toggleOverlay() {
  if (overlayToggleInFlight) return;
  overlayToggleInFlight = true;
  setOverlayButtonStatus('Checking tab…');
  const withTargetTab = (activeTab) => {
    const tabId = activeTab?.id;
    const capturedTabId = tabId;
    if (!Number.isInteger(tabId)) {
      log('No active tab found for overlay preview.', 'log-error');
      setOverlayButtonStatus('No tab found', 1800);
      releaseOverlayToggleLock();
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
      setOverlayButtonStatus('Use website tab', 2200);
      releaseOverlayToggleLock();
      return;
    }
    setOverlayButtonStatus('Showing…');

    const runOverlayInject = (panelInitiallyOpen) => {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          func: (overlayTextRight, rightTextId, heardTextId, heardInitial, lhs, rhsHintStackId, panelInitiallyOpen) => {
          const OVERLAY_ID = 'obli-overlay';
          const existing = document.getElementById(OVERLAY_ID);
          if (existing) {
            existing.__obliCleanup?.();
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

          const gridShell = document.createElement('div');
          Object.assign(gridShell.style, {
            flex: '1',
            minHeight: '0',
            height: '100%',
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
            transition: 'opacity 160ms ease, color 160ms ease, transform 160ms ease',
          };

          const labelStyle = {
            color: 'rgba(255, 255, 255, 0.72)',
            fontFamily: 'Arial, sans-serif',
            fontSize: '10px',
            fontWeight: '700',
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
          };

          const leftColumn = document.createElement('div');
          Object.assign(leftColumn.style, {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            justifyContent: 'center',
            gap: '10px',
            maxWidth: '100%',
            width: '100%',
            padding: '12px',
            boxSizing: 'border-box',
          });

          const lhsHeading = document.createElement('div');
          lhsHeading.textContent = 'Live delivery cues';
          Object.assign(lhsHeading.style, labelStyle);

          const capStyle = {
            fontFamily: 'Arial, sans-serif',
            fontSize: 'clamp(10px, 0.9vw, 13px)',
            color: 'rgba(255, 255, 255, 0.9)',
            lineHeight: '1.38',
            fontWeight: '600',
            marginTop: '5px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            transition: 'color 480ms ease, opacity 480ms ease',
          };

          const makeBarBlock = (titleText, fillId, capId) => {
            const wrap = document.createElement('div');
            const titleEl = document.createElement('div');
            titleEl.textContent = titleText;
            Object.assign(titleEl.style, labelStyle);

            const track = document.createElement('div');
            Object.assign(track.style, {
              height: '9px',
              borderRadius: '6px',
              background: 'rgba(255, 255, 255, 0.07)',
              overflow: 'hidden',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              marginTop: '4px',
            });
            const fill = document.createElement('div');
            fill.id = fillId;
            Object.assign(fill.style, {
              height: '100%',
              width: '45%',
              borderRadius: '4px',
              transition: 'width 680ms ease, background 420ms ease',
              background: '#ef6c00',
            });

            track.appendChild(fill);

            const cap = document.createElement('div');
            cap.id = capId;
            Object.assign(cap.style, capStyle);

            wrap.appendChild(titleEl);
            wrap.appendChild(track);
            wrap.appendChild(cap);
            return wrap;
          };

          const semBlock = makeBarBlock('Semantics', lhs.semFill, lhs.semCap);
          const tempoBlock = makeBarBlock('Tempo', lhs.tempoFill, lhs.tempoCap);
          const exprBlock = makeBarBlock('Expression', lhs.faceFill, lhs.faceCap);
          const wordingBlock = makeBarBlock('Wording', lhs.langFill, lhs.langCap);

          const lhsCard = document.createElement('div');
          Object.assign(lhsCard.style, {
            ...textBaseStyle,
            padding: '12px 14px',
            textAlign: 'left',
          });
          lhsCard.appendChild(lhsHeading);
          lhsCard.appendChild(semBlock);
          lhsCard.appendChild(tempoBlock);
          lhsCard.appendChild(exprBlock);
          lhsCard.appendChild(wordingBlock);

          const hintSection = document.createElement('div');
          Object.assign(hintSection.style, {
            ...textBaseStyle,
            padding: '10px 12px',
            textAlign: 'left',
            maxWidth: '100%',
          });
          const hintHeading = document.createElement('div');
          hintHeading.textContent = 'Live hints';
          Object.assign(hintHeading.style, labelStyle);
          const hintStack = document.createElement('div');
          hintStack.id = rhsHintStackId;
          Object.assign(hintStack.style, {
            maxHeight: '26vh',
            overflowY: 'auto',
            marginTop: '6px',
            fontSize: 'clamp(11px, 1vw, 14px)',
            fontWeight: '600',
            lineHeight: '1.42',
          });
          hintSection.appendChild(hintHeading);
          hintSection.appendChild(hintStack);

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
            fontSize: 'clamp(12px, 1.1vw, 18px)',
            fontWeight: '700',
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
          Object.assign(rightTextBox.style, textBaseStyle, {
            maxWidth: '100%',
            fontSize: 'clamp(14px, 1.35vw, 24px)',
            lineHeight: '1.42',
            fontWeight: '600',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            hyphens: 'auto',
            textAlign: 'left',
          });
          rightTextBox.textContent = overlayTextRight ? String(overlayTextRight).trim() : '';

          leftColumn.appendChild(lhsCard);

          rightColumn.appendChild(heardLine);
          rightColumn.appendChild(hintSection);
          rightColumn.appendChild(rightTextBox);

          leftPanel.appendChild(leftColumn);
          rightPanel.appendChild(rightColumn);
          gridShell.appendChild(leftPanel);
          gridShell.appendChild(centerPanel);
          gridShell.appendChild(rightPanel);
          overlay.appendChild(gridShell);

          const overlayActions = document.createElement('div');
          const overlayActionInset = 'clamp(10px, 2.5vw, 18px)';
          Object.assign(overlayActions.style, {
            position: 'fixed',
            left: overlayActionInset,
            right: overlayActionInset,
            bottom: overlayActionInset,
            zIndex: '2147483647',
            pointerEvents: 'auto',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 'clamp(6px, 1.6vw, 8px)',
            maxWidth: 'none',
            boxSizing: 'border-box',
          });

          const overlayActionStyle = {
            appearance: 'none',
            border: '1px solid #009EC8',
            borderRadius: '8px',
            background: '#ffffff',
            color: '#545454',
            fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            flex: '0 1 auto',
            minWidth: '0',
            maxWidth: '168px',
            minHeight: 'clamp(34px, 5vw, 40px)',
            fontSize: 'clamp(11px, 1.8vw, 12px)',
            fontWeight: '650',
            lineHeight: '1.1',
            letterSpacing: '0',
            padding: 'clamp(8px, 1.8vw, 11px) clamp(10px, 2.2vw, 15px)',
            boxShadow: '0 1px 2px rgba(0, 51, 64, 0.08)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textAlign: 'center',
            touchAction: 'manipulation',
            transition: 'background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease, transform 100ms ease',
          };

          let panelOpen = Boolean(panelInitiallyOpen);
          const panelButton = document.createElement('button');
          panelButton.type = 'button';
          panelButton.textContent = panelOpen ? 'Close Panel' : 'Open Panel';
          Object.assign(panelButton.style, overlayActionStyle, {
            background: '#ffffff',
            color: '#545454',
            border: '1px solid #009EC8',
          });
          const setOverlayButtonHover = (button, hovered) => {
            button.style.background = hovered ? '#e5f8fc' : '#ffffff';
            button.style.borderColor = '#009EC8';
            button.style.boxShadow = hovered ? '0 2px 6px rgba(0, 158, 200, 0.16)' : '0 1px 2px rgba(0, 51, 64, 0.08)';
          };
          [panelButton].forEach((button) => {
            button.addEventListener('mouseenter', () => setOverlayButtonHover(button, true));
            button.addEventListener('mouseleave', () => setOverlayButtonHover(button, false));
            button.addEventListener('focus', () => {
              button.style.outline = '2px solid #009EC8';
              button.style.outlineOffset = '2px';
            });
            button.addEventListener('blur', () => {
              button.style.outline = 'none';
            });
            button.addEventListener('mousedown', () => {
              button.style.transform = 'translateY(1px)';
            });
            button.addEventListener('mouseup', () => {
              button.style.transform = 'translateY(0)';
            });
          });
          panelButton.addEventListener('click', () => {
            const messageType = panelOpen ? 'close_side_panel' : 'open_side_panel';
            const fallbackText = panelOpen ? 'Close Panel' : 'Open Panel';
            panelButton.textContent = panelOpen ? 'Closing...' : 'Opening...';
            chrome.runtime.sendMessage({ type: messageType }, (response) => {
              if (chrome.runtime.lastError || !response?.ok) {
                panelButton.textContent = panelOpen ? 'Still Open' : 'Click Extension Icon';
                window.setTimeout(() => {
                  panelButton.textContent = fallbackText;
                }, 1800);
                return;
              }
              panelOpen = !panelOpen;
              panelButton.textContent = panelOpen ? 'Close Panel' : 'Open Panel';
            });
          });

          const closeOverlayButton = document.createElement('button');
          closeOverlayButton.type = 'button';
          closeOverlayButton.textContent = 'Close Overlay';
          Object.assign(closeOverlayButton.style, overlayActionStyle, {
            background: '#009EC8',
            color: '#ffffff',
            border: '1px solid #009EC8',
          });
          const setCloseOverlayHover = (hovered) => {
            closeOverlayButton.style.background = hovered ? '#0089ad' : '#009EC8';
            closeOverlayButton.style.borderColor = hovered ? '#0089ad' : '#009EC8';
            closeOverlayButton.style.boxShadow = hovered ? '0 2px 6px rgba(0, 158, 200, 0.2)' : '0 1px 2px rgba(0, 51, 64, 0.08)';
          };
          closeOverlayButton.addEventListener('mouseenter', () => setCloseOverlayHover(true));
          closeOverlayButton.addEventListener('mouseleave', () => setCloseOverlayHover(false));
          closeOverlayButton.addEventListener('focus', () => {
            closeOverlayButton.style.outline = '2px solid #009EC8';
            closeOverlayButton.style.outlineOffset = '2px';
          });
          closeOverlayButton.addEventListener('blur', () => {
            closeOverlayButton.style.outline = 'none';
          });
          closeOverlayButton.addEventListener('mousedown', () => {
            closeOverlayButton.style.transform = 'translateY(1px)';
          });
          closeOverlayButton.addEventListener('mouseup', () => {
            closeOverlayButton.style.transform = 'translateY(0)';
          });
          closeOverlayButton.addEventListener('click', () => {
            overlay.__obliCleanup?.();
            document.getElementById(OVERLAY_ID)?.remove();
          });

          overlayActions.appendChild(panelButton);
          overlayActions.appendChild(closeOverlayButton);
          overlay.appendChild(overlayActions);

          const overlayButtons = [panelButton, closeOverlayButton];
          const applyOverlayActionLayout = () => {
            const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
            const stacked = viewportWidth < 390;
            const compact = viewportWidth < 560;
            Object.assign(overlayActions.style, {
              flexDirection: stacked ? 'column' : 'row',
              alignItems: stacked ? 'stretch' : 'center',
              justifyContent: stacked ? 'stretch' : 'flex-end',
            });
            overlayButtons.forEach((button) => {
              Object.assign(button.style, {
                flex: stacked ? '1 1 auto' : compact ? '1 1 0' : '0 1 auto',
                width: stacked ? '100%' : 'auto',
                maxWidth: stacked ? '100%' : compact ? 'calc((100vw - 34px) / 2)' : '168px',
                whiteSpace: stacked ? 'normal' : 'nowrap',
              });
            });
          };
          applyOverlayActionLayout();
          window.addEventListener('resize', applyOverlayActionLayout, { passive: true });
          overlay.__obliCleanup = () => {
            window.removeEventListener('resize', applyOverlayActionLayout);
          };

          document.body.appendChild(overlay);
          return { state: 'added' };
        },
        args: [
          '',
          OVERLAY_RIGHT_TEXT_ID,
          OVERLAY_RIGHT_HEARD_ID,
          lastOverlayHeardSentence,
          {
            semFill: LHS_SEMANTIC_FILL_ID,
            semCap: LHS_SEMANTIC_CAP_ID,
            tempoFill: LHS_TEMPO_FILL_ID,
            tempoCap: LHS_TEMPO_CAP_ID,
            faceFill: LHS_EXPRESSION_FILL_ID,
            faceCap: LHS_EXPRESSION_CAP_ID,
            langFill: LHS_LANGUAGE_FILL_ID,
            langCap: LHS_LANGUAGE_CAP_ID,
          },
          OVERLAY_RHS_HINT_STACK_ID,
          Boolean(panelInitiallyOpen),
        ],
      },
      (results) => {
        try {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || 'Unknown script injection error.';
            if (tabUrl.startsWith('file://')) {
              log(
                `Overlay inject failed: ${msg} Enable "Allow access to file URLs" in chrome://extensions for this extension, or test on a regular website.`,
                'log-error'
              );
              setOverlayButtonStatus('Allow file URLs', 2400);
              return;
            }
            log(
              `Overlay inject failed: ${msg} Try a regular website (https://...) instead of a restricted page.`,
              'log-error'
            );
            setOverlayButtonStatus('Access blocked', 2200);
            return;
          }
          const state = results?.[0]?.result?.state;
          if (state === 'added') {
            overlayInsightTabId = capturedTabId;
            log('Transparent overlay preview shown on active tab.', 'log-screen');
            setOverlayButtonStatus('Hide Overlay');
            flushPresenterLhsMeters();
            renderOverlayHintFeed();
          } else if (state === 'removed') {
            overlayInsightTabId = null;
            stopHintFeedTicker();
            log('Transparent overlay preview removed.', 'log-screen');
            setOverlayButtonStatus('Show Overlay');
          } else {
            setOverlayButtonStatus('Try again', 1600);
          }
        } finally {
          releaseOverlayToggleLock();
        }
      }
    );
    };

    const overlayWindowId = activeTab?.windowId;
    if (!Number.isInteger(overlayWindowId)) {
      runOverlayInject(false);
      return;
    }
    chrome.runtime.sendMessage({ type: 'get_panel_state', windowId: overlayWindowId }, (panelState) => {
      if (chrome.runtime.lastError) {
        runOverlayInject(false);
        return;
      }
      runOverlayInject(panelState?.panelOpen === true);
    });
  };

  // In detached mode, target the original tab that launched this window.
  if (isDetachedWindow && Number.isInteger(sourceTabId) && sourceTabId > 0) {
    chrome.tabs.get(sourceTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        log(
          'Could not find the original source tab. Re-open detached window from the tab you want to preview.',
          'log-error'
        );
        setOverlayButtonStatus('Reopen panel', 2200);
        releaseOverlayToggleLock();
        return;
      }
      withTargetTab(tab);
    });
    return;
  }

  chrome.runtime.sendMessage({ type: 'get_capture_target' }, (response) => {
    const targetTabId = response?.tabId;
    if (chrome.runtime.lastError || !Number.isInteger(targetTabId)) {
      if (response?.error) log(response.error, 'log-error');
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        withTargetTab(tabs?.[0]);
      });
      return;
    }

    chrome.tabs.get(targetTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
          withTargetTab(tabs?.[0]);
        });
        return;
      }
      withTargetTab(tab);
    });
  });
}

if (isDetachedWindow && popoutBtn) {
  popoutBtn.textContent = 'Detached Window Open';
  popoutBtn.disabled = true;
} else if (popoutBtn) {
  popoutBtn.textContent = 'Close Panel';
  markSidePanelOpen();
}

if (!startBtn || !stopBtn || !preview || !placeholder || !barTab || !barMic || !barSys) {
  console.error('[Oblique] Popup controls did not render before popup.js loaded.');
} else {
  startBtn.addEventListener('click', startCapture);
  stopBtn.addEventListener('click', stopCapture);
  popoutBtn?.addEventListener('click', isDetachedWindow ? openDetachedWindow : closeSidePanel);
  overlayToggleBtn?.addEventListener('click', toggleOverlay);
}
