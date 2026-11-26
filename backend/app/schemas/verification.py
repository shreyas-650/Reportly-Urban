"""
ReportlyUrban — Phase 8.3 Citizen Resolution Verification & Dispute Schemas
Strict extra='forbid' Pydantic models with reason sanitization and UUID validation.
Zero AI verdict/confidence fields are ever included in citizen/officer responses.
"""

import re
from typing import FrozenSet, List, Literal, Optional
import uuid
from pydantic import BaseModel, ConfigDict, Field, field_validator

VerificationDecision = Literal["verified", "disputed"]
AdminDisputeAction = Literal["reopen", "keep_resolved", "close_unconfirmed"]

VALID_DISPUTE_FILTERS: FrozenSet[str] = frozenset(
    {"open_dispute", "reopened", "escalated_to_admin", "admin_resolved", "closed_unconfirmed"}
)

_HTML_TAG_RX = re.compile(r"<[^>]+>")
_DANGEROUS_MARKUP_RX = re.compile(r"(?:<\s*script|javascript:|onerror\s*=|onload\s*=|<\s*iframe)", re.IGNORECASE)


def sanitize_verification_reason(raw_value: Optional[str], *, required: bool) -> Optional[str]:
    if raw_value is None:
        if required:
            raise ValueError("A reason is required when disputing a resolution.")
        return None
    if not isinstance(raw_value, str):
        raise ValueError("Reason must be plain text.")
    if _DANGEROUS_MARKUP_RX.search(raw_value):
        raise ValueError("Reason contains disallowed markup.")
    stripped = _HTML_TAG_RX.sub(" ", raw_value)
    collapsed = " ".join(stripped.split()).strip()
    if not collapsed:
        if required:
            raise ValueError("A non-empty reason is required when disputing a resolution.")
        return None
    if len(collapsed) > 1000:
        raise ValueError("Reason must not exceed 1000 characters.")
    return collapsed


def _validate_optional_uuid(raw_value: Optional[str]) -> Optional[str]:
    if raw_value is None:
        return None
    cleaned = raw_value.strip()
    if not cleaned:
        return None
    try:
        return str(uuid.UUID(cleaned))
    except ValueError:
        raise ValueError("Invalid evidence_id format.")


class ResolutionVerifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidence_id: Optional[str] = Field(default=None, max_length=64)
    reason: Optional[str] = Field(default=None, max_length=1000)

    @field_validator("evidence_id")
    @classmethod
    def check_evidence_id(cls, value: Optional[str]) -> Optional[str]:
        return _validate_optional_uuid(value)

    @field_validator("reason")
    @classmethod
    def check_reason(cls, value: Optional[str]) -> Optional[str]:
        return sanitize_verification_reason(value, required=False)


class ResolutionDisputeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidence_id: Optional[str] = Field(default=None, max_length=64)
    reason: str = Field(..., min_length=1, max_length=1000)

    @field_validator("evidence_id")
    @classmethod
    def check_evidence_id(cls, value: Optional[str]) -> Optional[str]:
        return _validate_optional_uuid(value)

    @field_validator("reason")
    @classmethod
    def check_reason(cls, value: str) -> str:
        cleaned = sanitize_verification_reason(value, required=True)
        assert cleaned is not None
        return cleaned


class VerificationHistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    evidence_id: str
    decision: VerificationDecision
    reason: Optional[str] = None
    created_at: str


class CitizenVerificationStatusResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    complaint_id: str
    complaint_status: str
    latest_evidence_id: Optional[str] = None
    can_verify: bool
    reopen_count: int = 0
    max_reopens: int = 2
    current_decision: Optional[VerificationHistoryItem] = None
    history: List[VerificationHistoryItem] = Field(default_factory=list)


class VerificationSubmissionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verification_id: str
    complaint_id: str
    evidence_id: str
    decision: VerificationDecision
    reason: Optional[str] = None
    complaint_status: str
    action: Optional[str] = None
    reopened: bool = False
    escalated_to_admin: bool = False
    reopen_count: int = 0
    max_reopens: Optional[int] = None
    sla_deadline: Optional[str] = None
    message: Optional[str] = None
    created_at: str


class AdminVerificationHistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    evidence_id: str
    decision: VerificationDecision
    reason: Optional[str] = None
    citizen_display_name: str
    created_at: str


class AdminVerificationEventItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    evidence_id: Optional[str] = None
    event_type: str
    actor_type: str
    actor_display_name: str
    result: str
    details: Optional[str] = None
    created_at: str


class AdminVerificationHistoryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    complaint_id: str
    complaint_status: str
    latest_evidence_id: Optional[str] = None
    latest_decision: Optional[VerificationDecision] = None
    dispute_state: Optional[str] = None
    reopen_count: int = 0
    admin_resolution_note: Optional[str] = None
    admin_decided_at: Optional[str] = None
    history: List[AdminVerificationHistoryItem] = Field(default_factory=list)
    events: List[AdminVerificationEventItem] = Field(default_factory=list)


class AdminDisputedComplaintItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    complaint_id: str
    complaint_reference: str
    title: str
    category: str
    ward: str
    complaint_status: str
    dispute_state: str
    reopen_count: int
    latest_reason: Optional[str] = None
    citizen_display_name: str
    sla_deadline: Optional[str] = None
    updated_at: str
    admin_decided_at: Optional[str] = None


class AdminDisputedComplaintsListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: List[AdminDisputedComplaintItem]
    page: int
    page_size: int
    total: int
    total_pages: int


class AdminDisputeDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: AdminDisputeAction
    note: str = Field(..., min_length=5, max_length=1000)

    @field_validator("note")
    @classmethod
    def check_note(cls, value: str) -> str:
        cleaned = sanitize_verification_reason(value, required=True)
        assert cleaned is not None
        if len(cleaned) < 5:
            raise ValueError("Admin decision note must be at least 5 characters.")
        return cleaned


class AdminDisputeDecisionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    complaint_id: str
    action: AdminDisputeAction
    complaint_status: str
    dispute_state: str
    admin_resolution_note: str
    admin_decided_at: str
