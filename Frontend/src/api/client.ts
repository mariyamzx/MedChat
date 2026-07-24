// ── API client ───────────────────────────────────────────────────────────────
//
// Every network call in the app goes through this file. Nothing else imports
// fetch. That means the base URL, error handling, and the request/response
// shapes all live in one place, and the UI components stay unaware that a
// server exists at all.
//
// The backend is treated as fixed and is never modified — this layer adapts to
// it, including translating its field names and enum values (see mappers.ts).

import type {
  ChatHistoryTurn,
  ChatResponse,
  HealthResponse,
  LoginResponse,
  PatientProfileResponse,
  PrescriptionHistoryResponse,
  ProfileUpdatePayload,
  ProfileUpdateResponse,
  SurveyPayload,
  SurveyResponse,
} from './types'

export const API_BASE_URL: string =
  (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ||
  'http://127.0.0.1:8000'

/**
 * An error with a message that is safe and useful to show a patient.
 * `status` is the HTTP code where there was one, or 0 for network failures.
 */
export class ApiError extends Error {
  status: number
  detail: string

  constructor(message: string, status: number, detail = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/** FastAPI returns validation errors as an array of objects under `detail`. */
function readDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const detail = (body as { detail?: unknown }).detail

  if (typeof detail === 'string') return detail

  if (Array.isArray(detail)) {
    return detail
      .map(item => {
        if (item && typeof item === 'object') {
          const loc = (item as { loc?: unknown[] }).loc
          const msg = (item as { msg?: string }).msg ?? ''
          const field = Array.isArray(loc) ? loc.filter(p => p !== 'body').join('.') : ''
          return field ? `${field}: ${msg}` : msg
        }
        return String(item)
      })
      .filter(Boolean)
      .join('; ')
  }

  return ''
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body } = options

  let response: Response

  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // fetch only rejects on network-level failures, so this is the
    // "server isn't running" / "wrong port" / "CORS blocked" case.
    throw new ApiError(
      `Can't reach the MedChat server at ${API_BASE_URL}. Make sure the backend is ` +
        `running and that this address is allowed in its CORS settings.`,
      0,
    )
  }

  let parsed: unknown = null
  const text = await response.text()

  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }

  if (!response.ok) {
    const detail = readDetail(parsed) || text.slice(0, 300)
    throw new ApiError(friendlyMessage(response.status, detail), response.status, detail)
  }

  return parsed as T
}

function friendlyMessage(status: number, detail: string): string {
  switch (status) {
    case 400:
      return detail || 'That request was rejected as invalid.'
    case 401:
      // The backend's own wording here is already patient-appropriate and
      // deliberately identical for a wrong email and a wrong password.
      return detail || 'Invalid email or password.'
    case 404:
      return detail || 'We could not find that record.'
    case 409:
      return detail || 'An account with this email already exists. Try logging in instead.'
    case 422:
      return detail
        ? `Some of the information sent was rejected — ${detail}`
        : 'Some of the information sent was rejected.'
    case 429:
      return 'The assistant is receiving too many requests right now. Please wait a moment.'
    case 500:
    case 502:
    case 503:
      return detail
        ? `The server hit an error: ${detail}`
        : 'The server hit an unexpected error. Please try again.'
    default:
      return detail || `Request failed (HTTP ${status}).`
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

export const api = {
  health: () => request<HealthResponse>('/health'),

  /**
   * Creates the account. Note the backend has no separate "register" step —
   * POST /survey is what creates the patient, so the email and password
   * collected at sign-up are submitted together with the survey answers.
   */
  submitSurvey: (payload: SurveyPayload) =>
    request<SurveyResponse>('/survey', { method: 'POST', body: payload }),

  login: (email: string, password: string) =>
    request<LoginResponse>('/login', { method: 'POST', body: { email, password } }),

  getProfile: (patientId: string) =>
    request<PatientProfileResponse>(`/patient-profile/${patientId}`),

  /**
   * Replaces the stored medical history. The whole profile is sent, not a patch,
   * because the survey form is prefilled from the stored record and submitted
   * complete — a partial merge would resurrect entries the patient just deleted.
   */
  updateProfile: (patientId: string, payload: ProfileUpdatePayload) =>
    request<ProfileUpdateResponse>(`/patient-profile/${patientId}`, {
      method: 'PUT',
      body: payload,
    }),

  chat: (patientId: string, message: string, history: ChatHistoryTurn[]) =>
    request<ChatResponse>('/chat', {
      method: 'POST',
      body: { patient_id: patientId, message, history },
    }),

  getPrescriptionHistory: (patientId: string) =>
    request<PrescriptionHistoryResponse>(`/prescription-history/${patientId}`),
}
