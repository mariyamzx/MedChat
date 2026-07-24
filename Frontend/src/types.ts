// ── Frontend domain types ────────────────────────────────────────────────────
//
// These were previously declared inline at the top of App.tsx. They moved here
// so the mapper layer (src/api/mappers.ts) can use them without importing from
// App.tsx, which would create a circular import.
//
// The shapes are unchanged from the original design apart from two additions,
// both noted below.

export type Page = 'auth' | 'survey' | 'chat' | 'history' | 'profile'

export interface User {
  name: string
  email: string
}

export interface Medication {
  id: string
  name: string
  type: string
  dosage: string
  frequency: string
  route: string
  reason: string
  startDate: string
  endDate: string
  status: string
}

export interface Allergy {
  id: string
  category: string
  substance: string
  reaction: string
  severity: string
  onsetDate: string
}

export interface AdverseReaction {
  id: string
  medicine: string
  description: string
  date: string
}

export interface Condition {
  id: string
  name: string
  status: string
  diagnosedDate: string
}

export interface HistoryNote {
  id: string
  category: string
  description: string
  date: string
}

export interface PatientData {
  fullName: string
  dob: string
  sex: string
  height: string
  weight: string
  /**
   * ADDED. The backend stores weight_kg as a number, and a bare "170" is
   * genuinely ambiguous between kg and lb — a 2.2x error in a field used for
   * dose reasoning. An explicit unit removes the guess.
   */
  weightUnit: 'kg' | 'lb'
  medications: Medication[]
  allergies: Allergy[]
  adverseReactions: AdverseReaction[]
  conditions: Condition[]
  historyNotes: HistoryNote[]
  recentMedChanges: boolean
  recentMedChangesNotes: string
  alcohol: string
  tobacco: string
  recreationalDrugs: boolean
  recreationalDrugsNotes: string
  pregnancy: string
}

/** A consultation row in the history view. */
export interface Rx {
  id: string
  date: string
  symptoms: string
  medicine: string
  /**
   * 'urgent' ADDED — the backend logs emergency escalations distinctly from
   * safety-filter blocks, and conflating the two would misreport what happened.
   */
  status: 'approved' | 'blocked' | 'urgent'
  blockedReason?: string
}

// ── Chat presentation ────────────────────────────────────────────────────────

import type { ChatStatus, Severity } from './api/types'

/**
 * What the recommendation card renders. Derived from the backend response by
 * toRec() in src/api/present.ts — kept out of the component so the decision
 * about when the urgent card appears is unit-testable.
 */
export interface Rec {
  kind: 'medicine' | 'urgent' | 'no-safe-option'
  status: ChatStatus
  severity?: Severity
  medicine?: string
  dose?: string
  howToTake?: string
  whyThisOne?: string
  reviewAfter?: string
  blockedReason?: string
}
