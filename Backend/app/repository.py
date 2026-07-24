"""
Data access layer.

WHY THIS FILE IS THE WHOLE MIGRATION STRATEGY
---------------------------------------------
Previously, raw SQL strings were embedded directly inside the endpoint
functions in main.py and inside safety_filter.py. That meant swapping the
database would have required editing business logic in five places, which
is exactly how a "simple" migration breaks things.

Every database statement now lives in this one file, behind functions with
stable names and stable return shapes. main.py, safety_filter.py and
chat_engine.py call these functions and never touch Mongo directly. The
return shapes are byte-for-byte identical to what the Postgres version
produced, so nothing downstream — including your existing frontend and the
CLI — can tell the difference.

DOCUMENT MODEL
--------------
Postgres needed 6 tables for one patient because relational databases
can't nest. Mongo can, so a patient is ONE document with the child records
embedded as arrays:

    patients {
      _id, full_name, date_of_birth, ..., email, password_hash,
      allergies: [...], conditions: [...], medications: [...],
      adverse_reactions: [...], history_notes: [...]
    }

This turns the old 6-query profile fetch into a single lookup. patient_id
is still a UUID *string* stored in _id, so the existing UUID validation,
the API contract and every stored frontend ID keep working — we did not
switch to Mongo's native ObjectId, deliberately.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from app.database import get_db


# ==========================================================
# Helpers
# ==========================================================

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return str(uuid.uuid4())


def _iso(value):
    """Mongo returns real datetime/date objects. The old Postgres endpoints
    serialised these to ISO strings in the JSON response, so we do the same
    here — otherwise the frontend would suddenly receive a different date
    format and silently render 'Invalid Date'."""
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def _clean(doc: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Recursively converts a Mongo document into plain JSON-safe values."""
    if doc is None:
        return None

    out = {}
    for k, v in doc.items():
        if isinstance(v, dict):
            out[k] = _clean(v)
        elif isinstance(v, list):
            out[k] = [_clean(i) if isinstance(i, dict) else _iso(i) for i in v]
        else:
            out[k] = _iso(v)
    return out


# ==========================================================
# PATIENTS
# ==========================================================

def email_exists(email: str) -> bool:
    return get_db().patients.count_documents(
        {"email": email.strip().lower()}, limit=1
    ) > 0


def create_patient(survey, password_hash: str) -> str:
    """
    Replaces the old multi-INSERT transaction.

    Postgres needed one INSERT per table plus a manual db.commit() and a
    rollback handler. Here the entire patient — including every allergy,
    condition and medication — is a single atomic document insert. There is
    no partial-write failure mode left to handle.
    """
    patient_id = _new_id()
    now = _now()

    doc = {
        "_id": patient_id,
        "full_name": survey.full_name,
        "date_of_birth": survey.date_of_birth,
        "sex": survey.sex,
        "weight_kg": survey.weight_kg,
        "height_cm": survey.height_cm,
        "pregnancy_status": survey.pregnancy_status,
        "alcohol_use": survey.alcohol_use,
        "tobacco_use": survey.tobacco_use,
        "recreational_drug_use": survey.recreational_drug_use,
        "recreational_drug_notes": survey.recreational_drug_notes,
        "primary_provider_name": survey.primary_provider_name,
        "primary_pharmacy": survey.primary_pharmacy,
        "email": survey.email.strip().lower(),
        "password_hash": password_hash,
        "created_at": now,
        "updated_at": now,

        "medications": [
            {"medication_id": _new_id(), **_stringify_dates(m.model_dump())}
            for m in survey.medications
        ],
        "allergies": [
            {"allergy_id": _new_id(), "status": "active", **_stringify_dates(a.model_dump())}
            for a in survey.allergies
        ],
        "adverse_reactions": [
            {"reaction_id": _new_id(), **_stringify_dates(r.model_dump())}
            for r in survey.adverse_reactions
        ],
        "conditions": [
            {"condition_id": _new_id(), **_stringify_dates(c.model_dump())}
            for c in survey.conditions
        ],
        "history_notes": [
            {"note_id": _new_id(), **_stringify_dates(h.model_dump())}
            for h in survey.history_notes
        ],
    }

    get_db().patients.insert_one(doc)
    return patient_id


def _stringify_dates(d: dict) -> dict:
    """Pydantic gives us `date` objects, which PyMongo cannot encode
    (it handles datetime, not date). Converting to ISO strings here is the
    fix for what would otherwise be an InvalidDocument error on any survey
    containing an onset_date."""
    return {k: (v.isoformat() if hasattr(v, "isoformat") and not isinstance(v, str) else v)
            for k, v in d.items()}


