# MedChat

MedChat is a personalized medical assistant chatbot that helps users understand their symptoms and recommends safe over-the-counter (OTC) medicines. It uses each patient's stored medical history, including allergies, medications, chronic conditions, and other health information, to provide tailored responses.


---

## What it does

MedChat helps users understand their symptoms while providing safe, personalized over-the-counter (OTC) medicine recommendations based on their medical history.

Before using the chatbot, each patient completes a one-time medical profile that includes information such as age, current medications, allergies, previous adverse drug reactions, chronic conditions, pregnancy status, and lifestyle habits. This profile is securely stored and used in every future conversation, allowing the chatbot to provide responses that are tailored to the individual rather than relying only on the current message.

The system can:

* Guide new users through a multi-step onboarding survey and securely store their medical profile.
* Understand the user's message and determine whether it is:

  * an emergency,
  * a symptom-related medical query,
  * a greeting or casual conversation, or
  * a message that needs more information before advice can be given.
* Respond naturally to greetings and general conversation without generating unnecessary medical advice.
* Detect emergency symptoms such as severe chest pain or difficulty breathing and immediately advise the user to seek urgent medical care instead of continuing with normal chatbot responses.
* Analyze symptom-related queries and provide:

  * a simple explanation of the likely condition,
  * practical self-care recommendations,
  * a safe OTC medicine recommendation when appropriate, and
  * a medical disclaimer encouraging consultation with a healthcare professional.
* Verify every medicine recommendation against the patient's:

  * allergies,
  * previous adverse drug reactions,
  * chronic medical conditions,
  * pregnancy or breastfeeding status, and
  * current medications,
    before it is ever shown to the user.
* Automatically reject unsafe medicine suggestions and generate a safer alternative whenever possible.
* Save every consultation and recommendation so patients can review their previous conversations and prescription history.
* Allow patients to update their medical profile whenever their medications, allergies, or health conditions change.


---

## Architecture

**Backend:** FastAPI + MongoDB Atlas, with an LLM (Groq by default, Hugging Face as a fallback) used only for classification and drafting — never for the final safety decision.

**Frontend:** React 19 + TypeScript + Tailwind, built with Vite.

### The chat pipeline

```
POST /chat
   │
   ├─ triage ─────────────── classify the message
   │      ├─ emergency keyword/regex scan   (pure code, runs first, always)
   │      ├─ greeting / small-talk match    (pure code, no LLM call)
   │      └─ LLM classifier                 (only if the above didn't settle it)
   │
   ├─ emergency ───────────► urgent-care reply, no medicine, no LLM needed
   ├─ greeting / chat ─────► conversational reply, medicine forbidden by prompt
   ├─ too vague ───────────► follow-up questions instead of a guess
   │
   └─ medical symptoms
          ├─ generate a structured clinical response (self-care first, medicine
          │  only if the severity policy calls for one)
          ├─ run the candidate medicine through the deterministic safety filter
          ├─ blocked? feed the reason back to the model and regenerate (up to 3x)
          └─ log the outcome to prescription history
```

The key design decision: **the medical path is the only route that can produce a medicine name, and everything on it passes through a safety filter that is plain code, not another model call.** There is no path from "hello" to a prescription, and no path from a generated suggestion to the patient without it clearing six independent checks (direct allergy match, allergy by drug class, prior adverse reaction, chronic-condition contraindication, pregnancy/breastfeeding contraindication, and duplicate therapy against a drug the patient is already taking).

### Data model

A patient is a single MongoDB document with allergies, conditions, medications, adverse reactions, and history notes embedded as arrays — one query fetches a full profile. Every prescription/consultation is logged separately in a `prescription_history` collection, including which medicines were tried and rejected before one was approved.

---

## Setup

### Backend

```bash
cd Backend
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env           # fill in MONGODB_URI and GROQ_API_KEY
python seed_reference_data.py  # loads drug classes + contraindication rules, run once
uvicorn app.main:app --reload
```

Visit `http://127.0.0.1:8000/docs` for interactive API docs and `/health` to confirm the database and LLM are both reachable. See `Backend/README.md` for MongoDB Atlas setup, troubleshooting, and full endpoint details.

### Frontend

```bash
cd Frontend
npm install
cp .env.example .env   # point it at the backend URL
npm run dev
```

---

## Known limitations

- **No alternate-medicine suggestions.** If a user explicitly asks for a different or alternative medicine than the one already recommended, the assistant does not provide one. The safety filter's retry loop will swap in a different medicine on its own if the first one it generates gets blocked, but there's no path for a user-requested "give me another option" beyond what the pipeline already decided.
- **No ointments (or other medicines) recommended by name.** The clinical prompt is restricted to generic, oral, over-the-counter medicine names as a deliberate safety boundary — it will not name a specific topical product/ointment for skin-related complaints.

These are scoping decisions from the current safety design, not bugs — expanding either would mean extending the safety filter and prompt rules to cover the additional cases first.

---

## Project structure

```
MedChat_2/
├── Backend/
│   ├── app/
│   │   ├── main.py            # FastAPI app, all endpoints
│   │   ├── triage.py          # Stage 1 — message classification
│   │   ├── chat_engine.py     # Stage 2/3 — the conversation pipeline
│   │   ├── prompts.py         # every LLM prompt used in the app
│   │   ├── safety_filter.py   # deterministic, code-only safety checks
│   │   ├── repository.py      # all MongoDB access
│   │   ├── schemas.py         # request/response models
│   │   ├── llm_client.py      # Groq/HF HTTP client
│   │   ├── profile_routes.py  # PUT /patient-profile/{id}
│   │   ├── config.py          # env vars, startup validation
│   │   └── database.py        # MongoDB connection
│   ├── tests/                 # offline triage, safety filter, profile update tests
│   ├── seed_reference_data.py # loads drug classes + contraindication rules
│   ├── chatbot.py             # CLI for interactive testing against a real patient
│   └── API_CONTRACT.md
└── Frontend/
    └── src/
        ├── App.tsx            # main application shell and chat UI
        ├── api/                # typed API client, request/response mappers
        ├── components/
        └── types.ts
```

---

## Disclaimer

MedChat is an educational project and is not a substitute for professional medical advice. Every clinical response includes a disclaimer directing the patient to confirm with a pharmacist or doctor before taking any medicine.

## Contributors
[https://github.com/mariyamzx/](url)
[https://github.com/abiha25/](url)
