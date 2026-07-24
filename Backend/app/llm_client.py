"""
LLM access layer.

WHY LANGCHAIN WAS REMOVED
-------------------------
The old chain was `prompt | ChatHuggingFace(HuggingFaceEndpoint(...)) |
JsonOutputParser`. Three problems with that for this project:

  1. langchain, langchain-core and langchain-huggingface were pinned to
     exact versions. Any pip resolution change broke the import chain —
     a likely source of the "backend server issues" you hit.
  2. HuggingFaceEndpoint with task="text-generation" points at the legacy
     serverless inference API, which has been progressively retired. That
     path returns 404s and StopIteration errors that look like code bugs.
  3. JsonOutputParser can only *hope* the model emitted JSON. It has no
     way to enforce it.

This replacement is ~150 lines of plain `requests` against an
OpenAI-compatible chat endpoint. Both Groq and Hugging Face's current
router speak that format, so switching providers is one env var. Groq is
the default because it supports response_format={"type":"json_object"},
which makes the API itself guarantee parseable JSON — a far stronger
guarantee than prompting for it.

You can still describe this in your report as structured JSON output
validated by Pydantic, which is exactly what it is.
"""

import json
import logging
import re
from typing import Optional, Type, TypeVar

import requests
from pydantic import BaseModel, ValidationError

from app import config

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class LLMUnavailableError(Exception):
    """Raised when the provider cannot be reached or returns an error.
    Callers catch this and degrade gracefully instead of 500-ing."""


class LLMFormatError(Exception):
    """Raised when the model's output could not be coerced into the
    expected schema after retries."""


# ==========================================================
# Provider call
# ==========================================================

def _provider_settings() -> tuple[str, str, str]:
    """Returns (url, api_key, model) for the configured provider."""
    if config.LLM_PROVIDER == "huggingface":
        return config.HF_BASE_URL, config.HF_TOKEN, config.HF_MODEL
    return config.GROQ_BASE_URL, config.GROQ_API_KEY, config.GROQ_MODEL


def call_llm(
    system_prompt: str,
    user_prompt: str,
    *,
    temperature: float = 0.2,
    max_tokens: int = 900,
    force_json: bool = False,
) -> str:
    """
    Single chat completion. Returns the raw assistant text.

    Retries on transient network/5xx errors only — a 401 is not going to
    fix itself, so we fail immediately with a message that names the
    actual problem instead of burning three attempts first.
    """
    url, api_key, model = _provider_settings()

    if not api_key:
        raise LLMUnavailableError(
            f"No API key configured for provider '{config.LLM_PROVIDER}'. "
            f"Set {'HF_TOKEN' if config.LLM_PROVIDER == 'huggingface' else 'GROQ_API_KEY'} in .env"
        )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    # Groq enforces JSON at the API level. HF's router does not reliably
    # support this yet, so we only send it for Groq and fall back to
    # prompt-level instruction plus the extractor below.
    if force_json and config.LLM_PROVIDER == "groq":
        payload["response_format"] = {"type": "json_object"}

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    last_error = None

    for attempt in range(1, config.LLM_MAX_RETRIES + 1):
        try:
            response = requests.post(
                url, headers=headers, json=payload,
                timeout=config.LLM_TIMEOUT_SECONDS,
            )

            if response.status_code == 401:
                raise LLMUnavailableError(
                    f"{config.LLM_PROVIDER} rejected the API key (401). "
                    "Check the key in .env — and rotate it if it has ever been shared."
                )

            if response.status_code == 404:
                raise LLMUnavailableError(
                    f"Model '{model}' not found on {config.LLM_PROVIDER} (404). "
                    "The model name may have been retired — try another."
                )

            if response.status_code == 429:
                last_error = "Rate limited (429)."
                logger.warning("Rate limited, attempt %s", attempt)
                continue

            response.raise_for_status()

            data = response.json()
            return data["choices"][0]["message"]["content"] or ""

        except LLMUnavailableError:
            raise
        except requests.exceptions.Timeout:
            last_error = f"Request timed out after {config.LLM_TIMEOUT_SECONDS}s."
            logger.warning("LLM timeout, attempt %s", attempt)
        except requests.exceptions.ConnectionError as e:
            last_error = f"Could not reach {config.LLM_PROVIDER}: {e}"
            logger.warning("LLM connection error, attempt %s", attempt)
        except requests.exceptions.HTTPError as e:
            last_error = f"HTTP error from {config.LLM_PROVIDER}: {e}"
            logger.warning("LLM HTTP error, attempt %s", attempt)
        except (KeyError, IndexError, ValueError) as e:
            last_error = f"Unexpected response shape from {config.LLM_PROVIDER}: {e}"
            logger.warning("LLM response parse error, attempt %s", attempt)

    raise LLMUnavailableError(last_error or "LLM call failed for an unknown reason.")


# ==========================================================
# JSON extraction and validation
# ==========================================================

_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def extract_json(text: str) -> dict:
    """
    Pulls a JSON object out of model output.

    Small models wrap JSON in markdown fences, add a preamble like
    "Here is the JSON:", or append a trailing explanation. The old
    JsonOutputParser choked on all three. This strips fences, then falls
    back to slicing between the first '{' and its matching '}' by brace
    counting — which survives nested objects, unlike a naive rfind.
    """
    if not text or not text.strip():
        raise LLMFormatError("Model returned an empty response.")

    cleaned = _FENCE_RE.sub("", text.strip())

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    if start == -1:
        raise LLMFormatError(f"No JSON object found in model output: {text[:200]}")

    depth = 0
    in_string = False
    escaped = False

    for i in range(start, len(cleaned)):
        ch = cleaned[i]

        if escaped:
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue

        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = cleaned[start:i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError as e:
                    raise LLMFormatError(f"Malformed JSON in model output: {e}")

    raise LLMFormatError(f"Unterminated JSON object in model output: {text[:200]}")


def call_llm_structured(
    system_prompt: str,
    user_prompt: str,
    schema: Type[T],
    *,
    temperature: float = 0.2,
    max_tokens: int = 900,
) -> T:
    """
    Calls the model and validates the result against a Pydantic schema.

    If validation fails, retries ONCE with the validation error fed back to
    the model. This is far more effective than a blind retry, because the
    model is told exactly which field it got wrong.
    """
    raw = call_llm(system_prompt, user_prompt,
                   temperature=temperature, max_tokens=max_tokens, force_json=True)

    try:
        return schema.model_validate(extract_json(raw))
    except (LLMFormatError, ValidationError) as first_error:
        logger.warning("Structured output failed validation, retrying once: %s", first_error)

        repair_prompt = (
            f"{user_prompt}\n\n"
            f"Your previous reply was rejected because it did not match the required "
            f"format. The error was:\n{first_error}\n\n"
            f"Reply again with ONLY a valid JSON object matching the schema. "
            f"No markdown, no explanation, no text before or after."
        )

        raw_retry = call_llm(system_prompt, repair_prompt,
                             temperature=0.0, max_tokens=max_tokens, force_json=True)

        try:
            return schema.model_validate(extract_json(raw_retry))
        except (LLMFormatError, ValidationError) as second_error:
            raise LLMFormatError(
                f"Model could not produce valid {schema.__name__} after a retry. "
                f"Last error: {second_error}"
            )


def is_configured() -> bool:
    _, api_key, _ = _provider_settings()
    return bool(api_key)
