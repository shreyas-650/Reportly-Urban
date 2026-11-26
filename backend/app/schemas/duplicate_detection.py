"""
ReportlyUrban — Phase 9.4 Duplicate Detection Schemas
Strict Pydantic models for rule/AI duplicate linking, Gemini JSON output validation,
and admin-only duplicate review endpoints.
"""

import json
import math
import re
from typing import Iterable, List, Literal, Optional, Set
from pydantic import BaseModel, ConfigDict, Field, field_validator

DuplicateMethodType = Literal["rule", "ai"]
DuplicateLinkStatusType = Literal["suspected", "confirmed_duplicate", "not_duplicate"]
DuplicateFilterStatusType = Literal["all", "suspected", "confirmed_duplicate", "not_duplicate"]

PHASE_9_4_FEATURE_NAME = "duplicate_detection"
VALID_DUPLICATE_FILTERS = ("all", "suspected", "confirmed_duplicate", "not_duplicate")

_HTML_TAG_RX = re.compile(r"<[^>]+>")


class DuplicateComparisonCandidateWire(BaseModel):
    """Wire candidate entry supplied to Gemini v1beta response_schema (omits extra='forbid')."""

    candidate_id: str
    is_potential_duplicate: bool
    similarity_score: float = Field(..., ge=0.0, le=1.0)
    reason: str = Field(..., min_length=3, max_length=300)


class DuplicateComparisonWireSchema(BaseModel):
    """Wire response schema supplied to Gemini v1beta response_schema."""

    comparisons: List[DuplicateComparisonCandidateWire]
    confidence: float = Field(..., ge=0.0, le=1.0)


class DuplicateComparisonCandidateStrict(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_id: str = Field(..., min_length=1, max_length=64)
    is_potential_duplicate: bool
    similarity_score: float = Field(..., ge=0.0, le=1.0)
    reason: str = Field(..., min_length=3, max_length=300)

    @field_validator("similarity_score")
    @classmethod
    def check_finite_score(cls, value: float) -> float:
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("similarity_score must be finite in [0.0, 1.0].")
        return float(value)

    @field_validator("reason")
    @classmethod
    def sanitize_reason(cls, value: str) -> str:
        cleaned = _HTML_TAG_RX.sub("", value or "").strip()
        if len(cleaned) < 3:
            raise ValueError("reason must contain at least 3 non-empty characters.")
        return cleaned[:300]


class DuplicateComparisonStrictRaw(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comparisons: List[DuplicateComparisonCandidateStrict]
    confidence: float = Field(..., ge=0.0, le=1.0)

    @field_validator("confidence")
    @classmethod
    def check_finite_confidence(cls, value: float) -> float:
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("confidence must be finite in [0.0, 1.0].")
        return float(value)


def _reject_non_finite_constant(token: str) -> None:
    raise ValueError(f"Non-finite JSON constant not allowed: {token}")


def parse_and_validate_duplicate_output(
    raw_text: Optional[str],
    allowed_candidate_ids: Iterable[str],
) -> tuple[Optional[DuplicateComparisonStrictRaw], Optional[str]]:
    """
    Validates raw Gemini JSON output strictly against allowed candidate UUIDs and finite bounds.
    Rejects hallucinated candidate IDs, duplicate entries, extra fields, or non-finite scores.
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
        validated = DuplicateComparisonStrictRaw.model_validate(parsed_json)
    except Exception:
        return None, "invalid_model_output: schema validation failed"

    allowed_set: Set[str] = {str(cid).strip() for cid in allowed_candidate_ids if cid}
    seen: Set[str] = set()
    for item in validated.comparisons:
        cid = item.candidate_id.strip()
        if cid not in allowed_set:
            return None, "invalid_model_output: unrecognized candidate_id"
        if cid in seen:
            return None, "invalid_model_output: repeated candidate_id"
        seen.add(cid)

    return validated, None


class AdminDuplicateLinkItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    complaint_id: str
    candidate_complaint_id: str
    similarity_score: float
    reason: str
    method: DuplicateMethodType
    status: DuplicateLinkStatusType
    decided_by: Optional[str] = None
    decided_at: Optional[str] = None
    created_at: str
    linked_complaint_id: str
    linked_complaint_number: str
    linked_title: str
    linked_category: str
    linked_ward: str
    linked_status: str
    linked_priority: str
    linked_created_at: str


class AdminComplaintDuplicatesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature_enabled: bool
    items: List[AdminDuplicateLinkItem] = Field(default_factory=list)


class AdminDuplicateQueueRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    complaint_id: str
    candidate_complaint_id: str
    similarity_score: float
    reason: str
    method: DuplicateMethodType
    status: DuplicateLinkStatusType
    decided_at: Optional[str] = None
    created_at: str
    complaint_number: str
    complaint_title: str
    complaint_category: str
    complaint_ward: str
    complaint_status: str
    candidate_complaint_number: str
    candidate_title: str
    candidate_ward: str
    candidate_status: str


class AdminDuplicatesListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    feature_enabled: bool
    items: List[AdminDuplicateQueueRow] = Field(default_factory=list)
    total: int
    page: int
    page_size: int
    total_pages: int


class AdminDuplicateDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AdminDuplicateDecisionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success: bool
    link_id: str
    complaint_id: str
    candidate_complaint_id: str
    status: Literal["confirmed_duplicate", "not_duplicate"]
    decided_at: str


class CitizenDuplicateTriggerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: bool
