"""
Tests for the profile update path.

Needs a database connection but NOT an API key or a running server — it calls
the repository function directly, so it tests the write semantics rather than
FastAPI's routing.

The critical assertions are the ones about what must NOT change: email,
password_hash and created_at. If an update ever wiped those, the account would
become impossible to log into.

Run:  python -m tests.test_profile_update
"""

import sys
import time
import uuid

from app import repository
from app.database import get_db, ping
from app.profile_routes import ProfileUpdateIn
from app.safety_filter import check_medicine_safety


def make_patient():
    """Creates a patient the same way /survey does, via the repository."""
    from app.schemas import SurveyIn

    email = f"update-test-{uuid.uuid4()}@test.local"
    survey = SurveyIn(
        full_name="Original Name",
        date_of_birth="1990-01-01",
        sex="female",
        weight_kg=60.0,
        height_cm=165.0,
        pregnancy_status="not_pregnant",
        email=email,
        password="irrelevant",
        allergies=[{
            "category": "medication", "substance_name": "penicillin",
            "severity": "severe", "reaction_description": "hives",
        }],
        conditions=[{"condition_name": "asthma", "status": "active"}],
        medications=[{"medicine_name_raw": "Salbutamol", "medication_type": "prescription"}],
    )
    return repository.create_patient(survey, "ORIGINAL_HASH"), email


def run():
    ok_db, message = ping()
    if not ok_db:
        print(f"Cannot run: {message}")
        return 1

    results = []

    def check(condition, label, extra=""):
        if condition:
            print(f"[PASS] {label}")
        else:
            print(f"[FAIL] {label} {extra}")
        results.append(bool(condition))

    patient_id, email = make_patient()

    try:
        before = repository.get_patient_raw(patient_id)
        created_at_before = before["created_at"]
        time.sleep(0.01)

        # --- Baseline: the original allergy is enforced ---
        print("--- before update ---")
        check(
            check_medicine_safety(patient_id, "Amoxicillin")["result"] == "blocked",
            "penicillin allergy blocks amoxicillin",
        )
        check(
            check_medicine_safety(patient_id, "Ibuprofen")["result"] == "blocked",
            "asthma blocks ibuprofen",
        )

        # --- Update: swap the allergy, drop the condition, rename ---
        print("\n--- applying update ---")
        payload = ProfileUpdateIn(
            full_name="Updated Name",
            date_of_birth="1991-02-02",
            sex="female",
            weight_kg=62.5,
            height_cm=166.0,
            pregnancy_status="pregnant",
            allergies=[{
                "category": "medication", "substance_name": "sulfamethoxazole",
                "severity": "moderate", "reaction_description": "rash",
            }],
            conditions=[],
            medications=[],
            adverse_reactions=[{
                "medicine_name_raw": "codeine", "reaction_description": "nausea",
            }],
            history_notes=[{"category": "surgery", "description": "appendectomy"}],
        )

        check(repository.update_patient_profile(patient_id, payload) is True,
              "update reports success")

        after = repository.get_patient_raw(patient_id)

        # --- Credentials and audit fields must survive ---
        print("\n--- credentials preserved (the thing that must never break) ---")
        check(after["email"] == email, "email unchanged", f"got {after.get('email')}")
        check(after["password_hash"] == "ORIGINAL_HASH", "password_hash unchanged",
              f"got {after.get('password_hash')}")
        check(after["_id"] == patient_id, "patient_id unchanged")
        check(after["created_at"] == created_at_before, "created_at unchanged")
        check(after["updated_at"] != created_at_before, "updated_at was bumped")

        # --- Core fields updated ---
        print("\n--- fields updated ---")
        check(after["full_name"] == "Updated Name", "full_name updated")
        check(after["date_of_birth"] == "1991-02-02", "date_of_birth updated")
        check(after["weight_kg"] == 62.5, "weight_kg updated")
        check(after["pregnancy_status"] == "pregnant", "pregnancy_status updated")

        # --- Children fully replaced, not merged ---
        print("\n--- children replaced, not merged ---")
        allergies = repository.get_active_allergies(patient_id)
        check(len(allergies) == 1, "exactly one allergy", f"got {len(allergies)}")
        check(allergies[0]["substance_name"] == "sulfamethoxazole",
              "new allergy stored")
        check(allergies[0].get("status") == "active",
              "replaced allergy is marked active (or safety filter would skip it)")
        check(len(repository.get_conditions(patient_id)) == 0,
              "removed condition is gone, not resurrected")
        check(len(repository.get_active_medications(patient_id)) == 0,
              "removed medication is gone")
        check(len(repository.get_adverse_reactions(patient_id)) == 1,
              "adverse reaction added")

        # --- The safety filter follows the new data immediately ---
        print("\n--- safety filter reflects the update ---")
        check(check_medicine_safety(patient_id, "Amoxicillin")["result"] == "passed",
              "old penicillin allergy no longer blocks amoxicillin")
        check(check_medicine_safety(patient_id, "Trimethoprim-sulfamethoxazole")["result"] == "blocked",
              "NEW allergy now blocks by class")
        check(check_medicine_safety(patient_id, "Codeine")["result"] == "blocked",
              "newly added adverse reaction now blocks")
        check(check_medicine_safety(patient_id, "Ibuprofen")["result"] == "blocked",
              "pregnancy now blocks NSAIDs (asthma was removed, pregnancy added)")

        # --- Profile shape unchanged for existing consumers ---
        print("\n--- GET shape still matches the contract ---")
        profile = repository.get_patient_profile(patient_id)
        expected_keys = {"patient", "allergies", "conditions", "medications",
                         "adverse_reactions", "history_notes"}
        check(set(profile.keys()) == expected_keys, "profile keys unchanged",
              f"got {set(profile.keys())}")
        check(profile["patient"]["patient_id"] == patient_id, "patient_id present")

        # --- Missing patient ---
        print("\n--- missing patient ---")
        check(repository.update_patient_profile(str(uuid.uuid4()), payload) is False,
              "update on unknown patient returns False")

        # --- Login still works after the update ---
        print("\n--- login still works ---")
        found = repository.find_patient_by_email(email)
        check(found is not None and found["_id"] == patient_id,
              "patient still findable by email")

    finally:
        repository.delete_patient(patient_id)
        get_db().patients.delete_many({"email": {"$regex": "^update-test-"}})

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed.")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(run())
