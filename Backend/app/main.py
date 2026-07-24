"""
FastAPI application.

CHANGES FROM THE ORIGINAL
-------------------------
- CORS middleware added. Without it, every browser request from the React
  frontend is rejected before reaching any of this code. This was almost
  certainly a large part of the "backend server issues" during integration.
- POST /login added. /survey stored an email and password hash but nothing
  ever verified them, so the frontend login screen had no endpoint.
- GET /health added, reporting database and LLM configuration status.
- POST /chat now runs the actual conversation pipeline. It previously
  required the caller to have already decided the medicine.
- POST /safety-check preserves the old /chat behaviour, so the existing
  safety-filter test suite still works.
- All SQL is gone; every endpoint calls repository functions instead.
"""

import hashlib
import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware

from app import config, database, llm_client, repository
from app.chat_engine import process_message
from app.profile_routes import router as profile_router
from app.database import get_db
from app.safety_filter import check_medicine_safety
from app.schemas import SurveyIn, ChatIn, ChatOut, LoginIn, SafetyCheckIn

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")
logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Runs once at boot. Reports configuration and connection problems
    immediately and in plain language, rather than letting them surface as
    a confusing 500 on the first request.

    Uses the lifespan API rather than @app.on_event("startup"), which is
    deprecated in current FastAPI and emits warnings on every run.
    """
    problems = config.validate_startup_config()

    if problems:
        logger.error("=" * 60)
        logger.error("CONFIGURATION PROBLEMS")
        for p in problems:
            logger.error("  - %s", p)
        logger.error("=" * 60)

    ok, message = database.ping()
    if ok:
        logger.info("MongoDB: %s (database: %s)", message, config.MONGODB_DB_NAME)
        try:
            database.ensure_indexes()
        except Exception as e:
            logger.warning("Could not create indexes: %s", e)
    else:
        logger.error("MongoDB: %s", message)

    logger.info("LLM provider: %s (configured: %s)",
                config.LLM_PROVIDER, llm_client.is_configured())
    logger.info("CORS origins: %s", config.CORS_ORIGINS)

    yield


app = FastAPI(
    title="MedChat API",
    description="Symptom-to-recommendation assistant with patient-history personalisation",
    version="2.0.0",
    lifespan=lifespan,
)


# ==========================================================
# CORS
# ==========================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==========================================================
# Routers
# ==========================================================
# PUT /patient-profile/{patient_id} lives in app/profile_routes.py so this file
# and every endpoint in it stay unmodified. Nothing above or below is affected.

app.include_router(profile_router)


# ==========================================================
# Helpers
# ==========================================================

def validate_uuid(id_str: str):
    """Unchanged from the original — patient IDs are still UUID strings,
    so this validation and every ID already stored in a frontend remain
    valid after the database migration."""
    try:
        uuid.UUID(id_str)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid patient_id format — must be a UUID")


def hash_password(password: str) -> str:
    """SHA-256, as before. A production system would use bcrypt with a
    per-password salt — a known and acceptable simplification for a course
    project, worth naming explicitly if you're asked about it."""
    return hashlib.sha256(password.encode()).hexdigest()


# ==========================================================
# Health
# ==========================================================

@app.get("/")
def root():
    return {"service": "MedChat API", "version": "2.0.0", "docs": "/docs"}


@app.get("/health")
def health():
    db_ok, db_message = database.ping()

    return {
        "status": "ok" if db_ok else "degraded",
        "database": {"connected": db_ok, "detail": db_message},
        "llm": {"provider": config.LLM_PROVIDER, "configured": llm_client.is_configured()},
        "config_problems": config.validate_startup_config(),
    }


# ==========================================================
# Survey
# ==========================================================

