# MedChat Backend — v2

FastAPI + MongoDB Atlas. Symptom-to-recommendation assistant with patient-history personalisation.

---

## Setup

**1. Create the environment**

```bash
cd Backend
python -m venv venv

# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

pip install -r requirements.txt
```

**2. Set up MongoDB Atlas**

1. Create a free M0 cluster at <https://cloud.mongodb.com>
2. **Database Access** → add a database user, note the username and password
3. **Network Access** → Add IP Address → *Allow access from anywhere* (`0.0.0.0/0`) for development
4. **Connect** → *Drivers* → *Python* → copy the connection string

**3. Configure**

```bash
cp .env.example .env
```

Fill in `MONGODB_URI` and `GROQ_API_KEY`. Get a free Groq key at <https://console.groq.com>.

> If your database password contains `@`, `#`, `/`, `:` or `%`, URL-encode it in the URI (`@` → `%40`) or the connection string will fail to parse.

**4. Seed the reference data**

```bash
python seed_reference_data.py
```

Loads drug classes and contraindication rules. Run once, and again any time you edit those lists.

**5. Run**

```bash
uvicorn app.main:app --reload
```

Open <http://127.0.0.1:8000/docs> for interactive API docs, and <http://127.0.0.1:8000/health> to confirm the database and LLM are both reachable.

---

## Verify it works

```bash
# No database or API key needed — tests the deterministic routing layer
python -m tests.test_triage_offline

# Needs the database, but no API key — the safety filter never calls the LLM
python -m tests.test_safety_filter

# Profile updates: checks credentials survive and the safety filter follows the new data
python -m tests.test_profile_update

# Interactive chat against a real patient
python chatbot.py <patient_id>
```

To create a test patient, POST to `/survey` from `/docs`, then copy the returned `patient_id`.

---

## Architecture

```
POST /chat
   │
   ├─ triage.py ─────────── classify the message
   │      ├─ emergency keywords + regex   (pure code, runs first)
   │      ├─ greeting / small-talk match  (pure code, no LLM call)
   │      └─ LLM classifier               (only if the above didn't settle it)
   │
   ├─ emergency ──────────► urgent-care reply, no medicine, no LLM needed
   ├─ greeting / chat ────► conversational reply, medicine forbidden by prompt
   ├─ too vague ─────────► follow-up questions
   │
   └─ medical symptoms
          ├─ chat_engine.py ── generate structured clinical response
          ├─ safety_filter.py ─ six deterministic checks
          ├─ blocked? ───────── feed the reason back, regenerate (up to 3x)
          └─ repository.py ──── log to prescription_history
```

**The important property:** the medical path is the only route that can produce a medicine name, and everything on it passes the safety filter first. There is no path from "hello" to a prescription.

### Why the chatbot used to always prescribe

The original system used one prompt that said *"recommend ONE generic medicine"*, with an output schema whose only fields were `medicine_name`, `reasoning`, `confidence` and `requires_medical_attention`. The model had no field to put a greeting in and no instruction that a greeting was even possible. It wasn't a tuning problem — the architecture had a single exit. Splitting classification from generation is what fixes it.

### Why the safety filter is code, not AI

`safety_filter.py` never calls a model. It is the last line of defence, and a check that depends on the model behaving is not a check on the model. Six independent rules run:

| # | Check | Status |
|---|---|---|
| 1 | Allergy — direct name match | was present |
| 2 | Allergy — drug-class cross-reactivity | was present |
| 3 | Prior adverse reaction | **new** |
| 4 | Chronic condition contraindication | **new** |
| 5 | Pregnancy / breastfeeding | **new** |
| 6 | Duplicate therapy (same drug or class) | **new** |

Rules 3–6 were previously left entirely to the prompt. The data for rule 3 was being collected by the survey, stored, and then never consulted before recommending.

---

## What changed from v1

| Area | Before | Now |
|---|---|---|
| Database | PostgreSQL, 9 tables, raw SQL inline in endpoints | MongoDB Atlas, 4 collections, all access behind `repository.py` |
| Patient record | 6 tables, 6 queries to assemble | 1 document, 1 query |
| Chat | Standalone CLI calling the API over HTTP | `POST /chat`, logic inside the backend |
| Intent handling | None — every message got a medicine | Triage stage with 8 intents |
| Severity | None | mild / moderate / severe, controlling whether a medicine is named at all |
| Safety filter | Allergies only | Six checks |
| LLM | LangChain + retired HF endpoint | Direct HTTP, Groq or HF, one env var to switch |
| JSON parsing | `JsonOutputParser`, hoped for valid JSON | API-enforced JSON + brace-matching extractor + validation retry |
| CORS | Absent | Configured |
| Login | No endpoint | `POST /login` |
| Editing a profile | Not possible | `PUT /patient-profile/{id}` |

The database swap touched exactly one file's worth of logic. `main.py`, `safety_filter.py` and `chat_engine.py` call repository functions with unchanged names and unchanged return shapes, which is why the migration didn't ripple outward.

`patient_id` is still a UUID string — deliberately not Mongo's native `ObjectId` — so the API contract, the UUID validation and any ID already stored in a frontend all keep working.

---

## Updating a patient profile

`PUT /patient-profile/{patient_id}` replaces a patient's medical history. It was
added so the frontend's "Update Medical History" screen can write through —
without it, a patient could correct an allergy in the UI while the assistant
carried on reasoning over the old one.

It lives in **`app/profile_routes.py`**, its own router. `main.py` gains only an
import and one `include_router()` call, so no existing endpoint or function was
modified.

Two deliberate choices:

- **`email` and `password` are absent from the schema**, and it's declared
  `extra="forbid"`. An update cannot change login credentials, and trying returns
  a `422` rather than being silently ignored.
- **The write uses `$set`, not `replace_one`.** `replace_one` would drop every
  field not in the new document — wiping `email`, `password_hash` and
  `created_at`, and making the account unusable.

Child lists (allergies, conditions, medications) are replaced wholesale rather
than merged. Merging would silently resurrect an allergy the patient had just
deleted.

---

## Troubleshooting

**`ServerSelectionTimeoutError`**
Your IP isn't whitelisted. Atlas → Network Access → Add IP Address.

**`DNS query name does not exist`**
`dnspython` is missing. `pip install "pymongo[srv]"`.

**`SSL: CERTIFICATE_VERIFY_FAILED`**
Handled — `database.py` passes `certifi.where()` explicitly. If it persists, `pip install --upgrade certifi`.

**`InvalidURI: Username and password must be escaped`**
URL-encode special characters in your password.

**CORS error in the browser console**
Add your frontend's exact origin (including port) to `CORS_ORIGINS` in `.env`.

**`401` from the LLM provider**
Bad or expired API key. Check `/health` to see which provider is active.

**`404` for the model**
The model name was retired. Try another in `GROQ_MODEL`.

---

## Security note

The v1 zip contained a committed `.env` with a live `HF_TOKEN` and `GROQ_API_KEY`. **Rotate both keys.** `.gitignore` now excludes `.env`, and `.env.example` is the file to commit.

Passwords use SHA-256 without a salt. A production system would use bcrypt via `passlib` — a known, acceptable simplification for a course project, and worth naming explicitly if you're asked about it in evaluation.
