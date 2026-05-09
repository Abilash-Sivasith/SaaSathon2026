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

## Reference retrieval

`reference_context.txt` is indexed in memory on startup and refreshed automatically when the file changes. For each finalized transcript segment, the server retrieves only the most relevant reference excerpts and first tries to answer locally from those facts. Overlay insights are keyword-only bullets for quick sales cues, not live transcript text or long analysis. If no excerpt matches, it skips the insight LLM call and returns no insight.

Set `INSIGHT_LLM_FALLBACK=1` if you want the model to rewrite retrieved facts when the local fast path cannot produce a hint. Leave it unset for the lowest latency.

Useful knobs:

```bash
OPENAI_TRANSCRIBE_QUALITY=clarity   # clarity=gpt-4o-transcribe, realtime=gpt-4o-mini-transcribe
OPENAI_MODEL=gpt-4o-transcribe      # optional explicit override
OPENAI_TRANSCRIBE_LANGUAGE=en      # default; use auto only for multilingual demos
OPENAI_TRANSCRIBE_PROMPT="English sales meeting. Preserve exact proper nouns, product names, and money amounts..."
OPENAI_TRANSCRIBE_NORMALIZE_AUDIO=1 # high/low pass + loudness normalization before STT
OPENAI_TRANSCRIBE_AUDIO_FILTERS="highpass=f=80,lowpass=f=7600,loudnorm=I=-18:TP=-2:LRA=11"
OPENAI_TRANSCRIBE_SAMPLE_RATE=16000
TRANSCRIPT_MIN_LATIN_RATIO=0.7     # filters likely auto-detect drift/noise
INSIGHT_REFERENCE_TOP_K=4          # max retrieved chunks
INSIGHT_REFERENCE_MAX_CHARS=1200   # prompt budget for retrieved facts
INSIGHT_REFERENCE_MIN_SCORE=1.2    # higher = stricter matching
INSIGHT_FAST_MAX_ITEMS=3           # top-ranked local facts shown in one overlay hint
INSIGHT_CONTEXT_FALLBACK=1         # vague follow-ups can use recent transcript topic memory
INSIGHT_CONTEXT_FALLBACK_CHARS=6000
INSIGHT_RETURN_LAST_ON_NO_MATCH=1  # keep returning the last useful top-ranked cue
INSIGHT_LLM_FALLBACK=0             # 0 = fastest, 1 = model fallback for hard matches
INSIGHT_TRANSCRIPT_CONTEXT_CHARS=8000
```

For best accuracy, keep facts in short headed sections or bullets, avoid mixing unrelated topics in one bullet, and put exact product/person names in the reference text. The overlay keeps the last useful cue on screen and shows up to three ranked facts, like `#1 | $100/mo/user | Oblique | realtime coaching` or `#2 | discount: ask 50% | settle 20% | be strict`. Vague follow-ups such as "how much is it?" use recent transcript context to find the closest reference match. Common ASR misses for domain words are normalized, and close token matches are checked against the reference vocabulary.

For the clearest transcripts, leave `OPENAI_TRANSCRIBE_QUALITY=clarity` so the server uses `gpt-4o-transcribe`. For lower latency, set `OPENAI_TRANSCRIBE_QUALITY=realtime` or explicitly set `OPENAI_MODEL=gpt-4o-mini-transcribe`.

The extension uses two independent throttles:

- Audio: mic chunks flush about every 1.2 seconds, wait at most 1.6 seconds, and keep only the freshest queued chunk if the server lags.
- Visual: camera frames are captured about every 3 seconds and analyzed about every 5 seconds in a separate request, so transcript/keyword updates never wait for slower vision analysis.

Run the local retrieval quality check after editing `reference_context.txt`:

```bash
server/.venv/bin/python server/test_reference_quality.py
```

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
  "insight": "• #1 | PDF reading | signing | AI integration",
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
