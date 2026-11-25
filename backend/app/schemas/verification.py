"""
ReportlyUrban — Phase 8.3 Citizen Resolution Verification & Dispute Schemas
Strict extra='forbid' Pydantic models with reason sanitization and UUID validation.
Zero AI verdict/confidence fields are ever included in citizen/officer responses.
"""

import re
from typing import List, Literal, Optional
import uuid
from pydantic import BaseModel, ConfigDict, Field, field_validator

VerificationDecision = Literal["verified", "disputed"]

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
    created_at: str


class AdminVerificationHistoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    evidence_id: str
    decision: VerificationDecision
    reason: Optional[str] = None
    citizen_display_name: str
    created_at: str


class AdminVerificationHistoryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    complaint_id: str
    complaint_status: str
    latest_evidence_id: Optional[str] = None
    latest_decision: Optional[VerificationDecision] = None
    history: List[AdminVerificationHistoryItem] = Field(default_factory=list)
