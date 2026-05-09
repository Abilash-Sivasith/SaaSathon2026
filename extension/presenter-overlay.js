/**
 * Presenter overlay — present by default on normal pages.
 * Element IDs must stay in sync with extension/popup.js (text + color updates).
 */
const OB_OVERLAY_ID = 'obli-overlay-poc';
const OB_LEFT_TEXT_ID = 'obli-overlay-left-feedback';
const OB_LEFT_DELIVERY_ID = 'obli-overlay-left-delivery';
const OB_LEFT_BRIEF_ID = 'obli-overlay-left-brief';
const OB_RIGHT_TEXT_ID = 'obli-overlay-right-text';
const OB_HEARD_TEXT_ID = 'obli-overlay-right-heard';
const OB_LISTENING_BAR_ID = 'obli-overlay-listening-bar';

function obliCanInjectOverlay() {
  const proto = location.protocol;
  return proto === 'http:' || proto === 'https:' || proto === 'file:';
}

function obliBuildPresenterOverlay() {
  const overlayTextLeft = 'Coach: camera idle. Start when ready.';
  const overlayTextRight =
    'Key details appear once speech is transcribed and the server matches your brief.';
  const overlayBriefInitial = overlayTextRight;
  const overlayDeliveryInitial =
    'Tone: —\nPace: — (smoothed wpm / instant wpm / sec per word / clip length appear after you speak.)';
  const heardInitial = 'Listening…';

  const overlay = document.createElement('div');
  overlay.id = OB_OVERLAY_ID;
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    pointerEvents: 'none',
  });

  const listeningBar = document.createElement('div');
  listeningBar.id = OB_LISTENING_BAR_ID;
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

  const visualLabel = document.createElement('div');
  visualLabel.textContent = 'Visual feedback';
  Object.assign(visualLabel.style, labelStyle);

  const leftTextBox = document.createElement('div');
  leftTextBox.id = OB_LEFT_TEXT_ID;
  leftTextBox.textContent = overlayTextLeft;
  Object.assign(leftTextBox.style, textBaseStyle, {
    fontSize: 'clamp(13px, 1.25vw, 22px)',
    lineHeight: '1.35',
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: '#ffd54f',
  });

  const toneTempoLabel = document.createElement('div');
  toneTempoLabel.textContent = 'Tone & tempo';
  Object.assign(toneTempoLabel.style, labelStyle);

  const leftDeliveryBox = document.createElement('div');
  leftDeliveryBox.id = OB_LEFT_DELIVERY_ID;
  leftDeliveryBox.textContent = overlayDeliveryInitial;
  Object.assign(leftDeliveryBox.style, textBaseStyle, {
    fontSize: 'clamp(11px, 1.05vw, 16px)',
    lineHeight: '1.4',
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: '#c8e6c9',
    fontWeight: '600',
  });

  const briefLabel = document.createElement('div');
  briefLabel.textContent = 'Context matches';
  Object.assign(briefLabel.style, labelStyle);

  const leftBriefBox = document.createElement('div');
  leftBriefBox.id = OB_LEFT_BRIEF_ID;
  leftBriefBox.textContent = overlayBriefInitial;
  Object.assign(leftBriefBox.style, textBaseStyle, {
    fontSize: 'clamp(11px, 1.07vw, 17px)',
    lineHeight: '1.42',
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: '#b3e5fc',
    fontWeight: '600',
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
  heardLine.id = OB_HEARD_TEXT_ID;
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
  rightTextBox.id = OB_RIGHT_TEXT_ID;
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

  leftColumn.appendChild(visualLabel);
  leftColumn.appendChild(leftTextBox);
  leftColumn.appendChild(toneTempoLabel);
  leftColumn.appendChild(leftDeliveryBox);
  leftColumn.appendChild(briefLabel);
  leftColumn.appendChild(leftBriefBox);
  leftPanel.appendChild(leftColumn);
  rightPanel.appendChild(rightColumn);
  gridShell.appendChild(leftPanel);
  gridShell.appendChild(centerPanel);
  gridShell.appendChild(rightPanel);
  overlay.appendChild(listeningBar);
  overlay.appendChild(gridShell);

  return overlay;
}

function obliEnsurePresenterOverlay() {
  if (!obliCanInjectOverlay()) {
    return;
  }
  if (document.getElementById(OB_OVERLAY_ID)) {
    return;
  }
  if (!document.body) {
    return;
  }
  document.body.appendChild(obliBuildPresenterOverlay());
}

let obliPersistenceAttached = false;
function obliAttachPersistenceWatcher() {
  if (obliPersistenceAttached || !obliCanInjectOverlay()) return;
  obliPersistenceAttached = true;

  let debounced;
  const schedule = () => {
    clearTimeout(debounced);
    debounced = window.setTimeout(() => {
      if (!document.getElementById(OB_OVERLAY_ID) && document.body) {
        obliEnsurePresenterOverlay();
      }
    }, 80);
  };

  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

(function obliBootstrap() {
  if (!obliCanInjectOverlay()) {
    return;
  }

  const run = () => {
    obliEnsurePresenterOverlay();
    obliAttachPersistenceWatcher();
  };

  if (document.body) {
    run();
  } else {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  }
})();
