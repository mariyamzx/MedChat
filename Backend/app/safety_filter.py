"""
Deterministic safety filter.

This is CODE, not AI. Nothing here asks the model anything. It is the last
line of defence between a generated suggestion and the patient, and it runs
after every generation.

WHAT CHANGED AND WHY
--------------------
The original filter checked allergies only. Everything else — pregnancy,
chronic conditions, drug interactions, double-dosing — was left to the
prompt, i.e. left to the model's goodwill. For a medical tool that is the
wrong place for those checks, because a model that hallucinates is
precisely the failure this layer exists to catch.

Five independent checks now run, in order of severity:

  1. Allergy, direct match           (was present)
  2. Allergy, drug-class match       (was present)
  3. Prior adverse reaction          (NEW — was in the DB, never checked)
  4. Condition contraindication      (NEW — asthma + NSAID, ulcer + NSAID, ...)
  5. Pregnancy contraindication      (NEW)
  6. Duplicate therapy               (NEW — already taking a same-class drug)

The function signature is unchanged apart from dropping the `db` argument
(the repository layer owns that now), and it still returns
{"result": ..., "blocked_reason": ...}, so callers are unaffected.
"""

import logging
from typing import Optional

from app import repository

logger = logging.getLogger(__name__)


def _norm(s: Optional[str]) -> str:
    return (s or "").strip().lower()


def _overlaps(a: str, b: str) -> bool:
    """Substring match in either direction — 'penicillin' vs 'Penicillin V'.
    Guards against empty strings, which would otherwise match everything and
    block every medicine (a real bug class in the original)."""
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return False
    return a in b or b in a


def _blocked(reason: str) -> dict:
    return {"result": "blocked", "blocked_reason": reason}


_PASSED = {"result": "passed", "blocked_reason": None}


def check_medicine_safety(patient_id: str, recommended_medicine_name: str) -> dict:
    """
    Runs every deterministic check against one candidate medicine.

    Returns {"result": "passed"|"blocked", "blocked_reason": str|None}
    """
    medicine = _norm(recommended_medicine_name)

    if not medicine:
        return _blocked("No medicine name supplied to the safety filter.")

    # ------------------------------------------------------
    # 1 & 2 — Allergies (direct, then drug class)
    # ------------------------------------------------------
    allergies = repository.get_active_allergies(patient_id)
    allergy_substances = [_norm(a.get("substance_name")) for a in allergies]
    allergy_substances = [s for s in allergy_substances if s]

    for substance in allergy_substances:
        if _overlaps(substance, medicine):
            return _blocked(f"Direct match: patient is allergic to '{substance}'")

    for class_name in repository.get_classes_for_medicine(medicine):
        members = repository.get_class_members(class_name)
        for substance in allergy_substances:
            if substance == _norm(class_name) or any(_overlaps(substance, m) for m in members):
                return _blocked(
                    f"Class match: patient is allergic to '{substance}', which is in "
                    f"the same class ('{class_name}') as '{medicine}'"
                )

    # ------------------------------------------------------
    # 3 — Prior adverse reactions
    #
    # The patient already told us this medicine hurt them. That data was
    # being collected by the survey, stored in the database, and then
    # never consulted before recommending. Now it is.
    # ------------------------------------------------------
    for reaction in repository.get_adverse_reactions(patient_id):
        past_med = _norm(reaction.get("medicine_name_raw"))
        if _overlaps(past_med, medicine):
            return _blocked(
                f"Prior adverse reaction: patient previously reacted to "
                f"'{past_med}' ({reaction.get('reaction_description', 'reaction not recorded')})"
            )

    # ------------------------------------------------------
    # 4 — Chronic condition contraindications
    #
    # e.g. NSAIDs in asthma, peptic ulcer, or kidney disease; paracetamol
    # in liver disease. Matched by condition keyword against the patient's
    # recorded conditions, then by medicine name or drug class.
    # ------------------------------------------------------
    conditions = [_norm(c.get("condition_name")) for c in repository.get_conditions(patient_id)]
    conditions = [c for c in conditions if c]
    medicine_classes = {_norm(c) for c in repository.get_classes_for_medicine(medicine)}

    for rule in repository.get_condition_contraindications():
        keyword = _norm(rule.get("condition_keyword"))
        target = _norm(rule.get("target"))
        target_type = rule.get("target_type", "medicine")

        if not any(keyword and keyword in c for c in conditions):
            continue

        hit = (target in medicine_classes) if target_type == "class" else _overlaps(target, medicine)
        if hit:
            return _blocked(
                f"Condition contraindication: '{medicine}' is not advised with "
                f"'{keyword}' — {rule.get('reason', 'contraindicated')}"
            )

    # ------------------------------------------------------
    # 5 — Pregnancy / breastfeeding
    # ------------------------------------------------------
    pregnancy_status = _norm(repository.get_pregnancy_status(patient_id))

    if pregnancy_status in ("pregnant", "breastfeeding", "planning_pregnancy"):
        for rule in repository.get_pregnancy_contraindications():
            target = _norm(rule.get("target"))
            target_type = rule.get("target_type", "medicine")
            applies_to = rule.get("applies_to", ["pregnant", "breastfeeding", "planning_pregnancy"])

            if pregnancy_status not in applies_to:
                continue

            hit = (target in medicine_classes) if target_type == "class" else _overlaps(target, medicine)
            if hit:
                return _blocked(
                    f"Pregnancy contraindication: '{medicine}' is not advised when "
                    f"'{pregnancy_status}' — {rule.get('reason', 'contraindicated')}"
                )

    # ------------------------------------------------------
    # 6 — Duplicate therapy
    #
    # Recommending naproxen to someone already taking ibuprofen is an
    # accidental double dose of the same drug class. This is one of the
    # most common real-world OTC harms and no model can be trusted to
    # catch it every time.
    # ------------------------------------------------------
    current_meds = repository.get_active_medications(patient_id)

    for med in current_meds:
        current = _norm(med.get("medicine_name_raw"))
        if not current:
            continue

        if _overlaps(current, medicine):
            return _blocked(
                f"Duplicate therapy: patient is already taking '{current}' — "
                f"taking '{medicine}' as well risks a double dose"
            )

        if medicine_classes:
            current_classes = {_norm(c) for c in repository.get_classes_for_medicine(current)}
            shared = medicine_classes & current_classes
            if shared:
                return _blocked(
                    f"Duplicate therapy: patient already takes '{current}', which is in "
                    f"the same class ('{', '.join(sorted(shared))}') as '{medicine}'"
                )

    return dict(_PASSED)
