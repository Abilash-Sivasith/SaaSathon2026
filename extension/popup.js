const startBtn  = document.getElementById('start');
const stopBtn   = document.getElementById('stop');
const logEl     = document.getElementById('log');
const preview   = document.getElementById('screen-preview');
const placeholder = document.getElementById('preview-placeholder');
const barTab    = document.getElementById('bar-tab');
const barMic    = document.getElementById('bar-mic');
const barSys    = document.getElementById('bar-sys');
const recordingsEl = document.getElementById('recordings');
const recordingsEmptyEl = document.getElementById('recordings-empty');

let screenStream  = null; // getDisplayMedia (video + optional system audio)
let tabStream     = null; // chrome.tabCapture  (tab audio)
let micStream     = null; // getUserMedia        (microphone)

let audioCtx      = null;
let rafId         = null;
let frameInterval = null;
let recorders     = [];   // one MediaRecorder per stream
let eventSeq      = 0;
let lastLevelLogTs = 0;
let chunkStore     = {};
let objectUrls     = [];
let tabMonitorNodes = null;

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

async function blobPrefixB64(blob, bytes = 120) {
  const slice = blob.slice(0, bytes);
  const buf = await slice.arrayBuffer();
  const arr = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function resetSessionBuffers() {
  chunkStore = {
    tab: { chunks: [], mimeType: '' },
    mic: { chunks: [], mimeType: '' },
    system_audio: { chunks: [], mimeType: '' },
  };
}

function clearObjectUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

function clearRecordingsUI() {
  recordingsEl.querySelectorAll('.rec-card').forEach((n) => n.remove());
  recordingsEmptyEl.style.display = '';
}

function saveBlobLocally(blobUrl, fileName) {
  if (chrome.downloads && chrome.downloads.download) {
    chrome.downloads.download({
      url: blobUrl,
      filename: fileName,
      saveAs: true,
    }, () => {
      if (chrome.runtime.lastError) {
        log(`Save failed: ${chrome.runtime.lastError.message}`, 'log-error');
      } else {
        log(`Saved: ${fileName}`, 'log-audio');
      }
    });
    return;
  }

  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fileName;
  a.click();
}

function renderRecordingCard(label, blob, mimeType) {
  recordingsEmptyEl.style.display = 'none';

  const blobUrl = URL.createObjectURL(blob);
  objectUrls.push(blobUrl);

  const card = document.createElement('div');
  card.className = 'rec-card';

  const head = document.createElement('div');
  head.className = 'rec-head';

  const source = document.createElement('span');
  source.textContent = `Source: ${label}`;

  const actions = document.createElement('div');
  actions.className = 'rec-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'rec-btn';
  saveBtn.textContent = 'Save';
  const fileName = `obli-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
  saveBtn.addEventListener('click', () => saveBlobLocally(blobUrl, fileName));
  actions.appendChild(saveBtn);

  head.appendChild(source);
  head.appendChild(actions);

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = blobUrl;
  audio.style.width = '100%';

  const meta = document.createElement('div');
  meta.className = 'rec-meta';
  meta.textContent = `${mimeType || 'audio/webm'} • ${formatBytes(blob.size)}`;

  card.appendChild(head);
  card.appendChild(audio);
  card.appendChild(meta);
  recordingsEl.prepend(card);

  emitEvent('recording_ready', {
    label,
    size: blob.size,
    mimeType: mimeType || blob.type || 'audio/webm',
    fileName,
  });
  log(`Recording ready [${label}] ${formatBytes(blob.size)}`, 'log-audio');
}

function finalizeRecordings() {
  ['tab', 'mic', 'system_audio'].forEach((label) => {
    const item = chunkStore[label];
    if (!item || item.chunks.length === 0) return;
    const blob = new Blob(item.chunks, { type: item.mimeType || 'audio/webm' });
    renderRecordingCard(label, blob, item.mimeType);
  });
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
    const b64prefix = await blobPrefixB64(ev.data, 120);

    if (!chunkStore[label]) {
      chunkStore[label] = { chunks: [], mimeType: rec.mimeType || ev.data.type || 'audio/webm' };
    }
    if (!chunkStore[label].mimeType) {
      chunkStore[label].mimeType = rec.mimeType || ev.data.type || 'audio/webm';
    }
    chunkStore[label].chunks.push(ev.data);

    emitEvent('media_chunk', {
      label,
      size: ev.data.size,
      mimeType: rec.mimeType,
      b64prefix,
    });
    log(`Chunk [${label}] ${ev.data.size} bytes, b64prefix=${b64prefix.slice(0, 20)}...`, 'log-audio');
  };
  rec.onstop = () => resolveStopped();
  rec.start(1000);
  recorders.push({ label, rec, stopped });
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

async function startCapture() {
  let stage = 'initialization';
  try {
    clearObjectUrls();
    clearRecordingsUI();
    resetSessionBuffers();

    // 1. Tab audio via chrome.tabCapture
    stage = 'tab audio permission';
    log('Requesting tab audio…', 'log-audio');
    tabStream = await new Promise((res, rej) =>
      chrome.tabCapture.capture({ audio: true, video: false }, (s) =>
        chrome.runtime.lastError
          ? rej(new Error(chrome.runtime.lastError.message))
          : s
            ? res(s)
            : rej(new Error('Tab audio capture returned no stream.'))
      )
    );
    emitEvent('capture_start', { source: 'tab_audio' });

    // 2. Screen (video + system audio if the OS/browser allows it)
    stage = 'screen permission';
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

    // 3. Microphone (optional)
    stage = 'microphone permission';
    log('Requesting microphone…', 'log-audio');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });

      if (!micStream.getAudioTracks().length) {
        throw new Error('No microphone track was returned by the browser.');
      }
      emitEvent('capture_start', { source: 'microphone' });
    } catch (micErr) {
      // Some devices reject strict constraints; retry with plain audio.
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        emitEvent('capture_start', { source: 'microphone', fallback: true });
        log('Microphone fallback capture enabled.', 'log-audio');
      } catch {
        micStream = null;
        log(
          `Microphone unavailable: ${micErr.message || micErr}. Continuing with tab/screen only.`,
          'log-error'
        );
      }
    }

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
    log(`Error during ${stage}: ${err.message || err}`, 'log-error');

    [screenStream, tabStream, micStream].forEach(s => s?.getTracks().forEach(t => t.stop()));
    screenStream = tabStream = micStream = null;
    preview.srcObject = null;
    placeholder.style.display = '';
    startBtn.disabled = false;
    stopBtn.disabled  = true;
  }
}

async function stopCapture() {
  const activeRecorders = [...recorders];
  activeRecorders.forEach(({ rec }) => rec.state !== 'inactive' && rec.stop());
  await Promise.allSettled(activeRecorders.map(({ stopped }) => stopped));
  recorders = [];

  finalizeRecordings();

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

  preview.srcObject = null;
  placeholder.style.display = '';
  barTab.style.width = barMic.style.width = barSys.style.width = '0%';

  startBtn.disabled = false;
  stopBtn.disabled  = true;
  emitEvent('capture_stop', {});
  log('Capture stopped.', 'log-audio');
}

  startBtn.addEventListener('click', () => {
    startCapture();
  });
  stopBtn.addEventListener('click', () => {
    stopCapture();
  });