def patient_exists(patient_id: str) -> bool:
    return get_db().patients.count_documents({"_id": patient_id}, limit=1) > 0


def get_patient_raw(patient_id: str) -> Optional[dict]:
    return get_db().patients.find_one({"_id": patient_id})


def find_patient_by_email(email: str) -> Optional[dict]:
    return get_db().patients.find_one({"email": email.strip().lower()})


def get_patient_profile(patient_id: str) -> Optional[dict]:
    """
    Returns the EXACT same JSON shape the Postgres version returned:
    {patient, allergies, conditions, medications, adverse_reactions,
     history_notes}

    This is the contract that chatbot.py and the frontend depend on, so it
    is reassembled from the embedded document rather than changed. Note the
    'active' filters on allergies and medications — those were WHERE
    clauses in the old SQL and are preserved here as list comprehensions.
    """
    doc = get_patient_raw(patient_id)
    if not doc:
        return None

    doc = _clean(doc)

    child_keys = ["allergies", "conditions", "medications",
                  "adverse_reactions", "history_notes"]

    patient = {k: v for k, v in doc.items() if k not in child_keys}
    patient["patient_id"] = patient.pop("_id")

    return {
        "patient": patient,
        "allergies": [a for a in doc.get("allergies", [])
                      if a.get("status", "active") == "active"],
        "conditions": doc.get("conditions", []),
        "medications": [m for m in doc.get("medications", [])
                        if m.get("status", "active") == "active"],
        "adverse_reactions": doc.get("adverse_reactions", []),
        "history_notes": doc.get("history_notes", []),
    }


def get_active_allergies(patient_id: str) -> List[dict]:
    """Used by the safety filter. Projection pulls back only the allergies
    array rather than the whole patient document."""
    doc = get_db().patients.find_one({"_id": patient_id}, {"allergies": 1})
    if not doc:
        return []
    return [a for a in doc.get("allergies", []) if a.get("status", "active") == "active"]


def get_active_medications(patient_id: str) -> List[dict]:
    doc = get_db().patients.find_one({"_id": patient_id}, {"medications": 1})
    if not doc:
        return []
    return [m for m in doc.get("medications", []) if m.get("status", "active") == "active"]


def get_conditions(patient_id: str) -> List[dict]:
    doc = get_db().patients.find_one({"_id": patient_id}, {"conditions": 1})
    return doc.get("conditions", []) if doc else []


def get_adverse_reactions(patient_id: str) -> List[dict]:
    doc = get_db().patients.find_one({"_id": patient_id}, {"adverse_reactions": 1})
    return doc.get("adverse_reactions", []) if doc else []


def get_pregnancy_status(patient_id: str) -> Optional[str]:
    doc = get_db().patients.find_one({"_id": patient_id}, {"pregnancy_status": 1})
    return doc.get("pregnancy_status") if doc else None


def delete_patient(patient_id: str) -> None:
    """Used by the test suites. In Postgres the child rows disappeared via
    ON DELETE CASCADE; here they are inside the document, so deleting the
    document removes them by construction."""
    get_db().patients.delete_one({"_id": patient_id})
    get_db().prescription_history.delete_many({"patient_id": patient_id})


