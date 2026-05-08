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
    emitEvent('media_chunk', { label, size: ev.data.size, mimeType: rec.mimeType });
    log(`Chunk [${label}] ${ev.data.size} bytes`, 'log-audio');
  };
  rec.start(1000);
  recorders.push(rec);
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

async function startCapture() {
  try {
    // 1. Screen (video + system audio if the OS/browser allows it)
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

    // 2. Tab audio via chrome.tabCapture
    log('Requesting tab audio…', 'log-audio');
    tabStream = await new Promise((res, rej) =>
      chrome.tabCapture.capture({ audio: true, video: false }, (s) =>
        chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res(s)
      )
    );
    emitEvent('capture_start', { source: 'tab_audio' });

    // 3. Microphone
    log('Requesting microphone…', 'log-audio');
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    emitEvent('capture_start', { source: 'microphone' });

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
    log('Error: ' + (err.message || err), 'log-error');
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
