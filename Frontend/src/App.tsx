import { useState, useRef, useEffect, type ReactNode } from 'react'

import { api, ApiError, API_BASE_URL } from './api/client'
import {
  buildProfileUpdatePayload,
  buildSurveyPayload,
  prescriptionToRx,
  profileToPatientData,
} from './api/mappers'
import { toRec } from './api/present'
import type {
  ChatHistoryTurn,
  ChatResponse,
  ClinicalSections,
  Severity,
} from './api/types'
import type {
  AdverseReaction,
  Allergy,
  Condition,
  HistoryNote,
  Medication,
  Page,
  PatientData,
  Rec,
  Rx,
  User,
} from './types'
import { Markdown } from './components/Markdown'

// ── Types ─────────────────────────────────────────────────────────────────────
//
// The survey/patient shapes moved to src/types.ts so the mapper layer can share
// them. What remains here is UI-only state.
//
// REMOVED: SYMPTOM_DB, EMERGENCY_TERMS and botRespond(). Those were a
// hard-coded lookup table of ten symptom keywords with fixed medicine strings —
// a design-time placeholder. Recommendations now come from the backend, which
// reasons over the patient's full stored history and runs six deterministic
// safety checks before any medicine is returned. Keeping a second, weaker copy
// of that logic in the browser would risk the two disagreeing.

interface Msg {
  id: string
  role: 'user' | 'bot'
  /** Always the backend's full `reply` text — this is what gets sent back as history. */
  content: string
  time: string
  sections?: ClinicalSections | null
  rec?: Rec
  followUps?: string[]
  disclaimer?: string | null
  isError?: boolean
}

// ── Constants & Helpers ───────────────────────────────────────────────────────

const EMPTY_PATIENT: PatientData = {
  fullName: '', dob: '', sex: '', height: '', weight: '', weightUnit: 'kg',
  medications: [], allergies: [], adverseReactions: [], conditions: [], historyNotes: [],
  recentMedChanges: false, recentMedChangesNotes: '',
  alcohol: '', tobacco: '', recreationalDrugs: false, recreationalDrugsNotes: '', pregnancy: ''
}

const STEP_LABELS = ['About You', 'Medications', 'Allergies', 'Medical History', 'Lifestyle']

// The medical history itself now lives on the server, so the browser only
// remembers who is signed in. On reload the profile is re-fetched, which means
// the app can never show history that has drifted out of sync with what the
// assistant is actually reasoning over.
interface Session { patientId: string; name: string; email: string }
const SESSION_KEY = 'medchat_session'

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Session
    return parsed?.patientId ? parsed : null
  } catch {
    return null
  }
}
function saveSession(session: Session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)) } catch { /* storage disabled */ }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* storage disabled */ }
}

const uid = () => Math.random().toString(36).slice(2, 9)
const ts  = () => new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

/** Turns a backend chat response into a renderable bot message. */
function toBotMsg(res: ChatResponse): Msg {
  return {
    id: uid(),
    role: 'bot',
    content: res.reply,
    time: ts(),
    sections: res.sections,
    rec: toRec(res),
    followUps: res.follow_up_questions?.length ? res.follow_up_questions : undefined,
    disclaimer: res.disclaimer,
  }
}

// ── Shared Components ─────────────────────────────────────────────────────────

const inpBase = 'px-3 py-2.5 rounded-xl border border-lav-200 bg-white text-plum text-sm placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-lav-400/30 focus:border-lav-500 transition'
const inp = `w-full ${inpBase}`

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold text-plum-light tracking-widest uppercase">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  )
}

function PBtn({ onClick, children, type = 'button', disabled, sm }: {
  onClick?: () => void; children: ReactNode; type?: 'button' | 'submit'; disabled?: boolean; sm?: boolean
}) {
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`bg-lav-500 hover:bg-lav-600 text-white rounded-xl font-semibold text-sm transition disabled:opacity-40 cursor-pointer active:scale-95 ${sm ? 'px-3 py-1.5' : 'px-5 py-2.5'}`}>
      {children}
    </button>
  )
}

function SBtn({ onClick, children, sm }: { onClick?: () => void; children: ReactNode; sm?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`bg-white border border-lav-200 text-plum hover:bg-lav-50 rounded-xl font-medium text-sm transition cursor-pointer ${sm ? 'px-3 py-1.5' : 'px-4 py-2.5'}`}>
      {children}
    </button>
  )
}

function StepProgress({ step }: { step: number }) {
  return (
    <div className="flex items-start">
      {STEP_LABELS.map((label, i) => (
        <div key={i} className="flex-1 flex items-center">
          <div className="flex flex-col items-center gap-1.5">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all flex-shrink-0
              ${i < step ? 'bg-lav-500 text-white' : i === step ? 'bg-lav-500 text-white ring-4 ring-lav-200' : 'bg-white border-2 border-lav-200 text-muted'}`}>
              {i < step ? '✓' : i + 1}
            </div>
            <span className={`text-[10px] font-semibold tracking-wide whitespace-nowrap ${i === step ? 'text-lav-500' : i < step ? 'text-plum-light' : 'text-muted'}`}>
              {label}
            </span>
          </div>
          {i < STEP_LABELS.length - 1 && (
            <div className={`flex-1 h-0.5 mx-1 mb-5 ${i < step ? 'bg-lav-500' : 'bg-lav-200'} transition-colors`} />
          )}
        </div>
      ))}
    </div>
  )
}

function EntryCard({ title, subtitle, badge, onEdit, onDelete }: {
  title: string; subtitle?: string; badge?: string; onEdit: () => void; onDelete: () => void
}) {
  return (
    <div className="flex items-start justify-between p-3.5 bg-lav-50 border border-lav-200 rounded-xl gap-3 group transition hover:border-lav-300">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-plum text-sm">{title}</span>
          {badge && (
            <span className="px-2 py-0.5 bg-lav-200 text-plum-light rounded-full text-[10px] font-semibold uppercase tracking-wide">
              {badge}
            </span>
          )}
        </div>
        {subtitle && <p className="text-xs text-muted mt-0.5 line-clamp-2">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button type="button" onClick={onEdit}
          className="p-1.5 rounded-lg text-muted hover:text-plum hover:bg-lav-100 text-xs transition cursor-pointer" title="Edit">
          ✏️
        </button>
        <button type="button" onClick={onDelete}
          className="p-1.5 rounded-lg text-muted hover:text-red-500 hover:bg-red-50 text-xs transition cursor-pointer" title="Remove">
          ✕
        </button>
      </div>
    </div>
  )
}

function EmptyState({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <button type="button" onClick={onAdd}
      className="w-full py-7 border-2 border-dashed border-lav-200 rounded-xl text-muted text-sm hover:border-lav-400 hover:text-lav-500 hover:bg-lav-50 transition cursor-pointer flex flex-col items-center gap-1.5">
      <span className="text-xl opacity-50">＋</span>
      <span className="font-medium">{label}</span>
    </button>
  )
}

function AddMoreBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex items-center gap-1.5 text-lav-500 hover:text-lav-600 text-sm font-semibold cursor-pointer transition">
      <span className="text-base leading-none">+</span> {label}
    </button>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div>
      <h3 className="font-bold text-plum text-sm">{children}</h3>
      <div className="w-6 h-0.5 bg-lav-400 rounded-full mt-1" />
    </div>
  )
}

// ── Recommendation Card ───────────────────────────────────────────────────────

function RecCard({ rec }: { rec: Rec }) {
  // Same pill styling as the old confidence badge. The backend no longer
  // returns a self-reported confidence score — it returns a triaged severity,
  // which is a real signal rather than the model grading its own work.
  const sevCls: Record<string, string> = {
    mild:     'text-emerald-700 bg-emerald-50 border-emerald-200',
    moderate: 'text-sky-700 bg-sky-50 border-sky-200',
    severe:   'text-amber-700 bg-amber-50 border-amber-200',
  }

  if (rec.kind === 'urgent') {
    return (
      <div className="rounded-2xl border p-5 space-y-3 w-full"
        style={{ borderColor: '#FBBEBE', backgroundColor: '#FFF1F1' }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-black text-xl flex-shrink-0"
            style={{ backgroundColor: '#E05252' }}>!</div>
          <p className="font-bold text-sm leading-snug" style={{ color: '#7F1D1D' }}>
            Urgent Medical Attention Required
          </p>
        </div>
        <p className="text-sm leading-relaxed" style={{ color: '#991B1B' }}>
          Your symptoms indicate a potentially serious condition.{' '}
          <strong>Do not self-medicate.</strong> Please call your local emergency number
          or go to your nearest emergency department immediately.
        </p>
        <button type="button"
          onClick={() => window.open('https://www.google.com/maps/search/urgent+care+near+me', '_blank')}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm font-semibold transition cursor-pointer hover:opacity-90 active:scale-95"
          style={{ backgroundColor: '#E05252' }}>
          📍 Find Nearby Care
        </button>
      </div>
    )
  }

  // Every over-the-counter option was ruled out by the deterministic safety
  // filter for this specific patient. Shown as its own state rather than as a
  // recommendation, because there is no medicine to recommend.
  if (rec.kind === 'no-safe-option') {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 space-y-3 w-full">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-400 flex items-center justify-center text-white font-black text-xl flex-shrink-0">
            ⚠
          </div>
          <p className="font-bold text-sm leading-snug text-amber-900">
            No Safe Option Found For You
          </p>
        </div>
        <p className="text-sm leading-relaxed text-amber-800">
          The safety checks ruled out every suitable over-the-counter medicine based on
          your saved allergies, conditions and current medicines.{' '}
          <strong>Please speak to a pharmacist or your doctor.</strong>
        </p>
        {rec.blockedReason && (
          <p className="text-xs text-amber-800/90 border-t border-amber-200 pt-3 leading-relaxed">
            <span className="font-semibold">Why: </span>{rec.blockedReason}
          </p>
        )}
      </div>
    )
  }

  const isFallback = rec.severity === 'mild'

  return (
    <div className="rounded-2xl border border-lav-200 bg-white p-5 space-y-3 w-full">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">
            {isFallback ? 'If self-care isn\u2019t enough' : 'Suggested'}
          </p>
          <p className="font-bold text-plum text-sm leading-snug">{rec.medicine}</p>
        </div>
        {rec.severity && rec.severity !== 'not_applicable' && (
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border flex-shrink-0 ${sevCls[rec.severity]}`}>
            {rec.severity}
          </span>
        )}
      </div>

      {(rec.dose || rec.howToTake || rec.reviewAfter) && (
        <div className="border-t border-lav-100 pt-3 space-y-1.5">
          {rec.dose && (
            <p className="text-xs text-plum-light leading-relaxed">
              <span className="font-semibold text-plum">Dose: </span>{rec.dose}
            </p>
          )}
          {rec.howToTake && (
            <p className="text-xs text-plum-light leading-relaxed">
              <span className="font-semibold text-plum">How to take it: </span>{rec.howToTake}
            </p>
          )}
          {rec.reviewAfter && (
            <p className="text-xs text-plum-light leading-relaxed">
              <span className="font-semibold text-plum">
                {isFallback ? 'Try self-care first for: ' : 'See someone if it lasts beyond: '}
              </span>
              {rec.reviewAfter}
            </p>
          )}
        </div>
      )}

      {rec.whyThisOne && (
        <p className="text-xs text-plum-light leading-relaxed border-t border-lav-100 pt-3">
          <span className="font-semibold text-plum">Why this one for you: </span>{rec.whyThisOne}
        </p>
      )}

      <p className="text-[10px] text-muted border-t border-lav-100 pt-3 leading-relaxed">
        ⚠️ Not a prescription. Always consult a healthcare provider before starting any medication.
      </p>
    </div>
  )
}

