"""
Command-line chat client.

WHAT CHANGED
------------
The original chatbot.py was a separate program that talked to your own
FastAPI server over HTTP. That meant the chat logic lived outside the
backend, so there was no endpoint a frontend could ever call — the logic
was only reachable by running this script by hand.

The logic now lives in app/chat_engine.py, inside the backend, exposed at
POST /chat. This file is just a thin CLI wrapper around the same engine,
kept because it is genuinely useful for testing the pipeline without
needing the frontend or even the web server running.

Usage:
    python chatbot.py <patient_id>              # interactive session
    python chatbot.py <patient_id> "sore throat"  # single message
"""

import sys
import logging

from app.chat_engine import process_message
from app import repository, database, config
from app.schemas import ChatMessage

logging.basicConfig(level=logging.WARNING, format="%(levelname)s | %(message)s")


BANNER = """
======================================================================
  MedChat - command line client
======================================================================
  Type your message and press Enter.
  Commands:  /profile   show the loaded patient profile
             /history   show past recommendations
             /quit      exit
======================================================================
"""


def print_response(result):
    print("\n" + "-" * 70)
    print(result.reply)

    if result.medicine_name:
        print(f"\n[medicine: {result.medicine_name}]")

    print(f"[status: {result.status} | intent: {result.intent}", end="")
    if result.severity != "not_applicable":
        print(f" | severity: {result.severity}", end="")
    if result.safety_filter_result:
        print(f" | safety: {result.safety_filter_result}", end="")
    print("]")

    if result.blocked_reason:
        print(f"[blocked: {result.blocked_reason}]")

    if result.disclaimer:
        print(f"\n{result.disclaimer}")

    print("-" * 70)


def show_profile(patient_id):
    profile = repository.get_patient_profile(patient_id)
    if not profile:
        print("Patient not found.")
        return

    p = profile["patient"]
    print(f"\nName        : {p.get('full_name')}")
    print(f"DOB / sex   : {p.get('date_of_birth')} / {p.get('sex')}")
    print(f"Pregnancy   : {p.get('pregnancy_status') or 'n/a'}")
    print(f"Allergies   : {[a['substance_name'] for a in profile['allergies']] or 'none'}")
    print(f"Conditions  : {[c['condition_name'] for c in profile['conditions']] or 'none'}")
    print(f"Medications : {[m['medicine_name_raw'] for m in profile['medications']] or 'none'}")
    print(f"Reactions   : {[r['medicine_name_raw'] for r in profile['adverse_reactions']] or 'none'}\n")


def show_history(patient_id):
    history = repository.get_prescription_history(patient_id)
    if not history:
        print("\nNo prescription history yet.\n")
        return

    print()
    for h in history[:10]:
        print(f"  {h.get('created_at')} | {h.get('recommended_medicine_name') or '(no medicine)'} "
              f"| {h.get('safety_filter_result')} | {h.get('reported_symptoms')[:50]}")
    print()


def main():
    if len(sys.argv) < 2:
        print('\nUsage:\n  python chatbot.py <patient_id>\n'
              '  python chatbot.py <patient_id> "your message"\n')
        sys.exit(1)

    patient_id = sys.argv[1]

    problems = config.validate_startup_config()
    if problems:
        print("\nConfiguration problems:")
        for p in problems:
            print(f"  - {p}")
        print()

    ok, message = database.ping()
    if not ok:
        print(f"Database error: {message}")
        sys.exit(1)

    if not repository.patient_exists(patient_id):
        print(f"No patient with ID {patient_id}")
        sys.exit(1)

    # Single-shot mode
    if len(sys.argv) >= 3:
        result = process_message(patient_id, " ".join(sys.argv[2:]))
        print_response(result)
        return

    # Interactive mode — history is kept so follow-ups work
    print(BANNER)
    show_profile(patient_id)

    history = []

    while True:
        try:
            message = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye.")
            break

        if not message:
            continue

        if message.lower() in ("/quit", "/exit", "quit", "exit"):
            print("Bye.")
            break

        if message.lower() == "/profile":
            show_profile(patient_id)
            continue

        if message.lower() == "/history":
            show_history(patient_id)
            continue

        result = process_message(patient_id, message, history)
        print_response(result)

        history.append(ChatMessage(role="user", content=message))
        history.append(ChatMessage(role="assistant", content=result.reply))
        history = history[-10:]   # keep the context window small


if __name__ == "__main__":
    main()
