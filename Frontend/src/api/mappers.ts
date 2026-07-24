// ── Mappers ──────────────────────────────────────────────────────────────────
//
// The frontend survey and the backend API were designed independently, so they
// disagree on field names, enum values and units. Since the backend is fixed,
// every one of those disagreements is reconciled here.
//
// This file is the entire reason integration works without touching the
// backend. If a value ever looks wrong in the database, this is the only place
// to look.
//
// Mismatches handled:
//
//   fullName         -> full_name
//   dob              -> date_of_birth
//   sex              "Male"/"Intersex"/"Prefer not to say" -> male/female/other
//   height           free text ("5ft 10in", "178 cm") -> height_cm number
//   weight           number + unit -> weight_kg number
//   pregnancy        "planning"/"not-applicable" -> planning_pregnancy/not_applicable
//   alcohol          "moderate"/"heavy" -> regular
//   tobacco          "cigarettes"/"vaping"/"other" -> current
//   medication.name  -> medicine_name_raw ; "as-needed" status -> active
//   allergy.substance-> substance_name ; "contrast-dye" -> contrast_dye
//   reaction.date    free text ("2021") -> null, text folded into description
//   recentMedChanges no backend field -> folded into history_notes

import type {
  ApiAdverseReaction,
  ApiAllergy,
  ApiCondition,
  ApiHistoryNote,
  ApiMedication,
  ApiPrescription,
  PatientProfileResponse,
  ProfileUpdatePayload,
  SurveyPayload,
} from './types'

import type {
  AdverseReaction,
  Allergy,
  Condition,
  HistoryNote,
  Medication,
  PatientData,
  Rx,
} from '../types'

const uid = () => Math.random().toString(36).slice(2, 9)

/** Empty strings must become null, not "", or they land in the database. */
function orNull(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The backend types `occurred_around` as a real date, so anything that isn't
 * ISO YYYY-MM-DD would be rejected with a 422. Free-text answers like "2021"
 * are dropped from the date field and preserved in the description instead, so
 * no information is silently lost.
 */
function isoDateOrNull(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null
  return Number.isNaN(new Date(trimmed).getTime()) ? null : trimmed
}

// ── Unit parsing ─────────────────────────────────────────────────────────────

/**
 * Parses height into centimetres.
 *
 * Bare numbers are safe to disambiguate here because the plausible ranges
 * don't overlap: 100-250 can only be cm, and 4-8 can only be feet.
 */
export function parseHeightToCm(raw: string): number | null {
  const text = (raw ?? '').trim().toLowerCase()
  if (!text) return null

  const feetInches = text.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(\d+(?:\.\d+)?)?/)
  if (feetInches) {
    const feet = parseFloat(feetInches[1])
    const inches = feetInches[2] ? parseFloat(feetInches[2]) : 0
    return round1(feet * 30.48 + inches * 2.54)
  }

  const inchesOnly = text.match(/(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)/)
  if (inchesOnly) return round1(parseFloat(inchesOnly[1]) * 2.54)

  const metres = text.match(/(\d+\.\d+)\s*m(?:eters?|etres?)?\b/)
  if (metres) return round1(parseFloat(metres[1]) * 100)

  const cm = text.match(/(\d+(?:\.\d+)?)\s*cm/)
  if (cm) return round1(parseFloat(cm[1]))

  const bare = text.match(/^(\d+(?:\.\d+)?)$/)
  if (bare) {
    const n = parseFloat(bare[1])
    if (n >= 90 && n <= 260) return round1(n)          // centimetres
    if (n >= 3 && n <= 8.5) return round1(n * 30.48)   // feet
    if (n >= 1.2 && n <= 2.3) return round1(n * 100)   // metres
  }

  return null
}

