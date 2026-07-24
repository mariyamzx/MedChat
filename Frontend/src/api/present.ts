// ── Chat presentation logic ──────────────────────────────────────────────────
//
// Decides which recommendation card a chat response gets. This lives outside the
// component on purpose: the branch that shows the red "urgent care" card is
// safety-relevant, and logic buried inside JSX can't be unit-tested.
//
// The ordering below is deliberate — urgency is checked before anything else, so
// no other condition can shadow it.

import type { ChatResponse } from './types'
import type { Rec } from '../types'

export function toRec(res: ChatResponse): Rec | undefined {
  // 1. Emergency. Either signal alone is enough: `status` is the routed
  //    outcome, and `requires_medical_attention` is a separate flag the backend
  //    sets. Trusting only one would mean a single field regression could hide
  //    an emergency.
  if (res.status === 'urgent_care_needed' || res.requires_medical_attention) {
    return { kind: 'urgent', status: res.status }
  }

  // 2. Every candidate medicine was blocked for this patient's profile.
  if (res.status === 'exhausted_retries') {
    return {
      kind: 'no-safe-option',
      status: res.status,
      blockedReason: res.blocked_reason ?? undefined,
    }
  }

  // 3. A medicine was suggested and passed the safety filter.
  const med = res.sections?.medicine
  if (med?.name) {
    return {
      kind: 'medicine',
      status: res.status,
      severity: res.severity,
      medicine: med.name,
      dose: med.typical_adult_dose ?? undefined,
      howToTake: med.how_to_take ?? undefined,
      whyThisOne: med.why_this_one ?? undefined,
      reviewAfter: med.max_days_before_review ?? undefined,
    }
  }

  // 4. Conversation, clarification, or self-care only — no card. The reply text
  //    is complete on its own in these cases.
  return undefined
}
