// Background service worker — receives real-time capture events.

let ingestCount = 0;
let lastPanelTarget = null;
const panelOpenWindows = new Set();

function isInjectableTab(tab) {
  const url = tab?.url || '';
  return (
    Number.isInteger(tab?.id) &&
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('edge://') &&
    !url.startsWith('about:')
  );
}

function rememberPanelTarget(tab) {
  if (!isInjectableTab(tab) || !Number.isInteger(tab?.windowId)) return;
  lastPanelTarget = { tabId: tab.id, windowId: tab.windowId, url: tab.url || '' };
}

function getLastPanelTarget(sendResponse) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const activeTab = tabs?.find(isInjectableTab);
    if (activeTab) {
      rememberPanelTarget(activeTab);
      sendResponse({ ok: true, tabId: activeTab.id, windowId: activeTab.windowId, url: activeTab.url || '' });
      return;
    }

    if (Number.isInteger(lastPanelTarget?.tabId)) {
      chrome.tabs.get(lastPanelTarget.tabId, (tab) => {
        if (!chrome.runtime.lastError && isInjectableTab(tab)) {
          rememberPanelTarget(tab);
          sendResponse({ ok: true, tabId: tab.id, windowId: tab.windowId, url: tab.url || '' });
          return;
        }

        sendResponse({ ok: false, error: 'No normal website tab found. Open the page you want, click the extension icon from that page, then try again.' });
      });
      return;
    }

    sendResponse({ ok: false, error: 'No normal website tab found. Open a regular https:// page and click the extension icon from that page.' });
  });
}

function configureSidePanel() {
  if (!chrome.sidePanel) return;

  const optionsResult = chrome.sidePanel.setOptions?.({ path: 'dist/popup.html', enabled: true });
  optionsResult?.catch?.(() => {});
  const behaviorResult = chrome.sidePanel.setPanelBehavior?.({ openPanelOnActionClick: false });
  behaviorResult?.catch?.(() => {});
}

chrome.runtime.onInstalled.addListener(configureSidePanel);
chrome.runtime.onStartup?.addListener(configureSidePanel);

chrome.action.onClicked.addListener((tab) => {
  configureSidePanel();
  rememberPanelTarget(tab);

  if (chrome.sidePanel?.open) {
    const windowId = tab?.windowId;
    const openResult = chrome.sidePanel.open(Number.isInteger(windowId) ? { windowId } : {});
    if (Number.isInteger(windowId)) panelOpenWindows.add(windowId);
    openResult?.catch?.(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get_capture_target') {
    getLastPanelTarget(sendResponse);
    return true;
  }

  if (msg.type === 'open_side_panel') {
    configureSidePanel();
    const windowId = _sender.tab?.windowId || msg.windowId || lastPanelTarget?.windowId;
    rememberPanelTarget(_sender.tab);

    if (!chrome.sidePanel?.open || !Number.isInteger(windowId)) {
      sendResponse({ ok: false, error: 'Side panel is not available for this window.' });
      return false;
    }

    const openResult = chrome.sidePanel.open({ windowId });
    if (openResult?.then) {
      openResult
        .then(() => {
          panelOpenWindows.add(windowId);
          sendResponse({ ok: true, panelOpen: true });
        })
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    panelOpenWindows.add(windowId);
    sendResponse({ ok: true, panelOpen: true });
    return false;
  }

  if (msg.type === 'close_side_panel') {
    const tabId = _sender.tab?.id || msg.tabId || lastPanelTarget?.tabId;
    const windowId = _sender.tab?.windowId || msg.windowId || lastPanelTarget?.windowId;
    const closeOptions = Number.isInteger(tabId)
      ? { tabId, path: 'dist/popup.html', enabled: false }
      : { path: 'dist/popup.html', enabled: false };

    if (!chrome.sidePanel?.setOptions) {
      sendResponse({ ok: false, error: 'Side panel close is not available.' });
      return false;
    }

    chrome.sidePanel.setOptions(closeOptions, () => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (Number.isInteger(windowId)) panelOpenWindows.delete(windowId);
      sendResponse({ ok: true, panelOpen: false });
    });
    return true;
  }

  if (msg.type === 'panel_opened') {
    const windowId = msg.windowId || lastPanelTarget?.windowId;
    if (Number.isInteger(windowId)) panelOpenWindows.add(windowId);
    sendResponse({ ok: true, panelOpen: true });
    return false;
  }

  if (msg.type === 'get_panel_state') {
    const windowId = _sender.tab?.windowId || msg.windowId || lastPanelTarget?.windowId;
    sendResponse({ ok: true, panelOpen: Number.isInteger(windowId) ? panelOpenWindows.has(windowId) : false });
    return false;
  }

  if (msg.type === 'ingest') {
    ingestCount += 1;

    // TODO: relay event to backend when popup sends via chrome.runtime.sendMessage
    // fetch('https://your-backend/ingest', { method: 'POST', body: JSON.stringify(msg.event) })
    //   .then(r => sendResponse({ ok: r.ok }))
    //   .catch(e => sendResponse({ ok: false, error: e.message }));
    console.log(
      `[Background] #${ingestCount} ${msg.event?.type ?? 'unknown'} @ ${new Date().toISOString()}`,
      msg.event
    );
    sendResponse({ ok: true });
    return true; // keep channel open for async response
  }
});

console.log('[Background] service worker ready');
