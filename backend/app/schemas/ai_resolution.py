"""
ReportlyUrban — Phase 8.2 Advisory AI Resolution Comparison Schemas
Strict extra='forbid' Pydantic models for structured Gemini comparison output,
sanitization, admin-only requests, and minimal safe responses.
"""

import json
import math
import re
from typing import List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator

AiResolutionVerdict = Literal["appears_fixed", "appears_not_fixed", "unclear"]
AiResolutionStatus = Literal["pending", "completed", "failed"]
AiResolutionTriggerSource = Literal["automatic", "manual"]

ADVISORY_DISCLAIMER = "This is an AI suggestion. It does not confirm that the work is complete."
CONFIDENCE_NOTE = "Model-estimated visual confidence, not proof the work is complete"

_HTML_TAG_RX = re.compile(r"<[^>]+>")
_DANGEROUS_MARKUP_RX = re.compile(r"(?:<\s*script|javascript:|onerror\s*=|onload\s*=|<\s*iframe)", re.IGNORECASE)
_EMAIL_RX = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
_PHONE_RX = re.compile(r"(?:\+?\d[\d\s\-()]{7,}\d)")
_PLATE_RX = re.compile(
    r"(?:\b[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,3}[-\s]?\d{3,4}\b|\b(?:license|number)\s*plate\s*[:#-]?\s*[A-Z0-9-]{4,12}\b)",
    re.IGNORECASE,
)
_ADDRESS_RX = re.compile(
    r"(?:\b\d{1,5}\s+[A-Z][a-zA-Z]+\s+(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Boulevard|Blvd|Drive|Dr|Colony|Nagar)\b|\b(?:pin|zip|postal)\s*(?:code)?\s*[:#-]?\s*\d{5,6}\b)",
    re.IGNORECASE,
)
_IDENTITY_OR_INJECTION_RX = re.compile(
    r"(?:\b(?:identified person|driver name|citizen name|resident named|mr\.|mrs\.|ms\.)\b|ignore\s+previous\s+instructions|system\s+prompt)",
    re.IGNORECASE,
)


class AiResolutionGeminiWireSchema(BaseModel):
    """
    Wire schema supplied to Gemini v1beta response_schema.
    Omits extra='forbid' so google-genai does not emit additional_properties=false,
    which the Gemini v1beta Schema proto rejects with 400 INVALID_ARGUMENT.
    """

    verdict: AiResolutionVerdict
    confidence: float = Field(..., ge=0.0, le=1.0)
    summary: str = Field(..., min_length=1, max_length=600)


class AiResolutionGeminiRaw(BaseModel):
    """Strict local schema used to validate parsed Gemini structured JSON output."""

    model_config = ConfigDict(extra="forbid")

    verdict: AiResolutionVerdict
    confidence: float = Field(..., ge=0.0, le=1.0)
    summary: str = Field(..., min_length=1, max_length=600)

    @field_validator("confidence")
    @classmethod
    def check_finite_confidence(cls, value: float) -> float:
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("Confidence must be a finite number between 0 and 1.")
        return float(value)


class AiComparisonValidatedOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verdict: AiResolutionVerdict
    confidence: float
    summary: str = Field(..., min_length=1, max_length=300)


class AiResolutionRerunRequest(BaseModel):
    """Admin manual re-run request body (rejects any client-supplied IDs or verdict fields)."""

    model_config = ConfigDict(extra="forbid")


class AiResolutionCheckAttempt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    status: AiResolutionStatus
    verdict: Optional[AiResolutionVerdict] = None
    confidence: Optional[float] = None
    summary: Optional[str] = None
    failure_category: Optional[str] = None
    model_name: str
    prompt_version: str
    trigger_source: AiResolutionTriggerSource
    triggered_by_admin: bool
    created_at: str
    completed_at: Optional[str] = None


class AiResolutionCheckResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature_enabled: bool
    advisory_notice: str = ADVISORY_DISCLAIMER
    confidence_note: str = CONFIDENCE_NOTE
    latest: Optional[AiResolutionCheckAttempt] = None
    attempts: List[AiResolutionCheckAttempt] = Field(default_factory=list)


def _reject_non_finite_constant(token: str) -> None:
    raise ValueError(f"Non-finite JSON constant not allowed: {token}")


def parse_and_validate_comparison_output(
    raw_text: Optional[str],
) -> tuple[Optional[AiComparisonValidatedOutput], Optional[str]]:
    """
    Independently parses and validates raw Gemini JSON response.
    Returns (validated_output, failure_category). Never returns a guess on invalid output.
    """
    if not raw_text or not isinstance(raw_text, str):
        return None, "invalid_model_output"

    trimmed = raw_text.strip()
    if "```" in trimmed or not trimmed.startswith("{"):
        return None, "malformed_json"

    try:
        parsed_json = json.loads(trimmed, parse_constant=_reject_non_finite_constant)
    except Exception:
        return None, "malformed_json"

    if not isinstance(parsed_json, dict):
        return None, "invalid_model_output"

    try:
        raw_model = AiResolutionGeminiRaw.model_validate(parsed_json)
    except Exception:
        return None, "invalid_model_output"

    if _DANGEROUS_MARKUP_RX.search(raw_model.summary):
        return None, "unsafe_model_output"

    stripped_summary = _HTML_TAG_RX.sub(" ", raw_model.summary)
    collapsed_summary = " ".join(stripped_summary.split()).strip()
    if not collapsed_summary or len(collapsed_summary) > 300:
        return None, "invalid_model_output"

    if (
        _EMAIL_RX.search(collapsed_summary)
        or _PHONE_RX.search(collapsed_summary)
        or _PLATE_RX.search(collapsed_summary)
        or _ADDRESS_RX.search(collapsed_summary)
        or _IDENTITY_OR_INJECTION_RX.search(collapsed_summary)
    ):
        return None, "unsafe_model_output"

    return (
        AiComparisonValidatedOutput(
            verdict=raw_model.verdict,
            confidence=round(float(raw_model.confidence), 4),
            summary=collapsed_summary,
        ),
        None,
    )
