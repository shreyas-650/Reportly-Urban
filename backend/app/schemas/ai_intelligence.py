"""
ReportlyUrban — Phase 9.1 AI Category & Priority Suggestion Schemas (Shadow Mode)
Strict schemas for Gemini structured JSON output validation and admin-only review endpoints.
"""

import json
import math
from typing import List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.ai import CivicCategoryType, VALID_CIVIC_CATEGORIES

VALID_COMPLAINT_PRIORITIES = ("low", "normal", "medium", "high", "emergency")

ComplaintPriorityType = Literal["low", "normal", "medium", "high", "emergency"]
AiDecisionStatusType = Literal["pending", "completed", "failed"]
AdminDecisionOutcomeType = Literal["pending", "accepted", "overridden", "ignored"]

PHASE_9_1_FEATURE_NAME = "category_priority_suggestion"


class CategoryPriorityWireSchema(BaseModel):
    """
    Wire schema supplied to Gemini v1beta response_schema.
    Omits extra='forbid' so google-genai does not emit additional_properties=false,
    which the Gemini v1beta Schema proto rejects with 400 INVALID_ARGUMENT.
    """

    suggested_category: CivicCategoryType
    suggested_priority: ComplaintPriorityType
    confidence: float = Field(..., ge=0.0, le=1.0)


class CategoryPriorityStrictRaw(BaseModel):
    """Strict local schema used to validate parsed Gemini structured JSON output."""

    model_config = ConfigDict(extra="forbid")

    suggested_category: CivicCategoryType
    suggested_priority: ComplaintPriorityType
    confidence: float = Field(..., ge=0.0, le=1.0)

    @field_validator("confidence")
    @classmethod
    def check_finite_confidence(cls, value: float) -> float:
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("Confidence must be a finite number between 0.0 and 1.0.")
        return float(value)


def _reject_non_finite_constant(token: str) -> None:
    raise ValueError(f"Non-finite JSON constant not allowed: {token}")


def parse_and_validate_suggestion_output(
    raw_text: Optional[str],
) -> tuple[Optional[CategoryPriorityStrictRaw], Optional[str]]:
    """
    Parses and validates raw Gemini JSON response against strict category/priority whitelist.
    Returns (validated_output, error_message). Rejects anything outside allowed values or extra keys.
    """
    if not raw_text or not isinstance(raw_text, str):
        return None, "invalid_model_output: empty response"

    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        lines = [line for line in cleaned.splitlines() if not line.strip().startswith("```")]
        cleaned = "\n".join(lines).strip()

    try:
        parsed_json = json.loads(cleaned, parse_constant=_reject_non_finite_constant)
    except Exception:
        return None, "invalid_model_output: malformed JSON"

    if not isinstance(parsed_json, dict):
        return None, "invalid_model_output: JSON root must be an object"

    try:
        validated = CategoryPriorityStrictRaw.model_validate(parsed_json)
    except Exception:
        return None, "invalid_model_output: failed strict category/priority/confidence validation"

    if (
        validated.suggested_category not in VALID_CIVIC_CATEGORIES
        or validated.suggested_priority not in VALID_COMPLAINT_PRIORITIES
    ):
        return None, "invalid_model_output: disallowed category or priority"

    return validated, None


class AdminAiSuggestionAcceptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_updated_at: Optional[str] = Field(default=None, max_length=64)


class AdminAiSuggestionOverrideRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: CivicCategoryType
    priority: ComplaintPriorityType
    expected_updated_at: Optional[str] = Field(default=None, max_length=64)


class AdminAiSuggestionIgnoreRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_updated_at: Optional[str] = Field(default=None, max_length=64)


class AiSuggestionRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    complaint_id: str
    feature: str
    model_name: str
    prompt_version: str
    status: AiDecisionStatusType
    suggested_category: Optional[CivicCategoryType] = None
    suggested_priority: Optional[ComplaintPriorityType] = None
    confidence: Optional[float] = None
    error_message: Optional[str] = None
    admin_decision: AdminDecisionOutcomeType
    final_category: Optional[CivicCategoryType] = None
    final_priority: Optional[ComplaintPriorityType] = None
    decided_at: Optional[str] = None
    created_at: str
    completed_at: Optional[str] = None


class AdminAiSuggestionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature_enabled: bool
    label: str = "AI suggestion"
    shadow_mode: bool = True
    latest: Optional[AiSuggestionRecord] = None
    attempts: List[AiSuggestionRecord] = Field(default_factory=list)


class AdminAiSuggestionDecisionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success: bool
    complaint_id: str
    decision_id: str
    admin_decision: Literal["accepted", "overridden", "ignored"]
    final_category: Optional[CivicCategoryType] = None
    final_priority: Optional[ComplaintPriorityType] = None
    complaint_updated_at: Optional[str] = None
    decided_at: str


class CitizenAiSuggestionTriggerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: bool
    queued: bool
