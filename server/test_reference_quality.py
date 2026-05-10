"""Local quality checks for live reference retrieval.

Run from repo root:
    server/.venv/bin/python server/test_reference_quality.py

This intentionally avoids pytest so it can run anywhere the server venv works.
"""

from __future__ import annotations

import re
import sys
import os
from collections import Counter, defaultdict
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

# Quality script targets the rich keyed reference file; production answers use context.txt.
os.environ["INSIGHT_REFERENCE_PATH"] = str(SERVER_DIR / "reference_context.txt")
# This script scores retrieval against reference_context, not the default answer index.
os.environ["INSIGHT_ANSWER_INDEX_PATH"] = str(SERVER_DIR / "reference_context.txt")
# Expectations in CASES match the legacy demo-specific fast path + overlay rewrites.
os.environ["INSIGHT_FAST_LITERAL_FROM_SOURCE"] = "0"
os.environ["INSIGHT_FAST_DEMO_FILTERS"] = "1"

import main  # noqa: E402


CASES = [
    {
        "name": "oblique_price",
        "utterance": "How much does Oblique cost per user?",
        "category": "pricing",
        "expected": ["$100/mo/user", "Oblique"],
        "forbidden": ["$100k", "$20k"],
    },
    {
        "name": "misheard_oblique_price",
        "utterance": "How much does ob leak cost per user?",
        "category": "pricing",
        "expected": ["$100/mo/user", "Oblique"],
        "forbidden": ["$100k", "$20k"],
    },
    {
        "name": "john_100k_purchase",
        "utterance": "What did John Doe buy last year?",
        "category": "purchase_100k",
        "expected": ["$100k", "John Doe", "Integration"],
        "forbidden": ["$100/mo/user", "$20k"],
    },
    {
        "name": "misheard_john_purchase",
        "utterance": "What did Jon Dough buy last year?",
        "category": "purchase_100k",
        "expected": ["$100k", "John Doe", "Integration"],
        "forbidden": ["$100/mo/user", "$20k"],
    },
    {
        "name": "software_100k_hint",
        "utterance": "cost of software 100k",
        "category": "purchase_100k",
        "expected": ["$100k", "John Doe", "Integration"],
        "forbidden": ["$20k", "$100/mo/user"],
    },
    {
        "name": "prior_spend_20k",
        "utterance": "How much did Justus spend before?",
        "category": "prior_spend_20k",
        "expected": ["$20k", "Lumin PDF + Sign"],
        "forbidden": ["$100k"],
    },
    {
        "name": "refund_discount",
        "utterance": "Can he get a discount or refund?",
        "category": "refund_discount",
        "expected": ["Nov 2024 outage", "refund risk", "settle 20%"],
        "forbidden": ["$100/mo/user", "Full Stack", "AEP"],
    },
    {
        "name": "misheard_refund_outage",
        "utterance": "What about the out age and refuned problem?",
        "category": "refund_discount",
        "expected": ["Nov 2024 outage", "refund risk"],
        "forbidden": ["$100/mo/user", "$100k", "Full Stack"],
    },
    {
        "name": "price_plain",
        "utterance": "What is the price?",
        "category": "pricing",
        "expected": ["$100/mo/user", "Oblique"],
        "forbidden": ["$100k", "$20k", "Holdco"],
    },
    {
        "name": "price_per_seat",
        "utterance": "How expensive is Oblique per seat?",
        "category": "pricing",
        "expected": ["$100/mo/user", "Oblique"],
        "forbidden": ["$100k", "$20k"],
    },
    {
        "name": "product_features",
        "utterance": "What does the product include?",
        "category": "product_features",
        "expected": ["PDF reading", "signing", "AI"],
        "forbidden": ["refund", "$100k"],
    },
    {
        "name": "new_product_overview",
        "utterance": "Tell me about the new product",
        "category": "product_overview",
        "expected": ["Oblique", "sales trainer", "intelligence platform"],
        "forbidden": ["Holdco", "3 kids", "$100k", "John Doe", "web3"],
    },
    {
        "name": "new_product_realtime",
        "utterance": "Does the new product give realtime meeting information?",
        "category": "product_overview",
        "expected": ["realtime meeting info", "sales technique feedback"],
        "forbidden": ["Holdco", "3 kids", "$100k", "John Doe"],
    },
    {
        "name": "sales_technique_feedback",
        "utterance": "Can it provide sales technique feedback?",
        "category": "product_overview",
        "expected": ["realtime meeting info", "sales technique feedback"],
        "forbidden": ["Holdco", "$100k", "web3"],
    },
    {
        "name": "oblique_product_overview",
        "utterance": "What does the Oblique new product do?",
        "category": "product_overview",
        "expected": ["Oblique", "sales trainer", "intelligence platform"],
        "forbidden": ["Holdco", "3 kids", "$100k", "John Doe", "Cloudflare Workers"],
    },
    {
        "name": "typo_new_product_overview",
        "utterance": "Tell me about the new procufc",
        "category": "product_overview",
        "expected": ["Oblique", "sales trainer", "intelligence platform"],
        "forbidden": ["Holdco", "3 kids", "$100k", "John Doe"],
    },
    {
        "name": "misheard_new_product_overview",
        "utterance": "Tell me about obleek and the new prodict",
        "category": "product_overview",
        "expected": ["Oblique", "sales trainer", "intelligence platform"],
        "forbidden": ["Holdco", "3 kids", "$100k", "John Doe"],
    },
    {
        "name": "followup_product_price",
        "utterance": "How much is it?",
        "context": "We are discussing Oblique pricing and cost for the new product.",
        "category": "pricing",
        "expected": ["$100/mo/user", "Oblique"],
        "forbidden": ["$100k", "$20k", "Holdco"],
    },
    {
        "name": "followup_product_features",
        "utterance": "Does it include signing?",
        "context": "We are talking about Oblique product features and PDF workflows.",
        "category": "product_features",
        "expected": ["PDF reading", "signing", "AI"],
        "forbidden": ["$100k", "Holdco", "3 kids"],
    },
    {
        "name": "followup_refund_issue",
        "utterance": "What about that issue?",
        "context": "Justus mentioned the November 2024 cloud outage and refund concern.",
        "category": "refund_discount",
        "expected": ["Nov 2024 outage", "refund risk"],
        "forbidden": ["$100/mo/user", "$100k", "Holdco", "sales coaching", "web3"],
    },
    {
        "name": "followup_john_team_purchase",
        "utterance": "What about that team purchase?",
        "context": "We were discussing John Doe in the Integration team buying software last year.",
        "category": "purchase_100k",
        "expected": ["$100k", "John Doe", "Integration"],
        "forbidden": ["$100/mo/user", "$20k"],
    },
    {
        "name": "justus_work_misheard",
        "utterance": "Where does justice work?",
        "category": "person_work",
        "expected": ["Holdco", "software engineer"],
        "forbidden": ["$100k", "$20k"],
    },
    {
        "name": "justus_huneke_misheard",
        "utterance": "Who is Justus Hunika at hold co?",
        "category": "person_work",
        "expected": ["Holdco", "software engineer"],
        "forbidden": ["$100k", "$20k"],
    },
    {
        "name": "who_is_justus",
        "utterance": "Who is Justus Huneke?",
        "category": "person_work",
        "expected": ["Holdco", "software engineer"],
        "forbidden": ["$100/mo/user", "$100k", "Rocky"],
    },
    {
        "name": "rocky_friend",
        "utterance": "Who is Rocky to Justus?",
        "category": "person_friend",
        "expected": ["Rocky", "close friend"],
        "forbidden": ["$100k", "$100/mo/user"],
    },
    {
        "name": "justus_kids",
        "utterance": "Does Justus have kids?",
        "category": "person_kids",
        "expected": ["3 kids", "family"],
        "forbidden": ["$100k"],
    },
    {
        "name": "justus_family_rapport",
        "utterance": "Any family rapport notes for Justus?",
        "category": "person_kids",
        "expected": ["3 kids", "family", "rapport"],
        "forbidden": ["$100k", "$100/mo/user", "Rocky"],
    },
    {
        "name": "website_profile",
        "utterance": "What does jstEagle say he builds on his website?",
        "category": "public_profile",
        "expected": ["web3", "websites"],
        "forbidden": ["3 kids", "$100k", "sales coaching"],
    },
    {
        "name": "website_stack",
        "utterance": "What stack does Justus list on his website?",
        "category": "public_stack",
        "expected": ["TypeScript", "Next.js", "Cloudflare"],
        "forbidden": ["refund", "$20k"],
    },
    {
        "name": "misheard_stack",
        "utterance": "Does he use type script and cloud flare workers?",
        "category": "public_stack",
        "expected": ["TypeScript", "Cloudflare"],
        "forbidden": ["refund", "$20k", "3 kids"],
    },
    {
        "name": "website_tools",
        "utterance": "What tools are listed on the jstEagle website?",
        "category": "public_stack",
        "expected": ["TypeScript", "Next.js", "Cloudflare"],
        "forbidden": ["refund", "$20k", "3 kids"],
    },
    {
        "name": "current_project",
        "utterance": "What is Justus current project?",
        "category": "public_alf",
        "expected": ["ALF Dashboard", "current project"],
        "forbidden": ["$100k", "$100/mo/user"],
    },
    {
        "name": "alf_dashboard",
        "utterance": "What is Justus working on with ALF dashboards?",
        "category": "public_alf",
        "expected": ["on-chain dashboards", "speed"],
        "forbidden": ["3 kids", "$100/mo/user"],
    },
    {
        "name": "on_chain_speed",
        "utterance": "What should I mention about on-chain dashboard speed?",
        "category": "public_alf",
        "expected": ["on-chain dashboards", "indexing", "speed"],
        "forbidden": ["$100k", "$100/mo/user", "3 kids"],
    },
    {
        "name": "november_outage",
        "utterance": "What happened in November 2024?",
        "category": "refund_discount",
        "expected": ["Nov 2024 outage", "refund risk"],
        "forbidden": ["$100/mo/user", "$100k", "Full Stack"],
    },
    {
        "name": "negotiation_guidance",
        "utterance": "How should I handle the negotiation?",
        "category": "refund_discount",
        "expected": ["discount: ask 50%", "settle 20%", "be strict"],
        "forbidden": ["$100k", "$100/mo/user", "Full Stack"],
    },
    {
        "name": "oblique_fit_scenario",
        "utterance": "Why does Oblique fit Justus?",
        "category": "oblique_fit",
        "expected": ["web3 dashboards", "sales coaching"],
        "forbidden": ["$20k", "$100k", "Cloudflare Workers"],
    },
    {
        "name": "oblique_integration_scenario",
        "utterance": "How could Oblique integrate for him?",
        "category": "oblique_integration",
        "expected": ["Cloudflare Workers", "TypeScript"],
        "forbidden": ["refund", "3 kids"],
    },
    {
        "name": "misheard_integration_scenario",
        "utterance": "How could ob leek intergration work for him?",
        "category": "oblique_integration",
        "expected": ["Cloudflare Workers", "TypeScript"],
        "forbidden": ["refund", "3 kids"],
    },
    {
        "name": "weather_no_match",
        "utterance": "What is the weather today?",
        "category": "no_match",
        "expected": [],
        "forbidden": ["$100", "Justus", "PDF"],
    },
    {
        "name": "random_chitchat_no_match",
        "utterance": "Can you hear me okay?",
        "category": "no_match",
        "expected": [],
        "forbidden": ["$100", "Justus", "Oblique", "Holdco"],
    },
    {
        "name": "empty_no_match",
        "utterance": "",
        "category": "no_match",
        "expected": [],
        "forbidden": ["$100", "Justus", "Oblique", "Holdco"],
    },
    {
        "name": "chinese_noise_no_match",
        "utterance": "他买了多少钱的软件",
        "category": "no_match",
        "expected": [],
        "forbidden": ["$100", "$20k", "$100k"],
    },
    {
        "name": "prompt_leak_no_match",
        "utterance": (
            "Oblique, Lumin PDF, Lumin Sign, Justus Huneke, Holdco, John Doe, "
            "pricing, discount, refund, software, integration, PDF signing, AI."
        ),
        "category": "no_match",
        "expected": [],
        "forbidden": ["$100", "$20k", "$100k", "Holdco"],
    },
    {
        "name": "exact_transcribe_prompt_no_match",
        "utterance": "English sales meeting. Proper nouns: Justus Huneke, Oblique, Lumin PDF, Lumin Sign, Holdco.",
        "category": "no_match",
        "expected": [],
        "forbidden": ["$100", "$20k", "$100k", "Holdco", "Justus"],
    },
    {
        "name": "long_corporate_hallucination_no_match",
        "utterance": (
            "Hello everyone, this is John Doe, CEO of Justus Huneke and Oblique. "
            "Today, I'll be discussing our recent progress with Lumin PDF, Lumin Sign, and Holdco. "
            "We have made great strides with Cloudflare Workers and TypeScript integrations. "
            "We are proud to report $100k in revenue and a $20k investment. "
            "Looking ahead, thank you for your continued support."
        ),
        "category": "no_match",
        "expected": [],
        "forbidden": ["$100", "$20k", "$100k", "Holdco", "Justus", "Oblique"],
    },
]