@app.post("/survey")
def submit_survey(survey: SurveyIn, db=Depends(get_db)):
    """
    Creates a patient. Request body is unchanged from the original contract.

    The old version ran ~6 INSERTs inside a manual transaction with a
    rollback handler. It is now one atomic document insert, so the
    partially-created-patient failure mode no longer exists.
    """
    try:
        if repository.email_exists(survey.email):
            raise HTTPException(
                status_code=409,
                detail="An account with this email already exists.",
            )

        patient_id = repository.create_patient(survey, hash_password(survey.password))

        logger.info("Created patient %s", patient_id)

        return {
            "patient_id": patient_id,
            "message": "Survey submitted successfully",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Survey submission failed")
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================================
# Login  (NEW)
# ==========================================================

@app.post("/login")
def login(credentials: LoginIn):
    """
    Verifies email + password and returns the patient_id the frontend needs
    for every subsequent request.

    Deliberately returns the same generic message for "no such email" and
    "wrong password", so the endpoint can't be used to discover which
    email addresses are registered.
    """
    patient = repository.find_patient_by_email(credentials.email)

    if not patient or patient.get("password_hash") != hash_password(credentials.password):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    return {
        "patient_id": patient["_id"],
        "full_name": patient.get("full_name"),
        "email": patient.get("email"),
        "message": "Login successful",
    }


# ==========================================================
# Patient profile
# ==========================================================

@app.get("/patient-profile/{patient_id}")
def get_patient_profile(patient_id: str, db=Depends(get_db)):
    """Response shape is identical to the original — six keys, same names,
    same nesting — so nothing consuming this endpoint needs changing."""
    validate_uuid(patient_id)

    profile = repository.get_patient_profile(patient_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Patient not found")

    profile["patient"].pop("password_hash", None)

    return profile


# ==========================================================
# Chat  (REWRITTEN)
# ==========================================================

@app.post("/chat", response_model=ChatOut)
def chat(payload: ChatIn, db=Depends(get_db)):
    """
    The conversational endpoint.

    Send whatever the user typed. The pipeline classifies it, and only the
    medical path can produce a medicine — which is then checked by the
    deterministic safety filter before it is returned.

    Request:  {"patient_id": "...", "message": "...", "history": [...]}
    Response: see the ChatOut schema — always the same shape, including
              on failure, so the frontend never has to branch on error
              handling separately.
    """
    validate_uuid(payload.patient_id)

    if not repository.patient_exists(payload.patient_id):
        raise HTTPException(status_code=404, detail="Patient not found")

    if not payload.message or not payload.message.strip():
        raise HTTPException(status_code=400, detail="message cannot be empty")

    try:
        return process_message(
            patient_id=payload.patient_id,
            message=payload.message.strip(),
            history=payload.history,
        )
    except Exception as e:
        logger.exception("Chat pipeline failed")
        raise HTTPException(status_code=500, detail=f"Chat pipeline error: {e}")


# ==========================================================
# Safety check  (the OLD /chat, preserved)
# ==========================================================

@app.post("/safety-check")
def safety_check(payload: SafetyCheckIn, db=Depends(get_db)):
    """
    Runs the safety filter on a medicine name supplied by the caller and
    logs the result. This is exactly what the original POST /chat did.

    It is kept so the existing evaluation suite still runs, and because it
    is genuinely useful on its own — it lets you test the safety filter
    without spending an LLM call.
    """
    validate_uuid(payload.patient_id)

    if not repository.patient_exists(payload.patient_id):
        raise HTTPException(status_code=404, detail="Patient not found")

    result = check_medicine_safety(payload.patient_id, payload.recommended_medicine_name)

    prescription_id = repository.log_prescription(
        patient_id=payload.patient_id,
        reported_symptoms=payload.reported_symptoms,
        recommended_medicine_name=payload.recommended_medicine_name,
        llm_raw_response=payload.llm_raw_response,
        safety_filter_result=result["result"],
        blocked_reason=result["blocked_reason"],
    )

    return {
        "prescription_id": prescription_id,
        "recommended_medicine_name": payload.recommended_medicine_name,
        "safety_filter_result": result["result"],
        "blocked_reason": result["blocked_reason"],
    }


# ==========================================================
# Prescription history
# ==========================================================

@app.get("/prescription-history/{patient_id}")
def get_prescription_history(patient_id: str, db=Depends(get_db)):
    """
    Newest first, with alternatives embedded.

    The old version ran one extra query per prescription to fetch its
    alternatives (an N+1 pattern). Alternatives are now inside the
    document, so this is a single query regardless of history length.
    """
    validate_uuid(patient_id)

    if not repository.patient_exists(patient_id):
        raise HTTPException(status_code=404, detail="Patient not found")

    return {
        "patient_id": patient_id,
        "prescriptions": repository.get_prescription_history(patient_id),
    }
