// Background service worker — message router for future backend integration.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ingest') {
    // TODO: relay event to backend when popup sends via chrome.runtime.sendMessage
    // fetch('https://your-backend/ingest', { method: 'POST', body: JSON.stringify(msg.event) })
    //   .then(r => sendResponse({ ok: r.ok }))
    //   .catch(e => sendResponse({ ok: false, error: e.message }));
    console.log('[Background] event received:', msg.event);
    sendResponse({ ok: true });
    return true; // keep channel open for async response
  }
});

console.log('[Background] service worker ready');
