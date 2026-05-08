const startBtn  = document.getElementById('start');
const stopBtn   = document.getElementById('stop');
const logEl     = document.getElementById('log');
const preview   = document.getElementById('screen-preview');
const placeholder = document.getElementById('preview-placeholder');
const barTab    = document.getElementById('bar-tab');
const barMic    = document.getElementById('bar-mic');
const barSys    = document.getElementById('bar-sys');

let screenStream  = null; // getDisplayMedia (video + optional system audio)
let tabStream     = null; // chrome.tabCapture  (tab audio)
let micStream     = null; // getUserMedia        (microphone)

let audioCtx      = null;
let rafId         = null;
let frameInterval = null;
let recorders     = [];   // one MediaRecorder per stream
let packetSeq     = 0;    // monotonic packet id for media chunks

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log('[Logger]', msg);
}

// Structured event ready to POST to a backend later.
function emitEvent(type, payload) {
  const event = { type, ts: Date.now(), ...payload };
  console.log('[Event]', JSON.stringify(event));
  // TODO: send to backend
  // fetch('https://your-backend/ingest', { method:'POST', body: JSON.stringify(event) });
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

  if (step === 'tab_audio') {
    if (name === 'PermissionDeniedError' || name === 'NotAllowedError') {
      return 'Tab audio capture was denied. Keep the target tab active and try Start again.';
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
  rec.ondataavailable = async (ev) => {
    if (!ev.data || ev.data.size === 0) return;
    packetSeq += 1;
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
    log(
      `Packet #${payload.packetId} [${label}] ${payload.size} bytes ` +
      `mime=${payload.mimeType} data=${payload.constructorName}`,
      'log-audio'
    );
  };
  rec.start(1000);
  recorders.push(rec);
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
    tabStream = await new Promise((res, rej) =>
      chrome.tabCapture.capture({ audio: true, video: false }, (s) =>
        chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(s)
      )
    );
    emitEvent('capture_start', { source: 'tab_audio' });

    // 2. Microphone
    currentStep = 'microphone';
    log('Requesting microphone…', 'log-audio');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    emitEvent('capture_start', { source: 'microphone' });

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
    const tabAnalyser = buildMeter(tabStream);
    const micAnalyser = buildMeter(micStream);
    const sysAudioTracks = screenStream.getAudioTracks();
    const sysAnalyser = sysAudioTracks.length
      ? buildMeter(new MediaStream(sysAudioTracks))
      : null;

    function meterLoop() {
      const tabRms = rms(tabAnalyser);
      const micRms = rms(micAnalyser);
      const sysRms = sysAnalyser ? rms(sysAnalyser) : 0;

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
    attachRecorder(micStream,  'mic');
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

function stopCapture() {
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
  emitEvent('capture_stop', {});
  log('Capture stopped.', 'log-audio');
}

startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);
