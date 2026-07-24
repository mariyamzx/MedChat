// ── Backend API types ────────────────────────────────────────────────────────
//
// These mirror API_CONTRACT.md exactly. Nothing here is invented — every field
// corresponds to something the backend actually returns. Keeping them in one
// file means that if the contract ever changes, TypeScript points at every
// call site that needs updating.

export type ChatStatus =
  | 'chat'
  | 'needs_clarification'
  | 'self_care_only'
  | 'approved'
  | 'urgent_care_needed'
  | 'exhausted_retries'
  | 'error'

export type Intent =
  | 'greeting'
  | 'small_talk'
  | 'identity'
  | 'medical_symptoms'
  | 'medical_question'
  | 'insufficient_info'
  | 'emergency'
  | 'out_of_scope'

export type Severity = 'mild' | 'moderate' | 'severe' | 'not_applicable'

export interface MedicineBlock {
  name: string | null
  typical_adult_dose: string | null
  how_to_take: string | null
  why_this_one: string | null
  max_days_before_review: string | null
}

export interface ClinicalSections {
  possible_condition: string
  self_care: string[]
  medicine: MedicineBlock | null
  warning_signs: string[]
  when_to_seek_care: string
}

export interface ChatResponse {
  status: ChatStatus
  intent: Intent
  severity: Severity
  reply: string
  sections: ClinicalSections | null
  medicine_name: string | null
  alternatives: string[]
  follow_up_questions: string[]
  safety_filter_result: string | null
  blocked_reason: string | null
  requires_medical_attention: boolean
  prescription_id: string | null
  disclaimer: string | null
  error: string | null
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

// ── Survey payload (POST /survey) ────────────────────────────────────────────

export interface ApiMedication {
  medicine_name_raw: string
  medication_type: string
  dosage: string | null
  frequency: string | null
  route: string | null
  reason_for_use: string | null
  start_date: string | null
  end_date: string | null
  status: string
}

export interface ApiAllergy {
  category: string
  substance_name: string
  reaction_description: string | null
  severity: string
  onset_date: string | null
}

export interface ApiAdverseReaction {
  medicine_name_raw: string
  reaction_description: string
  occurred_around: string | null
}

export interface ApiCondition {
  condition_name: string
  status: string
  diagnosed_date: string | null
}

export interface ApiHistoryNote {
  category: string
  description: string
  approx_date: string | null
}

/**
 * PUT /patient-profile/{id} body — the survey payload without email or password.
 * Modelled as its own type (rather than Partial<SurveyPayload>) because those
 * two fields must be structurally impossible to send on an update.
 */
export interface ProfileUpdatePayload {
  full_name: string
  date_of_birth: string
  sex: string
  weight_kg: number | null
  height_cm: number | null
  pregnancy_status: string | null
  alcohol_use: string | null
  tobacco_use: string | null
  recreational_drug_use: boolean | null
  recreational_drug_notes: string | null
  primary_provider_name: string | null
  primary_pharmacy: string | null
  medications: ApiMedication[]
  allergies: ApiAllergy[]
  adverse_reactions: ApiAdverseReaction[]
  conditions: ApiCondition[]
  history_notes: ApiHistoryNote[]
}

export interface ProfileUpdateResponse {
  patient_id: string
  message: string
  profile: PatientProfileResponse | null
}

export interface SurveyPayload {
  full_name: string
  date_of_birth: string
  sex: string
  weight_kg: number | null
  height_cm: number | null
  pregnancy_status: string | null
  alcohol_use: string | null
  tobacco_use: string | null
  recreational_drug_use: boolean | null
  recreational_drug_notes: string | null
  primary_provider_name: string | null
  primary_pharmacy: string | null
  email: string
  password: string
  medications: ApiMedication[]
  allergies: ApiAllergy[]
  adverse_reactions: ApiAdverseReaction[]
  conditions: ApiCondition[]
  history_notes: ApiHistoryNote[]
}

export interface SurveyResponse {
  patient_id: string
  message: string
}

export interface LoginResponse {
  patient_id: string
  full_name: string | null
  email: string | null
  message: string
}

// ── Patient profile (GET /patient-profile/{id}) ──────────────────────────────
//
// The backend returns whole documents here, so these are permissive on
// purpose — extra keys are expected and harmless.

export interface ApiPatientCore {
  patient_id: string
  full_name?: string | null
  date_of_birth?: string | null
  sex?: string | null
  weight_kg?: number | null
  height_cm?: number | null
  pregnancy_status?: string | null
  alcohol_use?: string | null
  tobacco_use?: string | null
  recreational_drug_use?: boolean | null
  recreational_drug_notes?: string | null
  primary_provider_name?: string | null
  primary_pharmacy?: string | null
  email?: string | null
}

export interface PatientProfileResponse {
  patient: ApiPatientCore
  allergies: Array<Record<string, unknown>>
  conditions: Array<Record<string, unknown>>
  medications: Array<Record<string, unknown>>
  adverse_reactions: Array<Record<string, unknown>>
  history_notes: Array<Record<string, unknown>>
}

// ── Prescription history (GET /prescription-history/{id}) ────────────────────

export interface ApiPrescription {
  prescription_id: string
  reported_symptoms: string
  recommended_medicine_name: string | null
  safety_filter_result: string
  blocked_reason: string | null
  intent?: string | null
  severity?: string | null
  created_at: string
  alternatives?: Array<{ alternative_medicine_name: string; rank: number }>
}

export interface PrescriptionHistoryResponse {
  patient_id: string
  prescriptions: ApiPrescription[]
}

export interface HealthResponse {
  status: string
  database: { connected: boolean; detail: string }
  llm: { provider: string; configured: boolean }
  config_problems: string[]
}