BASE_CASES = CASES


POSITIVE_VARIANT_TEMPLATES = [
    "Quick question, {utterance}",
    "Can you remind me, {utterance}",
    "In this call, {utterance}",
    "I might have misheard, {utterance}",
    "For the sales notes, {utterance}",
    "Please capture, {utterance}",
    "If they ask again, {utterance}",
    "During discovery, {utterance}",
    "For the follow-up, {utterance}",
    "Could you surface this, {utterance}",
    "The customer asked, {utterance}",
    "I need the cue for this, {utterance}",
    "Please pull the best fact, {utterance}",
    "For the overlay, {utterance}",
    "As a quick note, {utterance}",
    "If this comes up, {utterance}",
    "I heard someone ask, {utterance}",
    "What should I remember if, {utterance}",
    "Can you find the closest fact, {utterance}",
    "Assume the transcript says, {utterance}",
    "In the meeting transcript, {utterance}",
    "For live coaching, {utterance}",
    "If the wording is messy, {utterance}",
    "If audio is unclear, {utterance}",
    "For a sales objection, {utterance}",
    "For a customer question, {utterance}",
    "For the next response, {utterance}",
    "Which keywords should appear for, {utterance}",
    "Give me the matching cue, {utterance}",
    "Find the matching reference fact, {utterance}",
    "If this is asked live, {utterance}",
    "If the customer asks this, {utterance}",
    "In plain meeting speech, {utterance}",
    "From the recent transcript, {utterance}",
    "Use the context and answer, {utterance}",
    "Give the top ranked cue, {utterance}",
    "What should stay on screen if, {utterance}",
    "For the call summary, {utterance}",
    "For sales prep, {utterance}",
    "If they bring this up, {utterance}",
    "If the transcript is partial, {utterance}",
    "If someone says this quickly, {utterance}",
    "If the mic clips this, {utterance}",
    "If it sounds like this, {utterance}",
    "Map this to reference context, {utterance}",
    "Show the closest match for, {utterance}",
    "What is the matching detail for, {utterance}",
    "Keep this concise, {utterance}",
    "Rank the important facts for, {utterance}",
    "Bring up the top three for, {utterance}",
    "For live notes, {utterance}",
    "For this customer moment, {utterance}",
]