// ── Auth Page ─────────────────────────────────────────────────────────────────

/**
 * Log in hits POST /login. Sign up does NOT hit the network here — the backend
 * creates the patient in POST /survey, which needs the medical history too, so
 * the credentials are held and submitted together at the end of the survey.
 */
function AuthPage({ onLogin, onSignup }: {
  onLogin: (email: string, password: string) => Promise<void>
  onSignup: (user: User, password: string) => void
}) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: string, v: string) => { setF(p => ({ ...p, [k]: v })); setError(null) }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return

    const email = f.email.trim()

    if (mode === 'signup') {
      // The confirm field was collected but never checked before, so a typo
      // silently created an account nobody could log into.
      if (f.password !== f.confirm) {
        setError('Those passwords don\u2019t match.')
        return
      }
      if (f.password.length < 8) {
        setError('Please use a password of at least 8 characters.')
        return
      }
      onSignup({ name: f.name.trim() || email.split('@')[0], email }, f.password)
      return
    }

    setBusy(true)
    setError(null)
    try {
      await onLogin(email, f.password)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log in. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-lav-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2.5 mb-2">
            <div className="w-11 h-11 rounded-2xl bg-lav-500 flex items-center justify-center shadow-sm">
              <span className="text-white font-black text-xl">M</span>
            </div>
            <span className="text-2xl font-bold text-plum tracking-tight">MedChat</span>
          </div>
          <p className="text-sm text-muted">Personalized medicine guidance, safely</p>
        </div>

        <div className="bg-white rounded-2xl border border-lav-200 p-7 shadow-sm">
          <div className="flex bg-lav-100 rounded-xl p-1 mb-6">
            {(['login', 'signup'] as const).map(m => (
              <button key={m} type="button" onClick={() => { setMode(m); setError(null) }}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition cursor-pointer
                  ${mode === m ? 'bg-white text-plum shadow-sm' : 'text-muted hover:text-plum-light'}`}>
                {m === 'login' ? 'Log In' : 'Sign Up'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === 'signup' && (
              <Field label="Full Name">
                <input value={f.name} onChange={e => set('name', e.target.value)}
                  placeholder="Jane Smith" autoComplete="name" className={inp} />
              </Field>
            )}
            <Field label="Email">
              <input type="email" value={f.email} onChange={e => set('email', e.target.value)}
                placeholder="you@example.com" required autoComplete="email" className={inp} />
            </Field>
            <Field label="Password">
              <input type="password" value={f.password} onChange={e => set('password', e.target.value)}
                placeholder="••••••••" required minLength={8}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className={inp} />
            </Field>
            {mode === 'signup' && (
              <Field label="Confirm Password">
                <input type="password" value={f.confirm} onChange={e => set('confirm', e.target.value)}
                  placeholder="••••••••" autoComplete="new-password" className={inp} />
              </Field>
            )}

            {error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5">
                <p className="text-xs text-red-700 leading-relaxed">{error}</p>
              </div>
            )}

            <PBtn type="submit" disabled={!f.email || !f.password || busy}>
              {busy ? 'Logging in…' : mode === 'login' ? 'Log In →' : 'Create Account →'}
            </PBtn>
          </form>

          {mode === 'signup' && (
            <p className="text-xs text-muted mt-4 leading-relaxed">
              Next you'll fill in your medical history. Your account is created when you
              finish it.
            </p>
          )}
        </div>

        <p className="text-center text-xs text-muted mt-4 leading-relaxed">
          Your health data is stored on the MedChat server so recommendations can be
          checked against your history.
        </p>
      </div>
    </div>
  )
}

// ── Survey Steps ──────────────────────────────────────────────────────────────

function Step1({ data, setData }: { data: PatientData; setData: (d: PatientData) => void }) {
  const set = (k: keyof PatientData, v: string) => setData({ ...data, [k]: v })
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        A few basics about you. This helps us give advice that's right for your age, sex, and body size.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Field label="Full Name *">
            <input value={data.fullName} onChange={e => set('fullName', e.target.value)}
              placeholder="Jane Smith" autoComplete="name" className={inp} />
          </Field>
        </div>
        <Field label="Date of Birth *" hint="Your age affects safe doses for some medicines">
          <input type="date" value={data.dob} onChange={e => set('dob', e.target.value)} className={inp} />
        </Field>
        <Field label="Sex *" hint="Some medicines work differently depending on sex">
          <select value={data.sex} onChange={e => set('sex', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Intersex">Intersex</option>
            <option value="Prefer not to say">Prefer not to say</option>
          </select>
        </Field>
        <Field label="Height" hint="Used to work out the right medicine dose">
          <input value={data.height} onChange={e => set('height', e.target.value)} placeholder="e.g. 5ft 10in or 178 cm" className={inp} />
        </Field>
        {/*
          The unit is now explicit. A bare "170" is genuinely ambiguous between
          pounds and kilograms — a 2.2x difference in a value the assistant uses
          when reasoning about doses.
        */}
        <Field label="Weight" hint="Used to work out the right medicine dose">
          <div className="flex gap-2">
            <input value={data.weight} onChange={e => set('weight', e.target.value)}
              inputMode="decimal" placeholder="e.g. 77" className={`${inpBase} flex-1 min-w-0`} />
            <select value={data.weightUnit}
              onChange={e => setData({ ...data, weightUnit: e.target.value as 'kg' | 'lb' })}
              className="w-20 shrink-0 px-2.5 py-2.5 rounded-xl border border-lav-200 bg-white text-plum text-sm focus:outline-none focus:ring-2 focus:ring-lav-400/30 focus:border-lav-500 transition">
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </div>
        </Field>
      </div>
      <p className="text-xs text-muted">* Required</p>
    </div>
  )
}

function MedFormInline({ med, onChange, onSave, onCancel }: {
  med: Partial<Medication>; onChange: (m: Partial<Medication>) => void
  onSave: () => void; onCancel: () => void
}) {
  const s = (k: keyof Medication, v: string) => onChange({ ...med, [k]: v })
  return (
    <div className="bg-lav-50 border border-lav-300 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="Medicine Name">
            <input value={med.name || ''} onChange={e => s('name', e.target.value)} placeholder="e.g. Metformin" className={inp} />
          </Field>
        </div>
        <Field label="Type">
          <select value={med.type || ''} onChange={e => s('type', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="prescription">Prescription (from a doctor)</option>
            <option value="otc">Over-the-counter (bought without a prescription)</option>
            <option value="supplement">Supplement (vitamins, minerals)</option>
            <option value="herbal">Herbal / natural remedy</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={med.status || ''} onChange={e => s('status', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="active">Still taking it</option>
            <option value="discontinued">Stopped taking it</option>
          </select>
        </Field>
        <Field label="Dosage" hint="e.g. how many mg per dose">
          <input value={med.dosage || ''} onChange={e => s('dosage', e.target.value)} placeholder="e.g. 500 mg" className={inp} />
        </Field>
        <Field label="Frequency" hint="How often you take it">
          <input value={med.frequency || ''} onChange={e => s('frequency', e.target.value)} placeholder="e.g. twice a day, or only when needed" className={inp} />
        </Field>
        <Field label="How You Take It">
          <select value={med.route || ''} onChange={e => s('route', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="Oral">By mouth (swallowed)</option>
            <option value="Topical">On the skin</option>
            <option value="Injection">Injection (a shot)</option>
            <option value="Inhalation">Breathed in (inhaler)</option>
            <option value="Sublingual">Under the tongue</option>
            <option value="Nasal">Through the nose</option>
          </select>
        </Field>
        <Field label="Reason for Use" hint="What condition it's for">
          <input value={med.reason || ''} onChange={e => s('reason', e.target.value)} placeholder="e.g. Type 2 Diabetes" className={inp} />
        </Field>
        <Field label="Start Date">
          <input type="date" value={med.startDate || ''} onChange={e => s('startDate', e.target.value)} className={inp} />
        </Field>
        <Field label="End Date">
          <input type="date" value={med.endDate || ''} onChange={e => s('endDate', e.target.value)} className={inp} />
        </Field>
      </div>
      <div className="flex gap-2 pt-1">
        <PBtn onClick={onSave} sm>Save medication</PBtn>
        <SBtn onClick={onCancel} sm>Cancel</SBtn>
      </div>
    </div>
  )
}

function Step2({ data, setData }: { data: PatientData; setData: (d: PatientData) => void }) {
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<Partial<Medication>>({})

  function save() {
    if (!form.name) return
    if (editId) {
      setData({ ...data, medications: data.medications.map(m => m.id === editId ? { ...(form as Medication), id: editId } : m) })
      setEditId(null)
    } else {
      setData({ ...data, medications: [...data.medications, { ...form, id: uid() } as Medication] })
      setAdding(false)
    }
    setForm({})
  }

  function startEdit(m: Medication) {
    setEditId(m.id); setForm(m); setAdding(false)
  }

  return (
    <div className="space-y-7">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          List anything you take regularly — prescription drugs, over-the-counter medicines,
          vitamins, or herbal remedies. This helps us avoid recommending something that could
          interact badly with what you're already taking.
        </p>
        <div className="space-y-2.5">
          {data.medications.map(m =>
            editId === m.id
              ? <MedFormInline key={m.id} med={form} onChange={setForm} onSave={save}
                  onCancel={() => { setEditId(null); setForm({}) }} />
              : <EntryCard key={m.id} title={m.name} badge={m.type}
                  subtitle={[m.dosage, m.frequency, m.status].filter(Boolean).join(' · ')}
                  onEdit={() => startEdit(m)}
                  onDelete={() => setData({ ...data, medications: data.medications.filter(x => x.id !== m.id) })} />
          )}
        </div>
        {adding && !editId && (
          <MedFormInline med={form} onChange={setForm} onSave={save}
            onCancel={() => { setAdding(false); setForm({}) }} />
        )}
        {!adding && !editId && (
          data.medications.length === 0
            ? <EmptyState label="Add a medication" onAdd={() => setAdding(true)} />
            : <AddMoreBtn label="Add medication" onClick={() => setAdding(true)} />
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 bg-lav-50 border border-lav-200 rounded-xl">
          <div>
            <p className="font-semibold text-plum text-sm">Any Recent Changes?</p>
            <p className="text-xs text-muted mt-0.5">Started, stopped, or changed the dose of any medicine recently?</p>
          </div>
          <button type="button" onClick={() => setData({ ...data, recentMedChanges: !data.recentMedChanges })}
            className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer flex-shrink-0 ${data.recentMedChanges ? 'bg-lav-500' : 'bg-lav-300'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${data.recentMedChanges ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {data.recentMedChanges && (
          <Field label="What changed?" hint="e.g. 'Doctor doubled my blood pressure dose last week'">
            <textarea value={data.recentMedChangesNotes}
              onChange={e => setData({ ...data, recentMedChangesNotes: e.target.value })}
              placeholder="Briefly describe what changed and when"
              rows={2} className={inp + ' resize-none'} />
          </Field>
        )}
      </div>
    </div>
  )
}

function Step3({ data, setData }: { data: PatientData; setData: (d: PatientData) => void }) {
  const [addingA, setAddingA] = useState(false)
  const [editAId, setEditAId] = useState<string | null>(null)
  const [aForm, setAForm] = useState<Partial<Allergy>>({})

  const [addingR, setAddingR] = useState(false)
  const [editRId, setEditRId] = useState<string | null>(null)
  const [rForm, setRForm] = useState<Partial<AdverseReaction>>({})

  const sA = (k: keyof Allergy, v: string) => setAForm(f => ({ ...f, [k]: v }))
  const sR = (k: keyof AdverseReaction, v: string) => setRForm(f => ({ ...f, [k]: v }))

  function saveAllergy() {
    if (!aForm.substance) return
    if (editAId) {
      setData({ ...data, allergies: data.allergies.map(a => a.id === editAId ? { ...(aForm as Allergy), id: editAId } : a) })
      setEditAId(null)
    } else {
      setData({ ...data, allergies: [...data.allergies, { ...aForm, id: uid() } as Allergy] })
      setAddingA(false)
    }
    setAForm({})
  }

  function saveReaction() {
    if (!rForm.medicine) return
    if (editRId) {
      setData({ ...data, adverseReactions: data.adverseReactions.map(r => r.id === editRId ? { ...(rForm as AdverseReaction), id: editRId } : r) })
      setEditRId(null)
    } else {
      setData({ ...data, adverseReactions: [...data.adverseReactions, { ...rForm, id: uid() } as AdverseReaction] })
      setAddingR(false)
    }
    setRForm({})
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div>
          <SectionTitle>Known Allergies</SectionTitle>
          <p className="text-xs text-muted mt-1.5">
            Any allergies to medicines, food, latex, or dyes used in medical scans — and how serious the reaction was.
          </p>
        </div>
        <div className="space-y-2.5">
          {data.allergies.map(a =>
            editAId === a.id
              ? <AllergyForm key={a.id} aForm={aForm} sA={sA} onSave={saveAllergy} onCancel={() => { setEditAId(null); setAForm({}) }} />
              : <EntryCard key={a.id} title={a.substance} badge={a.severity}
                  subtitle={[a.category, a.reaction].filter(Boolean).join(' · ')}
                  onEdit={() => { setEditAId(a.id); setAForm(a) }}
                  onDelete={() => setData({ ...data, allergies: data.allergies.filter(x => x.id !== a.id) })} />
          )}
        </div>
        {addingA && !editAId && <AllergyForm aForm={aForm} sA={sA} onSave={saveAllergy} onCancel={() => { setAddingA(false); setAForm({}) }} />}
        {!addingA && !editAId && (
          data.allergies.length === 0
            ? <EmptyState label="Add an allergy" onAdd={() => setAddingA(true)} />
            : <AddMoreBtn label="Add allergy" onClick={() => setAddingA(true)} />
        )}
      </div>

      <div className="space-y-3">
        <div>
          <SectionTitle>Bad Reactions to Medicine</SectionTitle>
          <p className="text-xs text-muted mt-1.5">
            Times a medicine made you seriously unwell, even if it wasn't a true allergy.
          </p>
        </div>
        <div className="space-y-2.5">
          {data.adverseReactions.map(r =>
            editRId === r.id
              ? <ReactionForm key={r.id} rForm={rForm} sR={sR} onSave={saveReaction} onCancel={() => { setEditRId(null); setRForm({}) }} />
              : <EntryCard key={r.id} title={r.medicine} subtitle={r.description}
                  onEdit={() => { setEditRId(r.id); setRForm(r) }}
                  onDelete={() => setData({ ...data, adverseReactions: data.adverseReactions.filter(x => x.id !== r.id) })} />
          )}
        </div>
        {addingR && !editRId && <ReactionForm rForm={rForm} sR={sR} onSave={saveReaction} onCancel={() => { setAddingR(false); setRForm({}) }} />}
        {!addingR && !editRId && (
          data.adverseReactions.length === 0
            ? <EmptyState label="Add an adverse drug reaction" onAdd={() => setAddingR(true)} />
            : <AddMoreBtn label="Add reaction" onClick={() => setAddingR(true)} />
        )}
      </div>
    </div>
  )
}

// Top-level (not nested inside Step3) so they don't get redefined — and remounted, losing input focus — on every keystroke.
function AllergyForm({ aForm, sA, onSave, onCancel }: {
  aForm: Partial<Allergy>; sA: (k: keyof Allergy, v: string) => void; onSave: () => void; onCancel: () => void
}) {
  return (
    <div className="bg-lav-50 border border-lav-300 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category">
          <select value={aForm.category || ''} onChange={e => sA('category', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="medication">Medication</option><option value="food">Food</option>
            <option value="latex">Latex</option>
            <option value="contrast-dye">Iodine / dye used in medical scans</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="What are you allergic to?">
          <input value={aForm.substance || ''} onChange={e => sA('substance', e.target.value)} placeholder="e.g. Penicillin" className={inp} />
        </Field>
        <div className="col-span-2">
          <Field label="What happens when exposed?" hint="e.g. rash, swelling, trouble breathing">
            <input value={aForm.reaction || ''} onChange={e => sA('reaction', e.target.value)} placeholder="e.g. Hives, facial swelling" className={inp} />
          </Field>
        </div>
        <Field label="How Serious?">
          <select value={aForm.severity || ''} onChange={e => sA('severity', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="mild">Mild (minor, e.g. a small rash)</option>
            <option value="moderate">Moderate (noticeable, uncomfortable)</option>
            <option value="severe">Severe (breathing trouble, swelling, emergency)</option>
          </select>
        </Field>
        <Field label="Onset Date">
          <input type="date" value={aForm.onsetDate || ''} onChange={e => sA('onsetDate', e.target.value)} className={inp} />
        </Field>
      </div>
      <div className="flex gap-2"><PBtn onClick={onSave} sm>Save allergy</PBtn><SBtn onClick={onCancel} sm>Cancel</SBtn></div>
    </div>
  )
}

function ReactionForm({ rForm, sR, onSave, onCancel }: {
  rForm: Partial<AdverseReaction>; sR: (k: keyof AdverseReaction, v: string) => void; onSave: () => void; onCancel: () => void
}) {
  return (
    <div className="bg-lav-50 border border-lav-300 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Which Medicine?">
          <input value={rForm.medicine || ''} onChange={e => sR('medicine', e.target.value)} placeholder="e.g. Amoxicillin" className={inp} />
        </Field>
        <Field label="Roughly When?">
          <input value={rForm.date || ''} onChange={e => sR('date', e.target.value)} placeholder="e.g. 2021" className={inp} />
        </Field>
        <div className="col-span-2">
          <Field label="What Happened?" hint="This isn't the same as an allergy — describe any time a medicine made you seriously unwell">
            <input value={rForm.description || ''} onChange={e => sR('description', e.target.value)} placeholder="e.g. Severe rash, hospitalized overnight" className={inp} />
          </Field>
        </div>
      </div>
      <div className="flex gap-2"><PBtn onClick={onSave} sm>Save reaction</PBtn><SBtn onClick={onCancel} sm>Cancel</SBtn></div>
    </div>
  )
}

function Step4({ data, setData }: { data: PatientData; setData: (d: PatientData) => void }) {
  const [addingC, setAddingC] = useState(false)
  const [editCId, setEditCId] = useState<string | null>(null)
  const [cForm, setCForm] = useState<Partial<Condition>>({})

  const [addingH, setAddingH] = useState(false)
  const [editHId, setEditHId] = useState<string | null>(null)
  const [hForm, setHForm] = useState<Partial<HistoryNote>>({})

  const sC = (k: keyof Condition, v: string) => setCForm(f => ({ ...f, [k]: v }))
  const sH = (k: keyof HistoryNote, v: string) => setHForm(f => ({ ...f, [k]: v }))

  function saveCond() {
    if (!cForm.name) return
    if (editCId) {
      setData({ ...data, conditions: data.conditions.map(c => c.id === editCId ? { ...(cForm as Condition), id: editCId } : c) })
      setEditCId(null)
    } else {
      setData({ ...data, conditions: [...data.conditions, { ...cForm, id: uid() } as Condition] })
      setAddingC(false)
    }
    setCForm({})
  }

  function saveHist() {
    if (!hForm.description) return
    if (editHId) {
      setData({ ...data, historyNotes: data.historyNotes.map(h => h.id === editHId ? { ...(hForm as HistoryNote), id: editHId } : h) })
      setEditHId(null)
    } else {
      setData({ ...data, historyNotes: [...data.historyNotes, { ...hForm, id: uid() } as HistoryNote] })
      setAddingH(false)
    }
    setHForm({})
  }

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div>
          <SectionTitle>Diagnosed Conditions</SectionTitle>
          <p className="text-xs text-muted mt-1.5">
            Anything a doctor has diagnosed you with — for example diabetes, high blood pressure,
            heart disease, asthma, or thyroid disease.
          </p>
        </div>
        <div className="space-y-2.5">
          {data.conditions.map(c =>
            editCId === c.id
              ? <CondForm key={c.id} cForm={cForm} sC={sC} onSave={saveCond} onCancel={() => { setEditCId(null); setCForm({}) }} />
              : <EntryCard key={c.id} title={c.name} badge={c.status}
                  subtitle={c.diagnosedDate ? `Diagnosed: ${c.diagnosedDate}` : undefined}
                  onEdit={() => { setEditCId(c.id); setCForm(c) }}
                  onDelete={() => setData({ ...data, conditions: data.conditions.filter(x => x.id !== c.id) })} />
          )}
        </div>
        {addingC && !editCId && <CondForm cForm={cForm} sC={sC} onSave={saveCond} onCancel={() => { setAddingC(false); setCForm({}) }} />}
        {!addingC && !editCId && (
          data.conditions.length === 0
            ? <EmptyState label="Add a diagnosed condition" onAdd={() => setAddingC(true)} />
            : <AddMoreBtn label="Add condition" onClick={() => setAddingC(true)} />
        )}
      </div>

      <div className="space-y-3">
        <div>
          <SectionTitle>Other Medical History</SectionTitle>
          <p className="text-xs text-muted mt-1.5">
            Hospital stays, surgeries, reactions to anesthesia, close family members' health
            conditions, or any past treatment for mental health (like therapy or medication
            for depression or anxiety).
          </p>
        </div>
        <div className="space-y-2.5">
          {data.historyNotes.map(h =>
            editHId === h.id
              ? <HistForm key={h.id} hForm={hForm} sH={sH} onSave={saveHist} onCancel={() => { setEditHId(null); setHForm({}) }} />
              : <EntryCard key={h.id} title={h.description}
                  badge={h.category?.replace('-', ' ')} subtitle={h.date}
                  onEdit={() => { setEditHId(h.id); setHForm(h) }}
                  onDelete={() => setData({ ...data, historyNotes: data.historyNotes.filter(x => x.id !== h.id) })} />
          )}
        </div>
        {addingH && !editHId && <HistForm hForm={hForm} sH={sH} onSave={saveHist} onCancel={() => { setAddingH(false); setHForm({}) }} />}
        {!addingH && !editHId && (
          data.historyNotes.length === 0
            ? <EmptyState label="Add a history note" onAdd={() => setAddingH(true)} />
            : <AddMoreBtn label="Add note" onClick={() => setAddingH(true)} />
        )}
      </div>
    </div>
  )
}

// Top-level (not nested inside Step4) so they don't get redefined — and remounted, losing input focus — on every keystroke.
function CondForm({ cForm, sC, onSave, onCancel }: {
  cForm: Partial<Condition>; sC: (k: keyof Condition, v: string) => void; onSave: () => void; onCancel: () => void
}) {
  return (
    <div className="bg-lav-50 border border-lav-300 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="Condition Name" hint="e.g. diabetes, high blood pressure, asthma, thyroid disease">
            <input value={cForm.name || ''} onChange={e => sC('name', e.target.value)} placeholder="e.g. Type 2 Diabetes" className={inp} />
          </Field>
        </div>
        <Field label="Status">
          <select value={cForm.status || ''} onChange={e => sC('status', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="active">Still have it</option>
            <option value="managed">Under control with treatment</option>
            <option value="resolved">No longer have it</option>
          </select>
        </Field>
        <Field label="Roughly When Diagnosed?">
          <input value={cForm.diagnosedDate || ''} onChange={e => sC('diagnosedDate', e.target.value)} placeholder="e.g. Jan 2019" className={inp} />
        </Field>
      </div>
      <div className="flex gap-2"><PBtn onClick={onSave} sm>Save condition</PBtn><SBtn onClick={onCancel} sm>Cancel</SBtn></div>
    </div>
  )
}

function HistForm({ hForm, sH, onSave, onCancel }: {
  hForm: Partial<HistoryNote>; sH: (k: keyof HistoryNote, v: string) => void; onSave: () => void; onCancel: () => void
}) {
  return (
    <div className="bg-lav-50 border border-lav-300 rounded-xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category">
          <select value={hForm.category || ''} onChange={e => sH('category', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="hospitalization">Hospital Stay</option>
            <option value="surgery">Surgery / Operation</option>
            <option value="anesthesia">Reaction to Anesthesia</option>
            <option value="family-history">Family Health History</option>
            <option value="mental-health">Mental Health (e.g. depression, anxiety)</option>
          </select>
        </Field>
        <Field label="Roughly When?">
          <input value={hForm.date || ''} onChange={e => sH('date', e.target.value)} placeholder="e.g. 2018" className={inp} />
        </Field>
        <div className="col-span-2">
          <Field label="Brief Description">
            <input value={hForm.description || ''} onChange={e => sH('description', e.target.value)} placeholder="Brief description of the event" className={inp} />
          </Field>
        </div>
      </div>
      <div className="flex gap-2"><PBtn onClick={onSave} sm>Save note</PBtn><SBtn onClick={onCancel} sm>Cancel</SBtn></div>
    </div>
  )
}

function Step5({ data, setData }: { data: PatientData; setData: (d: PatientData) => void }) {
  const set = (k: keyof PatientData, v: unknown) => setData({ ...data, [k]: v })
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        This section is about everyday habits that can affect how medicines work in your body.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Alcohol" hint="Alcohol can interact with many medicines">
          <select value={data.alcohol} onChange={e => set('alcohol', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="none">I don't drink</option>
            <option value="occasional">Occasional (1–2 times a week)</option>
            <option value="moderate">Moderate (3–4 times a week)</option>
            <option value="heavy">Frequent (daily or almost daily)</option>
          </select>
        </Field>
        <Field label="Smoking / Tobacco">
          <select value={data.tobacco} onChange={e => set('tobacco', e.target.value)} className={inp}>
            <option value="">Select…</option>
            <option value="none">Never smoked</option>
            <option value="former">Used to, but quit</option>
            <option value="cigarettes">Currently — cigarettes</option>
            <option value="vaping">Currently — vaping</option>
            <option value="other">Currently — other tobacco product</option>
          </select>
        </Field>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 bg-lav-50 border border-lav-200 rounded-xl">
          <div>
            <p className="font-semibold text-plum text-sm">Recreational or Injectable Drug Use</p>
            <p className="text-xs text-muted mt-0.5">
              Cannabis, stimulants, or other substances not prescribed by a doctor. This is
              kept confidential and helps us catch dangerous drug interactions.
            </p>
          </div>
          <button type="button" onClick={() => set('recreationalDrugs', !data.recreationalDrugs)}
            className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer flex-shrink-0 ${data.recreationalDrugs ? 'bg-lav-500' : 'bg-lav-300'}`}>
            <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${data.recreationalDrugs ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {data.recreationalDrugs && (
          <Field label="Notes (optional)" hint="Substance(s), frequency, last use">
            <textarea value={data.recreationalDrugsNotes}
              onChange={e => set('recreationalDrugsNotes', e.target.value)}
              placeholder="e.g. Cannabis, 2–3×/week, last use 3 days ago"
              rows={2} className={inp + ' resize-none'} />
          </Field>
        )}
      </div>

      <Field label="Pregnancy" hint="Some medicines aren't safe during pregnancy or while breastfeeding">
        <div className="grid grid-cols-2 gap-2">
          {[
            { v: 'pregnant',       l: 'Currently pregnant' },
            { v: 'breastfeeding',  l: 'Currently breastfeeding' },
            { v: 'planning',       l: 'Planning a pregnancy' },
            { v: 'not-applicable', l: 'Not applicable' },
          ].map(opt => (
            <button key={opt.v} type="button"
              onClick={() => set('pregnancy', data.pregnancy === opt.v ? '' : opt.v)}
              className={`p-3 rounded-xl border text-sm font-medium text-left transition cursor-pointer
                ${data.pregnancy === opt.v ? 'bg-lav-500 text-white border-lav-500' : 'bg-white border-lav-200 text-plum hover:bg-lav-50'}`}>
              {opt.l}
            </button>
          ))}
        </div>
      </Field>
    </div>
  )
}

// ── Survey Page ───────────────────────────────────────────────────────────────

// ── Survey Page ───────────────────────────────────────────────────────────────

function SurveyPage({ user, initialData, onSubmit, onDone, mode = 'onboarding', onCancel }: {
  user: User
  initialData: PatientData
  /** Resolves once the answers are safely stored, rejects with a showable message. */
  onSubmit: (d: PatientData) => Promise<void>
  onDone: (d: PatientData) => void
  mode?: 'onboarding' | 'update'
  onCancel?: () => void
}) {
  const [step, setStep] = useState(0)
  const [data, setData] = useState<PatientData>(initialData)
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const StepComponents = [Step1, Step2, Step3, Step4, Step5]
  const StepComp = StepComponents[step]
  const isUpdate = mode === 'update'

  /**
   * The backend requires full_name, date_of_birth and sex. The survey used to
   * allow all three to be blank, which produced a patient record the assistant
   * couldn't reason about — no age means no age-appropriate dosing.
   */
  function validate(): string | null {
    if (!data.fullName.trim()) return 'Please enter your full name on the “About You” step.'
    if (!data.dob) return 'Please enter your date of birth on the “About You” step.'
    if (Number.isNaN(new Date(data.dob).getTime())) return 'That date of birth doesn\u2019t look valid.'
    if (new Date(data.dob) > new Date()) return 'Your date of birth can\u2019t be in the future.'
    if (!data.sex) return 'Please select your sex on the “About You” step.'
    return null
  }

  async function handleSubmit() {
    if (busy) return

    const problem = validate()
    if (problem) {
      setError(problem)
      setStep(0)
      return
    }

    setBusy(true)
    setError(null)
    try {
      await onSubmit(data)
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your answers. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-lav-100 flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center space-y-5">
          <div className="w-16 h-16 rounded-full bg-lav-500 flex items-center justify-center mx-auto text-white text-3xl shadow-sm">✓</div>
          <div>
            <h2 className="text-2xl font-bold text-plum">
              {isUpdate ? 'Saved!' : `All set, ${user.name.split(' ')[0]}!`}
            </h2>
            <p className="text-sm text-muted mt-2 leading-relaxed">
              {isUpdate
                ? 'Your medical history has been updated. MedChat will use it from your next message onwards.'
                : 'Your medical history has been saved. MedChat will use it to provide safer, more personalized recommendations.'}
            </p>
          </div>

          <PBtn onClick={() => onDone(data)}>{isUpdate ? 'Done →' : 'Go to MedChat →'}</PBtn>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-lav-100">
      <div className="bg-white border-b border-lav-200 px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-lav-500 flex items-center justify-center">
            <span className="text-white font-black text-sm">M</span>
          </div>
          <span className="font-bold text-plum">MedChat</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">
            {isUpdate ? 'Update medical history' : 'Medical history'} · Step {step + 1} of 5
          </span>
          {isUpdate && onCancel && (
            <button type="button" onClick={onCancel}
              className="text-xs text-muted hover:text-plum transition cursor-pointer px-2 py-1 rounded-lg hover:bg-lav-50">
              ✕ Cancel
            </button>
          )}
        </div>
      </div>

      <div className="max-w-xl mx-auto px-4 py-8 space-y-7">
        {!isUpdate && (
          <p className="text-sm text-muted -mt-2">
            You'll only need to fill this in once — you can update any of it later from your profile.
          </p>
        )}
        <StepProgress step={step} />

        <div className="bg-white rounded-2xl border border-lav-200 p-6 shadow-sm">
          <h2 className="text-lg font-bold text-plum mb-1">{STEP_LABELS[step]}</h2>
          <div className="w-8 h-1 bg-lav-500 rounded-full mb-5" />
          <StepComp data={data} setData={setData} />
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-700 leading-relaxed">{error}</p>
          </div>
        )}

        <div className="flex items-center justify-between">
          {step > 0 ? <SBtn onClick={() => setStep(s => s - 1)}>← Back</SBtn> : <div />}
          {step < 4
            ? <PBtn onClick={() => setStep(s => s + 1)}>Next →</PBtn>
            : <PBtn onClick={handleSubmit} disabled={busy}>
                {busy ? 'Saving…' : isUpdate ? 'Save Changes →' : 'Submit →'}
              </PBtn>
          }
        </div>
      </div>
    </div>
  )
}

// ── Chat Page ─────────────────────────────────────────────────────────────────

// ── Chat Page ─────────────────────────────────────────────────────────────────

/** Renders the structured clinical sections, keeping self-care above any medicine. */
function SectionsBody({ sections, severity }: { sections: ClinicalSections; severity?: Severity }) {
  return (
    <div className="space-y-3">
      {sections.possible_condition && (
        <div>
          <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">
            What this looks like
          </p>
          <p className="leading-relaxed">{sections.possible_condition}</p>
        </div>
      )}

      {sections.self_care.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">
            {severity === 'mild' ? 'Try this first' : 'Self-care'}
          </p>
          <ul className="space-y-1">
            {sections.self_care.map((item, i) => (
              <li key={i} className="flex gap-2 leading-relaxed">
                <span className="text-lav-400 flex-shrink-0 select-none">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sections.warning_signs.length > 0 && (
        <div className="rounded-xl bg-red-50 border border-red-100 px-3 py-2.5">
          <p className="text-[10px] font-semibold text-red-700 uppercase tracking-widest mb-1">
            Get help right away if you notice
          </p>
          <ul className="space-y-1">
            {sections.warning_signs.map((item, i) => (
              <li key={i} className="flex gap-2 leading-relaxed text-red-800">
                <span className="flex-shrink-0 select-none">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sections.when_to_seek_care && (
        <div>
          <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">
            When to see a doctor
          </p>
          <p className="leading-relaxed">{sections.when_to_seek_care}</p>
        </div>
      )}
    </div>
  )
}

function ChatPage({ user, patientId, onRecorded }: {
  user: User
  patientId: string
  /** Lets the parent know a consultation was logged, so History stays fresh. */
  onRecorded: () => void
}) {
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      id: uid(), role: 'bot', time: ts(),
      content: `Hi ${user.name.split(' ')[0]}! I'm MedChat, your personalized medicine guidance assistant. Describe how you're feeling and I'll suggest appropriate options based on your medical history.`,
    },
  ])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [msgs, typing])

  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim()
    if (!text || typing) return

    // Captured before appending, because the backend takes the new message
    // separately from the prior turns.
    const history: ChatHistoryTurn[] = msgs.slice(-10).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }))

    setMsgs(prev => [...prev, { id: uid(), role: 'user', content: text, time: ts() }])
    setInput('')
    setTyping(true)

    try {
      const res = await api.chat(patientId, text, history)
      setMsgs(prev => [...prev, toBotMsg(res)])
      if (res.prescription_id) onRecorded()
    } catch (err) {
      const message = err instanceof ApiError
        ? err.message
        : 'Something went wrong reaching the assistant. Please try again.'
      setMsgs(prev => [...prev, {
        id: uid(), role: 'bot', time: ts(), content: message, isError: true,
      }])
    } finally {
      setTyping(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollable px-4 py-6 space-y-5 bg-lav-50">
        {msgs.map(msg => {
          // When the assistant returned a medicine, the medicine block moves to
          // the card and the rest of the sections render in the bubble, so
          // nothing is shown twice. Otherwise the bubble shows the full reply,
          // which the backend guarantees is complete on its own.
          const useSections = Boolean(msg.sections && msg.rec?.kind === 'medicine')

          return (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`flex flex-col gap-2 ${msg.role === 'user' ? 'items-end max-w-xs lg:max-w-md' : 'items-start max-w-sm lg:max-w-xl'}`}>
                {msg.role === 'bot' && (
                  <div className="flex items-center gap-1.5">
                    <div className="w-5 h-5 rounded-full bg-lav-500 flex items-center justify-center text-white text-[10px] font-black flex-shrink-0">M</div>
                    <span className="text-[10px] text-muted font-medium">MedChat · {msg.time}</span>
                  </div>
                )}

                <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed
                  ${msg.role === 'user'
                    ? 'bg-lav-500 text-white rounded-tr-sm'
                    : msg.isError
                      ? 'bg-red-50 border border-red-200 text-red-800 rounded-tl-sm'
                      : 'bg-white border border-lav-200 text-plum rounded-tl-sm shadow-sm'}`}>
                  {msg.role === 'bot' && useSections && msg.sections
                    ? <SectionsBody sections={msg.sections} severity={msg.rec?.severity} />
                    : msg.role === 'bot'
                      ? <Markdown text={msg.content} />
                      : msg.content}
                </div>

                {msg.rec && <RecCard rec={msg.rec} />}

                {msg.followUps && msg.followUps.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {msg.followUps.map((q, i) => (
                      <button key={i} type="button" onClick={() => send(q)} disabled={typing}
                        className="px-3 py-1.5 bg-white border border-lav-200 text-plum-light hover:bg-lav-50 hover:border-lav-300 rounded-xl text-xs font-medium transition cursor-pointer disabled:opacity-40 text-left">
                        {q}
                      </button>
                    ))}
                  </div>
                )}

                {msg.disclaimer && (
                  <p className="text-[10px] text-muted leading-relaxed max-w-full">{msg.disclaimer}</p>
                )}

                {msg.role === 'user' && (
                  <span className="text-[10px] text-muted">{msg.time}</span>
                )}
              </div>
            </div>
          )
        })}

        {typing && (
          <div className="flex justify-start">
            <div className="flex items-start gap-1.5">
              <div className="w-5 h-5 rounded-full bg-lav-500 flex items-center justify-center text-white text-[10px] font-black mt-2 flex-shrink-0">M</div>
              <div className="px-4 py-3 bg-white border border-lav-200 rounded-2xl rounded-tl-sm shadow-sm flex items-center gap-1.5">
                {[0, 1, 2].map(i => (
                  <div key={i} className="w-2 h-2 rounded-full bg-lav-400"
                    style={{ animation: `dot-bounce 1.2s ease-in-out ${i * 0.18}s infinite` }} />
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex-shrink-0 border-t border-lav-200 px-4 py-3 bg-white">
        <div className="flex gap-2.5 max-w-3xl mx-auto">
          <input value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            placeholder="Describe how you're feeling…"
            className="flex-1 px-4 py-2.5 rounded-xl border border-lav-200 bg-lav-50 text-plum text-sm placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-lav-400/30 focus:border-lav-500 focus:bg-white transition" />
          <button type="button" onClick={() => void send()} disabled={!input.trim() || typing}
            className="px-4 py-2.5 bg-lav-500 hover:bg-lav-600 text-white rounded-xl font-semibold text-sm transition disabled:opacity-40 cursor-pointer active:scale-95 flex-shrink-0">
            Send
          </button>
        </div>
        <p className="text-center text-[10px] text-muted mt-2">
          MedChat may make mistakes. Always consult a licensed healthcare professional before taking any medication.
        </p>
      </div>
    </div>
  )
}

// ── History Page ──────────────────────────────────────────────────────────────

// ── History Page ──────────────────────────────────────────────────────────────

function HistoryPage({ patientId, refreshKey }: { patientId: string; refreshKey: number }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [rxs, setRxs] = useState<Rx[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)

    api.getPrescriptionHistory(patientId)
      .then(res => {
        if (cancelled) return
        setRxs(res.prescriptions.map(prescriptionToRx))
      })
      .catch(err => {
        if (cancelled) return
        setRxs([])
        setError(err instanceof ApiError ? err.message : 'Could not load your history.')
      })

    // React 19 StrictMode runs effects twice in development; this flag stops
    // the first, discarded response from overwriting the second.
    return () => { cancelled = true }
  }, [patientId, refreshKey])

  if (rxs === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-3">
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map(i => (
            <div key={i} className="w-2 h-2 rounded-full bg-lav-400"
              style={{ animation: `dot-bounce 1.2s ease-in-out ${i * 0.18}s infinite` }} />
          ))}
        </div>
        <p className="text-sm text-muted">Loading your consultation history…</p>
      </div>
    )
  }

  if (error && rxs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-3">
        <div className="text-5xl opacity-20 select-none">⚠️</div>
        <p className="font-bold text-plum">Couldn't load history</p>
        <p className="text-sm text-muted max-w-xs leading-relaxed">{error}</p>
      </div>
    )
  }

  if (rxs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-3">
        <div className="text-5xl opacity-20 select-none">🗂</div>
        <p className="font-bold text-plum">No consultation history yet</p>
        <p className="text-sm text-muted max-w-xs leading-relaxed">
          Your recommendation history will appear here after your first MedChat session.
        </p>
      </div>
    )
  }

  // The backend logs blocked attempts and emergency escalations alongside
  // approved suggestions. They are shown, and labelled distinctly, because a
  // blocked suggestion is exactly the safety system doing its job — hiding it
  // would misrepresent the record.
  const dotCls: Record<Rx['status'], string> = {
    approved: 'bg-emerald-400',
    blocked:  'bg-amber-400',
    urgent:   'bg-urgent',
  }
  const badgeCls: Record<Rx['status'], string> = {
    approved: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    blocked:  'text-amber-700 bg-amber-50 border-amber-200',
    urgent:   'text-red-700 bg-red-50 border-red-200',
  }
  const badgeLabel: Record<Rx['status'], string> = {
    approved: 'approved',
    blocked:  'blocked',
    urgent:   'urgent care',
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-3">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-base font-bold text-plum">
          {rxs.length} consultation{rxs.length !== 1 ? 's' : ''}
        </h2>
      </div>
      {rxs.map(rx => (
        <div key={rx.id} className="bg-white border border-lav-200 rounded-2xl overflow-hidden transition hover:border-lav-300">
          <button type="button"
            className="w-full px-5 py-4 flex items-center justify-between gap-4 cursor-pointer hover:bg-lav-50 transition text-left"
            onClick={() => setExpanded(expanded === rx.id ? null : rx.id)}>
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dotCls[rx.status]}`} />
              <div className="min-w-0">
                <p className="font-semibold text-plum text-sm truncate">{rx.medicine}</p>
                <p className="text-xs text-muted truncate mt-0.5">{rx.symptoms}</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 flex-shrink-0">
              <span className="text-xs text-muted hidden sm:block">{rx.date}</span>
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${badgeCls[rx.status]}`}>
                {badgeLabel[rx.status]}
              </span>
              <span className="text-muted text-xs">{expanded === rx.id ? '▲' : '▼'}</span>
            </div>
          </button>

          {expanded === rx.id && (
            <div className="px-5 pb-5 border-t border-lav-100 pt-4 grid grid-cols-3 gap-4">
              <div>
                <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Date</p>
                <p className="text-sm text-plum">{rx.date}</p>
              </div>
              <div className="col-span-2">
                <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Reported Symptoms</p>
                <p className="text-sm text-plum">{rx.symptoms}</p>
              </div>
              <div className="col-span-3">
                <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">Recommendation</p>
                <p className="text-sm text-plum">{rx.medicine}</p>
              </div>
              {rx.blockedReason && (
                <div className="col-span-3">
                  <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">
                    Safety Check
                  </p>
                  <p className="text-sm text-plum leading-relaxed">{rx.blockedReason}</p>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Nav ───────────────────────────────────────────────────────────────────────

function Nav({ user, page, onNav, onOpenSidebar }: {
  user: User; page: Page; onNav: (p: Page) => void; onOpenSidebar: () => void
}) {
  return (
    <nav className="bg-white border-b border-lav-200 px-5 h-14 flex items-center justify-between flex-shrink-0">
      <button type="button" onClick={() => onNav('chat')}
        className="flex items-center gap-2 cursor-pointer" title="Go to home">
        <div className="w-8 h-8 rounded-xl bg-lav-500 flex items-center justify-center">
          <span className="text-white font-black text-base">M</span>
        </div>
        <span className="font-bold text-plum tracking-tight">MedChat</span>
      </button>

      <div className="flex items-center gap-1">
        {([['chat', 'Home'] as const, ['history', 'History'] as const]).map(([p, label]) => (
          <button key={p} type="button" onClick={() => onNav(p)}
            className={`px-3.5 py-1.5 rounded-xl text-sm font-medium transition cursor-pointer
              ${page === p ? 'bg-lav-100 text-lav-600' : 'text-muted hover:text-plum hover:bg-lav-50'}`}>
            {label}
          </button>
        ))}
        <div className="ml-2 pl-3 border-l border-lav-200">
          <button type="button" onClick={onOpenSidebar}
            className="w-8 h-8 rounded-full bg-lav-500 flex items-center justify-center cursor-pointer hover:ring-2 hover:ring-lav-300 transition"
            title="Open menu">
            <span className="text-white text-xs font-bold">{user.name[0]?.toUpperCase()}</span>
          </button>
        </div>
      </div>
    </nav>
  )
}

// ── Account Sidebar ───────────────────────────────────────────────────────────

function AccountSidebar({ user, page, open, onClose, onNav, onUpdateSurvey, onLogout }: {
  user: User; page: Page; open: boolean; onClose: () => void
  onNav: (p: Page) => void; onUpdateSurvey: () => void; onLogout: () => void
}) {
  const items: { p: Page; label: string; icon: string }[] = [
    { p: 'chat',    label: 'Home',                 icon: '🏠' },
    { p: 'profile', label: 'Profile',               icon: '👤' },
    { p: 'chat',    label: 'Chatbot',                icon: '💬' },
    { p: 'history', label: 'Prescription History',  icon: '🗂' },
  ]

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/30 transition-opacity z-40 ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose} />
      <aside
        className={`fixed top-0 right-0 h-full w-72 bg-white border-l border-lav-200 shadow-xl z-50 transition-transform duration-300 flex flex-col
          ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-5 border-b border-lav-200 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-lav-500 flex items-center justify-center flex-shrink-0">
            <span className="text-white text-sm font-bold">{user.name[0]?.toUpperCase()}</span>
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-plum text-sm truncate">{user.name}</p>
            <p className="text-xs text-muted truncate">{user.email}</p>
          </div>
          <button type="button" onClick={onClose}
            className="ml-auto text-muted hover:text-plum text-lg leading-none cursor-pointer p-1" title="Close">✕</button>
        </div>

        <nav className="flex-1 overflow-y-auto scrollable py-2">
          {items.map((item, i) => (
            <button key={i} type="button"
              onClick={() => { onNav(item.p); onClose() }}
              className={`w-full flex items-center gap-3 px-5 py-3 text-sm font-medium transition cursor-pointer
                ${page === item.p ? 'bg-lav-100 text-lav-600' : 'text-plum hover:bg-lav-50'}`}>
              <span className="text-base">{item.icon}</span> {item.label}
            </button>
          ))}
          <div className="my-2 border-t border-lav-100" />
          <button type="button" onClick={() => { onUpdateSurvey(); onClose() }}
            className="w-full flex items-center gap-3 px-5 py-3 text-sm font-medium text-plum hover:bg-lav-50 transition cursor-pointer">
            <span className="text-base">📝</span> Update Medical History
          </button>
        </nav>

        <div className="p-3 border-t border-lav-200">
          <button type="button" onClick={onLogout}
            className="w-full flex items-center gap-3 px-2 py-2.5 rounded-xl text-sm font-medium text-muted hover:text-red-600 hover:bg-red-50 transition cursor-pointer">
            <span className="text-base">🚪</span> Sign out
          </button>
        </div>
      </aside>
    </>
  )
}

// ── Profile Page ──────────────────────────────────────────────────────────────

// ── Profile Page ──────────────────────────────────────────────────────────────

function ProfilePage({ user, patient, onUpdateSurvey }: {
  user: User; patient: PatientData; onUpdateSurvey: () => void
}) {
  const Stat = ({ label, value }: { label: string; value: string | number }) => (
    <div className="bg-lav-50 border border-lav-200 rounded-xl p-3.5">
      <p className="text-[10px] font-semibold text-muted uppercase tracking-widest mb-1">{label}</p>
      <p className="text-sm font-semibold text-plum">{value || '—'}</p>
    </div>
  )

  const weight = patient.weight ? `${patient.weight} ${patient.weightUnit}` : ''

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-4">
        <div className="w-14 h-14 rounded-full bg-lav-500 flex items-center justify-center flex-shrink-0">
          <span className="text-white text-lg font-bold">{user.name[0]?.toUpperCase()}</span>
        </div>
        <div>
          <h2 className="text-lg font-bold text-plum">{patient.fullName || user.name}</h2>
          <p className="text-sm text-muted">{user.email}</p>
        </div>
        <div className="ml-auto">
          <PBtn onClick={onUpdateSurvey}>Update Medical History</PBtn>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>About You</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Date of Birth" value={patient.dob} />
          <Stat label="Sex" value={patient.sex} />
          <Stat label="Height" value={patient.height} />
          <Stat label="Weight" value={weight} />
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>Summary</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Medications" value={patient.medications.length} />
          <Stat label="Allergies" value={patient.allergies.length} />
          <Stat label="Diagnosed Conditions" value={patient.conditions.length} />
          <Stat label="History Notes" value={patient.historyNotes.length} />
        </div>
      </div>

      {/* Listing what the safety checks actually run against makes the system
          legible to the patient, rather than a black box. */}
      {patient.allergies.length > 0 && (
        <div className="space-y-3">
          <SectionTitle>Allergies On File</SectionTitle>
          <div className="space-y-2">
            {patient.allergies.map(a => (
              <div key={a.id} className="flex items-center gap-2 flex-wrap p-3 bg-lav-50 border border-lav-200 rounded-xl">
                <span className="font-semibold text-plum text-sm">{a.substance}</span>
                {a.severity && (
                  <span className="px-2 py-0.5 bg-lav-200 text-plum-light rounded-full text-[10px] font-semibold uppercase tracking-wide">
                    {a.severity}
                  </span>
                )}
                {a.reaction && <span className="text-xs text-muted">{a.reaction}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted text-center leading-relaxed pt-2">
        Your medical history is stored on the MedChat server and is used to check every
        recommendation against your allergies, conditions and current medicines.
      </p>
    </div>
  )
}

// ── Root App ──────────────────────────────────────────────────────────────────

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [page, setPage] = useState<Page>('auth')
  const [user, setUser] = useState<User | null>(null)
  const [patientId, setPatientId] = useState<string>('')
  const [patient, setPatient] = useState<PatientData>(EMPTY_PATIENT)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [surveyMode, setSurveyMode] = useState<'onboarding' | 'update'>('onboarding')
  const [returnPage, setReturnPage] = useState<Page>('chat')

  // Held between sign-up and the end of the survey. The backend creates the
  // patient in POST /survey, so there is nothing to send at sign-up time.
  const [pendingPassword, setPendingPassword] = useState<string | null>(null)

  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  // Bumped after each logged consultation so the history view refetches.
  const [historyKey, setHistoryKey] = useState(0)

  async function hydrate(session: Session) {
    const profile = await api.getProfile(session.patientId)
    setUser({ name: session.name, email: session.email })
    setPatientId(session.patientId)
    setPatient(profileToPatientData(profile))
    setPage('chat')
  }

  // Restores the signed-in patient on reload. The profile is always re-fetched
  // rather than trusted from browser storage, so the history shown is the same
  // history the assistant reasons over.
  useEffect(() => {
    const session = loadSession()
    if (!session) { setBooting(false); return }

    let cancelled = false

    hydrate(session)
      .catch((err: unknown) => {
        if (cancelled) return
        // A 404 means the patient no longer exists, so the session is dead.
        // Anything else (server down, CORS) is transient — keep the session and
        // let them retry instead of silently signing them out.
        if (err instanceof ApiError && err.status === 404) {
          clearSession()
        } else {
          setBootError(err instanceof ApiError ? err.message : 'Could not reach the MedChat server.')
        }
      })
      .finally(() => { if (!cancelled) setBooting(false) })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleLogin(email: string, password: string) {
    const res = await api.login(email, password)
    const profile = await api.getProfile(res.patient_id)
    const name = res.full_name || email.split('@')[0]
    const resolvedEmail = res.email || email

    setUser({ name, email: resolvedEmail })
    setPatientId(res.patient_id)
    setPatient(profileToPatientData(profile))
    saveSession({ patientId: res.patient_id, name, email: resolvedEmail })
    setPage('chat')
  }

  function handleSignup(u: User, password: string) {
    setUser(u)
    setPendingPassword(password)
    setPatient({ ...EMPTY_PATIENT, fullName: u.name })
    setSurveyMode('onboarding')
    setPage('survey')
  }

  /** Onboarding: this is the call that actually creates the account. */
  async function submitOnboardingSurvey(d: PatientData) {
    if (!user || pendingPassword === null) {
      throw new ApiError('Your sign-up session expired. Please sign up again.', 0)
    }

    const res = await api.submitSurvey(
      buildSurveyPayload(d, { email: user.email, password: pendingPassword }),
    )

    const name = d.fullName.trim() || user.name
    setPatientId(res.patient_id)
    setUser({ name, email: user.email })
    saveSession({ patientId: res.patient_id, name, email: user.email })
    setPendingPassword(null)

    // Read the profile back so what's displayed is what the server stored,
    // including any value the mappers had to normalise on the way in.
    try {
      setPatient(profileToPatientData(await api.getProfile(res.patient_id)))
    } catch {
      setPatient(d)
    }
  }

  /**
   * Updating: writes through to the server.
   *
   * The response carries the re-read profile, so what's displayed afterwards is
   * what was actually stored — including any value the mappers normalised on the
   * way in. If it's missing for any reason, fall back to a fresh GET rather than
   * trusting local state, because showing stale allergies while the assistant
   * reasons over corrected ones is the failure this feature exists to prevent.
   */
  async function saveUpdatedSurvey(d: PatientData) {
    if (!patientId) {
      throw new ApiError('You need to be logged in to update your medical history.', 0)
    }

    const res = await api.updateProfile(patientId, buildProfileUpdatePayload(d))

    if (res.profile) {
      setPatient(profileToPatientData(res.profile))
    } else {
      setPatient(profileToPatientData(await api.getProfile(patientId)))
    }

    const name = d.fullName.trim() || user?.name || ''
    if (user && name !== user.name) {
      setUser({ name, email: user.email })
      saveSession({ patientId, name, email: user.email })
    }
  }

  function openUpdateSurvey() {
    setSurveyMode('update')
    setReturnPage(page === 'survey' ? 'chat' : page)
    setPage('survey')
  }

  function handleLogout() {
    clearSession()
    setUser(null)
    setPatientId('')
    setPatient(EMPTY_PATIENT)
    setPendingPassword(null)
    setSidebarOpen(false)
    setBootError(null)
    setPage('auth')
  }

  // ── Boot states ──

  if (booting) {
    return (
      <div className="min-h-screen bg-lav-100 flex flex-col items-center justify-center gap-4">
        <div className="w-11 h-11 rounded-2xl bg-lav-500 flex items-center justify-center shadow-sm">
          <span className="text-white font-black text-xl">M</span>
        </div>
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map(i => (
            <div key={i} className="w-2 h-2 rounded-full bg-lav-400"
              style={{ animation: `dot-bounce 1.2s ease-in-out ${i * 0.18}s infinite` }} />
          ))}
        </div>
      </div>
    )
  }

  if (bootError && !user) {
    return (
      <div className="min-h-screen bg-lav-100 flex items-center justify-center p-4">
        <div className="w-full max-w-sm text-center space-y-5">
          <div className="text-5xl opacity-30 select-none">🔌</div>
          <div>
            <h2 className="text-xl font-bold text-plum">Can't reach MedChat</h2>
            <p className="text-sm text-muted mt-2 leading-relaxed">{bootError}</p>
            <p className="text-xs text-muted mt-3 leading-relaxed">
              Expected the server at <span className="font-mono">{API_BASE_URL}</span>. Check
              that the backend is running, then try again.
            </p>
          </div>
          <div className="flex items-center justify-center gap-2">
            <PBtn onClick={() => window.location.reload()}>Try Again</PBtn>
            <SBtn onClick={() => { clearSession(); setBootError(null) }}>Log In Instead</SBtn>
          </div>
        </div>
      </div>
    )
  }

  if (!user) return <AuthPage onLogin={handleLogin} onSignup={handleSignup} />

  if (page === 'survey') {
    const isUpdate = surveyMode === 'update'
    return (
      <SurveyPage
        user={user}
        initialData={patient}
        mode={surveyMode}
        onSubmit={isUpdate ? saveUpdatedSurvey : submitOnboardingSurvey}
        onDone={() => setPage(isUpdate ? returnPage : 'chat')}
        onCancel={isUpdate ? () => setPage(returnPage) : undefined}
      />
    )
  }

  return (
    <div className="h-screen flex flex-col bg-lav-100">
      <Nav user={user} page={page} onNav={setPage} onOpenSidebar={() => setSidebarOpen(true)} />
      <AccountSidebar user={user} page={page} open={sidebarOpen}
        onClose={() => setSidebarOpen(false)} onNav={setPage}
        onUpdateSurvey={openUpdateSurvey} onLogout={handleLogout} />
      <main className="flex-1 min-h-0 overflow-hidden">
        {page === 'chat' && patientId && (
          <ChatPage user={user} patientId={patientId}
            onRecorded={() => setHistoryKey(k => k + 1)} />
        )}
        {page === 'history' && patientId && (
          <div className="h-full overflow-y-auto scrollable">
            <HistoryPage patientId={patientId} refreshKey={historyKey} />
          </div>
        )}
        {page === 'profile' && (
          <div className="h-full overflow-y-auto scrollable">
            <ProfilePage user={user} patient={patient} onUpdateSurvey={openUpdateSurvey} />
          </div>
        )}
      </main>
    </div>
  )
}
