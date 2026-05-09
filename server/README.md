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

### `POST /transcripts`

Accepts a transcribed utterance from the extension. Logs it and returns an ack.

Request body:

```json
{
  "text": "hello world",
  "source": "mic",
  "language": "en-US",
  "is_final": true,
  "client_ts": 1715260800000,
  "session_id": "abc-123"
}
```

Only `text` is required.

Response:

```json
{
  "ok": true,
  "received_chars": 11,
  "server_ts": "2026-05-09T19:00:00+00:00"
}
```

## Quick test

```bash
curl -X POST http://localhost:8000/transcripts \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello from curl","source":"mic","is_final":true}'
```

You should see a log line on the server like:

```
[INFO] transcript-server: transcript received | client=127.0.0.1 | source=mic | ...
[INFO] transcript-server: text: hello from curl
```

## Sending from the extension

From the extension's background service worker (or popup), POST JSON like:

```js
fetch('http://localhost:8000/transcripts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: transcribedString, source: 'mic', is_final: true }),
});
```

CORS is currently open to all origins for development; tighten `allow_origins` in `main.py` before deploying.
