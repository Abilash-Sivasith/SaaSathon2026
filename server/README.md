# Transcript Server

FastAPI service that receives transcribed strings from the browser extension and logs them to the server console. This is the minimal "stage 1" backend — the endpoint just confirms the wiring works; downstream processing (LLM, persistence, etc.) plugs in later.

## Setup

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
# from inside the server/ directory, with the venv activated
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Or run the file directly:

```bash
python main.py
```

The server listens on `http://localhost:8000`. Interactive docs are available at `http://localhost:8000/docs`.

## Endpoints

### `GET /health`

Liveness probe. Returns `{"status": "ok"}`.

### `POST /ingest`

Unified endpoint for audio transcription and face analysis (send one or both in the same request).

Request body:

```json
{
  "audioB64": "...",
  "filename": "mic-12.webm",
  "mimeType": "audio/webm",
  "chunkIndex": 12,
  "imageB64": "...",
  "imageMimeType": "image/jpeg",
  "source": "mic",
  "ts": 1715260800000
}
```

Response:

```json
{
  "ok": true,
  "isFinal": true,
  "text": "hello world",
  "insight": "PDF · signing · AI",
  "face": {
    "state": "bored",
    "confidence": 0.72,
    "reason": "low engagement"
  }
}
```
Legacy endpoints `/transcribe` and `/face` still exist, but `/ingest` is the preferred unified path.

## Quick test

```bash
curl -X POST http://localhost:8000/ingest \
  -H 'Content-Type: application/json' \
  -d '{"audioB64":"...","mimeType":"audio/webm"}'
```

You should see a log line on the server like:

```
[INFO] transcript-server: transcript received | client=127.0.0.1 | source=mic | ...
[INFO] transcript-server: text: hello from curl
```

## Sending from the extension

From the extension's background service worker (or popup), POST JSON like:

```js
fetch('http://localhost:8000/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ audioB64, imageB64, mimeType: 'audio/webm', imageMimeType: 'image/jpeg' }),
});
```

CORS is currently open to all origins for development; tighten `allow_origins` in `main.py` before deploying.
