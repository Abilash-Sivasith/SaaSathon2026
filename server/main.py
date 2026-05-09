"""FastAPI server: receives audio from the extension, transcribes via OpenAI, logs each finalized transcript line and (unless disabled) an insight LLM reply built with reference_context.txt."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sys
from collections import deque
from dataclasses import dataclass
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
REFERENCE_CHUNKS: list["ReferenceChunk"] = []


@dataclass(frozen=True)
class ReferenceChunk:
    title: str
    text: str
    line_start: int
    line_end: int
    tokens: frozenset[str]


def _resolve_reference_path() -> Path:
    raw = os.getenv("INSIGHT_REFERENCE_PATH", "").strip()
    path = Path(raw) if raw else _server_dir / "reference_context.txt"
    if not path.is_absolute():
        path = _server_dir / path
    return path


REFERENCE_STOPWORDS = {
    "a", "about", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from",
    "had", "has", "have", "he", "her", "him", "his", "how", "if", "in", "into", "is", "it",
    "its", "me", "my", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them",
    "there", "they", "this", "to", "too", "us", "was", "we", "what", "when", "where", "who",
    "with", "you", "your", "does", "product",
}


def _reference_tokens(text: str) -> frozenset[str]:
    words = re.findall(r"[a-z0-9][a-z0-9_+-]*", text.lower())
    tokens: set[str] = set()
    for word in words:
        if len(word) < 3 or word in REFERENCE_STOPWORDS:
            continue
        tokens.add(word)
        if word.endswith("s") and len(word) > 4:
            tokens.add(word[:-1])
    return frozenset(tokens)


def _expand_reference_query_tokens(tokens: set[str], text: str) -> set[str]:
    expanded = set(tokens)
    lower = text.lower()
    if "justus" in expanded or "huneke" in expanded:
        expanded.update({"huneke", "holdco", "kids", "software", "engineer", "rocky"})
    if "john" in expanded and "doe" in expanded:
        expanded.update({"integration", "100k", "software", "department"})
    if "justice" in lower or "justic" in lower:
        expanded.update({"justus", "huneke", "holdco", "kids", "software", "engineer"})
    if "jsteagle" in expanded or "website" in expanded or "profile" in expanded:
        expanded.update({"web3", "websites", "alf", "dashboard", "typescript", "cloudflare", "next", "rust"})
    if "alf" in expanded or "dashboard" in expanded:
        expanded.update({"on-chain", "indexing", "dynamic", "efficiency", "speed"})
    if "integrat" in lower or "integration" in expanded:
        expanded.update({"cloudflare", "workers", "typescript", "dashboard", "low-latency"})
    if "fit" in expanded or "relevant" in expanded:
        expanded.update({"web3", "dashboards", "speed", "technical", "coaching"})
    return expanded


def _reference_line_title(line: str) -> str:
    stripped = line.strip()
    if not stripped:
        return ""
    if stripped.startswith("#"):
        return stripped.lstrip("#").strip()
    if stripped.endswith(":") and len(stripped.split()) <= 10:
        return stripped.rstrip(":")
    bullet = re.match(r"^\s*[-*]\s+(.+?)\s*$", line)
    if bullet:
        text = bullet.group(1).strip()
        if text.endswith(":") or len(text.split()) <= 8:
            return text.rstrip(":")
    return ""


def _is_reference_instruction_chunk(chunk: ReferenceChunk) -> bool:
    text = f"{chunk.title}\n{chunk.text}".lower()
    instruction_markers = (
        "reference context for the reasoning assistant",
        "this file is injected into the model",
        "replace this content with your real brief",
        "goals for the assistant",
    )
    return any(marker in text for marker in instruction_markers)


def _build_reference_chunks(body: str) -> list[ReferenceChunk]:
    """Build small, line-numbered chunks for cheap local retrieval."""
    chunks: list[ReferenceChunk] = []
    current_title = "Reference"
    current_lines: list[tuple[int, str]] = []

    def flush() -> None:
        nonlocal current_lines
        text = "\n".join(line for _, line in current_lines).strip()
        if not text:
            current_lines = []
            return
        line_start = current_lines[0][0]
        line_end = current_lines[-1][0]
        chunk_text = f"{current_title}\n{text}" if current_title else text
        chunks.append(
            ReferenceChunk(
                title=current_title or "Reference",
                text=chunk_text,
                line_start=line_start,
                line_end=line_end,
                tokens=_reference_tokens(chunk_text),
            )
        )
        current_lines = []

    for line_no, raw_line in enumerate(body.splitlines(), start=1):
        title = _reference_line_title(raw_line)
        starts_new_block = bool(title) or not raw_line.strip()
        if starts_new_block:
            flush()
            if title:
                current_title = title
                current_lines.append((line_no, raw_line))
            continue
        current_lines.append((line_no, raw_line))

    flush()
    return chunks


def get_reference_document() -> str:
    """Load reference text from disk; refresh when the file changes."""
    global REFERENCE_MTIME, REFERENCE_BODY, REFERENCE_CHUNKS
    path = _resolve_reference_path()
    try:
        st = path.stat()
    except FileNotFoundError:
        logger.warning("insight reference file missing at %s; model runs without reference", path)
        REFERENCE_MTIME = None
        REFERENCE_BODY = ""
        REFERENCE_CHUNKS = []
        return ""
    if REFERENCE_MTIME != st.st_mtime:
        REFERENCE_BODY = path.read_text(encoding="utf-8", errors="replace")
        REFERENCE_CHUNKS = _build_reference_chunks(REFERENCE_BODY)
        REFERENCE_MTIME = st.st_mtime
    return REFERENCE_BODY


INSIGHT_REFERENCE_TOP_K = int(os.getenv("INSIGHT_REFERENCE_TOP_K", "4"))
INSIGHT_REFERENCE_MAX_CHARS = int(os.getenv("INSIGHT_REFERENCE_MAX_CHARS", "1200"))
INSIGHT_REFERENCE_MIN_SCORE = float(os.getenv("INSIGHT_REFERENCE_MIN_SCORE", "1.2"))
INSIGHT_LLM_FALLBACK = os.getenv("INSIGHT_LLM_FALLBACK", "0").strip().lower() in ("1", "true", "yes")
INSIGHT_FAST_MAX_ITEMS = int(os.getenv("INSIGHT_FAST_MAX_ITEMS", "2"))


def get_relevant_reference_context(latest_segment: str, transcript_context: str = "") -> str:
    """Return the most relevant reference snippets for the current segment.

    This keeps insight prompts short and makes the model ground itself in the
    matching facts instead of scanning the whole reference document every time.
    """
    get_reference_document()
    if not REFERENCE_CHUNKS:
        return ""

    if not transcript_is_supported_language(latest_segment):
        return ""

    latest_tokens = set(_reference_tokens(latest_segment))
    context_tokens = set(_reference_tokens(transcript_context[-2000:]))
    if not latest_tokens:
        return ""
    latest_tokens = _expand_reference_query_tokens(latest_tokens, latest_segment)
    latest_lower = latest_segment.lower()
    person_query = "justus" in latest_tokens or "huneke" in latest_tokens
    work_query = any(term in latest_lower for term in ("work", "works", "job", "company", "where"))
    kids_query = "kids" in latest_lower or "children" in latest_lower
    money_query = any(term in latest_lower for term in ("cost", "price", "spend", "spent", "buy", "bought", "worth", "100k", "20k"))

    scored: list[tuple[float, ReferenceChunk]] = []
    for chunk in REFERENCE_CHUNKS:
        if _is_reference_instruction_chunk(chunk):
            continue
        title_lower = chunk.title.lower()
        chunk_lower = chunk.text.lower()
        if title_lower.startswith("about ") and not money_query:
            continue
        if title_lower in {"in meeting context", "meeting plan", "intro"} and not money_query:
            continue
        latest_overlap = latest_tokens & set(chunk.tokens)
        context_overlap = context_tokens & set(chunk.tokens)
        # Latest segment is the gate. Context can rank matches, but must not
        # retrieve stale facts on its own.
        if not latest_overlap:
            continue
        title_overlap = latest_tokens & _reference_tokens(chunk.title)
        score = (3.0 * len(latest_overlap)) + (0.6 * len(context_overlap)) + (1.5 * len(title_overlap))
        if money_query:
            if re.search(r"\b20k\b|\$20k|\bspend\b|\bspent\b", chunk_lower):
                score += 12.0
            if re.search(r"\b100k\b|\$100k|\bworth\b|\bbought\b", chunk_lower):
                score += 12.0
            if "$100" in chunk_lower or "per month per user" in chunk_lower:
                score += 8.0
        if person_query and not money_query:
            if "works for holdco" in chunk_lower:
                score += 10.0
            if "software engineer" in chunk_lower:
                score += 7.0
            if "has 3 kids" in chunk_lower:
                score += 7.0
            if "justus huneke" in chunk_lower:
                score += 4.0
            if "meeting with justus" in chunk_lower:
                score -= 2.0
        if work_query and "works for holdco" not in chunk_lower and "software engineer" not in chunk_lower:
            score -= 5.0
        if kids_query and "kids" not in chunk_lower:
            score -= 5.0
        # Strong exact phrases like product/person names are better than loose keyword overlap.
        for phrase in re.findall(r"\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3}\b", latest_segment):
            if phrase.lower() in chunk_lower and phrase.lower() in latest_lower:
                score += 2.0
        if score >= INSIGHT_REFERENCE_MIN_SCORE:
            scored.append((score, chunk))

    if not scored:
        return ""

    scored.sort(key=lambda item: (-item[0], item[1].line_start))
    selected: list[ReferenceChunk] = []
    used_chars = 0
    for _, chunk in scored[: max(1, INSIGHT_REFERENCE_TOP_K)]:
        formatted = f"[ref:{chunk.line_start}-{chunk.line_end}] {chunk.text.strip()}"
        next_len = len(formatted) + 2
        if selected and used_chars + next_len > INSIGHT_REFERENCE_MAX_CHARS:
            continue
        selected.append(chunk)
        used_chars += next_len

    return "\n\n".join(
        f"[ref:{chunk.line_start}-{chunk.line_end}] {chunk.text.strip()}"
        for chunk in selected
    )


def _clean_reference_fact(line: str) -> str:
    text = re.sub(r"^\[ref:\d+-\d+\]\s*", "", line.strip())
    text = re.sub(r"^\s*[-*]\s*", "", text)
    text = re.sub(r"^\s{2,}", "", text)
    text = text.strip().strip(":").strip()
    return re.sub(r"\s+", " ", text)


def _looks_like_reference_title(fact: str) -> bool:
    if fact.lower() in {"features include", "meeting plan", "intro"}:
        return True
    return len(fact.split()) <= 5 and ("(" in fact or fact[:1].isupper())


def _compact_reference_fact(fact: str, query_tokens: frozenset[str]) -> str:
    if re.search(r"\b100k\b", fact, re.IGNORECASE):
        return "$100k department purchase"
    if re.search(r"\b20k\b", fact, re.IGNORECASE):
        return "$20k Lumin PDF + Sign"
    if re.search(r"\$100\b", fact, re.IGNORECASE):
        return "$100/month/user"
    if len(fact) <= 120:
        return fact
    parts = re.split(r"(?<=[.;])\s+|,\s+|\s+-\s+", fact)
    relevant = [part.strip() for part in parts if _reference_tokens(part) & query_tokens]
    if relevant:
        fact = ", ".join(relevant[:2])
    if len(fact) > 120:
        fact = fact[:117].rstrip() + "..."
    return fact


def _short_overlay_fact(fact: str) -> str:
    if re.search(r"\b100k\b|\$100k", fact, re.IGNORECASE):
        return "$100k department purchase"
    if re.search(r"\b20k\b|\$20k", fact, re.IGNORECASE):
        return "$20k Lumin PDF + Sign"
    if re.search(r"\$100\b", fact, re.IGNORECASE):
        return "$100/month/user"
    if re.search(r"cloud outage|refund", fact, re.IGNORECASE):
        return "Nov 2024 outage refund risk"
    if re.search(r"large discounts|negotiator", fact, re.IGNORECASE):
        return "Tough negotiator; strict at 20%"
    if re.search(r"mostly web3 and websites", fact, re.IGNORECASE):
        return "web3 + websites"
    if re.search(r"currently working on ALF Dashboard", fact, re.IGNORECASE):
        return "currently building ALF Dashboard"
    if re.search(r"TypeScript, Next\.js, Cloudflare", fact, re.IGNORECASE):
        return "TypeScript + Next.js + Cloudflare"
    if re.search(r"on-chain data|indexing|dynamic display", fact, re.IGNORECASE):
        return "on-chain dashboards; speed matters"
    if re.search(r"why Oblique fits", fact, re.IGNORECASE):
        return "fit: web3 dashboards + coaching"
    if re.search(r"integrating Oblique|Cloudflare Workers", fact, re.IGNORECASE):
        return "integration: Cloudflare + TypeScript"
    if re.search(r"live key facts|visual coaching|fast audio", fact, re.IGNORECASE):
        return "proof: live facts + coaching"
    fact = re.sub(r"\bcosts\s+", "", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\bper month per user\b", "/month/user", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\bProduct includes\s+", "", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\band AI Integration\b", "+ AI", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\bPDF reading, signing,\s*", "PDF reading + signing ", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\basks for large discounts\s*", "asks large discounts ", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\bupto\b", "up to", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\bas long as you are strict\b", "if strict", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\s+", " ", fact).strip(" .")
    words = fact.split()
    if len(words) > 9:
        fact = " ".join(words[:9]).rstrip(",;") + "..."
    return fact


def synthesize_fast_insight(reference_context: str, latest_segment: str) -> str:
    """Low-latency local hint generation from retrieved reference excerpts.

    This is intentionally simple and conservative: only emit short facts that
    already appeared in retrieved context, so the live overlay can update without
    waiting on another model call after transcription.
    """
    query_tokens = _expand_reference_query_tokens(set(_reference_tokens(latest_segment)), latest_segment)
    if not reference_context.strip() or not query_tokens:
        return ""

    scored: list[tuple[float, int, str]] = []
    for idx, raw_line in enumerate(reference_context.splitlines()):
        fact = _clean_reference_fact(raw_line)
        if not fact or fact.startswith("#"):
            continue
        lower_fact_raw = fact.lower()
        if lower_fact_raw in {"features include", "meeting plan", "intro", "kids, life", "ask about family"}:
            continue
        if lower_fact_raw.startswith("about "):
            continue
        if _is_reference_instruction_chunk(
            ReferenceChunk("candidate", fact, 0, 0, _reference_tokens(fact))
        ):
            continue

        fact_tokens = _reference_tokens(fact)
        overlap = query_tokens & fact_tokens
        if not overlap:
            continue

        score = float(len(overlap))
        lower_fact = fact.lower()
        lower_query = latest_segment.lower()
        profile_query = any(term in lower_query for term in ("jsteagle", "website", "profile", "builds", "make things"))
        stack_query = any(term in lower_query for term in ("stack", "tools", "typescript", "cloudflare", "next.js", "nextjs"))
        alf_query = "alf" in lower_query or "dashboard" in lower_query or "dashboards" in lower_query
        if profile_query and not stack_query and not alf_query:
            if not ("web3" in lower_fact and "websites" in lower_fact):
                continue
        if stack_query:
            if not any(term in lower_fact for term in ("tools listed", "current stack")):
                continue
        if alf_query and not stack_query:
            if not any(term in lower_fact for term in ("alf dashboard", "alf work", "on-chain", "indexing", "dynamic display", "efficiency and speed")):
                continue
        prior_spend_query = any(term in lower_query for term in ("before", "previous", "prior")) and any(
            term in lower_query for term in ("spend", "spent", "purchase", "bought")
        )
        if prior_spend_query and re.search(r"\b100k\b|\$100k|john doe|department", lower_fact):
            continue
        money_query = any(term in lower_query for term in (
            "cost", "price", "pricing", "expensive", "spend", "spent", "100k", "20k", "worth", "purchase", "bought", "buy"
        ))
        explicit_100k_query = re.search(r"\b100k\b|\$100k", lower_query) is not None
        feature_query = any(term in lower_query for term in ("feature", "include", "includes", "included", "product"))
        website_query = any(term in lower_query for term in (
            "website", "profile", "jsteagle", "stack", "tools", "alf", "dashboard", "web3"
        ))
        oblique_integration_query = any(term in lower_query for term in ("integrate", "integration")) and "oblique" in lower_query
        oblique_fit_query = any(term in lower_query for term in ("fit", "relevant", "proof")) and "oblique" in lower_query
        if oblique_integration_query and "integrating oblique" not in lower_fact:
            continue
        if oblique_fit_query and not any(term in lower_fact for term in ("why oblique fits", "technical sales coaching", "proof")):
            continue
        if explicit_100k_query and re.search(r"\$100\b|per month per user", lower_fact):
            continue
        if money_query and not re.search(r"[$€£]|\b\d+\s*(?:%|percent|k|m)\b|\bcost\b|\bspend\b|\bspent\b|\bbought\b|\bworth\b|\bdiscount\b", lower_fact):
            continue
        if money_query and "meeting with" in lower_fact and not re.search(r"[$€£]|\b\d+\s*(?:%|percent|k|m)\b", lower_fact):
            continue
        if feature_query and not alf_query and "alf work includes" in lower_fact:
            continue
        if _looks_like_reference_title(fact) and not re.search(r"\b(has|works|bought|cost|includes?|spend|\d+)\b", lower_fact):
            continue
        if "kids" in lower_query and "kids" not in lower_fact:
            continue
        if "work" in lower_query and "where" in lower_query and "works with" in lower_fact:
            continue
        if "work" in lower_query and not alf_query and not any(term in lower_fact for term in ("works for", "works with", "software engineer", "holdco")):
            continue
        if _looks_like_reference_title(fact):
            score -= 1.25
        if any(term in lower_query for term in ("cost", "price", "pricing", "expensive", "month", "user")):
            if re.search(r"[$€£]|\b\d+\s*(?:%|percent|k|m|per month|per user)\b", lower_fact):
                score += 4.0
        if any(term in lower_query for term in ("discount", "refund", "negotiate", "deal")):
            if re.search(r"\b\d+\s*%|\brefund\b|\bdiscount\b|\bnegotiator\b", lower_fact):
                score += 4.0
        if any(term in lower_query for term in ("feature", "include", "does it", "product")):
            if any(term in lower_fact for term in ("include", "feature", "pdf", "sign", "ai", "integration")):
                score += 2.0
            if any(term in latest_segment.lower() for term in ("include", "signing", "pdf", "ai")) and any(
                term in lower_fact for term in ("product includes", "pdf reading", "signing", "ai integration")
            ):
                score += 16.0
        if any(term in lower_query for term in ("who", "person", "justus", "family", "kids", "work")):
            if any(term in lower_fact for term in ("justus", "kids", "works", "friends", "software engineer")):
                score += 2.0
            if "kids" in lower_query and re.search(r"\bhas\s+\d+\s+kids\b", lower_fact):
                score += 5.0
            if "work" in lower_query and any(term in lower_fact for term in ("works for", "software engineer")):
                score += 4.0
            if "meeting with" in lower_fact:
                score -= 2.0
        if website_query:
            if "web3" in lower_fact and "websites" in lower_fact:
                score += 12.0
            if "currently working on alf dashboard" in lower_fact:
                score += 10.0
            if "tools listed" in lower_fact or "current stack" in lower_fact:
                score += 10.0
            if any(term in lower_fact for term in ("web3", "websites", "alf dashboard", "typescript", "cloudflare", "on-chain", "indexing")):
                score += 8.0
            if any(term in lower_fact for term in ("age 30", "has 3 kids", "works for holdco")):
                score -= 4.0
        if oblique_fit_query:
            if any(term in lower_fact for term in ("why oblique fits", "proof", "technical sales coaching")):
                score += 10.0
        if oblique_integration_query:
            if any(term in lower_fact for term in ("integrating oblique", "cloudflare workers", "typescript", "low-latency")):
                score += 12.0

        if score <= 0:
            continue
        scored.append((score, idx, _compact_reference_fact(fact, query_tokens)))

    if not scored:
        return ""

    scored.sort(key=lambda item: (-item[0], item[1]))
    facts: list[str] = []
    seen: set[str] = set()
    for _, _, fact in scored:
        short_fact = _short_overlay_fact(fact)
        normalized = short_fact.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        facts.append(short_fact)
            if len(facts) >= max(1, INSIGHT_FAST_MAX_ITEMS):
                break

    return "\n".join(f"• {fact}" for fact in facts)


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

# ISO 639-1 hint. Default to English so live chunks do not drift into auto-detected
# Chinese/other-language fragments during silence, accents, or short noisy audio.
_tl_hint = os.getenv("OPENAI_TRANSCRIBE_LANGUAGE", "en").strip().lower()
TRANSCRIBE_LANGUAGE_HINT: str | None = None if _tl_hint == "auto" else (_tl_hint or "en")

INSIGHT_MODEL = os.getenv("OPENAI_INSIGHT_MODEL", "gpt-4o-mini")
INSIGHT_DISABLED = os.getenv("INSIGHT_DISABLED", "0").strip().lower() in ("1", "true", "yes")
# By default do not duplicate insights on stderr; extension shows them in the page overlay.
INSIGHT_LOG_TERMINAL = os.getenv("INSIGHT_LOG_TERMINAL", "0").strip().lower() in ("1", "true", "yes")
WEBM_TRANSCRIBE_MIN_BYTES = int(os.getenv("WEBM_TRANSCRIBE_MIN_BYTES", "32000"))
FACE_MODEL = os.getenv("OPENAI_FACE_MODEL", "gpt-4o-mini")
FACE_DISABLED = os.getenv("FACE_DISABLED", "0").strip().lower() in ("1", "true", "yes")
FACE_IMAGE_MAX_BYTES = int(os.getenv("FACE_IMAGE_MAX_BYTES", "1500000"))
COACH_RAISED_VOICE_RMS = float(os.getenv("COACH_RAISED_VOICE_RMS", "0.035"))
COACH_OFFENSIVE_WORDS = {
    word.strip().lower()
    for word in os.getenv(
        "COACH_OFFENSIVE_WORDS",
        "fuck,shit,bitch,asshole,bastard,dick,cunt,damn,crap,slut,whore",
    ).split(",")
    if word.strip()
}

STRIP_FILLER_WORDS = os.getenv("STRIP_FILLER_WORDS", "1").strip().lower() not in ("0", "false", "no")
TRANSCRIPT_MIN_LATIN_RATIO = float(os.getenv("TRANSCRIPT_MIN_LATIN_RATIO", "0.7"))

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


def transcript_is_supported_language(text: str) -> bool:
    """Reject likely auto-detect drift before it pollutes retrieval."""
    letters = re.findall(r"[^\W\d_]", text, flags=re.UNICODE)
    if not letters:
        return False
    latin = re.findall(r"[A-Za-z]", text)
    return (len(latin) / max(1, len(letters))) >= TRANSCRIPT_MIN_LATIN_RATIO


def clean_transcript_text(text: str) -> str:
    cleaned = strip_filler_words(text.strip())
    if not transcript_is_supported_language(cleaned):
        logger.info("ignored transcript chunk with unsupported language/noise: %r", cleaned[:80])
        return ""
    return cleaned


def transcript_has_offensive_language(text: str) -> bool:
    if not text or not COACH_OFFENSIVE_WORDS:
        return False
    lower = text.lower()
    return any(
        re.search(rf"(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])", lower)
        for word in COACH_OFFENSIVE_WORDS
    )


def build_speech_coaching(
    text: str | None,
    audio_rms: Optional[float] = None,
) -> dict[str, object] | None:
    """Deterministic live coaching for language/tone before visual smoothing."""
    offensive = transcript_has_offensive_language(text or "")
    raised_voice = isinstance(audio_rms, (int, float)) and audio_rms >= COACH_RAISED_VOICE_RMS
    if not offensive and not raised_voice:
        return None
    if offensive and raised_voice:
        feedback = "Coach: Tone it down and lower your voice."
        reason = "language and volume"
    elif offensive:
        feedback = "Coach: Tone it down. Keep it professional."
        reason = "offensive wording"
    else:
        feedback = "Coach: Lower your voice and slow down."
        reason = "raised voice"
    return {
        "state": "warning",
        "confidence": 0.95,
        "reason": reason,
        "feedback": feedback,
    }


def transcribe_then_clean(
    audio: bytes,
    mime_type: str,
    filename: str,
    api_key: str,
) -> str:
    raw = transcribe_bytes(audio, mime_type, filename, api_key)
    return clean_transcript_text(raw)


def prepare_transcription_wav(audio: bytes, mime_type: str) -> bytes:
    """Return mono WAV optimized for speech recognition clarity."""
    if not audio:
        return b""
    if mime_type.startswith("audio/wav") and not TRANSCRIBE_NORMALIZE_AUDIO:
        return audio

    input_suffix = ".wav" if mime_type.startswith("audio/wav") else ".webm"
    with tempfile.TemporaryDirectory() as tmpdir:
        in_path = Path(tmpdir) / f"input{input_suffix}"
        out_path = Path(tmpdir) / "output.wav"
        in_path.write_bytes(audio)
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(in_path),
            "-vn",
            "-ac",
            str(max(1, TRANSCRIBE_CHANNELS)),
            "-ar",
            str(max(8000, TRANSCRIBE_SAMPLE_RATE)),
        ]
        if TRANSCRIBE_NORMALIZE_AUDIO and TRANSCRIBE_AUDIO_FILTERS:
            cmd.extend(["-af", TRANSCRIBE_AUDIO_FILTERS])
        cmd.extend(["-f", "wav", str(out_path)])
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc.returncode != 0 or not out_path.exists():
            err = proc.stderr.decode("utf-8", errors="ignore")
            logger.error("ffmpeg failed: %s", err)
            raise HTTPException(status_code=500, detail={"error": "ffmpeg_failed", "message": err})
        return out_path.read_bytes()


INSIGHT_REASON_SYSTEM = (
    "You support live captions. You receive RETRIEVED INTERNAL REFERENCE EXCERPTS plus the transcript.\n\n"
    "Output MUST be compact bullets only:\n"
    "- Use only facts supported by the retrieved reference excerpts. Do not guess from general knowledge.\n"
    "- Return 1-3 bullets. Each bullet starts with `• ` and has 3-8 words.\n"
    "- Use fragments, not full sentences. No paragraphs, headings, explanations, or markdown lists besides `•`.\n"
    "- Only include fields that match the new finalized segment topic.\n"
    "- No names, rapport, bios, or extra topics unless clearly named in this segment.\n"
    "- If the retrieved excerpts do not directly support useful keywords for this segment: output exactly: ok\n"
    "- Examples: `• $100/month/user`, `• max discount 20%`, `• PDF reading + signing + AI`."
)


def synthesize_insight(
    api_key: str,
    reference_doc: str,
    transcript_context: str,
    latest_segment: str,
) -> str:
    client = OpenAI(api_key=api_key)
    ref = reference_doc.strip() or "(no matching reference excerpts)"
    user_content = (
        "Make the smallest useful overlay hint. Match retrieved facts to the new segment only.\n\n"
        "### Retrieved reference excerpts (internal)\n"
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
        temperature=0.0,
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


@app.on_event("startup")
async def warm_reference_index() -> None:
    get_reference_document()
    logger.info("reference index ready | chunks=%s", len(REFERENCE_CHUNKS))


class IngestIn(BaseModel):
    audioB64: Optional[str] = None
    imageB64: Optional[str] = None
    filename: str = "audio.webm"
    source: str = "unknown"
    mimeType: Optional[str] = "audio/webm"
    imageMimeType: str = "image/jpeg"
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
    _args: dict = {
        "model": MODEL,
        "response_format": "json",
    }
    if TRANSCRIBE_LANGUAGE_HINT:
        _args["language"] = TRANSCRIBE_LANGUAGE_HINT

    if not mime_type.startswith("audio/wav") and len(audio) < WEBM_TRANSCRIBE_MIN_BYTES:
        return ""

    wav_bytes = prepare_transcription_wav(audio, mime_type)
    if not wav_bytes:
        return ""
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
        return {"state": "neutral", "confidence": 0.5, "reason": "empty_response"}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            return {"state": "neutral", "confidence": 0.5, "reason": "parse_failed"}
        try:
            data = json.loads(match.group(0))
        except json.JSONDecodeError:
            return {"state": "neutral", "confidence": 0.5, "reason": "parse_failed"}

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
    return {"state": state, "confidence": confidence, "reason": reason}


def analyze_face_image(api_key: str, image_b64: str, mime_type: str) -> dict[str, object]:
    client = OpenAI(api_key=api_key)
    data_url = f"data:{mime_type};base64,{image_b64}"
    prompt = (
        "Classify engagement from a single webcam face image. "
        "Output JSON only: {\"state\":\"bored|neutral|engaged\",\"confidence\":0-1,"
        "\"reason\":\"short phrase\"}. No extra text."
    )
    out = client.chat.completions.create(
        model=FACE_MODEL,
        temperature=0.0,
        max_tokens=120,
        messages=[
            {"role": "system", "content": "You are a compact engagement classifier."},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            },
        ],
    )
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
            ref_text = get_relevant_reference_context(text, ctx)
            insight = synthesize_fast_insight(ref_text, text, ctx)
            if not insight and ref_text and INSIGHT_LLM_FALLBACK:
                insight = await asyncio.to_thread(
                    synthesize_insight,
                    api_key,
                    ref_text,
                    ctx,
                    text,
                )
            elif not insight:
                insight = "ok"
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

    response: dict[str, object] = {"ok": True, "isFinal": True, "text": text, "insight": insight_reply}
    speech_coaching = build_speech_coaching(text, payload.audioRms)
    if speech_coaching:
        response["coach"] = speech_coaching
    return response


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
