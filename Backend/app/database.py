"""
MongoDB Atlas connection.

WHY PYMONGO AND NOT MOTOR
-------------------------
Your existing FastAPI endpoints are synchronous (`def`, not `async def`).
Motor is async, so adopting it would force `async`/`await` through every
endpoint, the safety filter and the chat engine — a large rewrite with
many chances to break something. PyMongo is synchronous, so the shape of
every function stays exactly as it was; only the statements inside
repository.py changed. FastAPI runs sync endpoints in a threadpool, which
is more than adequate here.

WHY certifi
-----------
The single most common MongoDB Atlas failure on Windows is an SSL
handshake error, because Python can't find a trusted CA bundle. Passing
certifi's bundle explicitly eliminates that entire class of problem.
"""

import logging
from typing import Optional

import certifi
from pymongo import MongoClient, ASCENDING
from pymongo.errors import ConnectionFailure, ConfigurationError

from app.config import MONGODB_URI, MONGODB_DB_NAME

logger = logging.getLogger(__name__)

_client: Optional[MongoClient] = None
_db = None


def get_client() -> MongoClient:
    """Lazily creates a single shared MongoClient (it is thread-safe and
    manages its own connection pool — creating one per request is a
    classic performance mistake)."""
    global _client

    if _client is None:
        if not MONGODB_URI:
            raise RuntimeError(
                "MONGODB_URI is not set. Add it to your .env file."
            )
        _client = MongoClient(
            MONGODB_URI,
            tlsCAFile=certifi.where(),
            serverSelectionTimeoutMS=10000,
            uuidRepresentation="standard",
        )

    return _client


def get_db():
    """
    Returns the database handle.

    Kept as a plain function rather than a FastAPI dependency generator so
    that non-request code (the CLI, the seed script, the tests) can use the
    exact same accessor. Endpoints still receive it via Depends(get_db),
    so their signatures are unchanged.
    """
    global _db

    if _db is None:
        _db = get_client()[MONGODB_DB_NAME]

    return _db


def ping() -> tuple[bool, str]:
    """Health check. Returns (ok, message) instead of raising, so /health
    can report a database problem without the whole endpoint 500-ing."""
    try:
        get_client().admin.command("ping")
        return True, "connected"
    except (ConnectionFailure, ConfigurationError) as e:
        return False, f"MongoDB connection failed: {e}"
    except Exception as e:
        return False, f"MongoDB error: {e}"


def ensure_indexes() -> None:
    """
    Creates the indexes that replace the Postgres CREATE INDEX statements.

    Mongo creates collections implicitly on first insert, so there is no
    CREATE TABLE step to port — but indexes still need declaring, and the
    unique index on email is what preserves the old
    `email TEXT UNIQUE NOT NULL` constraint. Without it, duplicate
    signups would silently succeed.
    """
    db = get_db()

    db.patients.create_index([("email", ASCENDING)], unique=True, name="uniq_email")

    db.prescription_history.create_index(
        [("patient_id", ASCENDING), ("created_at", -1)],
        name="idx_prescription_patient_created",
    )

    db.drug_class_members.create_index(
        [("medicine_name", ASCENDING)], name="idx_drug_class_medicine"
    )
    db.drug_class_members.create_index(
        [("class_name", ASCENDING)], name="idx_drug_class_class"
    )

    db.condition_contraindications.create_index(
        [("condition_keyword", ASCENDING)], name="idx_contra_condition"
    )
    db.pregnancy_contraindications.create_index(
        [("target", ASCENDING)], name="idx_contra_pregnancy"
    )

    logger.info("MongoDB indexes ensured.")
