"""
Offline tests for the deterministic parts of triage.

WHY THIS FILE MATTERS
---------------------
These run with NO database and NO API key. They test the layer that
guarantees "hello" can never produce a medicine — and because that layer
is pure code, the guarantee is testable and repeatable, unlike prompt
behaviour.

Run:  python -m tests.test_triage_offline
"""

from app.triage import (
    check_for_emergency_symptoms,
    quick_classify,
    _normalise,
)


GREETING_CASES = [
    "hi", "Hi", "HI!", "hello", "Hello!!", "hey", "Hey there",
    "good morning", "Good Morning", "salam", "assalamualaikum", "aoa",
]

SMALL_TALK_CASES = [
    "thanks", "Thank you", "thx", "ok", "Okay", "bye", "how are you",
    "how are you?", "cool", "got it",
]

IDENTITY_CASES = [
    "who are you", "What are you?", "what can you do",
    "are you a real doctor", "how do you work",
]

EMERGENCY_CASES = [
    "I have chest pain radiating to my arm",
    "I can't breathe properly",
    "my throat is swelling",
    "I think I'm having a stroke, my face is drooping",
    "I took an overdose",
    "coughing blood since morning",
]

# These must NOT be caught by the deterministic layers — they need the
# LLM classifier, because they are real symptom reports.
NEEDS_LLM_CASES = [
    "I have a mild headache since this morning",
    "my stomach hurts a bit after eating",
    "sore throat and runny nose for two days",
    "I feel a bit feverish",
    "what is paracetamol used for",
    "who are you to tell me what to take for my chronic migraine",
]


def run():
    failures = []

    def check(condition, label):
        if condition:
            print(f"  PASS  {label}")
        else:
            print(f"  FAIL  {label}")
            failures.append(label)

    print("\n--- Emergency detection ---")
    for text in EMERGENCY_CASES:
        check(check_for_emergency_symptoms(text), f"emergency: {text!r}")

    print("\n--- Emergency false positives ---")
    for text in GREETING_CASES + SMALL_TALK_CASES:
        check(not check_for_emergency_symptoms(text), f"not emergency: {text!r}")

    print("\n--- Greetings resolve without an LLM call ---")
    for text in GREETING_CASES:
        result = quick_classify(text)
        check(result is not None and result.intent == "greeting", f"greeting: {text!r}")

    print("\n--- Small talk resolves without an LLM call ---")
    for text in SMALL_TALK_CASES:
        result = quick_classify(text)
        check(result is not None and result.intent == "small_talk", f"small_talk: {text!r}")

    print("\n--- Identity questions ---")
    for text in IDENTITY_CASES:
        result = quick_classify(text)
        check(result is not None and result.intent == "identity", f"identity: {text!r}")

    print("\n--- Emergency wins over everything ---")
    result = quick_classify("hi, I have severe bleeding")
    check(result is not None and result.intent == "emergency",
          "emergency detected even inside a greeting")

    print("\n--- Real symptoms fall through to the LLM classifier ---")
    for text in NEEDS_LLM_CASES:
        result = quick_classify(text)
        check(result is None, f"falls through: {text!r}")

    print("\n--- Normalisation ---")
    check(_normalise("Hi!!!") == "hi", "punctuation stripped")
    check(_normalise("  HELLO   there  ") == "hello there", "whitespace collapsed")

    print("\n" + "=" * 60)
    if failures:
        print(f"{len(failures)} FAILURE(S):")
        for f in failures:
            print(f"  - {f}")
    else:
        print("All offline triage tests passed.")
    print("=" * 60)

    return len(failures)


if __name__ == "__main__":
    raise SystemExit(1 if run() else 0)
