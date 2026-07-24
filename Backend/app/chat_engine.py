"""
Stage 2/3 — the conversation pipeline.

FLOW
----
    message
      │
      ├─ triage (deterministic first, then LLM)
      │
      ├─ emergency ──────────────► urgent care reply, NO model call needed
      ├─ greeting/small talk/    ─► conversational reply, medicine forbidden
      │   identity/out of scope
      ├─ insufficient info ──────► ask follow-up questions
      │
      └─ medical symptoms
            │
            ├─ build clinical response (self-care first, medicine per severity)
            ├─ deterministic safety filter on any named medicine
            ├─ blocked?  ─► feed the block reason back, regenerate (up to N times)
            └─ log to prescription_history

The critical property: the medical path is the ONLY path that can produce
a medicine name, and everything on it passes through the safety filter
before the user sees it. There is no route from "hello" to a prescription.
"""

import json
import logging
from typing import Optional, List, Tuple

from app import config, llm_client, prompts, repository, triage
from app.safety_filter import check_medicine_safety
from app.schemas import (
    ChatOut, ClinicalResponse, MedicineBlock, TriageResult,
)

logger = logging.getLogger(__name__)


# ==========================================================
# Profile formatting
# ==========================================================

def format_profile_for_prompt(profile: dict) -> str:
    """
    Renders the patient profile as readable text for the model.

    Kept close to your original function, with two changes: the age is now
    computed from date_of_birth (models reason far better about "34 years
    old" than about a date), and lifestyle factors are included because
    they affect medicine choice.
    """
    patient = profile.get("patient", {})
    lines = []

    lines.append("=== BASIC INFORMATION ===")

    age = _calculate_age(patient.get("date_of_birth"))
    lines.append(f"Age: {age if age is not None else 'Unknown'}")
    lines.append(f"Sex: {patient.get('sex', 'Unknown')}")

    if patient.get("weight_kg") is not None:
        lines.append(f"Weight: {patient['weight_kg']} kg")
    if patient.get("height_cm") is not None:
        lines.append(f"Height: {patient['height_cm']} cm")
    if patient.get("pregnancy_status"):
        lines.append(f"Pregnancy status: {patient['pregnancy_status']}")

    lines.append("\n=== ALLERGIES ===")
    allergies = profile.get("allergies", [])
    if allergies:
        for a in allergies:
            lines.append(
                f"- {a.get('substance_name')} (severity: {a.get('severity', 'unknown')}) "
                f"- reaction: {a.get('reaction_description') or 'not recorded'}"
            )
    else:
        lines.append("None reported")

    lines.append("\n=== CURRENT MEDICATIONS ===")
    medications = profile.get("medications", [])
    if medications:
        for m in medications:
            lines.append(
                f"- {m.get('medicine_name_raw')} "
                f"({m.get('dosage') or 'dose not recorded'}, "
                f"{m.get('frequency') or 'frequency not recorded'}) "
                f"for {m.get('reason_for_use') or 'reason not recorded'}"
            )
    else:
        lines.append("None reported")

    lines.append("\n=== CHRONIC CONDITIONS ===")
    conditions = profile.get("conditions", [])
    if conditions:
        for c in conditions:
            lines.append(f"- {c.get('condition_name')} ({c.get('status', 'active')})")
    else:
        lines.append("None reported")

    lines.append("\n=== PREVIOUS ADVERSE DRUG REACTIONS ===")
    reactions = profile.get("adverse_reactions", [])
    if reactions:
        for r in reactions:
            lines.append(
                f"- {r.get('medicine_name_raw')} caused: {r.get('reaction_description')}"
            )
    else:
        lines.append("None reported")

    lines.append("\n=== MEDICAL HISTORY ===")
    notes = profile.get("history_notes", [])
    if notes:
        for n in notes:
            lines.append(f"- {n.get('category')}: {n.get('description')}")
    else:
        lines.append("None reported")

    lines.append("\n=== LIFESTYLE ===")
    lines.append(f"Alcohol: {patient.get('alcohol_use') or 'not recorded'}")
    lines.append(f"Tobacco: {patient.get('tobacco_use') or 'not recorded'}")

    return "\n".join(lines)


