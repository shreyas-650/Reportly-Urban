"""
ReportlyUrban — Phase 9.5 Suspicious / False Claim Screening & Workflow Advancement Schemas
"""

import json
import math
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, ValidationError

PHASE_9_5_FEATURE_NAME = "suspicious_claim_screening"

VALID_SCREENING_REASON_CODES = (
    "duplicate_spam",
    "no_evidence",
    "gibberish",
    "rate_abuse",
    "needs_clarification",
)

VALID_RISK_LEVELS = ("low", "medium", "high")

VALID_ADMIN_SCREENING_FILTERS = (
    "needs_review",
    "priority_review",
    "ai_advanced",
    "dismissed",
    "confirmed_suspicious",
    "reverted",
    "all",
)


class ScreeningGeminiWireSchema(BaseModel):
    """Strict schema returned by Gemini for borderline screening only."""

    model_config = ConfigDict(extra="forbid")

    risk_level: Literal["low", "medium", "high"]
    reason_codes: List[
        Literal[
            "duplicate_spam",
            "no_evidence",
            "gibberish",
            "rate_abuse",
            "needs_clarification",
        ]
    ] = Field(default_factory=list, max_length=3)
    confidence: float = Field(ge=0.0, le=1.0)
    needs_clarification: bool = False


def parse_and_validate_screening_output(
    raw_text: str,
) -> tuple[Optional[ScreeningGeminiWireSchema], Optional[str]]:
    if not raw_text or not isinstance(raw_text, str):
        return None, "empty_response"

    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()

    try:
        parsed_json = json.loads(cleaned)
    except (ValueError, TypeError):
        return None, "invalid_json"

    if not isinstance(parsed_json, dict):
        return None, "expected_json_object"

    try:
        validated = ScreeningGeminiWireSchema.model_validate(parsed_json)
    except ValidationError:
        return None, "schema_validation_failed"

    if not math.isfinite(validated.confidence):
        return None, "invalid_confidence"

    # Reject contradictory output (e.g. high risk with zero reason codes)
    if validated.risk_level in ("medium", "high") and not validated.reason_codes:
        return None, "missing_reason_codes_for_elevated_risk"

    return validated, None


class CitizenScreeningTriggerResponse(BaseModel):
    """Strict citizen secrecy response: never reveals screening outcome or flags."""

    model_config = ConfigDict(extra="forbid")
    accepted: bool


class AdminScreeningQueueItem(BaseModel):
    review_id: str
    complaint_id: str
    complaint_number: str
    complaint_title: str
    complaint_category: str
    complaint_status: str
    complaint_created_at: str
    screening_version: str
    model_name: str
    prompt_version: str
    mode: str
    risk_level: str
    confidence: float
    reason_codes: List[str] = Field(default_factory=list)
    operational_flags: List[str] = Field(default_factory=list)
    used_gemini: bool
    would_advance: bool
    applied_advance: bool
    review_status: str
    admin_decision: str
    advancement_outcome: str
    decision_reason: Optional[str] = None
    decided_at: Optional[str] = None
    created_at: str
    updated_at: str


class AdminScreeningQueueResponse(BaseModel):
    screening_mode: str
    feature_enabled: bool
    items: List[AdminScreeningQueueItem] = Field(default_factory=list)
    total: int
    page: int
    page_size: int
    total_pages: int


class AdminScreeningEventItem(BaseModel):
    id: str
    actor_type: str
    event_type: str
    mode: str
    screening_version: str
    model_name: Optional[str] = None
    prompt_version: Optional[str] = None
    risk_level: Optional[str] = None
    confidence: Optional[float] = None
    reason_codes: List[str] = Field(default_factory=list)
    operational_flags: List[str] = Field(default_factory=list)
    would_advance: bool = False
    applied: bool = False
    previous_status: Optional[str] = None
    resulting_status: Optional[str] = None
    notes: Optional[str] = None
    created_at: str


class AdminComplaintScreeningResponse(BaseModel):
    complaint_id: str
    complaint_status: str
    screening_mode: str
    feature_enabled: bool
    review: Optional[Dict[str, Any]] = None
    events: List[AdminScreeningEventItem] = Field(default_factory=list)
    latest_metrics: Optional[Dict[str, Any]] = None


class AdminScreeningActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Optional[str] = Field(default=None, max_length=500)


class AdminScreeningDecisionResponse(BaseModel):
    success: bool
    complaint_id: str
    review_id: str
    review_status: str
    admin_decision: str
    advancement_outcome: str
    complaint_status: str
    decided_at: str