def _variant_case(case: dict[str, object], idx: int, template: str) -> dict[str, object]:
    utterance = str(case["utterance"])
    return {
        **case,
        "name": f"{case['name']}_variant_{idx}",
        "utterance": template.format(utterance=utterance[:1].lower() + utterance[1:]),
    }


GENERATED_CASES = [
    _variant_case(case, idx, template)
    for case in BASE_CASES
    if case["expected"] and str(case["utterance"]).strip()
    for idx, template in enumerate(POSITIVE_VARIANT_TEMPLATES, start=1)
]

CASES = [*BASE_CASES, *GENERATED_CASES]


def infer_category(insight: str) -> str:
    first_line = insight.splitlines()[0] if insight else ""
    text = first_line.lower()
    if not text:
        return "no_match"
    if "$100k" in first_line:
        return "purchase_100k"
    if "$20k" in first_line:
        return "prior_spend_20k"
    if "$100/mo/user" in first_line:
        return "pricing"
    if "refund" in text or "discount" in text or "settle 20%" in text or "negotiator" in text or "strict at 20%" in text:
        return "refund_discount"
    if "realtime meeting info" in text and "sales technique feedback" in text:
        return "product_overview"
    if "pdf reading" in text or ("signing" in text and "ai" in text):
        return "product_features"
    if "sales trainer" in text and "intelligence platform" in text:
        return "product_overview"
    if "3 kids" in text:
        return "person_kids"
    if "holdco" in text or "software engineer" in text:
        return "person_work"
    if "rocky" in text and "close friend" in text:
        return "person_friend"
    if "web3" in text and "websites" in text:
        return "public_profile"
    if "typescript" in text and "next.js" in text and "cloudflare" in text:
        return "public_stack"
    if "on-chain dashboards" in text or "alf dashboard" in text:
        return "public_alf"
    if "web3 dashboards" in text and "sales coaching" in text:
        return "oblique_fit"
    if "cloudflare workers" in text and "typescript" in text:
        return "oblique_integration"
    return "other"