def update_patient_profile(patient_id: str, survey) -> bool:
    """
    Replaces a patient's medical history in place. Returns False if no such
    patient exists.

    ADDED so the frontend's "Update Medical History" screen can actually write
    through. Without it, a patient could correct an allergy while the assistant
    kept reasoning over the old one — the worst failure mode this app has.

    WHY $set AND NOT replace_one
    ----------------------------
    replace_one would drop every field not present in the new document, which
    means email, password_hash and created_at would be wiped and the account
    would become unusable. $set touches only the listed fields, so credentials
    and audit timestamps survive untouched. `survey` deliberately carries no
    email or password for the same reason — an update must not be able to
    change them.

    Child collections are replaced wholesale rather than merged, because the
    frontend submits the complete survey every time (the form is prefilled from
    the stored profile). Merging would silently resurrect an allergy the patient
    had just deleted.
    """
    now = _now()

    update = {
        "full_name": survey.full_name,
        "date_of_birth": survey.date_of_birth,
        "sex": survey.sex,
        "weight_kg": survey.weight_kg,
        "height_cm": survey.height_cm,
        "pregnancy_status": survey.pregnancy_status,
        "alcohol_use": survey.alcohol_use,
        "tobacco_use": survey.tobacco_use,
        "recreational_drug_use": survey.recreational_drug_use,
        "recreational_drug_notes": survey.recreational_drug_notes,
        "primary_provider_name": survey.primary_provider_name,
        "primary_pharmacy": survey.primary_pharmacy,
        "updated_at": now,

        # IDs are regenerated because these are full replacements, not edits to
        # individual rows. Nothing references them, so there is nothing to break.
        "medications": [
            {"medication_id": _new_id(), **_stringify_dates(m.model_dump())}
            for m in survey.medications
        ],
        "allergies": [
            {"allergy_id": _new_id(), "status": "active", **_stringify_dates(a.model_dump())}
            for a in survey.allergies
        ],
        "adverse_reactions": [
            {"reaction_id": _new_id(), **_stringify_dates(r.model_dump())}
            for r in survey.adverse_reactions
        ],
        "conditions": [
            {"condition_id": _new_id(), **_stringify_dates(c.model_dump())}
            for c in survey.conditions
        ],
        "history_notes": [
            {"note_id": _new_id(), **_stringify_dates(h.model_dump())}
            for h in survey.history_notes
        ],
    }

    result = get_db().patients.update_one({"_id": patient_id}, {"$set": update})
    return result.matched_count > 0


# ==========================================================
# REFERENCE DATA  (static clinical data, curated — not patient data)
# ==========================================================

def get_classes_for_medicine(medicine: str) -> List[str]:
    """
    Replaces the old SQL that used ILIKE with || concatenation. Mongo has no
    ILIKE, so matching is done in Python over what is a very small
    collection — clearer, and it avoids regex-injection issues from
    medicine names containing special characters.
    """
    medicine = medicine.strip().lower()
    classes = set()

    for row in get_db().drug_class_members.find({}, {"class_name": 1, "medicine_name": 1}):
        name = (row.get("medicine_name") or "").strip().lower()
        if not name:
            continue
        if name in medicine or medicine in name:
            classes.add(row["class_name"])

    return sorted(classes)


def get_class_members(class_name: str) -> List[str]:
    return [
        (r.get("medicine_name") or "").strip().lower()
        for r in get_db().drug_class_members.find({"class_name": class_name})
    ]


def get_condition_contraindications() -> List[dict]:
    return list(get_db().condition_contraindications.find({}, {"_id": 0}))


def get_pregnancy_contraindications() -> List[dict]:
    return list(get_db().pregnancy_contraindications.find({}, {"_id": 0}))


# ==========================================================
# PRESCRIPTION HISTORY
# ==========================================================

def log_prescription(
    patient_id: str,
    reported_symptoms: str,
    recommended_medicine_name: Optional[str],
    llm_raw_response: Optional[str],
    safety_filter_result: str,
    blocked_reason: Optional[str],
    alternatives: Optional[List[str]] = None,
    intent: Optional[str] = None,
    severity: Optional[str] = None,
    response_sections: Optional[dict] = None,
) -> str:
    """
    Replaces the INSERT ... RETURNING prescription_id, plus the separate
    prescription_alternatives table — alternatives are now an embedded
    array, which removes the second query that the history endpoint had to
    run per prescription (the old N+1 query pattern).
    """
    prescription_id = _new_id()

    get_db().prescription_history.insert_one({
        "_id": prescription_id,
        "patient_id": patient_id,
        "reported_symptoms": reported_symptoms,
        "recommended_medicine_name": recommended_medicine_name,
        "llm_raw_response": llm_raw_response,
        "safety_filter_result": safety_filter_result,
        "blocked_reason": blocked_reason,
        "admin_reviewed": False,
        "admin_decision": None,
        "reviewed_by": None,
        "intent": intent,
        "severity": severity,
        "response_sections": response_sections,
        "alternatives": [
            {"alternative_medicine_name": a, "rank": i + 1}
            for i, a in enumerate(alternatives or [])
        ],
        "created_at": _now(),
    })

    return prescription_id


def get_prescription_history(patient_id: str) -> List[dict]:
    """Newest first — same ordering as the old ORDER BY created_at DESC."""
    rows = get_db().prescription_history.find(
        {"patient_id": patient_id}
    ).sort("created_at", -1)

    history = []
    for r in rows:
        entry = _clean(r)
        entry["prescription_id"] = entry.pop("_id")
        entry.setdefault("alternatives", [])
        history.append(entry)

    return history