def _calculate_age(dob) -> Optional[int]:
    """Accepts a 'YYYY-MM-DD' string or a date. Returns None rather than
    raising if the value is missing or malformed — an unparseable date of
    birth should never take down a chat request."""
    if not dob:
        return None

    try:
        from datetime import date, datetime

        if isinstance(dob, str):
            parsed = datetime.fromisoformat(dob.replace("Z", "+00:00")).date()
        elif isinstance(dob, datetime):
            parsed = dob.date()
        else:
            parsed = dob

        today = date.today()
        return today.year - parsed.year - (
            (today.month, today.day) < (parsed.month, parsed.day)
        )
    except Exception:
        return None


# ==========================================================
# Rendering — structured sections into readable chat text
# ==========================================================

def render_clinical_reply(response: ClinicalResponse, severity: str) -> str:
    """
    Turns the structured JSON into the message the user actually reads.

    Done in code rather than asking the model for prose, so the ordering is
    guaranteed: self-care ALWAYS appears before any medicine, on every
    response, regardless of what the model felt like emphasising.
    """
    parts = []

    if response.possible_condition:
        parts.append(f"**What this looks like**\n{response.possible_condition}")

    if response.self_care:
        bullets = "\n".join(f"- {s}" for s in response.self_care)
        heading = "**Try this first**" if severity == "mild" else "**Self-care**"
        parts.append(f"{heading}\n{bullets}")

    if response.medicine and response.medicine.name:
        med = response.medicine
        lines = []

        if severity == "mild":
            lines.append(
                f"**If that isn't enough**\n"
                f"If you're not improving after "
                f"{med.max_days_before_review or 'a couple of days'}, "
                f"you could try **{med.name}**."
            )
        else:
            lines.append(f"**Medicine**\n**{med.name}**")

        if med.typical_adult_dose:
            lines.append(f"- Typical adult dose: {med.typical_adult_dose}")
        if med.how_to_take:
            lines.append(f"- How to take it: {med.how_to_take}")
        if med.why_this_one:
            lines.append(f"- Why this one for you: {med.why_this_one}")
        if med.max_days_before_review and severity != "mild":
            lines.append(f"- See someone if it's still going after {med.max_days_before_review}")

        parts.append("\n".join(lines))

    if response.warning_signs:
        bullets = "\n".join(f"- {w}" for w in response.warning_signs)
        parts.append(f"**Get medical help right away if you notice**\n{bullets}")

    if response.when_to_seek_care:
        parts.append(f"**When to see a doctor**\n{response.when_to_seek_care}")

    return "\n\n".join(parts)


# ==========================================================
# Non-medical path
# ==========================================================

def handle_conversation(message: str, history: list, patient_name: str,
                        intent: str) -> str:
    """Conversational reply. The prompt forbids naming medicines, and this
    path never reaches the clinical generator at all — so even a
    misbehaving model cannot produce a prescription here."""
    try:
        return llm_client.call_llm(
            prompts.CONVERSATION_SYSTEM.format(patient_name=patient_name or "there"),
            prompts.CONVERSATION_USER.format(
                history=triage.format_history(history),
                message=message,
            ),
            temperature=0.6,
            max_tokens=200,
        ).strip()
    except Exception as e:
        logger.warning("Conversational LLM call failed: %s", e)
        if intent == "greeting":
            return prompts.GREETING_FALLBACK
        return prompts.LLM_DOWN_FALLBACK


def handle_clarification(message: str, missing_info: List[str]) -> Tuple[str, List[str]]:
    """Asks for missing detail instead of guessing."""
    questions = missing_info or [
        "What symptoms are you having exactly?",
        "How long have you had them?",
        "How bad are they right now?",
    ]

    try:
        reply = llm_client.call_llm(
            prompts.CLARIFY_SYSTEM,
            prompts.CLARIFY_USER.format(
                message=message,
                missing_info="\n".join(f"- {q}" for q in questions),
            ),
            temperature=0.4,
            max_tokens=250,
        ).strip()
    except Exception as e:
        logger.warning("Clarification LLM call failed: %s", e)
        bullets = "\n".join(f"- {q}" for q in questions)
        reply = (
            "I'd like to help, but I need a bit more detail before I can say "
            f"anything useful:\n\n{bullets}"
        )

    return reply, questions


# ==========================================================
# Medical path
# ==========================================================