def run_case(case: dict[str, object]) -> dict[str, object]:
    utterance = str(case["utterance"])
    cleaned = main.clean_transcript_text(utterance)
    topic_context = str(case.get("context", ""))
    context = main.get_relevant_reference_context(cleaned, topic_context) if cleaned else ""
    insight = main.synthesize_fast_insight(context, cleaned, topic_context) if context else ""
    expected = [str(item) for item in case["expected"]]
    forbidden = [str(item) for item in case["forbidden"]]

    missing = [item for item in expected if item.lower() not in insight.lower()]
    forbidden_hits = [item for item in forbidden if item.lower() in insight.lower()]
    insight_lines = [line for line in insight.splitlines() if line.strip()]
    rank_missing = bool(insight) and not re.search(r"^• #1 \| ", insight)
    percentage_present = bool(re.search(r"#\d+\s+\d+%", insight))
    too_many_ranked = len(insight_lines) > 3
    too_few_ranked = bool(expected) and len(insight_lines) < 3
    predicted_category = infer_category(insight)
    category_mismatch = predicted_category != str(case["category"])
    expected_match = (
        not missing
        and not forbidden_hits
        and not rank_missing
        and not percentage_present
        and not too_many_ranked
        and not too_few_ranked
        and not category_mismatch
    )

    should_match = bool(expected)
    did_match = bool(insight)
    if should_match and did_match:
        binary = "TP"
    elif should_match and not did_match:
        binary = "FN"
    elif not should_match and did_match:
        binary = "FP"
    else:
        binary = "TN"

    return {
        **case,
        "cleaned": cleaned,
        "insight": insight,
        "predicted_category": predicted_category,
        "binary": binary,
        "passed": expected_match,
        "missing": missing,
        "forbidden_hits": forbidden_hits,
        "rank_missing": rank_missing,
        "percentage_present": percentage_present,
        "too_many_ranked": too_many_ranked,
        "too_few_ranked": too_few_ranked,
        "category_mismatch": category_mismatch,
    }


