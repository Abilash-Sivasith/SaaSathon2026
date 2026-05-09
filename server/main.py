"""FastAPI server: receives audio from the extension, transcribes via OpenAI, logs text only here."""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from openai import APIStatusError, OpenAI
from pydantic import BaseModel, Field

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S%z",
)
logger = logging.getLogger("transcript-server")

# One line per finalized transcript: log message is exactly the text (no logger name/timestamp prefix).
transcript_log = logging.getLogger("transcription-text")
transcript_log.setLevel(logging.INFO)
transcript_log.propagate = False
if not transcript_log.handlers:
    _transcript_handler = logging.StreamHandler()
    _transcript_handler.setFormatter(logging.Formatter("%(message)s"))
    transcript_log.addHandler(_transcript_handler)


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'").strip()
        if key and key not in os.environ:
            os.environ[key] = value


# Env files: repo-root `.env` (e.g. SaaSathon2026/.env) is the usual place next to extension code.
# Optional `server/.env` only sets variables not already in the process environment or set by the first file.
_repo_root = Path(__file__).resolve().parent.parent
_server_dir = Path(__file__).resolve().parent
load_dotenv(_repo_root / ".env")
load_dotenv(_server_dir / ".env")

MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini-transcribe")
WEBM_TRANSCRIBE_MIN_BYTES = int(os.getenv("WEBM_TRANSCRIBE_MIN_BYTES", "32000"))

STRIP_FILLER_WORDS = os.getenv("STRIP_FILLER_WORDS", "1").strip().lower() not in ("0", "false", "no")

# Hesitations / discourse markers unlikely to carry meaning when removed as whole-word matches.
_FILLER_RE = re.compile(
    r"(?i)"
    r"(?:"
    r"\b(?:uh+h*|umm*|um+|erm+|ermm*|er+|ah+h*|mhmm*|hm+|hmm+|huh+|oof)\b\s*[,;.:]?\s*"
    r"|\byou know\b\s*[,;.:]?\s*"
    r"|\bi mean\b\s*[,;.:]?\s*"
    r"|\bas i said\b\s*[,;.:]?\s*"
    r"|\bas i was saying\b\s*[,;.:]?\s*"
    r"|\b(?:sort of|kind of)\b\s*[,;.:]?\s*"
    r")",
)


def strip_filler_words(text: str) -> str:
    if not STRIP_FILLER_WORDS or not text:
        return text
    prev = None
    s = text
    while prev != s:
        prev = s
        s = _FILLER_RE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def transcribe_then_clean(
    audio: bytes,
    mime_type: str,
    filename: str,
    api_key: str,
) -> str:
    raw = transcribe_bytes(audio, mime_type, filename, api_key)
    return strip_filler_words(raw.strip())

app = FastAPI(
    title="SaaSathon2026 Transcript Server",
    description="Transcribes audio from the extension; transcript text is logged on the server only.",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TranscribeIn(BaseModel):
    audioB64: str
    filename: str = "audio.webm"
    source: str = "unknown"
    mimeType: str = "audio/webm"
    chunkIndex: int | str = Field(default="?")
    ts: Optional[int] = None


def resolve_api_key(authorization: Optional[str], x_api_key: Optional[str]) -> Optional[str]:
    key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if key:
        if key.startswith("sk-proj-") and "sk-or-v1" in key:
            logger.warning(
                "OPENAI_API_KEY looks like an OpenAI prefix merged with an OpenRouter key (sk-or-v1). "
                "Use a single secret from https://platform.openai.com/account/api-keys"
            )
        return key
    header = authorization or x_api_key
    if not header:
        return None
    return header.replace("Bearer ", "", 1).strip()


def transcribe_bytes(
    audio: bytes,
    mime_type: str,
    filename: str,
    api_key: str,
) -> str:
    client = OpenAI(api_key=api_key)
    if mime_type.startswith("audio/wav"):
        tr = client.audio.transcriptions.create(
            model=MODEL,
            file=("audio.wav", audio, "audio/wav"),
            response_format="json",
        )
    else:
        if len(audio) < WEBM_TRANSCRIBE_MIN_BYTES:
            return ""
        with tempfile.TemporaryDirectory() as tmpdir:
            in_path = Path(tmpdir) / "input.webm"
            out_path = Path(tmpdir) / "output.wav"
            in_path.write_bytes(audio)
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(in_path),
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    str(out_path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            if proc.returncode != 0 or not out_path.exists():
                err = proc.stderr.decode("utf-8", errors="ignore")
                logger.error("ffmpeg failed: %s", err)
                raise HTTPException(status_code=500, detail={"error": "ffmpeg_failed", "message": err})
            wav_bytes = out_path.read_bytes()
            tr = client.audio.transcriptions.create(
                model=MODEL,
                file=("audio.wav", wav_bytes, "audio/wav"),
                response_format="json",
            )

    text = getattr(tr, "text", None)
    if not text and isinstance(tr, dict):
        text = tr.get("text")
    return (text or "").strip()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
async def root() -> dict[str, object]:
    return {"ok": True, "model": MODEL}


@app.post("/transcribe")
async def transcribe(
    payload: TranscribeIn,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> dict[str, object]:
    api_key = resolve_api_key(authorization, x_api_key)
    if not api_key:
        raise HTTPException(status_code=401, detail={"error": "missing_openai_api_key"})

    try:
        audio = base64.b64decode(payload.audioB64)
    except Exception:
        raise HTTPException(status_code=400, detail={"error": "invalid_base64"})

    try:
        text = await asyncio.to_thread(
            transcribe_then_clean,
            audio,
            payload.mimeType,
            payload.filename,
            api_key,
        )
    except HTTPException:
        raise
    except APIStatusError as exc:
        if exc.status_code == 401:
            logger.warning("OpenAI rejected the API key (401). Check OPENAI_API_KEY in .env.")
            raise HTTPException(
                status_code=401,
                detail={"error": "invalid_openai_api_key", "message": "OpenAI returned 401; key missing or wrong."},
            ) from exc
        logger.exception("openai transcription failed")
        raise HTTPException(
            status_code=502,
            detail={"error": "openai_request_failed", "message": str(exc)},
        ) from exc
    except Exception as exc:
        logger.exception("openai transcription failed")
        raise HTTPException(
            status_code=500,
            detail={"error": "openai_request_failed", "message": str(exc)},
        ) from exc

    if not text:
        return {"ok": True, "isFinal": False}

    transcript_log.info("%s", text)

    return {"ok": True, "isFinal": True}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=True,
        log_level="info",
    )