/** Parses weight into kilograms. An explicit unit in the text wins over the dropdown. */
export function parseWeightToKg(raw: string, unit: 'kg' | 'lb'): number | null {
  const text = (raw ?? '').trim().toLowerCase()
  if (!text) return null

  if (/\b(lbs?|pounds?)\b/.test(text)) {
    const n = parseFloat(text)
    return Number.isFinite(n) ? round1(n * 0.453592) : null
  }
  if (/\bkgs?\b|\bkilo/.test(text)) {
    const n = parseFloat(text)
    return Number.isFinite(n) ? round1(n) : null
  }

  const n = parseFloat(text)
  if (!Number.isFinite(n)) return null
  return unit === 'lb' ? round1(n * 0.453592) : round1(n)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

// ── Enum mapping ─────────────────────────────────────────────────────────────

function mapSex(value: string): string {
  switch (value) {
    case 'Male':   return 'male'
    case 'Female': return 'female'
    case 'Intersex': return 'intersex'
    case 'Prefer not to say': return 'prefer_not_to_say'
    default: return (value || '').trim().toLowerCase().replace(/\s+/g, '_')
  }
}

function mapPregnancy(value: string): string | null {
  switch (value) {
    case 'pregnant':
      return 'pregnant'
    case 'breastfeeding':
      return 'breastfeeding'
    case 'planning':
      return 'planning_pregnancy'
    case 'not-applicable':
      return 'not_applicable'
    default:
      return null
  }
}

function mapAlcohol(value: string): string | null {
  return orNull(value)   // store verbatim
}

function mapTobacco(value: string): string | null {
  return orNull(value)   // store verbatim
}

function mapMedicationStatus(value: string): string {
  // 'as-needed' has no backend equivalent, but the patient IS still taking it,
  // so it must map to 'active' — mapping it to 'discontinued' would hide a live
  // medication from the interaction and duplicate-therapy checks.
  return value === 'discontinued' ? 'discontinued' : 'active'
}

function mapAllergyCategory(value: string): string {
  return value === 'contrast-dye' ? 'contrast_dye' : value || 'other'
}

function mapHistoryCategory(value: string): string {
  switch (value) {
    case 'anesthesia':
      return 'anesthesia_complication'
    case 'family-history':
      return 'family_history'
    case 'mental-health':
      return 'mental_health'
    default:
      return value || 'hospitalization'
  }
}

// ── Frontend -> backend ──────────────────────────────────────────────────────

/**
 * The shared body of both the create and update payloads.
 *
 * Split out so POST /survey and PUT /patient-profile/{id} can never drift
 * apart. They must produce identical medical data — if they didn't, updating a
 * profile could quietly store it in a different shape from the original, and
 * the safety filter would read one of them wrong.
 */
export function buildProfileBody(patient: PatientData): ProfileUpdatePayload {
  const medications: ApiMedication[] = patient.medications
    .filter(m => (m.name || '').trim())
    .map(m => ({
      medicine_name_raw: m.name.trim(),
      medication_type: orNull(m.type) ?? 'prescription',
      dosage: orNull(m.dosage),
      frequency: orNull(m.frequency),
      route: orNull(m.route),
      reason_for_use: orNull(m.reason),
      start_date: isoDateOrNull(m.startDate),
      end_date: isoDateOrNull(m.endDate),
      status: mapMedicationStatus(m.status),
    }))

  const allergies: ApiAllergy[] = patient.allergies
    .filter(a => (a.substance || '').trim())
    .map(a => ({
      category: mapAllergyCategory(a.category),
      substance_name: a.substance.trim(),
      reaction_description: orNull(a.reaction),
      // severity is required by the backend; 'moderate' is the safe default
      // because it neither downplays nor exaggerates an unstated reaction.
      severity: orNull(a.severity) ?? 'moderate',
      onset_date: isoDateOrNull(a.onsetDate),
    }))

  const adverse_reactions: ApiAdverseReaction[] = patient.adverseReactions
    .filter(r => (r.medicine || '').trim())
    .map(r => {
      const iso = isoDateOrNull(r.date)
      const freeText = !iso && orNull(r.date) ? ` (around ${r.date.trim()})` : ''
      return {
        medicine_name_raw: r.medicine.trim(),
        reaction_description: (orNull(r.description) ?? 'Reaction not described') + freeText,
        occurred_around: iso,
      }
    })

  const conditions: ApiCondition[] = patient.conditions
    .filter(c => (c.name || '').trim())
    .map(c => ({
      condition_name: c.name.trim(),
      status: orNull(c.status) ?? 'active',
      diagnosed_date: orNull(c.diagnosedDate),
    }))

  const history_notes: ApiHistoryNote[] = patient.historyNotes
    .filter(h => (h.description || '').trim())
    .map(h => ({
      category: mapHistoryCategory(h.category),
      description: h.description.trim(),
      approx_date: orNull(h.date),
    }))

  // The survey asks about recent medication changes but the backend has no
  // column for it. Rather than discard clinically relevant information, it is
  // recorded as a history note, which the assistant does read.
  if (patient.recentMedChanges) {
    history_notes.push({
      category: 'medication_change',
      description:
        orNull(patient.recentMedChangesNotes) ??
        'Patient reported a recent change to their medications but gave no details.',
      approx_date: null,
    })
  }

  return {
    full_name: patient.fullName.trim(),
    date_of_birth: patient.dob,
    sex: mapSex(patient.sex),
    weight_kg: parseWeightToKg(patient.weight, patient.weightUnit),
    height_cm: parseHeightToCm(patient.height),
    pregnancy_status: mapPregnancy(patient.pregnancy),
    alcohol_use: mapAlcohol(patient.alcohol),
    tobacco_use: mapTobacco(patient.tobacco),
    recreational_drug_use: patient.recreationalDrugs,
    recreational_drug_notes: patient.recreationalDrugs
      ? orNull(patient.recreationalDrugsNotes)
      : null,
    primary_provider_name: null,
    primary_pharmacy: null,
    medications,
    allergies,
    adverse_reactions,
    conditions,
    history_notes,
  }
}

/** POST /survey — the call that creates the account, so it carries credentials. */
export function buildSurveyPayload(
  patient: PatientData,
  credentials: { email: string; password: string },
): SurveyPayload {
  return {
    ...buildProfileBody(patient),
    email: credentials.email.trim().toLowerCase(),
    password: credentials.password,
  }
}

/**
 * PUT /patient-profile/{id} — deliberately carries NO email or password. The
 * backend rejects them too, so an update can't be used to change someone's
 * login credentials.
 */
export function buildProfileUpdatePayload(patient: PatientData): ProfileUpdatePayload {
  return buildProfileBody(patient)
}

// ── Backend -> frontend ──────────────────────────────────────────────────────

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function unmapSex(value: string): string {
  switch ((value || '').toLowerCase()) {
    case 'male':
      return 'Male'
    case 'female':
      return 'Female'
    case 'intersex': 
      return 'Intersex'
    case 'prefer_not_to_say': 
      return 'Prefer not to say'
    default:
      return 'Prefer not to say'
  }
}

function unmapAlcohol(value: string): string {
  if (value === 'regular') return 'moderate'   // legacy record
  return value
}

function unmapTobacco(value: string): string {
  if (value === 'current') return 'other'      // legacy record
  return value
}

function unmapPregnancy(value: string): string {
  switch (value) {
    case 'planning_pregnancy':
      return 'planning'
    case 'not_applicable':
    case 'not_pregnant':
      return 'not-applicable'
    case 'pregnant':
    case 'breastfeeding':
      return value
    default:
      return ''
  }
}

function unmapHistoryCategory(value: string): string {
  switch (value) {
    case 'anesthesia_complication':
      return 'anesthesia'
    case 'family_history':
      return 'family-history'
    case 'mental_health':
      return 'mental-health'
    default:
      return value
  }
}

/**
 * Rebuilds the survey's own data shape from a stored profile, so the profile
 * page and the "update medical history" screen show what the server actually
 * holds rather than whatever happens to be in browser state.
 */
export function profileToPatientData(profile: PatientProfileResponse): PatientData {
  const p = profile.patient ?? { patient_id: '' }

  const medications: Medication[] = (profile.medications ?? []).map(m => ({
    id: str(m.medication_id) || uid(),
    name: str(m.medicine_name_raw),
    type: str(m.medication_type),
    dosage: str(m.dosage),
    frequency: str(m.frequency),
    route: str(m.route),
    reason: str(m.reason_for_use),
    startDate: str(m.start_date),
    endDate: str(m.end_date),
    status: str(m.status),
  }))

  const allergies: Allergy[] = (profile.allergies ?? []).map(a => ({
    id: str(a.allergy_id) || uid(),
    category: str(a.category) === 'contrast_dye' ? 'contrast-dye' : str(a.category),
    substance: str(a.substance_name),
    reaction: str(a.reaction_description),
    severity: str(a.severity),
    onsetDate: str(a.onset_date),
  }))

  const adverseReactions: AdverseReaction[] = (profile.adverse_reactions ?? []).map(r => ({
    id: str(r.reaction_id) || uid(),
    medicine: str(r.medicine_name_raw),
    description: str(r.reaction_description),
    date: str(r.occurred_around),
  }))

  const conditions: Condition[] = (profile.conditions ?? []).map(c => ({
    id: str(c.condition_id) || uid(),
    name: str(c.condition_name),
    status: str(c.status),
    diagnosedDate: str(c.diagnosed_date),
  }))

  const allNotes = profile.history_notes ?? []

  // The synthetic 'medication_change' note written on submit is unpacked back
  // into the toggle it came from, so a round trip through the server doesn't
  // turn it into a stray history entry.
  const changeNote = allNotes.find(h => str(h.category) === 'medication_change')

  const historyNotes: HistoryNote[] = allNotes
    .filter(h => str(h.category) !== 'medication_change')
    .map(h => ({
      id: str(h.note_id) || uid(),
      category: unmapHistoryCategory(str(h.category)),
      description: str(h.description),
      date: str(h.approx_date),
    }))

  return {
    fullName: str(p.full_name),
    dob: str(p.date_of_birth).slice(0, 10),
    sex: p.sex ? unmapSex(str(p.sex)) : '',
    height: p.height_cm === null || p.height_cm === undefined ? '' : `${p.height_cm} cm`,
    weight: p.weight_kg === null || p.weight_kg === undefined ? '' : String(p.weight_kg),
    weightUnit: 'kg',
    medications,
    allergies,
    adverseReactions,
    conditions,
    historyNotes,
    recentMedChanges: Boolean(changeNote),
    recentMedChangesNotes: changeNote ? str(changeNote.description) : '',
    alcohol: unmapAlcohol(str(p.alcohol_use)),
    tobacco: unmapTobacco(str(p.tobacco_use)),
    recreationalDrugs: Boolean(p.recreational_drug_use),
    recreationalDrugsNotes: str(p.recreational_drug_notes),
    pregnancy: unmapPregnancy(str(p.pregnancy_status)),
  }
}

/**
 * Turns a logged prescription into a history row.
 *
 * The backend logs every attempt, including ones the safety filter blocked and
 * emergency escalations where no medicine was ever suggested. Those are
 * distinct outcomes and are labelled as such rather than flattened.
 */
export function prescriptionToRx(p: ApiPrescription): Rx {
  const noMedicine = !p.recommended_medicine_name

  // Both the emergency path and the self-care-only path log
  // safety_filter_result='not_applicable' with no medicine, so that pair cannot
  // tell them apart. `intent` is the real discriminator; the blocked_reason
  // text is the fallback for records written before intent was logged.
  const isEmergency =
    p.intent === 'emergency' ||
    (noMedicine && (p.blocked_reason ?? '').toLowerCase().includes('emergency'))

  const status: Rx['status'] = isEmergency
    ? 'urgent'
    : p.safety_filter_result === 'blocked'
      ? 'blocked'
      : 'approved'

  let medicine: string
  if (isEmergency) {
    medicine = 'Escalated to urgent care'
  } else if (p.recommended_medicine_name) {
    medicine = p.recommended_medicine_name
  } else {
    medicine = 'Self-care advice — no medicine needed'
  }

  return {
    id: p.prescription_id,
    date: formatDate(p.created_at),
    symptoms: p.reported_symptoms || '—',
    medicine,
    status,
    blockedReason: p.blocked_reason ?? undefined,
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