COACH_CASES = [
    {
        "name": "offensive_language_warning",
        "text": "That was a bad damn answer.",
        "audio_rms": 0.01,
        "expected_state": "warning",
        "expected": ["Calm down", "watch your language"],
    },
    {
        "name": "offensive_and_volume",
        "text": "That price is damn ridiculous.",
        "audio_rms": main.COACH_RAISED_VOICE_RMS + 0.02,
        "expected_state": "warning",
        "expected": ["Calm down", "watch your language", "volume"],
    },
    {
        "name": "raised_voice_warning",
        "text": "Can we talk about the price?",
        "audio_rms": main.COACH_RAISED_VOICE_RMS + 0.01,
        "expected_state": "warning",
        "expected": ["Lower voice"],
    },
    {
        "name": "normal_speech_no_warning",
        "text": "Can we talk about the price?",
        "audio_rms": 0.01,
        "expected_state": None,
        "expected": [],
    },
]


def run_coach_case(case: dict[str, object]) -> dict[str, object]:
    coach = main.build_speech_coaching(str(case["text"]), float(case["audio_rms"]))
    expected_state = case["expected_state"]
    expected = [str(item) for item in case["expected"]]
    text = str(coach.get("feedback", "")) if coach else ""
    missing = [item for item in expected if item.lower() not in text.lower()]
    state_mismatch = (coach or {}).get("state") != expected_state if expected_state else coach is not None
    return {
        **case,
        "coach": coach,
        "missing": missing,
        "state_mismatch": state_mismatch,
        "passed": not missing and not state_mismatch,
    }


