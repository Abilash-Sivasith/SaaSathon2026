"""FastAPI server: receives audio from the extension, transcribes via OpenAI, logs each finalized transcript line and (unless disabled) an insight LLM reply built with reference_context.txt."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
from collections import deque
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
# OpenAI's client uses httpx; keep server output focused on app + insight lines.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger("transcript-server")

_ANSI_RED = "\033[91m"
_ANSI_RESET = "\033[0m"


def _transcript_log_use_red() -> bool:
    if os.getenv("NO_COLOR", "").strip():
        return False
    if os.getenv("TRANSCRIPT_COLOR", "1").strip().lower() in ("0", "false", "no"):
        return False
    return sys.stderr.isatty()


class _TranscriptLineFormatter(logging.Formatter):
    """Plain message, optional bright-red ANSI for terminal transcript lines."""

    def __init__(self, use_red: bool) -> None:
        super().__init__("%(message)s")
        self._use_red = use_red

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)
        if self._use_red:
            return f"{_ANSI_RED}{text}{_ANSI_RESET}"
        return text


# One stream per finalized chunk: logged line is exactly the reasoning model reply (no prefix).
insight_log = logging.getLogger("insight-llm")
insight_log.setLevel(logging.INFO)
insight_log.propagate = False
if not insight_log.handlers:
    _insight_handler = logging.StreamHandler()
    _insight_handler.setFormatter(logging.Formatter("%(message)s"))
    insight_log.addHandler(_insight_handler)

# One line per finalized transcript chunk: message is exactly the spoken text (no prefix).
transcript_log = logging.getLogger("transcription-text")
transcript_log.setLevel(logging.INFO)
transcript_log.propagate = False
if not transcript_log.handlers:
    _transcript_handler = logging.StreamHandler()
    _transcript_handler.setFormatter(_TranscriptLineFormatter(_transcript_log_use_red()))
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

REFERENCE_MTIME: float | None = None
REFERENCE_BODY: str = ""


def _resolve_reference_path() -> Path:
    raw = os.getenv("INSIGHT_REFERENCE_PATH", "").strip()
    path = Path(raw) if raw else _server_dir / "reference_context.txt"
    if not path.is_absolute():
        path = _server_dir / path
    return path


def get_reference_document() -> str:
    """Load reference text from disk; refresh when the file changes."""
    global REFERENCE_MTIME, REFERENCE_BODY
    path = _resolve_reference_path()
    try:
        st = path.stat()
    except FileNotFoundError:
        logger.warning("insight reference file missing at %s; model runs without reference", path)
        REFERENCE_MTIME = None
        REFERENCE_BODY = ""
        return ""
    if REFERENCE_MTIME != st.st_mtime:
        REFERENCE_BODY = path.read_text(encoding="utf-8", errors="replace")
        REFERENCE_MTIME = st.st_mtime
    return REFERENCE_BODY


INSIGHT_TRANSCRIPT_CONTEXT_CHARS = int(os.getenv("INSIGHT_TRANSCRIPT_CONTEXT_CHARS", "12000"))
TRANSCRIPT_CHUNK_BUFFER: deque[str] = deque(maxlen=512)


def append_transcript_for_insight(segment: str) -> str:
    cleaned = segment.strip()
    if cleaned:
        TRANSCRIPT_CHUNK_BUFFER.append(cleaned)
    joined = " ".join(TRANSCRIPT_CHUNK_BUFFER)
    if len(joined) > INSIGHT_TRANSCRIPT_CONTEXT_CHARS:
        joined = joined[-INSIGHT_TRANSCRIPT_CONTEXT_CHARS:]
    return joined


MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini-transcribe")

# Optional ISO 639-1 hint (e.g. en). Unset / "auto" → model detects language (multilingual transcription).
_tl_hint = os.getenv("OPENAI_TRANSCRIBE_LANGUAGE", "").strip().lower()
TRANSCRIBE_LANGUAGE_HINT: str | None = None if _tl_hint in ("", "auto") else _tl_hint

INSIGHT_MODEL = os.getenv("OPENAI_INSIGHT_MODEL", "gpt-4o-mini")
INSIGHT_DISABLED = os.getenv("INSIGHT_DISABLED", "0").strip().lower() in ("1", "true", "yes")
# By default do not duplicate insights on stderr; extension shows them in the page overlay.
INSIGHT_LOG_TERMINAL = os.getenv("INSIGHT_LOG_TERMINAL", "0").strip().lower() in ("1", "true", "yes")
WEBM_TRANSCRIBE_MIN_BYTES = int(os.getenv("WEBM_TRANSCRIBE_MIN_BYTES", "32000"))
FACE_MODEL = os.getenv("OPENAI_FACE_MODEL", "gpt-4o-mini")
FACE_DISABLED = os.getenv("FACE_DISABLED", "0").strip().lower() in ("1", "true", "yes")
FACE_IMAGE_MAX_BYTES = int(os.getenv("FACE_IMAGE_MAX_BYTES", "1500000"))

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
    r"|\b(?:like|kinda|kind of|kinda like|kinda sort of|kinda kinda like)\b\s*[,;.:]?\s*"
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


INSIGHT_REASON_SYSTEM = (
    "You support live captions. You receive INTERNAL REFERENCE NOTES plus the transcript.\n\n"
    "Output MUST be keywords only — not sentences, bullets, or explanations:\n"
    "- Pull at most the few REFERENCE FACTS that match the *new finalized segment* topic (e.g. software / price "
    "/ product → only those fields).\n"
    "- Separate items with middot (·) or comma. Examples: \"$100 · max discount 20%\" for cost talk; "
    "\"PDF · signing · AI\" only if they asked what the product includes.\n"
    "- No names, rapport, bios, or extra topics unless that person/topic was clearly named in this segment.\n"
    "- At most ONE short line of keywords (typically under ~12 words). Never outline or recap.\n"
    "- If nothing in the reference matches this segment’s topic: output exactly: ok\n"
    "- Plain text only; use only commas/middots between facts — no colons, headers, or parentheses."
)


def synthesize_insight(
    api_key: str,
    reference_doc: str,
    transcript_context: str,
    latest_segment: str,
) -> str:
    client = OpenAI(api_key=api_key)
    ref = reference_doc.strip() or "(none — rely on transcript alone)"
    user_content = (
        "Keywords only — match facts from reference to what this segment asks or states. One line maximum.\n\n"
        "### Reference (internal)\n"
        + ref
        + "\n\n### Recent transcript (context only)\n"
        + (transcript_context.strip() or "(empty)")
        + "\n\n### New finalized segment (match topic against reference)\n"
        + latest_segment.strip()
    )
    out = client.chat.completions.create(
        model=INSIGHT_MODEL,
        messages=[
            {"role": "system", "content": INSIGHT_REASON_SYSTEM},
            {"role": "user", "content": user_content},
        ],
        temperature=0.15,
        max_tokens=int(os.getenv("INSIGHT_MAX_TOKENS", "80")),
    )
    choice = out.choices[0].message
    body = getattr(choice, "content", None) or ""
    return body.strip()


def insight_is_skip_token(text: str) -> bool:
    t = text.strip().lower().rstrip(".!?")
    return t in ("ok", "okay", "")


app = FastAPI(
    title="SaaSathon2026 Transcript Server",
    description="Transcribes audio from the extension; logs each chunk on logger transcription-text, then insights on insight-llm using reference_context.txt.",
    version="0.3.4",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class IngestIn(BaseModel):
    audioB64: Optional[str] = None
    imageB64: Optional[str] = None
    filename: str = "audio.webm"
    source: str = "unknown"
    mimeType: Optional[str] = "audio/webm"
    imageMimeType: str = "image/jpeg"
    chunkIndex: int | str = Field(default="?")
    ts: Optional[int] = None
    audioRms: Optional[float] = None
    recentTranscript: Optional[str] = None


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
    _args: dict = {
        "model": MODEL,
        "response_format": "json",
    }
    if TRANSCRIBE_LANGUAGE_HINT:
        _args["language"] = TRANSCRIBE_LANGUAGE_HINT
    if mime_type.startswith("audio/wav"):
        tr = client.audio.transcriptions.create(
            file=("audio.wav", audio, "audio/wav"),
            **_args,
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
                file=("audio.wav", wav_bytes, "audio/wav"),
                **_args,
            )

    text = getattr(tr, "text", None)
    if not text and isinstance(tr, dict):
        text = tr.get("text")
    return (text or "").strip()


def _strip_data_url(b64_or_data_url: str) -> str:
    if not b64_or_data_url:
        return ""
    if "," in b64_or_data_url and b64_or_data_url.strip().lower().startswith("data:"):
        return b64_or_data_url.split(",", 1)[1].strip()
    return b64_or_data_url.strip()


def _parse_face_response(raw: str) -> dict[str, object]:
    text = (raw or "").strip()
    if not text:
        return {"state": "neutral", "confidence": 0.5, "reason": "empty_response", "feedback": ""}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return {"state": "neutral", "confidence": 0.5, "reason": "parse_failed", "feedback": ""}
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return {"state": "neutral", "confidence": 0.5, "reason": "parse_failed", "feedback": ""}

    state = str(data.get("state", "neutral")).strip().lower()
    if state not in ("bored", "neutral", "engaged"):
        state = "neutral"

    confidence = data.get("confidence", 0.5)
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    reason = str(data.get("reason", "")).strip()
    feedback = str(data.get("feedback", "")).strip()
    return {"state": state, "confidence": confidence, "reason": reason, "feedback": feedback}


def analyze_face_image(
    api_key: str,
    image_b64: str,
    mime_type: str,
    audio_rms: Optional[float] = None,
    recent_transcript: Optional[str] = None,
) -> dict[str, object]:
    client = OpenAI(api_key=api_key)
    data_url = f"data:{mime_type};base64,{image_b64}"
    audio_tone = "unknown"
    if isinstance(audio_rms, (int, float)):
        if audio_rms < 0.01:
            audio_tone = "calm"
        elif audio_rms < 0.03:
            audio_tone = "neutral"
        else:
            audio_tone = "intense"
    prompt = (
        "Classify visible meeting engagement using only observable cues from the face image, "
        "recent transcript, and audio tone. Output JSON only with keys: state, confidence, reason, feedback. "
        "state must be bored|neutral|engaged. confidence is 0-1. "
        "Use lower confidence (0.2-0.45) when the face is unclear, occluded, off-camera, or the cue is ambiguous. "
        "reason is 2-6 words describing visible cues only. "
        "feedback is 1-2 short coaching sentences that are supportive, specific, and action-oriented. "
        "Avoid diagnosing emotions or personality; coach the next visible behavior instead. "
        "No extra text."
    )
    transcript = (recent_transcript or "").strip() or "(none)"
    tone_line = f"Audio tone: {audio_tone}."
    transcript_line = f"Recent transcript: {transcript}"
    request_kwargs = {
        "model": FACE_MODEL,
        "temperature": 0.0,
        "max_tokens": 120,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a conservative visual engagement coach. "
                    "Prefer neutral with modest confidence when evidence is weak."
                ),
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"{prompt}\n{tone_line}\n{transcript_line}"},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
    }
    try:
        out = client.chat.completions.create(
            **request_kwargs,
            response_format={"type": "json_object"},
        )
    except TypeError:
        out = client.chat.completions.create(**request_kwargs)
    except APIStatusError as exc:
        message = str(exc).lower()
        if exc.status_code != 400 or "response_format" not in message:
            raise
        out = client.chat.completions.create(**request_kwargs)
    body = out.choices[0].message.content or ""
    return _parse_face_response(body)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
async def root() -> dict[str, object]:
    return {
        "ok": True,
        "model": MODEL,
        "transcribeLanguage": TRANSCRIBE_LANGUAGE_HINT or "auto",
    }


async def _run_transcription(payload: IngestIn, api_key: str) -> dict[str, object]:
    if not payload.audioB64:
        return {"ok": True, "isFinal": False, "text": "", "insight": ""}

    try:
        audio = base64.b64decode(payload.audioB64)
    except Exception:
        raise HTTPException(status_code=400, detail={"error": "invalid_base64"})

    try:
        text = await asyncio.to_thread(
            transcribe_then_clean,
            audio,
            payload.mimeType or "audio/webm",
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
        return {"ok": True, "isFinal": False, "text": "", "insight": ""}

    transcript_log.info("%s", text)

    ctx = append_transcript_for_insight(text)
    insight_reply = ""
    if not INSIGHT_DISABLED:
        try:
            ref_text = get_reference_document()
            insight = await asyncio.to_thread(
                synthesize_insight,
                api_key,
                ref_text,
                ctx,
                text,
            )
        except APIStatusError as exc:
            logger.warning("OpenAI insight call failed (%s): %s", exc.status_code, exc)
            raise HTTPException(
                status_code=502,
                detail={"error": "insight_openai_failed", "message": str(exc)},
            ) from exc
        except Exception as exc:
            logger.exception("OpenAI insight call failed")
            raise HTTPException(
                status_code=500,
                detail={"error": "insight_failed", "message": str(exc)},
            ) from exc

        if insight and not insight_is_skip_token(insight):
            insight_reply = insight.strip()
            if INSIGHT_LOG_TERMINAL:
                insight_log.info("%s", insight_reply)
        elif not insight:
            logger.warning("insight model returned an empty reply (model=%s)", INSIGHT_MODEL)

    return {"ok": True, "isFinal": True, "text": text, "insight": insight_reply}


async def _run_face_analysis(payload: IngestIn, api_key: str) -> dict[str, object]:
    if FACE_DISABLED or not payload.imageB64:
        return {}

    raw_b64 = _strip_data_url(payload.imageB64)
    try:
        image_bytes = base64.b64decode(raw_b64)
    except Exception:
        raise HTTPException(status_code=400, detail={"error": "invalid_base64"})

    if len(image_bytes) > FACE_IMAGE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"error": "image_too_large", "max_bytes": FACE_IMAGE_MAX_BYTES},
        )

    mime_type = payload.imageMimeType or payload.mimeType or "image/jpeg"
    try:
        result = await asyncio.to_thread(
            analyze_face_image,
            api_key,
            raw_b64,
            mime_type,
            payload.audioRms,
            payload.recentTranscript,
        )
    except APIStatusError as exc:
        if exc.status_code == 401:
            raise HTTPException(
                status_code=401,
                detail={"error": "invalid_openai_api_key", "message": "OpenAI returned 401; key missing or wrong."},
            ) from exc
        logger.exception("OpenAI face analysis failed")
        raise HTTPException(
            status_code=502,
            detail={"error": "openai_request_failed", "message": str(exc)},
        ) from exc
    except Exception as exc:
        logger.exception("OpenAI face analysis failed")
        raise HTTPException(
            status_code=500,
            detail={"error": "openai_request_failed", "message": str(exc)},
        ) from exc

    return {"face": result}


@app.post("/ingest")
async def ingest(
    payload: IngestIn,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> dict[str, object]:
    if not payload.audioB64 and not payload.imageB64:
        raise HTTPException(status_code=400, detail={"error": "missing_payload"})

    if payload.imageB64 and FACE_DISABLED and not payload.audioB64:
        return {"ok": False, "error": "face_disabled"}

    api_key = resolve_api_key(authorization, x_api_key)
    if not api_key:
        raise HTTPException(status_code=401, detail={"error": "missing_openai_api_key"})

    tasks = []
    if payload.audioB64:
        tasks.append(_run_transcription(payload, api_key))
    if payload.imageB64 and not FACE_DISABLED:
        tasks.append(_run_face_analysis(payload, api_key))

    if not tasks:
        raise HTTPException(status_code=400, detail={"error": "missing_payload"})

    results = await asyncio.gather(*tasks, return_exceptions=True)
    response: dict[str, object] = {"ok": True}
    for res in results:
        if isinstance(res, HTTPException):
            raise res
        if isinstance(res, Exception):
            raise HTTPException(status_code=500, detail={"error": "processing_failed", "message": str(res)})
        response.update(res)

    return response


@app.post("/transcribe")
async def transcribe(
    payload: IngestIn,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> dict[str, object]:
    return await ingest(payload, request, authorization, x_api_key)


@app.post("/face")
async def face_analyze(
    payload: IngestIn,
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> dict[str, object]:
    if not payload.imageB64:
        raise HTTPException(status_code=400, detail={"error": "missing_image"})
    return await ingest(payload, request, authorization, x_api_key)


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
