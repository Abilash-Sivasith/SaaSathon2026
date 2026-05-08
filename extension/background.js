// Background service worker — receives real-time capture events.

let ingestCount = 0;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
