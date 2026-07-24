"""
Request/response models.

The survey models below are UNCHANGED from your original file — the
frontend's survey payload keeps working exactly as before. Everything new
is at the bottom, under "CHAT".
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Literal, Dict, Any
from datetime import date


# ==========================================================
# SURVEY  (unchanged — existing contract preserved)
# ==========================================================

class AllergyIn(BaseModel):
    category: str              # 'medication' | 'food' | 'latex' | 'contrast_dye' | 'other'
    substance_name: str
    reaction_description: Optional[str] = None
    severity: str              # 'mild' | 'moderate' | 'severe'
    onset_date: Optional[date] = None


class AdverseReactionIn(BaseModel):
    medicine_name_raw: str
    reaction_description: str
    occurred_around: Optional[date] = None


class ConditionIn(BaseModel):
    condition_name: str
    status: str = "active"     # 'active' | 'managed' | 'resolved'
    diagnosed_date: Optional[str] = None


class MedicationIn(BaseModel):
    medicine_name_raw: str
    medication_type: str = "prescription"   # 'prescription' | 'otc' | 'supplement' | 'herbal'
    dosage: Optional[str] = None
    frequency: Optional[str] = None
    route: Optional[str] = None
    reason_for_use: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    status: str = "active"


class HistoryNoteIn(BaseModel):
    category: str              # 'hospitalization' | 'surgery' | 'anesthesia_complication' | 'family_history'
    description: str
    approx_date: Optional[str] = None


class SurveyIn(BaseModel):
    # Q1
    full_name: str
    date_of_birth: str         # "YYYY-MM-DD"
    sex: str                   # 'male' | 'female' | 'other'
    # Q2
    weight_kg: Optional[float] = None
    height_cm: Optional[float] = None
    # Q19
    pregnancy_status: Optional[str] = None
    # Q17, Q18
    alcohol_use: Optional[str] = None
    tobacco_use: Optional[str] = None
    recreational_drug_use: Optional[bool] = None
    recreational_drug_notes: Optional[str] = None
    # Q3
    primary_provider_name: Optional[str] = None
    primary_pharmacy: Optional[str] = None
    # login
    email: str
    password: str

    # Q4-Q7
    medications: List[MedicationIn] = []
    # Q8-Q9
    allergies: List[AllergyIn] = []
    # Q10
    adverse_reactions: List[AdverseReactionIn] = []
    # Q11-Q12
    conditions: List[ConditionIn] = []
    # Q13-Q16
    history_notes: List[HistoryNoteIn] = []


# ==========================================================
# AUTH  (new — the frontend had nowhere to log in)
# ==========================================================

class LoginIn(BaseModel):
    email: str
    password: str


# ==========================================================
# CHAT  (rewritten)
# ==========================================================

class ChatMessage(BaseModel):
    """One prior turn, so the bot can handle follow-ups like 'since
    yesterday' without the frontend re-sending the whole story."""
    role: Literal["user", "assistant"]
    content: str


class ChatIn(BaseModel):
    patient_id: str
    message: str = Field(description="Whatever the user typed — a greeting, a question, or symptoms")
    history: List[ChatMessage] = Field(default_factory=list)


class SafetyCheckIn(BaseModel):
    """
    The OLD /chat body, preserved on its own endpoint (/safety-check).

    Your original /chat took a medicine name that had already been decided
    elsewhere. That is now what /safety-check does, so your existing
    safety-filter test suite keeps working unchanged while /chat becomes
    the real conversational endpoint.
    """
    patient_id: str
    reported_symptoms: str
    recommended_medicine_name: str
    llm_raw_response: Optional[str] = None


# ---------- Structured LLM outputs ----------

Intent = Literal[
    "greeting",           # "hi", "hello"
    "small_talk",         # "how are you", "thanks"
    "identity",           # "who are you", "what can you do"
    "medical_symptoms",   # actual symptoms reported
    "medical_question",   # general health question, no personal symptoms
    "insufficient_info",  # medical but too vague to act on
    "emergency",          # red-flag symptoms
    "out_of_scope",       # unrelated to health entirely
]

Severity = Literal["mild", "moderate", "severe", "not_applicable"]


class TriageResult(BaseModel):
    """Stage 1 output. Deliberately tiny — a small model classifies far more
    reliably than it routes itself inside one large prompt."""
    intent: Intent
    severity: Severity = "not_applicable"
    symptom_summary: Optional[str] = None
    missing_info: List[str] = Field(default_factory=list)


class MedicineBlock(BaseModel):
    name: Optional[str] = None
    typical_adult_dose: Optional[str] = None
    how_to_take: Optional[str] = None
    why_this_one: Optional[str] = None
    max_days_before_review: Optional[str] = None


class ClinicalResponse(BaseModel):
    """Stage 2 output for the medical path — the named sections you asked for."""
    possible_condition: str = ""
    self_care: List[str] = Field(default_factory=list)
    medicine: Optional[MedicineBlock] = None
    warning_signs: List[str] = Field(default_factory=list)
    when_to_seek_care: str = ""


# ---------- Final API response ----------

ChatStatus = Literal[
    "chat",                 # non-medical conversational reply
    "needs_clarification",  # bot asked follow-up questions
    "self_care_only",       # mild — home remedies, no medicine warranted
    "approved",             # medicine suggested and it passed the safety filter
    "urgent_care_needed",   # emergency path
    "exhausted_retries",    # every candidate medicine was blocked
    "error",
]


class ChatOut(BaseModel):
    status: ChatStatus
    intent: Intent
    severity: Severity = "not_applicable"

    # Plain text — a simple chat bubble can render just this and be correct.
    reply: str

    # Structured — a richer UI can render cards from this instead.
    sections: Optional[ClinicalResponse] = None

    medicine_name: Optional[str] = None
    alternatives: List[str] = Field(default_factory=list)
    follow_up_questions: List[str] = Field(default_factory=list)

    safety_filter_result: Optional[str] = None   # 'passed' | 'blocked' | None
    blocked_reason: Optional[str] = None
    requires_medical_attention: bool = False

    prescription_id: Optional[str] = None
    disclaimer: Optional[str] = None
    debug: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
