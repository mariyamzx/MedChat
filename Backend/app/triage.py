"""
Stage 1 — triage.

Three layers, cheapest and most reliable first:

  1. Emergency keyword scan   — pure code, runs first, cannot be skipped
  2. Trivial-message matcher  — pure code, catches "hi"/"thanks" with 100%
                                accuracy and zero LLM calls
  3. LLM classifier           — only for anything the first two didn't settle

Layer 2 is worth explaining. Your complaint was that greetings get a
medicine. Even a good classifier is only ~98% reliable, and a greeting is
the single most common message a chat app receives — so at scale that
still means visible failures. But "hi", "hello", "thanks" are a closed,
tiny set of exact strings. Matching them in code makes that failure mode
mathematically impossible rather than merely unlikely, and it makes the
app feel instant on the most common input.
"""

import logging
import re
from typing import Optional

from app import llm_client, prompts
from app.schemas import TriageResult

logger = logging.getLogger(__name__)


# ==========================================================
# Layer 1 — Emergency keywords
#
# Preserved from your original chatbot.py and extended. Runs before any
# model call, so an emergency can never be missed because the API was
# down, rate limited, or the model classified badly.
# ==========================================================

EMERGENCY_KEYWORDS = [
    # cardiac
    "chest pain", "chest tightness", "crushing pain", "pain radiating",
    "pain in my left arm", "heart attack",
    # respiratory
    "difficulty breathing", "shortness of breath", "can't breathe",
    "cannot breathe", "cant breathe", "trouble breathing",
    "unable to breathe", "gasping for air", "struggling to breathe",
    # bleeding
    "severe bleeding", "uncontrolled bleeding", "bleeding heavily",
    "coughing blood", "vomiting blood", "blood in my vomit",
    # neuro
    "loss of consciousness", "unconscious", "fainted", "fainting",
    "passed out", "blacked out",
    "stroke", "slurred speech", "face drooping", "one-sided weakness",
    "can't move my", "sudden confusion", "worst headache of my life",
    "seizure", "convulsion", "fitting",
    # allergic
    "severe allergic reaction", "anaphylaxis", "anaphylactic",
    "throat swelling", "swelling of throat", "throat closing",
    "tongue swelling", "lips swelling",
    # abdominal / obstetric
    "severe abdominal pain", "rigid abdomen",
    "bleeding while pregnant", "no fetal movement",
    # infection
    "stiff neck and fever", "rash that doesn't fade",
    # mental health / poisoning
    "suicidal", "kill myself", "end my life", "self-harm", "self harm",
    "overdose", "took too many pills", "poisoned",
]


# Fixed strings can't catch every word order. "throat swelling" is in the
# list above, but a real user writes "my throat is swelling" — which the
# substring check misses entirely. These patterns close that gap for the
# highest-risk phrasings, where a miss is least acceptable.
EMERGENCY_PATTERNS = [
    r"\b(throat|tongue|lips?|face)\b.{0,20}\b(swell|swelling|swollen|closing|closed up)\b",
    r"\b(swell|swelling|swollen)\b.{0,20}\b(throat|tongue|lips?|face)\b",
    r"\b(chest|heart)\b.{0,20}\b(pain|tight|tightness|pressure|crushing)\b",
    r"\b(can'?t|cannot|unable to|struggling to|hard to)\b.{0,15}\bbreath\w*\b",
    r"\b(breath\w*)\b.{0,15}\b(difficult|difficulty|hard|impossible)\b",
    r"\b(cough\w*|vomit\w*|throwing up)\b.{0,15}\bblood\b",
    r"\bblood\b.{0,15}\b(in|from)\b.{0,15}\b(vomit|stool|urine|cough)\b",
    r"\b(want|going|trying|thinking about)\b.{0,20}\b(to kill|to end)\b.{0,15}\b(myself|my life)\b",
    r"\b(took|taken|swallowed)\b.{0,20}\b(too many|whole bottle|all the)\b.{0,15}\b(pills?|tablets?)\b",
    r"\b(severe|heavy|uncontrolled|won'?t stop)\b.{0,15}\bbleed\w*\b",
    r"\bbleed\w*\b.{0,20}\b(won'?t stop|heavily|uncontrollably)\b",
    r"\b(lost|losing|loss of)\b.{0,15}\bconsciousness\b",
]

_COMPILED_EMERGENCY_PATTERNS = [re.compile(p, re.IGNORECASE) for p in EMERGENCY_PATTERNS]


def check_for_emergency_symptoms(text: str) -> bool:
    """Conservative match — fixed keywords first, then regex patterns for
    natural word orders. A false positive costs the user an unnecessary
    "please see a doctor". A false negative could cost far more, so the
    asymmetry is deliberate."""
    lowered = (text or "").lower()

    if any(keyword in lowered for keyword in EMERGENCY_KEYWORDS):
        return True

    return any(pattern.search(lowered) for pattern in _COMPILED_EMERGENCY_PATTERNS)