def generate_clinical_response(
    profile: dict,
    message: str,
    triage_result: TriageResult,
    history: list,
    rejected: Optional[List[str]] = None,
    rejection_reason: Optional[str] = None,
) -> Tuple[ClinicalResponse, str]:
    """One clinical generation attempt. Returns (parsed, raw JSON string)."""
    retry_note = ""
    if rejected:
        retry_note = prompts.RETRY_NOTE_TEMPLATE.format(
            rejected=", ".join(rejected),
            reason=rejection_reason or "not recorded",
        )

    parsed = llm_client.call_llm_structured(
        prompts.CLINICAL_SYSTEM,
        prompts.CLINICAL_USER.format(
            patient_profile=format_profile_for_prompt(profile),
            severity=triage_result.severity,
            symptom_summary=triage_result.symptom_summary or message,
            history=triage.format_history(history),
            message=message,
            retry_note=retry_note,
        ),
        ClinicalResponse,
        temperature=0.2,
        max_tokens=1200,
    )

    return parsed, parsed.model_dump_json(indent=2)


# ==========================================================
# Main entry point
# ==========================================================

def process_message(patient_id: str, message: str, history: Optional[list] = None) -> ChatOut:
    """
    The single function main.py's /chat endpoint calls.

    Returns a fully-populated ChatOut in every case, including failures —
    the endpoint should never have to construct a response itself, and the
    frontend can rely on the same shape coming back every time.
    """
    history = history or []

    # ------------------------------------------------------
    # Load profile
    # ------------------------------------------------------
    profile = repository.get_patient_profile(patient_id)
    if not profile:
        return ChatOut(
            status="error",
            intent="out_of_scope",
            reply="I couldn't find your profile. Please complete the health survey first.",
            error="Patient not found",
        )

    profile["patient"].pop("password_hash", None)  # never goes near the model
    patient_name = (profile["patient"].get("full_name") or "").split(" ")[0]

    # ------------------------------------------------------
    # Triage
    # ------------------------------------------------------
    triage_result = triage.classify(message, history)

    # ------------------------------------------------------
    # Emergency — no model call, no medicine, logged for audit
    # ------------------------------------------------------
    if triage_result.intent == "emergency":
        prescription_id = repository.log_prescription(
            patient_id=patient_id,
            reported_symptoms=message,
            recommended_medicine_name=None,
            llm_raw_response=None,
            safety_filter_result="not_applicable",
            blocked_reason="Emergency path — no medicine suggested",
            intent="emergency",
            severity="severe",
        )

        return ChatOut(
            status="urgent_care_needed",
            intent="emergency",
            severity="severe",
            reply=prompts.EMERGENCY_REPLY,
            requires_medical_attention=True,
            safety_filter_result="not_applicable",
            prescription_id=prescription_id,
            disclaimer=config.DISCLAIMER,
        )

    # ------------------------------------------------------
    # Non-medical — conversational reply
    # ------------------------------------------------------
    if triage_result.intent in ("greeting", "small_talk", "identity",
                               "out_of_scope", "medical_question"):

        # medical_question is general health info with no personal symptoms
        # ("what is paracetamol?"). It gets a conversational answer, but a
        # disclaimer too, since it is still health-related.
        reply = handle_conversation(message, history, patient_name, triage_result.intent)

        return ChatOut(
            status="chat",
            intent=triage_result.intent,
            reply=reply,
            disclaimer=(config.DISCLAIMER
                        if triage_result.intent == "medical_question" else None),
        )

    # ------------------------------------------------------
    # Too vague — ask, don't guess
    # ------------------------------------------------------
    if triage_result.intent == "insufficient_info":
        reply, questions = handle_clarification(message, triage_result.missing_info)

        return ChatOut(
            status="needs_clarification",
            intent="insufficient_info",
            reply=reply,
            follow_up_questions=questions,
        )

    # ------------------------------------------------------
    # Medical path — generate, filter, retry
    # ------------------------------------------------------
    rejected: List[str] = []
    rejection_reason: Optional[str] = None
    last_response: Optional[ClinicalResponse] = None
    last_raw: Optional[str] = None

    for attempt in range(1, config.MAX_SAFETY_RETRIES + 1):
        logger.info("Clinical generation attempt %s/%s", attempt, config.MAX_SAFETY_RETRIES)

        try:
            clinical, raw = generate_clinical_response(
                profile, message, triage_result, history,
                rejected or None, rejection_reason,
            )
        except llm_client.LLMUnavailableError as e:
            logger.error("LLM unavailable: %s", e)
            return ChatOut(
                status="error",
                intent=triage_result.intent,
                severity=triage_result.severity,
                reply=prompts.LLM_DOWN_FALLBACK,
                error=str(e),
                disclaimer=config.DISCLAIMER,
            )
        except Exception as e:
            logger.exception("Clinical generation failed")
            return ChatOut(
                status="error",
                intent=triage_result.intent,
                severity=triage_result.severity,
                reply=prompts.LLM_DOWN_FALLBACK,
                error=str(e),
                disclaimer=config.DISCLAIMER,
            )

        last_response, last_raw = clinical, raw
        medicine_name = clinical.medicine.name if clinical.medicine else None

        # -- No medicine suggested: self-care only. Nothing to filter. --
        if not medicine_name:
            prescription_id = repository.log_prescription(
                patient_id=patient_id,
                reported_symptoms=triage_result.symptom_summary or message,
                recommended_medicine_name=None,
                llm_raw_response=raw,
                safety_filter_result="not_applicable",
                blocked_reason=None,
                intent=triage_result.intent,
                severity=triage_result.severity,
                response_sections=clinical.model_dump(),
            )

            return ChatOut(
                status="self_care_only",
                intent=triage_result.intent,
                severity=triage_result.severity,
                reply=render_clinical_reply(clinical, triage_result.severity),
                sections=clinical,
                safety_filter_result="not_applicable",
                prescription_id=prescription_id,
                disclaimer=config.DISCLAIMER,
            )

        # -- Deterministic safety filter --
        safety = check_medicine_safety(patient_id, medicine_name)
        logger.info("Safety filter on '%s': %s", medicine_name, safety["result"])

        if safety["result"] == "passed":
            prescription_id = repository.log_prescription(
                patient_id=patient_id,
                reported_symptoms=triage_result.symptom_summary or message,
                recommended_medicine_name=medicine_name,
                llm_raw_response=raw,
                safety_filter_result="passed",
                blocked_reason=None,
                alternatives=rejected,
                intent=triage_result.intent,
                severity=triage_result.severity,
                response_sections=clinical.model_dump(),
            )

            return ChatOut(
                status="approved",
                intent=triage_result.intent,
                severity=triage_result.severity,
                reply=render_clinical_reply(clinical, triage_result.severity),
                sections=clinical,
                medicine_name=medicine_name,
                safety_filter_result="passed",
                prescription_id=prescription_id,
                disclaimer=config.DISCLAIMER,
                debug={"attempts": attempt, "rejected": rejected},
            )

        # -- Blocked: log the attempt, then retry with the reason fed back --
        logger.warning("Blocked '%s': %s", medicine_name, safety["blocked_reason"])

        repository.log_prescription(
            patient_id=patient_id,
            reported_symptoms=triage_result.symptom_summary or message,
            recommended_medicine_name=medicine_name,
            llm_raw_response=raw,
            safety_filter_result="blocked",
            blocked_reason=safety["blocked_reason"],
            intent=triage_result.intent,
            severity=triage_result.severity,
        )

        rejected.append(medicine_name)
        rejection_reason = safety["blocked_reason"]

    # ------------------------------------------------------
    # Every candidate was blocked.
    #
    # We still return the self-care portion of the last response — that
    # advice is not a medicine and was never unsafe. Failing to a blank
    # screen would be worse for the user than failing to "here is what you
    # can do without medication, and please ask a pharmacist".
    # ------------------------------------------------------
    logger.error("Exhausted %s attempts for patient %s", config.MAX_SAFETY_RETRIES, patient_id)

    safe_sections = None
    reply_parts = [
        "Based on your medical history, I couldn't find an over-the-counter "
        "medicine I'm confident is safe for you here — everything suitable for "
        "these symptoms conflicts with something in your profile.",
        "**Please speak to a pharmacist or your doctor**, and mention your "
        "allergies and current medicines when you do.",
    ]

    if last_response:
        safe_sections = ClinicalResponse(
            possible_condition=last_response.possible_condition,
            self_care=last_response.self_care,
            medicine=None,
            warning_signs=last_response.warning_signs,
            when_to_seek_care=last_response.when_to_seek_care,
        )
        if last_response.self_care:
            bullets = "\n".join(f"- {s}" for s in last_response.self_care)
            reply_parts.insert(1, f"**In the meantime, these are safe to try**\n{bullets}")

    return ChatOut(
        status="exhausted_retries",
        intent=triage_result.intent,
        severity=triage_result.severity,
        reply="\n\n".join(reply_parts),
        sections=safe_sections,
        alternatives=rejected,
        safety_filter_result="blocked",
        blocked_reason=rejection_reason,
        disclaimer=config.DISCLAIMER,
        error=f"No safe medicine found after {config.MAX_SAFETY_RETRIES} attempts.",
    )