def main_entry() -> int:
    results = [run_case(case) for case in CASES]
    coach_results = [run_coach_case(case) for case in COACH_CASES]
    verbose = os.getenv("REFERENCE_TEST_VERBOSE", "0").strip().lower() in ("1", "true", "yes")

    labels = sorted({str(r["category"]) for r in results} | {str(r["predicted_category"]) for r in results})
    matrix: dict[str, Counter[str]] = defaultdict(Counter)
    for result in results:
        matrix[str(result["category"])][str(result["predicted_category"])] += 1

    print("Binary retrieval matrix")
    binary_counts = Counter(str(result["binary"]) for result in results)
    for key in ("TP", "FP", "FN", "TN"):
        print(f"{key}: {binary_counts[key]}")

    print("\nCategory confusion matrix")
    print("actual\\pred," + ",".join(labels))
    for actual in labels:
        row = [str(matrix[actual][pred]) for pred in labels]
        print(actual + "," + ",".join(row))

    print("\nCase results")
    failures = 0
    for result in results:
        status = "PASS" if result["passed"] else "FAIL"
        if not result["passed"]:
            failures += 1
        if verbose or not result["passed"]:
            print(f"{status} {result['name']}: {result['predicted_category']} | {result['insight'] or '<no insight>'}")
        if result["missing"]:
            print(f"  missing: {result['missing']}")
        if result["forbidden_hits"]:
            print(f"  forbidden: {result['forbidden_hits']}")
        if result["rank_missing"]:
            print("  missing ranked prefix")
        if result["percentage_present"]:
            print("  should not include percentage confidence")
        if result["too_many_ranked"]:
            print("  returned more than top 3 ranked facts")
        if result["too_few_ranked"]:
            print("  returned fewer than top 3 ranked facts")
        if result["category_mismatch"]:
            print(f"  category mismatch: expected {result['category']}, got {result['predicted_category']}")

    print(f"\nPassed {len(results) - failures}/{len(results)} cases")

    print("\nSpeech coaching cases")
    coach_failures = 0
    for result in coach_results:
        status = "PASS" if result["passed"] else "FAIL"
        if not result["passed"]:
            coach_failures += 1
        if verbose or not result["passed"]:
            print(f"{status} {result['name']}: {result['coach'] or '<no coach>'}")
        if result["missing"]:
            print(f"  missing: {result['missing']}")
        if result["state_mismatch"]:
            print(f"  state mismatch: expected {result['expected_state']}")
    print(f"Passed {len(coach_results) - coach_failures}/{len(coach_results)} coaching cases")

    return 1 if failures or coach_failures else 0


if __name__ == "__main__":
    raise SystemExit(main_entry())
