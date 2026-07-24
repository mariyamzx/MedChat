"""
Safety filter test suite.

Ported from your original test_safety_filter.py / test_evaluation.py, with
new cases covering the checks that didn't exist before: adverse reactions,
condition contraindications, pregnancy, and duplicate therapy.

Needs a database connection but NOT an API key — the safety filter never
calls the LLM, which is the entire point of it.

Run:  python -m tests.test_safety_filter
"""

import sys
import uuid

from app.database import get_db, ping
from app.safety_filter import check_medicine_safety
from app import repository


def make_patient(allergies=None, conditions=None, medications=None,
                 adverse_reactions=None, pregnancy_status=None):
    """Creates a throwaway patient document directly, bypassing /survey."""
    patient_id = str(uuid.uuid4())

    get_db().patients.insert_one({
        "_id": patient_id,
        "full_name": "Test Patient",
        "date_of_birth": "2000-01-01",
        "sex": "female",
        "email": f"{patient_id}@test.local",
        "password_hash": "x",
        "pregnancy_status": pregnancy_status,
        "allergies": [
            {"allergy_id": str(uuid.uuid4()), "category": "medication",
             "substance_name": s, "severity": sev, "status": "active"}
            for s, sev in (allergies or [])
        ],
        "conditions": [
            {"condition_id": str(uuid.uuid4()), "condition_name": c, "status": "active"}
            for c in (conditions or [])
        ],
        "medications": [
            {"medication_id": str(uuid.uuid4()), "medicine_name_raw": m,
             "medication_type": "otc", "status": "active"}
            for m in (medications or [])
        ],
        "adverse_reactions": [
            {"reaction_id": str(uuid.uuid4()), "medicine_name_raw": m,
             "reaction_description": r}
            for m, r in (adverse_reactions or [])
        ],
        "history_notes": [],
    })

    return patient_id


CASES = [
    # --- Original cases, must all still pass after the migration ---
    {"n": 1, "desc": "direct allergy match",
     "patient": {"allergies": [("penicillin", "severe")]},
     "medicine": "Penicillin V", "expected": "blocked"},

    {"n": 2, "desc": "drug-class cross-reactivity",
     "patient": {"allergies": [("penicillin", "severe")]},
     "medicine": "Amoxicillin", "expected": "blocked"},

    {"n": 3, "desc": "unrelated medicine passes",
     "patient": {"allergies": [("penicillin", "severe")]},
     "medicine": "Ibuprofen", "expected": "passed"},

    {"n": 4, "desc": "no allergies at all",
     "patient": {},
     "medicine": "Amoxicillin", "expected": "passed"},

    {"n": 5, "desc": "sulfonamide substring",
     "patient": {"allergies": [("sulfamethoxazole", "moderate")]},
     "medicine": "Trimethoprim-sulfamethoxazole", "expected": "blocked"},

    {"n": 6, "desc": "case insensitivity",
     "patient": {"allergies": [("PENICILLIN", "severe")]},
     "medicine": "penicillin v", "expected": "blocked"},

    {"n": 7, "desc": "multiple allergies, one matches by class",
     "patient": {"allergies": [("ibuprofen", "mild"), ("penicillin", "severe")]},
     "medicine": "Amoxicillin", "expected": "blocked"},

    # --- NEW: adverse reactions ---
    {"n": 8, "desc": "prior adverse reaction blocks",
     "patient": {"adverse_reactions": [("codeine", "severe nausea")]},
     "medicine": "Codeine", "expected": "blocked"},

    {"n": 9, "desc": "adverse reaction to a different drug passes",
     "patient": {"adverse_reactions": [("codeine", "severe nausea")]},
     "medicine": "Paracetamol", "expected": "passed"},

    # --- NEW: condition contraindications ---
    {"n": 10, "desc": "NSAID with asthma",
     "patient": {"conditions": ["asthma"]},
     "medicine": "Ibuprofen", "expected": "blocked"},

    {"n": 11, "desc": "paracetamol with asthma is fine",
     "patient": {"conditions": ["asthma"]},
     "medicine": "Paracetamol", "expected": "passed"},

    {"n": 12, "desc": "NSAID with peptic ulcer",
     "patient": {"conditions": ["peptic ulcer disease"]},
     "medicine": "Naproxen", "expected": "blocked"},

    {"n": 13, "desc": "paracetamol with liver disease",
     "patient": {"conditions": ["chronic liver disease"]},
     "medicine": "Paracetamol", "expected": "blocked"},

    {"n": 14, "desc": "decongestant with hypertension",
     "patient": {"conditions": ["hypertension"]},
     "medicine": "Pseudoephedrine", "expected": "blocked"},

    # --- NEW: pregnancy ---
    {"n": 15, "desc": "NSAID in pregnancy",
     "patient": {"pregnancy_status": "pregnant"},
     "medicine": "Ibuprofen", "expected": "blocked"},

    {"n": 16, "desc": "paracetamol in pregnancy is fine",
     "patient": {"pregnancy_status": "pregnant"},
     "medicine": "Paracetamol", "expected": "passed"},

    {"n": 17, "desc": "NSAID when not pregnant is fine",
     "patient": {"pregnancy_status": "not_pregnant"},
     "medicine": "Ibuprofen", "expected": "passed"},

    # --- NEW: duplicate therapy ---
    {"n": 18, "desc": "same medicine already being taken",
     "patient": {"medications": ["Paracetamol"]},
     "medicine": "Paracetamol", "expected": "blocked"},

    {"n": 19, "desc": "same class already being taken",
     "patient": {"medications": ["Ibuprofen"]},
     "medicine": "Naproxen", "expected": "blocked"},

    {"n": 20, "desc": "different class is fine",
     "patient": {"medications": ["Ibuprofen"]},
     "medicine": "Cetirizine", "expected": "passed"},

    # --- Combined ---
    {"n": 21, "desc": "safe despite a full profile",
     "patient": {"allergies": [("penicillin", "severe")],
                 "conditions": ["hypertension"],
                 "medications": ["Metformin"]},
     "medicine": "Paracetamol", "expected": "passed"},
]


def run():
    ok, message = ping()
    if not ok:
        print(f"Cannot run: {message}")
        return 1

    if get_db().drug_class_members.count_documents({}) == 0:
        print("Reference data missing. Run:  python seed_reference_data.py")
        return 1

    passed = 0
    failures = []

    for case in CASES:
        patient_id = make_patient(**case["patient"])

        try:
            result = check_medicine_safety(patient_id, case["medicine"])
            actual = result["result"]
            success = actual == case["expected"]

            if success:
                passed += 1
                print(f"[PASS] {case['n']:>2}. {case['desc']}")
            else:
                failures.append(case)
                print(f"[FAIL] {case['n']:>2}. {case['desc']}")
                print(f"        {case['medicine']} -> expected {case['expected']}, got {actual}")
                if result["blocked_reason"]:
                    print(f"        reason: {result['blocked_reason']}")
        finally:
            repository.delete_patient(patient_id)

    print(f"\n{passed}/{len(CASES)} cases passed.")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(run())