# ==========================================================
# Layer 2 — Trivial messages
# ==========================================================

_GREETINGS = {
    "hi", "hii", "hiii", "hey", "heyy", "hello", "helo", "hlo", "yo",
    "good morning", "good afternoon", "good evening", "gm", "ge",
    "salam", "salaam", "assalam o alaikum", "assalamualaikum",
    "aoa", "asalam u alaikum", "hi there", "hello there",
}

_SMALL_TALK = {
    "thanks", "thank you", "thankyou", "thx", "ty", "shukriya",
    "ok", "okay", "okk", "k", "cool", "nice", "great", "got it",
    "bye", "goodbye", "see you", "good night", "gn",
    "how are you", "how are you?", "how r u", "hru",
    "yes", "no", "yeah", "yep", "nope", "hmm", "lol",
}

_IDENTITY_PATTERNS = [
    r"\bwho are you\b", r"\bwhat are you\b", r"\bwhat can you do\b",
    r"\bwhat do you do\b", r"\byour name\b", r"\bhow do you work\b",
    r"\bare you (a )?(real )?(doctor|human|bot|ai)\b",
    r"\bwhat is this (app|chatbot|bot)\b",
]


def _normalise(text: str) -> str:
    """Lowercase, strip punctuation and collapse whitespace, so 'Hi!!!' and
    'hi' are the same string."""
    cleaned = re.sub(r"[^\w\s]", "", (text or "").lower())
    return re.sub(r"\s+", " ", cleaned).strip()


def quick_classify(message: str) -> Optional[TriageResult]:
    """
    Returns a TriageResult if the message can be settled without an LLM
    call, otherwise None.
    """
    if check_for_emergency_symptoms(message):
        return TriageResult(
            intent="emergency",
            severity="severe",
            symptom_summary="Message contains recognised emergency warning signs.",
        )

    norm = _normalise(message)

    if not norm:
        return TriageResult(intent="small_talk", severity="not_applicable")

    # Trailing address words are noise: "hey there", "hello doc", "hi bot"
    # are all the same greeting. Stripping them keeps the exact-match sets
    # small instead of needing an entry for every combination.
    stripped = re.sub(
        r"\s+(there|doc|doctor|bot|medchat|everyone|all|again)$", "", norm
    ).strip()

    if norm in _GREETINGS or stripped in _GREETINGS:
        return TriageResult(intent="greeting", severity="not_applicable")

    if norm in _SMALL_TALK or stripped in _SMALL_TALK:
        return TriageResult(intent="small_talk", severity="not_applicable")

    # Only treat as identity if the message is short — "who are you to tell
    # me what medicine to take for my migraine" is a medical message.
    if len(norm.split()) <= 8:
        for pattern in _IDENTITY_PATTERNS:
            if re.search(pattern, norm):
                return TriageResult(intent="identity", severity="not_applicable")

    return None


# ==========================================================
# Layer 3 — LLM classifier
# ==========================================================

def format_history(history: list, limit: int = 6) -> str:
    """Last few turns only. Sending the whole conversation to a classifier
    wastes tokens and, past a point, actively degrades accuracy."""
    if not history:
        return "(no previous messages)"

    recent = history[-limit:]
    return "\n".join(
        f"{'User' if m.role == 'user' else 'Assistant'}: {m.content}"
        for m in recent
    )


def classify(message: str, history: list) -> TriageResult:
    """
    Full triage. Deterministic layers first, LLM only if needed.

    If the LLM is unreachable, falls back to a conservative default of
    insufficient_info — which makes the bot ask a question rather than
    guess. Never falls back to recommending anything.
    """
    quick = quick_classify(message)
    if quick is not None:
        logger.info("Triage resolved deterministically: %s", quick.intent)
        return quick

    try:
        result = llm_client.call_llm_structured(
            prompts.TRIAGE_SYSTEM,
            prompts.TRIAGE_USER.format(
                history=format_history(history),
                message=message,
            ),
            TriageResult,
            temperature=0.0,
            max_tokens=300,
        )
    except Exception as e:
        logger.warning("Triage LLM call failed (%s) — defaulting to insufficient_info", e)
        return TriageResult(
            intent="insufficient_info",
            severity="not_applicable",
            missing_info=[
                "What symptoms are you experiencing?",
                "How long have you had them?",
            ],
        )

    # Safety backstop: the keyword scan already ran, but if the model
    # independently judged this severe, honour that too. Escalation is
    # allowed; de-escalation is not.
    if result.severity == "severe" and result.intent == "medical_symptoms":
        result.intent = "emergency"

    logger.info("Triage: intent=%s severity=%s", result.intent, result.severity)
    return result
