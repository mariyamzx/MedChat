"""
Profile update endpoint.

WHY THIS IS A SEPARATE FILE
--------------------------
The frontend's "Update Medical History" screen had nowhere to write to, because
the API could only create a patient (POST /survey), never edit one. That left a
real hazard: a patient could correct an allergy in the UI while the assistant
carried on reasoning over the old, wrong one.

This needed a new endpoint. Putting it in its own router means main.py gains two
lines — an import and an include_router() call — and no existing endpoint,
schema, or function is modified. Everything that worked before behaves
identically.

The route is registered on the same app, so it appears in /docs alongside the
rest.
"""

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from app import repository
from app.database import get_db
from app.schemas import (
    AdverseReactionIn,
    AllergyIn,
    ConditionIn,
    HistoryNoteIn,
    MedicationIn,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["profile"])


class ProfileUpdateIn(BaseModel):
    """
    The survey payload minus email and password.

    Those two are deliberately absent rather than optional. If an update could
    carry them, this endpoint would become a way to change someone's login
    credentials knowing only their patient_id, which is not what a
    "update my medical history" button should be able to do.

    Every other field mirrors SurveyIn exactly, so the frontend can reuse the
    same form and the same payload builder.

    extra="forbid" matters here: Pydantic's default is to silently DROP unknown
    fields, so a request carrying "password" would be quietly ignored. For a
    field this sensitive, a loud 422 is better than a silent no-op — it makes the
    refusal visible instead of leaving the caller thinking it worked.
    """
    model_config = ConfigDict(extra="forbid")

    full_name: str
    date_of_birth: str
    sex: str
    weight_kg: Optional[float] = None
    height_cm: Optional[float] = None
    pregnancy_status: Optional[str] = None
    alcohol_use: Optional[str] = None
    tobacco_use: Optional[str] = None
    recreational_drug_use: Optional[bool] = None
    recreational_drug_notes: Optional[str] = None
    primary_provider_name: Optional[str] = None
    primary_pharmacy: Optional[str] = None

    medications: List[MedicationIn] = []
    allergies: List[AllergyIn] = []
    adverse_reactions: List[AdverseReactionIn] = []
    conditions: List[ConditionIn] = []
    history_notes: List[HistoryNoteIn] = []


def _validate_uuid(id_str: str):
    """Mirrors main.validate_uuid rather than importing it, so this module has no
    dependency on main.py and cannot affect it."""
    import uuid
    try:
        uuid.UUID(id_str)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid patient_id format — must be a UUID")


@router.put("/patient-profile/{patient_id}")
def update_patient_profile(patient_id: str, payload: ProfileUpdateIn, db=Depends(get_db)):
    """
    Replaces a patient's medical history.

    The whole profile is submitted, not a partial patch, because the frontend
    prefills the same five-step survey from the stored record and sends it back
    complete. A partial merge would silently resurrect entries the patient had
    just deleted.

    Email, password and created_at are untouched — see repository
    .update_patient_profile for why that matters.

    Returns the updated profile, so the caller doesn't need a second GET to show
    what was actually stored.
    """
    _validate_uuid(patient_id)

    updated = repository.update_patient_profile(patient_id, payload)
    if not updated:
        raise HTTPException(status_code=404, detail="Patient not found")

    logger.info("Updated profile for patient %s", patient_id)

    profile = repository.get_patient_profile(patient_id)
    if profile:
        profile["patient"].pop("password_hash", None)

    return {
        "patient_id": patient_id,
        "message": "Medical history updated successfully",
        "profile": profile,
    }
