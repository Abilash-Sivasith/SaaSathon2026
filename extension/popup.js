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
const urlParams = new URLSearchParams(window.location.search);
const isDetachedWindow = urlParams.get('mode') === 'window';
const sourceTabId = Number(urlParams.get('sourceTabId'));

let screenStream  = null; // getDisplayMedia (video + optional system audio)
let tabStream     = null; // chrome.tabCapture  (tab audio)
let micStream     = null; // getUserMedia        (microphone)

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

const transcribeQueues = {};
const transcribeInFlight = {};
const transcribeSeq = {};
const transcribeBuffers = {};
const transcribeTimers = {};
const lastRmsByLabel = { tab: 0, mic: 0, system_audio: 0 };
let transcribeConfig = {
  endpoint: '',
  apiKey: '',
  enabled: true,
};

const TRANSCRIBE_MIN_BYTES = 64000;
const TRANSCRIBE_MAX_INTERVAL_MS = 8000;
const TRANSCRIBE_MIN_RMS = 0.002;
const TRANSCRIBE_PCM_INTERVAL_MS = 5000;
let micTranscribeCtx = null;
let micTranscribeProcessor = null;
let micTranscribeSource = null;
let micTranscribeTimer = null;
let micPcmBuffer = [];
let micPcmSampleRate = 48000;


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

function ensureQueue(label) {
  if (!transcribeQueues[label]) transcribeQueues[label] = [];
  if (!transcribeSeq[label]) transcribeSeq[label] = 0;
  if (!transcribeInFlight[label]) transcribeInFlight[label] = false;
  if (!transcribeBuffers[label]) transcribeBuffers[label] = [];
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

  if (totalBytes >= TRANSCRIBE_MIN_BYTES) {
    flushTranscriptionBuffer(label, mimeType);
    return;
  }

  if (!transcribeTimers[label]) {
    transcribeTimers[label] = setTimeout(() => {
      transcribeTimers[label] = null;
      flushTranscriptionBuffer(label, mimeType);
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

function flushMicPcm(label) {
  if (!micPcmBuffer.length) return;
  const mergedLen = micPcmBuffer.reduce((sum, b) => sum + b.length, 0);
  const merged = new Float32Array(mergedLen);
  let offset = 0;
  micPcmBuffer.forEach((b) => {
    merged.set(b, offset);
    offset += b.length;
  });
  micPcmBuffer = [];

  const rms = lastRmsByLabel[label] ?? 0;
  if (rms < TRANSCRIBE_MIN_RMS) {
    return;
  }

  const downsampled = downsampleBuffer(merged, micPcmSampleRate, 16000);
  const wavBlob = encodeWav(downsampled, 16000);
  enqueueTranscriptionChunk(label, wavBlob, 'audio/wav');
}

function startMicTranscription(stream) {
  if (micTranscribeCtx) return;
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
  flushMicPcm('mic');
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

function flushTranscriptionBuffer(label, mimeType) {
  ensureQueue(label);
  const parts = transcribeBuffers[label];
  if (!parts || parts.length === 0) return;

  const combined = new Blob(parts, { type: mimeType || parts[0]?.type || 'audio/webm' });
  transcribeBuffers[label] = [];

  if (combined.size < TRANSCRIBE_MIN_BYTES) {
    return;
  }

  const rms = lastRmsByLabel[label] ?? 0;
  if (rms < TRANSCRIBE_MIN_RMS) {
    return;
  }

  transcribeSeq[label] += 1;
  transcribeQueues[label].push({
    seq: transcribeSeq[label],
    blob: combined,
    mimeType: combined.type || 'audio/webm',
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
      appendTranscriptLine(label, data.text || '', data.isFinal ? 'final' : 'partial');
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

  if (step === 'tab_audio') {
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

  [screenStream, tabStream, micStream].forEach(s => s?.getTracks().forEach(t => t.stop()));
  screenStream = tabStream = micStream = null;
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
  let currentStep = 'initialization';
  try {
    const micPermissionState = await getMicPermissionState();
    if (micPermissionState === 'denied') {
      log(
        'Microphone is currently blocked for this extension (no prompt will appear). ' +
        'Open Chrome site settings for this extension and allow Microphone, then retry.',
        'log-error'
      );
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

    startBtn.disabled = true;
    stopBtn.disabled  = false;
    log('All sources active.', 'log-audio');
  } catch (err) {
    console.error(err);
    cleanupPartialCapture();
    log('Error: ' + normalizeCaptureError(err, currentStep), 'log-error');
  }
}

async function stopCapture() {
  try {
    const activeRecorders = [...recorders];
    activeRecorders.forEach(({ rec }) => rec.state !== 'inactive' && rec.stop());
    await Promise.allSettled(activeRecorders.map(({ stopped }) => stopped));
    recorders = [];

    Object.keys(transcribeBuffers).forEach((label) => {
      flushTranscriptionBuffer(label);
    });

    finalizeRecordings();
  } catch (err) {
    console.error(err);
    log(`Stop encountered an issue: ${err?.message || err}`, 'log-error');
  } finally {
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

    [screenStream, tabStream, micStream].forEach(s => s?.getTracks().forEach(t => t.stop()));
    screenStream = tabStream = micStream = null;
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

function openDetachedWindow() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
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
        func: (overlayTextLeft, overlayTextRight) => {
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
            display: 'grid',
            gridTemplateColumns: '20vw 1fr 20vw',
            pointerEvents: 'none',
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
          leftTextBox.textContent = overlayTextLeft;
          Object.assign(leftTextBox.style, textBaseStyle);

          const rightTextBox = document.createElement('div');
          rightTextBox.textContent = overlayTextRight;
          Object.assign(rightTextBox.style, textBaseStyle);

          leftPanel.appendChild(leftTextBox);
          rightPanel.appendChild(rightTextBox);
          overlay.appendChild(leftPanel);
          overlay.appendChild(centerPanel);
          overlay.appendChild(rightPanel);
          document.body.appendChild(overlay);
          return { state: 'added' };
        },
        args: ['Add some text here', 'Add some text here'],
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
          log('Transparent overlay preview shown on active tab.', 'log-screen');
        } else if (state === 'removed') {
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

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
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