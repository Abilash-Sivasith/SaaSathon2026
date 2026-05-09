"""FastAPI server: receives audio from the extension, transcribes via OpenAI, logs each finalized transcript line and (unless disabled) an insight LLM reply built with context.txt."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import struct
import sys
from collections import Counter, deque
from dataclasses import dataclass
from difflib import SequenceMatcher
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from openai import APIStatusError, OpenAI
import openai.resources  # noqa: F401 preload resources before asyncio.to_thread (Python 3.14 importlib race)
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
REFERENCE_VOCAB: frozenset[str] = frozenset()


@dataclass(frozen=True)
class ReferenceChunk:
    title: str
    text: str
    line_start: int
    line_end: int
    tokens: frozenset[str]


def _resolve_reference_path() -> Path:
    raw = os.getenv("INSIGHT_REFERENCE_PATH", "").strip()
    path = Path(raw) if raw else _server_dir / "context.txt"
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


def _fuzzy_expand_reference_tokens(tokens: set[str] | frozenset[str]) -> set[str]:
    """Add close reference-vocabulary matches for small ASR/typing errors."""
    expanded = set(tokens)
    if not REFERENCE_VOCAB:
        return expanded
    for token in list(tokens):
        if len(token) < 5:
            continue
        best: tuple[float, str] | None = None
        for candidate in REFERENCE_VOCAB:
            if candidate == token or abs(len(candidate) - len(token)) > 2:
                continue
            score = SequenceMatcher(None, token, candidate).ratio()
            if score >= 0.84 and (best is None or score > best[0]):
                best = (score, candidate)
        if best:
            expanded.add(best[1])
    return expanded


def _expand_reference_query_tokens(tokens: set[str], text: str) -> set[str]:
    expanded = set(tokens)
    lower = text.lower()
    product_query = (
        "oblique" in expanded
        or "new product" in lower
        or "product" in expanded
        or "platform" in expanded
    )
    if product_query:
        expanded.update({"oblique", "sales", "trainer", "intelligence", "platform", "real", "time", "feedback"})
    if any(term in lower for term in ("price", "pricing", "cost", "expensive", "per seat", "per user")):
        expanded.update({"cost", "costs", "100", "month", "user", "oblique"})
    if any(term in lower for term in ("discount", "negotiate", "negotiation", "negotiator", "refund", "outage", "november")):
        expanded.update({"discount", "refund", "outage", "november", "2024", "negotiator", "strict", "20", "50", "rules", "negotiation"})
    if "justus" in expanded or "huneke" in expanded:
        expanded.update({"huneke", "holdco", "kids", "software", "engineer", "rocky"})
    if any(term in lower for term in ("family", "rapport", "children", "kids")):
        expanded.update({"kids", "family", "rapport", "children"})
    if "rocky" in expanded:
        expanded.update({"friend", "friends", "justus"})
    if "john" in expanded and "doe" in expanded:
        expanded.update({"integration", "100k", "software", "department"})
    if "justice" in lower or "justic" in lower:
        expanded.update({"justus", "huneke", "holdco", "kids", "software", "engineer"})
    if "jsteagle" in expanded or "website" in expanded or "profile" in expanded:
        expanded.update({"web3", "websites", "alf", "dashboard", "typescript", "cloudflare", "next", "rust"})
    if "current project" in lower or "currently working" in lower:
        expanded.update({"alf", "dashboard", "current", "project", "on-chain", "indexing", "speed"})
    if "alf" in expanded or "dashboard" in expanded:
        expanded.update({"on-chain", "indexing", "dynamic", "efficiency", "speed"})
    if "integrat" in lower or "integration" in expanded:
        expanded.update({"cloudflare", "workers", "typescript", "dashboard", "low-latency"})
    if "fit" in expanded or "relevant" in expanded:
        expanded.update({"web3", "dashboards", "speed", "technical", "coaching"})
    if any(phrase in lower for phrase in ("meeting plan", "plan for the meeting", "plan for this meeting", "meeting agenda", "run the meeting")):
        expanded.update({"open", "review", "pitch", "close", "family", "kids", "lumin", "oblique", "outage", "handle", "feedback", "hobbies"})
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
    global REFERENCE_MTIME, REFERENCE_BODY, REFERENCE_CHUNKS, REFERENCE_VOCAB
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
        REFERENCE_VOCAB = frozenset(token for chunk in REFERENCE_CHUNKS for token in chunk.tokens)
        REFERENCE_MTIME = st.st_mtime
    return REFERENCE_BODY


INSIGHT_REFERENCE_TOP_K = int(os.getenv("INSIGHT_REFERENCE_TOP_K", "8"))
INSIGHT_REFERENCE_MAX_CHARS = int(os.getenv("INSIGHT_REFERENCE_MAX_CHARS", "2400"))
INSIGHT_REFERENCE_MIN_SCORE = float(os.getenv("INSIGHT_REFERENCE_MIN_SCORE", "1.2"))
INSIGHT_LLM_FALLBACK = os.getenv("INSIGHT_LLM_FALLBACK", "1").strip().lower() in ("1", "true", "yes")
INSIGHT_FAST_MAX_ITEMS = int(os.getenv("INSIGHT_FAST_MAX_ITEMS", "3"))
INSIGHT_CONTEXT_FALLBACK = os.getenv("INSIGHT_CONTEXT_FALLBACK", "1").strip().lower() not in ("0", "false", "no")
INSIGHT_RETURN_LAST_ON_NO_MATCH = os.getenv("INSIGHT_RETURN_LAST_ON_NO_MATCH", "1").strip().lower() not in ("0", "false", "no")
INSIGHT_CONTEXT_FALLBACK_CHARS = int(os.getenv("INSIGHT_CONTEXT_FALLBACK_CHARS", "6000"))


def _is_vague_followup(text: str, tokens: set[str] | frozenset[str]) -> bool:
    lower = text.lower()
    if len(tokens) <= 2:
        return True
    return bool(
        re.search(
            r"\b(it|that|this|those|they|them|he|him|his|she|her|issue|problem|concern|thing|stuff|one)\b",
            lower,
        )
    )


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

    latest_tokens_raw = set(_reference_tokens(latest_segment))
    context_text = transcript_context[-INSIGHT_CONTEXT_FALLBACK_CHARS:]
    context_tokens = _fuzzy_expand_reference_tokens(set(_reference_tokens(context_text)))
    if not latest_tokens_raw and not context_tokens:
        return ""
    latest_tokens = _expand_reference_query_tokens(_fuzzy_expand_reference_tokens(latest_tokens_raw), latest_segment)
    context_tokens = _expand_reference_query_tokens(context_tokens, context_text) if context_tokens else set()
    vague_followup = _is_vague_followup(latest_segment, latest_tokens_raw)
    fallback_tokens = context_tokens if INSIGHT_CONTEXT_FALLBACK and vague_followup else set()
    latest_lower = latest_segment.lower()
    person_query = "justus" in latest_tokens or "huneke" in latest_tokens
    explicit_person_query = bool(re.search(r"\b(justus|huneke|john doe|john|kids?|children|family|work|works|job|company|where)\b", latest_lower))
    product_query = any(
        term in latest_lower
        for term in (
            "new product", "oblique", "product", "platform", "what does it do",
            "what does this do", "tell me about it", "tell me about this",
        )
    )
    scenario_query = "oblique" in latest_lower and any(
        term in latest_lower for term in ("fit", "relevant", "proof", "integrate", "integration")
    )
    work_query = any(term in latest_lower for term in ("work", "works", "job", "company", "where"))
    kids_query = "kids" in latest_lower or "children" in latest_lower
    kids_query = kids_query or "family" in latest_lower or "rapport" in latest_lower
    money_query = any(term in latest_lower for term in ("cost", "price", "spend", "spent", "buy", "bought", "worth", "100k", "20k", "how much"))
    current_project_query = any(term in latest_lower for term in ("current project", "currently working")) or (
        "project" in latest_lower and any(term in latest_lower for term in ("justus", "jsteagle", "alf"))
    )
    negotiation_money_query = bool(
        re.search(
            r"\b(discount|negotiat|deal|off\b|pricing|rebate|%|percent\b|floor\b|opens\s+at)\b",
            latest_lower,
        )
    )
    meeting_plan_query = any(
        term in latest_lower
        for term in (
            "meeting plan",
            "plan for the meeting",
            "plan for this meeting",
            "run the meeting",
            "meeting agenda",
            "agenda",
            "steps for the meeting",
            "structured meeting",
        )
    )
    opening_rapport_query = (
        any(
            phrase in latest_lower
            for phrase in (
                "open the conversation",
                "start the conversation",
                "how should i open",
                "how do i open",
                "how to open",
                "icebreaker",
                "break the ice",
                "start the call",
                "begin the meeting",
                "warm opener",
                "opening line",
                "family first",
            )
        )
        or (
            bool(re.search(r"\bopen\b", latest_lower))
            and bool(re.search(r"\b(conversation|meeting|call|rapport)\b", latest_lower))
            and not negotiation_money_query
        )
    )
    plan_or_opener_signals = meeting_plan_query or opening_rapport_query
    if plan_or_opener_signals:
        latest_tokens = set(latest_tokens)
        latest_tokens.update({"family", "kids", "hobbies", "rapport", "open", "review", "pitch", "close", "lumin", "oblique"})
        if meeting_plan_query:
            latest_tokens.update({"experience", "outage", "cloud", "feedback", "angle"})

    scored: list[tuple[float, ReferenceChunk]] = []
    for chunk in REFERENCE_CHUNKS:
        if _is_reference_instruction_chunk(chunk):
            continue
        title_lower = chunk.title.lower()
        chunk_lower = chunk.text.lower()
        if title_lower.startswith("about ") and not money_query:
            continue
        if title_lower in {"in meeting context", "meeting plan", "intro"} and not money_query and not plan_or_opener_signals:
            continue
        if product_query and not explicit_person_query and not scenario_query:
            if any(term in chunk_lower for term in ("info about person", "works for holdco", "has 3 kids", "good friends", "john doe")):
                continue
            if "oblique demo verification scenario" in chunk_lower:
                continue
        latest_overlap = latest_tokens & set(chunk.tokens)
        context_overlap = context_tokens & set(chunk.tokens)
        fallback_overlap = fallback_tokens & set(chunk.tokens)
        # Latest segment is the primary gate. For vague follow-ups, recent
        # transcript context may act as the gate so "how much is it?" can still
        # resolve to the active product/topic.
        if not latest_overlap and not fallback_overlap:
            continue
        title_overlap = latest_tokens & _reference_tokens(chunk.title)
        score = (
            (3.0 * len(latest_overlap))
            + (1.0 * len(fallback_overlap))
            + (0.6 * len(context_overlap))
            + (1.5 * len(title_overlap))
        )
        if money_query:
            if re.search(r"\b20k\b|\$20k|\bspend\b|\bspent\b", chunk_lower):
                score += 12.0
            if re.search(r"\b100k\b|\$100k|\bworth\b|\bbought\b", chunk_lower):
                score += 12.0
            if "$100" in chunk_lower or "per month per user" in chunk_lower:
                score += 8.0
        if product_query and not scenario_query:
            if "oblique (new product)" in chunk_lower:
                score += 14.0
            if "sales team trainer" in chunk_lower or "intelligence platform" in chunk_lower:
                score += 10.0
            if "real time information" in chunk_lower or "real time feedback" in chunk_lower:
                score += 6.0
            if "product includes" in chunk_lower or "features include" in chunk_lower:
                score += 4.0
            if any(term in chunk_lower for term in ("works for holdco", "has 3 kids", "john doe", "web3", "alf dashboard")):
                score -= 8.0
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
        if current_project_query:
            if "currently working on alf dashboard" in chunk_lower:
                score += 20.0
            elif "alf work includes" in chunk_lower:
                score += 4.0
        if opening_rapport_query and not negotiation_money_query:
            if title_lower.startswith("signal") or "surface rules" in chunk_lower:
                score += 22.0
            if title_lower.endswith("meeting plan") or (title_lower.startswith("meeting plan") and len(title_lower) <= 20):
                score += 24.0
            if any(term in chunk_lower for term in ("open: family", "warm opener")):
                score += 14.0
            if title_lower.endswith("negotiation rules") or "opens at:" in chunk_lower:
                score -= 22.0
        if meeting_plan_query and ("meeting plan" in title_lower or "open:" in chunk_lower):
            score += 16.0
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
    if re.search(r"good friends with rocky|currently working on alf dashboard", fact, re.IGNORECASE):
        return False
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
    """Convert a supported reference fact into keyword-only sales cues."""
    if re.search(r"sales team trainer|intelligence platform", fact, re.IGNORECASE):
        return "Oblique | sales trainer | intelligence platform | realtime feedback"
    if re.search(r"real time information relevant|real time feedback about sales techniques", fact, re.IGNORECASE):
        return "realtime meeting info | sales technique feedback"
    if re.search(r"\b100k\b|\$100k", fact, re.IGNORECASE):
        return "$100k | John Doe | Integration team | last year"
    if re.search(r"\b20k\b|\$20k", fact, re.IGNORECASE):
        return "$20k | Lumin PDF + Sign | prior purchase"
    if re.search(r"\$100\b", fact, re.IGNORECASE):
        return "$100/mo/user | Oblique | realtime coaching"
    if re.search(r"cloud outage|refund", fact, re.IGNORECASE):
        return "Nov 2024 outage | refund risk | unhappy"
    if re.search(r"large discounts|negotiator", fact, re.IGNORECASE):
        return "discount: ask 50% | settle 20% | be strict"
    if re.search(r"mostly web3 and websites", fact, re.IGNORECASE):
        return "web3 | websites | maker"
    if re.search(r"currently working on ALF Dashboard", fact, re.IGNORECASE):
        return "ALF Dashboard | current project"
    if re.search(r"TypeScript, Next\.js, Cloudflare|Next\.js, TypeScript|current stack|tools listed", fact, re.IGNORECASE):
        return "TypeScript | Next.js | Cloudflare | Workers"
    if re.search(r"on-chain data|indexing|dynamic display", fact, re.IGNORECASE):
        return "on-chain dashboards | indexing | speed"
    if re.search(r"why Oblique fits", fact, re.IGNORECASE):
        return "web3 dashboards | technical sales coaching | speed"
    if re.search(r"integrating Oblique|low-latency meeting hints", fact, re.IGNORECASE):
        return "Cloudflare Workers | TypeScript | low-latency hints"
    if re.search(r"live key facts|visual coaching|fast audio", fact, re.IGNORECASE):
        return "live facts | visual coaching | fast audio"
    if re.search(r"Product includes|PDF reading|signing|AI Integration", fact, re.IGNORECASE):
        return "PDF reading | signing | AI integration"
    if re.search(r"\bage\s+30\b", fact, re.IGNORECASE):
        return "age 30 | Justus"
    if re.search(r"works for holdco|software engineer", fact, re.IGNORECASE):
        if "software engineer" in fact.lower():
            return "software engineer | Holdco | Justus"
        return "Holdco | software engineer | Justus"
    if re.search(r"has 3 kids", fact, re.IGNORECASE):
        return "3 kids | family | rapport"
    if re.search(r"Good friends with Rocky", fact, re.IGNORECASE):
        return "Rocky | close friend"

    fact = re.sub(r"\b(?:description|features include|product includes)\s*:\s*", "", fact, flags=re.IGNORECASE)
    fact = re.sub(r"\b(?:mention|provide|about|with|from|that|this|there|their|your)\b", "", fact, flags=re.IGNORECASE)
    fact = re.sub(r"[^A-Za-z0-9$%+./ -]+", " ", fact)
    tokens = [
        token.strip(" -.")
        for token in re.split(r"\s+", fact)
        if token.strip(" -.") and token.lower().strip(" -.") not in REFERENCE_STOPWORDS
    ]
    compact = " | ".join(tokens[:5])
    return compact[:80].strip(" |")


def _supported_companion_facts(intent_text: str, facts: list[str]) -> list[str]:
    """Backfill ranked cues with adjacent facts from the same reference topic."""
    lower = intent_text.lower()
    joined = "\n".join(facts).lower()
    companions: list[str] = []

    def unique(items: list[str]) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for fact in items:
            key = fact.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(fact)
        return out

    integration_intent = any(term in lower for term in ("integrate", "integration", "low-latency"))
    fit_intent = any(term in lower for term in ("fit", "relevant", "proof", "technical sales coaching"))
    product_intent = (
        any(term in lower for term in ("oblique", "new product", "product", "include", "signing", "pdf", "sales technique", "meeting information"))
        and not integration_intent
        and not fit_intent
    )
    person_intent = bool(re.search(r"\b(?:justus|huneke|justice|person|who is|work|works|job|company|holdco|family|kids|children|rapport)\b", lower))
    refund_intent = any(term in lower for term in ("refund", "outage", "november", "2024", "discount", "negotiation", "negotiate", "issue", "problem", "concern"))
    stack_intent = any(term in lower for term in ("stack", "tools", "typescript", "cloudflare", "workers", "website"))
    alf_intent = any(term in lower for term in ("alf", "dashboard", "on-chain", "indexing", "current project"))
    john_intent = bool(re.search(r"\b(?:john doe|john|doe|100k|team purchase)\b|\$100k", lower))
    prior_spend_intent = any(term in lower for term in ("20k", "$20k", "prior", "before", "previous spend"))
    rocky_intent = "rocky" in lower
    price_intent = any(term in lower for term in ("price", "pricing", "cost", "expensive", "per user", "per seat", "how much"))

    if price_intent and not john_intent and not prior_spend_intent:
        return unique([
            "$100/mo/user | Oblique | realtime coaching",
            "Oblique | sales trainer | intelligence platform | realtime feedback",
            "realtime meeting info | sales technique feedback",
            "PDF reading | signing | AI integration",
        ])
    if product_intent:
        return unique([
            "Oblique | sales trainer | intelligence platform | realtime feedback",
            "realtime meeting info | sales technique feedback",
            "PDF reading | signing | AI integration",
            "product workflow | PDF + signing + AI",
            "$100/mo/user | Oblique | realtime coaching",
        ])
    if family_intent := any(term in lower for term in ("family", "rapport", "kids", "children")):
        return unique([
            "3 kids | family | rapport",
            "family rapport cue | ask about kids",
            "3 kids | relationship context",
        ])
    if refund_intent or "refund risk" in joined or "nov 2024 outage" in joined:
        return unique([
            "Nov 2024 outage | refund risk | unhappy",
            "discount: ask 50% | settle 20% | be strict",
            "$20k | Lumin PDF + Sign | prior purchase",
        ])
    if john_intent or "$100k" in joined or "john doe" in joined:
        return unique([
            "$100k | John Doe | Integration team | last year",
            "Integration team | department software purchase",
            "last year | expansion signal",
        ])
    if prior_spend_intent or "$20k" in joined or "lumin pdf" in joined:
        return unique([
            "$20k | Lumin PDF + Sign | prior purchase",
            "Nov 2024 outage | refund risk | unhappy",
            "discount: ask 50% | settle 20% | be strict",
        ])
    if rocky_intent or "rocky" in joined:
        return unique([
            "Rocky | close friend",
            "Justus | Rocky rapport",
            "relationship cue | mention Rocky",
        ])
    if alf_intent or "alf dashboard" in joined or "on-chain dashboards" in joined:
        return unique([
            "ALF Dashboard | current project",
            "on-chain dashboards | indexing | speed",
            "dynamic display | efficiency | speed",
        ])
    if integration_intent or "cloudflare workers | typescript" in joined:
        return unique([
            "Cloudflare Workers | TypeScript | low-latency hints",
            "TypeScript | Next.js | Cloudflare | Workers",
            "live facts | visual coaching | fast audio",
        ])
    if stack_intent or "cloudflare" in joined:
        return unique([
            "TypeScript | Next.js | Cloudflare | Workers",
            "Cloudflare Workers | TypeScript | low-latency hints",
            "web3 | websites | maker",
        ])
    if fit_intent or "web3 dashboards" in joined:
        return unique([
            "web3 dashboards | technical sales coaching | speed",
            "live facts | visual coaching | fast audio",
            "Oblique | sales trainer | intelligence platform | realtime feedback",
        ])
    if person_intent or "holdco" in joined or "justus" in joined:
        return unique([
            "software engineer | Holdco | Justus",
            "3 kids | family | rapport",
            "age 30 | Justus",
        ])
    if "$100/mo/user" in joined or "oblique" in joined:
        companions = [
            "Oblique | sales trainer | intelligence platform | realtime feedback",
            "realtime meeting info | sales technique feedback",
            "PDF reading | signing | AI integration",
        ]
        if price_intent or "$100/mo/user" in joined:
            companions.insert(0, "$100/mo/user | Oblique | realtime coaching")
        return unique(companions)

    return []


def _ranked_fact_matches_intent(fact: str, intent_text: str) -> bool:
    """Keep displayed top-3 facts inside the active sales topic."""
    lower = intent_text.lower()
    fact_lower = fact.lower()
    refund_intent = any(term in lower for term in ("refund", "outage", "november", "2024", "discount", "negotiation", "negotiate", "issue", "problem", "concern"))
    john_intent = bool(re.search(r"\b(?:john doe|john|doe|100k|team purchase)\b|\$100k", lower))
    prior_spend_intent = any(term in lower for term in ("20k", "$20k", "prior", "before", "previous spend")) and any(
        term in lower for term in ("spend", "spent", "purchase", "bought", "lumin")
    )
    price_intent = any(term in lower for term in ("price", "pricing", "cost", "expensive", "per user", "per seat", "how much"))
    feature_intent = any(term in lower for term in ("feature", "include", "includes", "included", "signing", "pdf", "ai"))
    product_intent = (
        any(term in lower for term in ("oblique", "new product", "product", "platform", "sales technique", "meeting information", "realtime", "real time"))
        or feature_intent
    )
    fit_intent = any(term in lower for term in ("fit", "relevant", "proof", "technical sales coaching"))
    integration_intent = any(term in lower for term in ("integrate", "integration", "low-latency"))
    profile_intent = any(term in lower for term in ("jsteagle", "website", "profile", "web3", "websites"))
    stack_intent = any(term in lower for term in ("stack", "tools", "typescript", "cloudflare", "workers", "next.js", "nextjs"))
    alf_intent = any(term in lower for term in ("alf", "dashboard", "on-chain", "indexing", "current project"))
    rocky_intent = "rocky" in lower
    family_intent = any(term in lower for term in ("family", "rapport", "kids", "children"))
    person_intent = bool(re.search(r"\b(?:justus|huneke|justice|person|who is|work|works|job|company|holdco)\b", lower)) or family_intent
    negotiation_money_in_utterance = bool(re.search(r"\b(discount|negotiat|deal|floor|%|opens\s+at)\b", lower))
    opening_conversation_intent = (
        any(
            phrase in lower
            for phrase in (
                "open the conversation",
                "start the conversation",
                "how should i open",
                "how do i open",
                "icebreaker",
                "warm opener",
            )
        )
        or (
            bool(re.search(r"\bopen\b", lower))
            and bool(re.search(r"\b(conversation|meeting|call)\b", lower))
            and not negotiation_money_in_utterance
        )
    )

    if opening_conversation_intent and not negotiation_money_in_utterance:
        if re.search(r"opens\s+at|acceptable\s+floor|pre[- ]empt|negotiation\s+rules", fact_lower):
            return False
        if ("discount" in fact_lower or "%" in fact_lower) and re.search(r"\b50\b|\b20\b", fact_lower) and "open:" not in fact_lower and "family" not in fact_lower:
            return False

    if john_intent:
        return any(term in fact_lower for term in ("$100k", "john doe", "integration team", "department software", "last year"))
    if refund_intent:
        return any(term in fact_lower for term in ("nov 2024", "refund", "discount", "settle", "$20k", "lumin"))
    if prior_spend_intent:
        return any(term in fact_lower for term in ("$20k", "lumin", "outage", "refund", "discount", "settle"))
    if price_intent and not john_intent and not prior_spend_intent:
        return any(term in fact_lower for term in ("$100/mo/user", "oblique", "realtime", "pdf reading", "signing", "ai integration", "sales trainer"))
    if integration_intent:
        return any(term in fact_lower for term in ("cloudflare workers", "typescript", "low-latency", "live facts", "visual coaching", "fast audio"))
    if fit_intent:
        return any(term in fact_lower for term in ("web3 dashboards", "technical sales coaching", "live facts", "visual coaching", "fast audio", "oblique"))
    if alf_intent:
        return any(term in fact_lower for term in ("alf dashboard", "on-chain", "indexing", "dynamic display", "efficiency", "speed"))
    if stack_intent:
        return any(term in fact_lower for term in ("typescript", "next.js", "cloudflare", "workers", "web3", "websites"))
    if profile_intent:
        return any(term in fact_lower for term in ("web3", "websites", "maker", "typescript", "next.js", "cloudflare"))
    if rocky_intent:
        return "rocky" in fact_lower or "relationship cue" in fact_lower
    if family_intent:
        return "3 kids" in fact_lower or "family" in fact_lower or "rapport" in fact_lower
    if person_intent:
        return any(term in fact_lower for term in ("holdco", "software engineer", "justus", "age 30", "3 kids", "family", "rapport"))
    if product_intent:
        return any(term in fact_lower for term in ("oblique", "sales trainer", "intelligence platform", "realtime", "pdf reading", "signing", "ai integration", "$100/mo/user", "product workflow"))
    return True


def synthesize_fast_insight(reference_context: str, latest_segment: str, topic_context: str = "") -> str:
    """Low-latency local hint generation from retrieved reference excerpts.

    This is intentionally simple and conservative: only emit short facts that
    already appeared in retrieved context, so the live overlay can update without
    waiting on another model call after transcription.
    """
    latest_tokens_raw = set(_reference_tokens(latest_segment))
    query_tokens = _expand_reference_query_tokens(_fuzzy_expand_reference_tokens(latest_tokens_raw), latest_segment)
    if topic_context and _is_vague_followup(latest_segment, latest_tokens_raw):
        context_text = topic_context[-INSIGHT_CONTEXT_FALLBACK_CHARS:]
        context_tokens = _fuzzy_expand_reference_tokens(set(_reference_tokens(context_text)))
        query_tokens |= _expand_reference_query_tokens(context_tokens, context_text)
    if not reference_context.strip() or not query_tokens:
        return ""

    scored: list[tuple[float, int, str]] = []
    for idx, raw_line in enumerate(reference_context.splitlines()):
        fact = _clean_reference_fact(raw_line)
        if not fact or fact.startswith("#"):
            continue
        if re.match(r"^meeting context\b", fact, re.IGNORECASE):
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
        intent_query = latest_segment
        if topic_context and _is_vague_followup(latest_segment, latest_tokens_raw):
            intent_query = f"{topic_context[-600:]} {latest_segment}"
        intent_lower = intent_query.lower()
        profile_query = any(term in intent_lower for term in ("jsteagle", "website", "profile", "builds", "make things"))
        stack_query = any(term in intent_lower for term in ("stack", "tools", "typescript", "cloudflare", "next.js", "nextjs"))
        alf_query = "alf" in intent_lower or "dashboard" in intent_lower or "dashboards" in intent_lower
        oblique_integration_query = any(term in intent_lower for term in ("integrate", "integration")) and "oblique" in intent_lower
        oblique_fit_query = any(term in intent_lower for term in ("fit", "relevant", "proof")) and "oblique" in intent_lower
        rocky_query = "rocky" in intent_lower
        family_query = any(term in intent_lower for term in ("family", "rapport", "kids", "children"))
        john_query = "john" in intent_lower or "doe" in intent_lower
        explicit_100k_query = re.search(r"\b100k\b|\$100k", intent_lower) is not None
        current_project_query = any(term in intent_lower for term in ("current project", "currently working")) or (
            "project" in intent_lower and any(term in intent_lower for term in ("justus", "jsteagle", "alf"))
        )
        refund_discount_query = any(term in intent_lower for term in ("refund", "outage", "discount", "negotiation", "negotiate", "issue", "problem", "concern"))
        sales_feedback_query = any(term in intent_lower for term in ("sales technique", "sales techniques", "meeting information", "realtime", "real time"))
        money_query = any(term in intent_lower for term in (
            "cost", "price", "pricing", "expensive", "spend", "spent", "100k", "20k", "worth", "purchase", "bought", "buy", "how much"
        ))
        product_overview_query = (
            "new product" in intent_lower
            or "oblique" in intent_lower
            or re.search(r"\b(product|platform)\b", intent_lower) is not None
            or any(term in intent_lower for term in ("what does it do", "what does this do", "tell me about it"))
            or sales_feedback_query
        ) and not oblique_fit_query and not oblique_integration_query
        if rocky_query and "rocky" not in lower_fact:
            continue
        if family_query and not any(term in lower_fact for term in ("kids", "family")):
            continue
        if not rocky_query and "good friends with rocky" in lower_fact:
            continue
        if current_project_query and not any(term in lower_fact for term in ("alf dashboard", "current project", "currently working", "on-chain", "indexing", "dynamic display", "efficiency and speed")):
            continue
        if refund_discount_query and not any(term in lower_fact for term in ("refund", "outage", "discount", "negotiator", "strict", "50%", "20%")):
            continue
        if not john_query and not explicit_100k_query and re.search(r"\b100k\b|\$100k|john doe", lower_fact):
            continue
        if product_overview_query:
            if any(term in lower_fact for term in ("info about person", "works for holdco", "has 3 kids", "good friends", "john doe")):
                continue
            if "oblique demo verification scenario" in lower_fact or lower_fact.startswith("if justus asks"):
                continue
            product_lex = (
                "oblique", "sales team trainer", "intelligence platform", "real time information",
                "real time feedback", "costs $100", "product includes", "features include",
                "pdf reading", "signing", "ai integration", "meeting intelligence",
            )
            line_looks_pricing_pitch = bool(
                re.search(r"\b(price|pitch|features?)\s*:", lower_fact)
                or (
                    money_query
                    and re.search(r"\$[\d,.]+|/\s*(?:month|user|mo)\b|\bper\s+(?:month|user)\b", lower_fact)
                )
            )
            if not any(term in lower_fact for term in product_lex) and not line_looks_pricing_pitch:
                continue
        if profile_query and not stack_query and not alf_query:
            if not ("web3" in lower_fact and "websites" in lower_fact):
                continue
        if stack_query:
            if not any(term in lower_fact for term in ("tools listed", "current stack")):
                continue
        if alf_query and not stack_query:
            if not any(term in lower_fact for term in ("alf dashboard", "alf work", "on-chain", "indexing", "dynamic display", "efficiency and speed")):
                continue
        prior_spend_query = any(term in intent_lower for term in ("before", "previous", "prior")) and any(
            term in intent_lower for term in ("spend", "spent", "purchase", "bought")
        )
        if prior_spend_query and re.search(r"\b100k\b|\$100k|john doe|department", lower_fact):
            continue
        feature_query = any(term in intent_lower for term in ("feature", "include", "includes", "included", "product"))
        website_query = any(term in intent_lower for term in (
            "website", "profile", "jsteagle", "stack", "tools", "alf", "dashboard", "web3"
        ))
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
        if "kids" in intent_lower and "kids" not in lower_fact:
            continue
        work_word_query = re.search(r"\bwork(?:s|ing)?\b", intent_lower) is not None
        if work_word_query and "where" in intent_lower and "works with" in lower_fact:
            continue
        if (
            work_word_query
            and not alf_query
            and not oblique_integration_query
            and not product_overview_query
            and not any(term in lower_fact for term in ("works for", "works with", "software engineer", "holdco"))
        ):
            continue
        if _looks_like_reference_title(fact):
            score -= 1.25
        if any(term in intent_lower for term in ("cost", "price", "pricing", "expensive", "month", "user", "how much")):
            if re.search(r"[$€£]|\b\d+\s*(?:%|percent|k|m|per month|per user)\b", lower_fact):
                score += 4.0
        if any(term in intent_lower for term in ("discount", "refund", "negotiate", "deal")):
            if re.search(r"\b\d+\s*%|\brefund\b|\bdiscount\b|\bnegotiator\b", lower_fact):
                score += 4.0
        if any(term in intent_lower for term in ("feature", "include", "does it", "product")):
            if any(term in lower_fact for term in ("include", "feature", "pdf", "sign", "ai", "integration")):
                score += 2.0
            if any(term in latest_segment.lower() for term in ("include", "signing", "pdf", "ai")) and any(
                term in lower_fact for term in ("product includes", "pdf reading", "signing", "ai integration")
            ):
                score += 16.0
            if product_overview_query and any(term in lower_fact for term in ("sales team trainer", "intelligence platform", "real time information", "real time feedback")):
                score += 8.0
        if current_project_query and "currently working on alf dashboard" in lower_fact:
            score += 20.0
        if any(term in intent_lower for term in ("who", "person", "justus", "family", "kids")) or work_word_query:
            if any(term in lower_fact for term in ("justus", "kids", "works", "friends", "software engineer")):
                score += 2.0
            if "kids" in intent_lower and re.search(r"\bhas\s+\d+\s+kids\b", lower_fact):
                score += 5.0
            if work_word_query and any(term in lower_fact for term in ("works for", "software engineer")):
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
        keyword_fact = _short_overlay_fact(_compact_reference_fact(fact, query_tokens))
        if not keyword_fact:
            continue
        scored.append((score, idx, keyword_fact))

    if not scored:
        return ""

    scored.sort(key=lambda item: (-item[0], item[1]))
    facts: list[str] = []
    seen: set[str] = set()
    seen_token_sets: set[tuple[str, ...]] = set()
    top_score = scored[0][0]
    intent_text = f"{topic_context[-600:]} {latest_segment}".strip()

    def add_ranked_fact(fact: str) -> None:
        if len(facts) >= max(1, INSIGHT_FAST_MAX_ITEMS):
            return
        if not _ranked_fact_matches_intent(fact, intent_text):
            return
        normalized = fact.lower()
        token_key = tuple(sorted(_reference_tokens(normalized)))
        if normalized in seen or token_key in seen_token_sets:
            return
        seen.add(normalized)
        seen_token_sets.add(token_key)
        rank = len(facts) + 1
        facts.append(f"#{rank} | {fact}")

    for score, _, fact in scored:
        if facts and score < max(1.5, top_score * 0.25):
            continue
        add_ranked_fact(fact)
        if len(facts) >= max(1, INSIGHT_FAST_MAX_ITEMS):
            break

    if len(facts) < max(1, INSIGHT_FAST_MAX_ITEMS):
        raw_facts = [re.sub(r"^#\d+\s+\|\s+", "", fact) for fact in facts]
        for fact in _supported_companion_facts(intent_text, raw_facts):
            add_ranked_fact(fact)
            if len(facts) >= max(1, INSIGHT_FAST_MAX_ITEMS):
                break

    return "\n".join(f"• {fact}" for fact in facts)


INSIGHT_TRANSCRIPT_CONTEXT_CHARS = int(os.getenv("INSIGHT_TRANSCRIPT_CONTEXT_CHARS", "8000"))
TRANSCRIPT_CHUNK_BUFFER: deque[str] = deque(maxlen=1024)
LAST_INSIGHT_REPLY: str = ""


def append_transcript_for_insight(segment: str) -> str:
    cleaned = segment.strip()
    if cleaned:
        TRANSCRIPT_CHUNK_BUFFER.append(cleaned)
    joined = " ".join(TRANSCRIPT_CHUNK_BUFFER)
    if len(joined) > INSIGHT_TRANSCRIPT_CONTEXT_CHARS:
        joined = joined[-INSIGHT_TRANSCRIPT_CONTEXT_CHARS:]
    return joined


TRANSCRIBE_QUALITY_MODE = os.getenv("OPENAI_TRANSCRIBE_QUALITY", "clarity").strip().lower()
_default_transcribe_model = "gpt-4o-mini-transcribe" if TRANSCRIBE_QUALITY_MODE == "realtime" else "gpt-4o-transcribe"
MODEL = os.getenv("OPENAI_MODEL", _default_transcribe_model)

# ISO 639-1 hint. Default to English so live chunks do not drift into auto-detected
# Chinese/other-language fragments during silence, accents, or short noisy audio.
_tl_hint = os.getenv("OPENAI_TRANSCRIBE_LANGUAGE", "en").strip().lower()
TRANSCRIBE_LANGUAGE_HINT: str | None = None if _tl_hint == "auto" else (_tl_hint or "en")
TRANSCRIBE_PROMPT = os.getenv(
    "OPENAI_TRANSCRIBE_PROMPT",
    (
        "Transcribe only the words actually spoken. Do not add introductions, summaries, or corporate updates. "
        "Spelling hints only: Justus Huneke; Oblique; Lumin PDF; Lumin Sign; Holdco; John Doe."
    ),
).strip()

INSIGHT_MODEL = os.getenv("OPENAI_INSIGHT_MODEL", "gpt-4o-mini")
INSIGHT_DISABLED = os.getenv("INSIGHT_DISABLED", "0").strip().lower() in ("1", "true", "yes")
# By default do not duplicate insights on stderr; extension shows them in the page overlay.
INSIGHT_LOG_TERMINAL = os.getenv("INSIGHT_LOG_TERMINAL", "0").strip().lower() in ("1", "true", "yes")
WEBM_TRANSCRIBE_MIN_BYTES = int(os.getenv("WEBM_TRANSCRIBE_MIN_BYTES", "32000"))
TRANSCRIBE_SAMPLE_RATE = int(os.getenv("OPENAI_TRANSCRIBE_SAMPLE_RATE", "16000"))
TRANSCRIBE_CHANNELS = int(os.getenv("OPENAI_TRANSCRIBE_CHANNELS", "1"))
TRANSCRIBE_NORMALIZE_AUDIO = os.getenv("OPENAI_TRANSCRIBE_NORMALIZE_AUDIO", "1").strip().lower() not in ("0", "false", "no")
TRANSCRIBE_AUDIO_FILTERS = os.getenv(
    "OPENAI_TRANSCRIBE_AUDIO_FILTERS",
    "highpass=f=80,lowpass=f=7600,loudnorm=I=-18:TP=-2:LRA=11",
).strip()
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
TRANSCRIPT_PROMPT_LEAK_MIN_TERMS = int(os.getenv("TRANSCRIPT_PROMPT_LEAK_MIN_TERMS", "7"))
TRANSCRIPT_PROMPT_LEAK_TERMS = {
    "oblique", "lumin pdf", "lumin sign", "justus huneke", "holdco", "john doe",
    "pricing", "discount", "refund", "software", "integration", "pdf signing", "ai",
    "transcribe only", "spelling hints", "english sales meeting", "proper nouns", "names:",
    "cloudflare workers", "typescript", "alf dashboard",
}

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


def transcript_looks_like_prompt_leak(text: str) -> bool:
    lower = text.lower()
    configured_prompt = TRANSCRIBE_PROMPT.lower().strip()
    if configured_prompt and lower.strip(" .") == configured_prompt.strip(" ."):
        return True

    def has_term(term: str) -> bool:
        escaped = re.escape(term.lower()).replace(r"\ ", r"\s+")
        return re.search(rf"(?<![a-z0-9]){escaped}(?![a-z0-9])", lower) is not None

    hits = sum(1 for term in TRANSCRIPT_PROMPT_LEAK_TERMS if has_term(term))
    comma_count = text.count(",")
    word_count = len(text.split())
    hallucination_markers = (
        "hello everyone",
        "today i'll be discussing",
        "today i will be discussing",
        "recent progress",
        "looking ahead",
        "thank you for your continued support",
        "we are proud to report",
        "significant milestone",
    )
    if hits >= 5 and word_count >= 45 and any(marker in lower for marker in hallucination_markers):
        return True
    if hits >= 7 and word_count >= 80:
        return True
    return hits >= TRANSCRIPT_PROMPT_LEAK_MIN_TERMS or (
        hits >= 5 and comma_count >= 4 and word_count <= 30
    )


def normalize_domain_terms(text: str) -> str:
    replacements = [
        (r"\bjustic\b", "Justus"),
        (r"\bjustice\b", "Justus"),
        (r"\bjust us\b", "Justus"),
        (r"\bjust as\b", "Justus"),
        (r"\bjust is\b", "Justus"),
        (r"\bjustus hunika\b", "Justus Huneke"),
        (r"\bhunika\b", "Huneke"),
        (r"\bhuneky\b", "Huneke"),
        (r"\blumen\b", "Lumin"),
        (r"\blumon\b", "Lumin"),
        (r"\bluman\b", "Lumin"),
        (r"\blumin pdf\b", "Lumin PDF"),
        (r"\blumin sign\b", "Lumin Sign"),
        (r"\bhold co\b", "Holdco"),
        (r"\bhold company\b", "Holdco"),
        (r"\bprocufc\b", "product"),
        (r"\bproducf\b", "product"),
        (r"\bprodcut\b", "product"),
        (r"\bprodict\b", "product"),
        (r"\bobliek\b", "Oblique"),
        (r"\bob leek\b", "Oblique"),
        (r"\bob leak\b", "Oblique"),
        (r"\boblique\b", "Oblique"),
        (r"\bobleek\b", "Oblique"),
        (r"\bobliq\b", "Oblique"),
        (r"\bjon dough\b", "John Doe"),
        (r"\bjohn dough\b", "John Doe"),
        (r"\bjon doe\b", "John Doe"),
        (r"\bcloud flare\b", "Cloudflare"),
        (r"\btype script\b", "TypeScript"),
        (r"\bnext js\b", "Next.js"),
        (r"\bdash board\b", "dashboard"),
        (r"\bouttage\b", "outage"),
        (r"\bout age\b", "outage"),
        (r"\brefuned\b", "refund"),
        (r"\bintergration\b", "Integration"),
    ]
    normalized = text
    for pattern, replacement in replacements:
        normalized = re.sub(pattern, replacement, normalized, flags=re.IGNORECASE)
    return normalized


def clean_transcript_text(text: str) -> str:
    cleaned = strip_filler_words(text.strip())
    cleaned = normalize_domain_terms(cleaned)
    if not transcript_is_supported_language(cleaned):
        logger.debug("ignored transcript chunk with unsupported language/noise: %r", cleaned[:80])
        return ""
    if transcript_looks_like_prompt_leak(cleaned):
        logger.debug("ignored transcript chunk that looks like prompt leak: %r", cleaned[:120])
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
        feedback = "Calm down — watch your language. Soften your volume."
        reason = "language and volume"
    elif offensive:
        feedback = "Calm down — watch your language."
        reason = "offensive wording"
    else:
        feedback = "Lower your voice."
        reason = "raised voice"
    return {
        "state": "warning",
        "confidence": 0.95,
        "reason": reason,
        "feedback": feedback,
    }


def wav_duration_seconds(wav: bytes) -> float:
    """Mono/stereo PCM WAV duration from header + data chunk size."""
    if len(wav) < 44:
        return 0.0
    try:
        audio_format = struct.unpack_from("<H", wav, 20)[0]
        channels = struct.unpack_from("<H", wav, 22)[0]
        sample_rate = struct.unpack_from("<I", wav, 24)[0]
        bits = struct.unpack_from("<H", wav, 34)[0]
        if audio_format != 1 or channels < 1 or sample_rate <= 0 or bits <= 0:
            return 0.0
        data_size = struct.unpack_from("<I", wav, 40)[0]
        frame_bytes = channels * (bits // 8)
        if frame_bytes <= 0:
            return 0.0
        return (data_size / frame_bytes) / sample_rate
    except struct.error:
        return 0.0


def _clamp_int(value: float, low: int, high: int) -> int:
    return int(max(low, min(high, round(value))))


def build_delivery_feedback(
    text: str,
    wav_bytes: bytes,
    audio_rms: Optional[float] = None,
) -> dict[str, object]:
    """Heuristic semantic + tempo (+ language / volume) scores for overlay bars."""
    words = re.findall(r"\w+", (text or "").lower())
    word_n = len(words)
    uniq_ratio = len(set(words)) / word_n if word_n else 1.0
    ctr = Counter(words)
    highest_share = ctr.most_common(1)[0][1] / word_n if word_n else 0.0

    semantic = 78 + 20 * uniq_ratio
    if word_n < 4:
        semantic = 68 + 8 * word_n
    if highest_share > 0.55 and word_n >= 5:
        semantic -= 18
    semantic = _clamp_int(semantic, 35, 96)
    if semantic >= 82:
        sem_label = "Clear, distinct wording"
    elif semantic >= 66:
        sem_label = "Mostly on track"
    else:
        sem_label = "Simplify — less repetition"

    dur = wav_duration_seconds(wav_bytes)
    wpm = (word_n / dur) * 60.0 if dur >= 0.35 and word_n else 0.0
    if wpm <= 0:
        tempo = 72
        tempo_label = "Speak a bit more to score pace"
    elif wpm < 95:
        tempo = _clamp_int(52 + (wpm / 95) * 28, 45, 80)
        tempo_label = "Pace is slow — add energy"
    elif wpm < 120:
        tempo = _clamp_int(76 + (wpm - 95) / 25 * 12, 70, 88)
        tempo_label = "Comfortable pace"
    elif wpm <= 155:
        tempo = _clamp_int(88 + min(8, (wpm - 120) / 35 * 8), 85, 96)
        tempo_label = "Strong, listener-friendly tempo"
    elif wpm <= 190:
        tempo = _clamp_int(96 - (wpm - 155) / 35 * 22, 58, 94)
        tempo_label = "Slightly rushed — breathe between points"
    else:
        tempo = _clamp_int(74 - (wpm - 190) * 0.35, 38, 72)
        tempo_label = "Too fast — slow down for clarity"

    offensive = transcript_has_offensive_language(text or "")
    raised_voice = isinstance(audio_rms, (int, float)) and audio_rms >= COACH_RAISED_VOICE_RMS

    if offensive and raised_voice:
        language_score = 12
        language_label = "Calm down — watch your language. Soften your volume."
    elif offensive:
        language_score = 14
        language_label = "Calm down — watch your language."
    elif raised_voice:
        language_score = 62
        language_label = "Lower your voice — stay professional."
    else:
        language_score = 92
        language_label = "No profanity flagged in this clip"

    return {
        "semantic": {"score": semantic, "label": sem_label},
        "tempo": {
            "score": tempo,
            "label": tempo_label,
            "wpm": round(wpm, 1) if wpm else None,
        },
        "language": {
            "score": language_score,
            "label": language_label,
            "offensive": offensive,
            "raised_voice": raised_voice,
        },
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


def _insight_llm_system_prompt() -> str:
    """System instructions for the insight LLM: full body of the configured context file (default context.txt)."""
    text = get_reference_document().strip()
    if text:
        return text
    return (
        "You help with a live meeting. Use only facts from the supplied reference excerpts; "
        "if nothing applies, reply exactly: ok"
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
            {"role": "system", "content": _insight_llm_system_prompt()},
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
    description="Transcribes audio from the extension; logs each chunk on logger transcription-text, then insights on insight-llm using context.txt.",
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
    if TRANSCRIBE_PROMPT:
        _args["prompt"] = TRANSCRIBE_PROMPT

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
    if state not in ("bored", "neutral", "engaged", "warning"):
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
    speech_coaching = build_speech_coaching(recent_transcript, audio_rms)
    if speech_coaching:
        return speech_coaching

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
        "state must be bored|neutral|engaged|warning. Use warning only for raised voice or unprofessional language. confidence is 0-1. "
        "Use lower confidence (0.2-0.45) when the face is unclear, occluded, off-camera, or the cue is ambiguous. "
        "reason is 2-6 words describing visible cues only. "
        "feedback is one very short coaching action under 4 words. "
        "Use direct visible behavior, e.g. 'Look back.' "
        "Avoid diagnosing emotions or personality; coach the next visible behavior instead. "
        "No extra text."
    )
    transcript = (recent_transcript or "").strip() or "(none)"
    tone_line = f"Audio tone: {audio_tone}."
    transcript_line = f"Recent transcript: {transcript}"
    request_kwargs = {
        "model": FACE_MODEL,
        "temperature": 0.0,
        "max_tokens": 80,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a conservative visual engagement and speech-tone coach. "
                    "Prefer neutral with modest confidence when evidence is weak. "
                    "Keep feedback short enough for a live overlay."
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
    global LAST_INSIGHT_REPLY
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

    delivery: dict[str, object] | None = None
    try:
        wav_for_metrics = prepare_transcription_wav(audio, payload.mimeType or "audio/webm")
        delivery = build_delivery_feedback(text, wav_for_metrics, payload.audioRms)
    except Exception:
        logger.debug("delivery metrics skipped", exc_info=True)

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
            LAST_INSIGHT_REPLY = insight_reply
            if INSIGHT_LOG_TERMINAL:
                insight_log.info("%s", insight_reply)
        elif INSIGHT_RETURN_LAST_ON_NO_MATCH and LAST_INSIGHT_REPLY:
            insight_reply = LAST_INSIGHT_REPLY
        elif not insight:
            logger.warning("insight model returned an empty reply (model=%s)", INSIGHT_MODEL)

    response: dict[str, object] = {"ok": True, "isFinal": True, "text": text, "insight": insight_reply}
    speech_coaching = build_speech_coaching(text, payload.audioRms)
    if speech_coaching:
        response["coach"] = speech_coaching
    if delivery:
        response["delivery"] = delivery
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
