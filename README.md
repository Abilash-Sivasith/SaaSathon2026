# Oblique

Your AI copilot for sales calls — listens in real time, surfaces product info, pricing, and objection handling exactly when you need it.

## What it does

Oblique is a Chrome extension + backend server that captures audio from your active browser tab and microphone during a meeting. It transcribes speech on the fly via OpenAI Whisper, then feeds each transcript chunk to an LLM that retrieves relevant context (pricing, product details, past incidents) and pushes live hints into a sidebar panel — so you never have to scramble for an answer mid-call.

## Architecture

```
extension/          Chrome MV3 extension (side panel UI + audio capture)
  background.js     Service worker — manages side panel lifecycle
  popup.js          Audio pipeline: tab capture, mic, screen; sends PCM to server
  presenter-overlay.js  Overlay injected into the meeting tab for live hints

server/             FastAPI backend
  main.py           Receives audio chunks, transcribes, runs insight LLM, streams replies
  context.txt       Reference document loaded at startup (product info, pricing, etc.)

landing/            Next.js dashboard (call analytics, follow-ups, org-wide stats)
```

## Getting started

### 1. Backend

```bash
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# add your key to the repo-root .env
echo "OPENAI_API_KEY=sk-..." > ../.env

uvicorn main:app --reload
# runs on http://localhost:8000
```

### 2. Landing page

```bash
cd landing
npm install
npm run dev
# runs on http://localhost:3000
```

### 3. Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` folder
4. Click the extension icon on any meeting tab to open the side panel

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | Required. Set in `.env` at the repo root. |
| `INSIGHT_REFERENCE_PATH` | `server/context.txt` | Path to the reference doc used for context retrieval. |
| `TRANSCRIPT_COLOR` | `1` | Set to `0` to disable red ANSI colouring for transcript lines in the terminal. |

Edit `server/context.txt` to add your own product details, pricing, and any objection-handling scripts you want surfaced during calls.

## Stack

- **Extension** — Chrome MV3, vanilla JS, React (Vite) for the side panel UI
- **Backend** — Python, FastAPI, OpenAI SDK (Whisper + chat completions)
- **Landing** — Next.js 15, TypeScript

## Disclaimer

This code is a dumpster fire of software, forged by every AI model available for the 2026 Lumin Sponsored SaaSathon.
