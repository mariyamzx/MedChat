"""
Central configuration.

WHY THIS FILE EXISTS
--------------------
Previously every module called os.getenv() on its own, so a missing
variable surfaced as a confusing crash deep inside a request. Loading
everything here once means the app fails fast at startup with a clear
message, and every other module imports named constants instead of
guessing at env var spellings.
"""

import os
from dotenv import load_dotenv

load_dotenv()


# ==========================================================
# Database (MongoDB Atlas)
# ==========================================================

MONGODB_URI = os.getenv("MONGODB_URI", "").strip()
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "medicine_chatbot").strip()


# ==========================================================
# LLM provider
# ==========================================================
# "groq" is the default because it is free-tier, fast, and — critically —
# supports response_format={"type":"json_object"}, which forces valid JSON
# at the API level instead of hoping a 7B model formats it correctly.
# "huggingface" is kept as a drop-in fallback so no work is lost.

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq").strip().lower()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip()
GROQ_BASE_URL = "https://api.groq.com/openai/v1/chat/completions"

HF_TOKEN = os.getenv("HF_TOKEN", "").strip()
HF_MODEL = os.getenv("HF_MODEL", "Qwen/Qwen2.5-72B-Instruct").strip()
HF_BASE_URL = "https://router.huggingface.co/v1/chat/completions"

LLM_TIMEOUT_SECONDS = int(os.getenv("LLM_TIMEOUT_SECONDS", "45"))
LLM_MAX_RETRIES = int(os.getenv("LLM_MAX_RETRIES", "2"))


# ==========================================================
# Safety pipeline
# ==========================================================

MAX_SAFETY_RETRIES = int(os.getenv("MAX_SAFETY_RETRIES", "3"))


# ==========================================================
# CORS
# ==========================================================
# Comma-separated list. Defaults cover the usual Vite / CRA dev ports so
# the frontend works out of the box without editing anything.

_default_origins = (
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:4173,http://127.0.0.1:4173"
)
CORS_ORIGINS = [
    o.strip() for o in os.getenv("CORS_ORIGINS", _default_origins).split(",") if o.strip()
]


# ==========================================================
# Standard disclaimer, returned with every clinical response
# ==========================================================

DISCLAIMER = (
    "This is an educational demo and not a substitute for professional "
    "medical advice. Always confirm with a pharmacist or doctor before "
    "taking any medicine."
)


def validate_startup_config() -> list[str]:
    """
    Returns a list of human-readable problems. main.py prints these at
    startup so a misconfigured .env is obvious immediately rather than
    causing a 500 on the first request.
    """
    problems = []

    if not MONGODB_URI:
        problems.append(
            "MONGODB_URI is not set. Copy .env.example to .env and paste your "
            "MongoDB Atlas connection string."
        )

    if LLM_PROVIDER == "groq" and not GROQ_API_KEY:
        problems.append("LLM_PROVIDER is 'groq' but GROQ_API_KEY is not set.")

    if LLM_PROVIDER == "huggingface" and not HF_TOKEN:
        problems.append("LLM_PROVIDER is 'huggingface' but HF_TOKEN is not set.")

    if LLM_PROVIDER not in ("groq", "huggingface"):
        problems.append(
            f"LLM_PROVIDER is '{LLM_PROVIDER}' — must be 'groq' or 'huggingface'."
        )

    return problems
