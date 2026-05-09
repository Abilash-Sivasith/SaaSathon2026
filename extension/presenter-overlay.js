/**
 * Presenter overlay — optional content script parity with extension/popup.js `toggleOverlay`.
 * Element IDs MUST match popup.js (LHS meter IDs + RHS hint stack) so injection stays aligned.
 */
const OB_OVERLAY_ID = 'obli-overlay';
const OB_LHS_SEMANTIC_FILL_ID = 'obli-overlay-lhs-semantic-fill';
const OB_LHS_SEMANTIC_CAP_ID = 'obli-overlay-lhs-semantic-cap';
const OB_LHS_TEMPO_FILL_ID = 'obli-overlay-lhs-tempo-fill';
const OB_LHS_TEMPO_CAP_ID = 'obli-overlay-lhs-tempo-cap';
const OB_LHS_EXPRESSION_FILL_ID = 'obli-overlay-lhs-expression-fill';
const OB_LHS_EXPRESSION_CAP_ID = 'obli-overlay-lhs-expression-cap';
const OB_LHS_LANGUAGE_FILL_ID = 'obli-overlay-lhs-language-fill';
const OB_LHS_LANGUAGE_CAP_ID = 'obli-overlay-lhs-language-cap';
const OB_RIGHT_TEXT_ID = 'obli-overlay-right-text';
const OB_HEARD_TEXT_ID = 'obli-overlay-right-heard';
const OB_RHS_HINT_STACK_ID = 'obli-overlay-rhs-hint-stack';

function obliCanInjectOverlay() {
  const proto = location.protocol;
  return proto === 'http:' || proto === 'https:' || proto === 'file:';
}

function obliBuildPresenterOverlay() {
  const overlayTextRight = '';
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

  const makeBarBlock = (titleText, fillId, capId, captionText) => {
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
    cap.textContent = captionText;

    wrap.appendChild(titleEl);
    wrap.appendChild(track);
    wrap.appendChild(cap);
    return wrap;
  };

  const lhsCard = document.createElement('div');
  Object.assign(lhsCard.style, {
    ...textBaseStyle,
    padding: '12px 14px',
    textAlign: 'left',
  });
  lhsCard.appendChild(lhsHeading);
  lhsCard.appendChild(
    makeBarBlock('Semantics', OB_LHS_SEMANTIC_FILL_ID, OB_LHS_SEMANTIC_CAP_ID, 'Speak to analyze clarity.')
  );
  lhsCard.appendChild(
    makeBarBlock(
      'Tempo',
      OB_LHS_TEMPO_FILL_ID,
      OB_LHS_TEMPO_CAP_ID,
      'Comfortable pacing scores green; rushed or sluggish trends red.'
    )
  );
  lhsCard.appendChild(
    makeBarBlock(
      'Expression',
      OB_LHS_EXPRESSION_FILL_ID,
      OB_LHS_EXPRESSION_CAP_ID,
      'Camera on — facial engagement updates live.'
    )
  );
  lhsCard.appendChild(
    makeBarBlock(
      'Wording',
      OB_LHS_LANGUAGE_FILL_ID,
      OB_LHS_LANGUAGE_CAP_ID,
      'Professional language scores high; flagged words dip the bar.'
    )
  );

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
  hintStack.id = OB_RHS_HINT_STACK_ID;
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
  rightTextBox.textContent = overlayTextRight.trim();
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