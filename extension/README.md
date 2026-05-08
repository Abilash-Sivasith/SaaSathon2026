Tab + Microphone Audio Logger
=================================

What it does
------------

This Chrome extension captures audio from the active tab and the user's microphone, computes RMS (volume) in real-time and logs it to the console, and records short audio chunks and logs their sizes and a small base64 snippet for inspection.

Install (developer mode)
------------------------

1. Open chrome://extensions
2. Enable "Developer mode"
3. Click "Load unpacked" and pick the `extension/` folder from this project

Notes and limitations
---------------------
- The extension uses the `chrome.tabCapture` API which requires the extension to be active on the tab you want to capture. You may need to click the extension action while on the tab.
- Browsers may block microphone access; you'll be prompted and must allow it.
- Media formats depend on the browser; recorded chunks are emitted as Blob objects (webm/ogg). The popup logs only the first 200 bytes of each chunk as base64 to avoid huge console outputs.

Files
-----
- `manifest.json` - MV3 manifest
- `popup.html` / `popup.js` - UI and capture logic
- `background.js` - minimal service worker
