"""
ReportlyUrban — Phase 7.3 Escalation, SLA Management & Notifications Schemas
Strict Pydantic validation with extra='forbid' on request models, category whitelisting,
bounded pagination (default 20, max 100), and safe output serialization.
"""

from datetime import date, datetime
import uuid
from typing import Any, FrozenSet, List, Optional, Tuple
from fastapi import HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

VALID_SLA_CATEGORIES: Tuple[str, ...] = (
    "potholes",
    "garbage",
    "streetlights",
    "water_leakage",
    "drainage",
    "public_infrastructure",
)
VALID_SLA_CATEGORY_SET: FrozenSet[str] = frozenset(VALID_SLA_CATEGORIES)
VALID_ESCALATION_STATUSES: FrozenSet[str] = frozenset({"completed", "blocked"})
VALID_REMINDER_KINDS: FrozenSet[str] = frozenset({"pre_deadline", "overdue"})
VALID_NOTIFICATION_KINDS: FrozenSet[str] = frozenset(
    {"reminder", "escalation", "escalation_blocked", "assignment"}
)
VALID_COMPLAINT_STATUSES: FrozenSet[str] = frozenset(
    {"submitted", "under_review", "in_progress", "resolved", "rejected", "not_confirmed_by_citizen"}
)


def parse_uuid_param(raw_value: str, label: str = "identifier") -> str:
    if not raw_value or not isinstance(raw_value, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {label}.",
        )
    try:
        return str(uuid.UUID(raw_value.strip()))
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {label}.",
        )


def validate_sla_category(raw_category: str) -> str:
    if not raw_category or not isinstance(raw_category, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid category.",
        )
    normalized = raw_category.strip().lower()
    if normalized not in VALID_SLA_CATEGORY_SET:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported complaint category.",
        )
    return normalized


def validate_bounded_pagination(
    page_raw: Optional[str], page_size_raw: Optional[str], default_size: int = 20, max_size: int = 100
) -> tuple[int, int]:
    page = 1
    page_size = default_size

    if page_raw is not None and page_raw.strip() != "":
        try:
            page = int(page_raw)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid page parameter.")
        if page < 1:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid page parameter.")

    if page_size_raw is not None and page_size_raw.strip() != "":
        try:
            page_size = int(page_size_raw)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid page_size parameter.")
        if page_size < 1 or page_size > max_size:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid page_size parameter (must be between 1 and {max_size}).",
            )

    return page, page_size


def reject_extra_query_params(request: Request, allowed: FrozenSet[str]) -> None:
    unknown = set(request.query_params.keys()) - set(allowed)
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported query parameter.",
        )


def validate_optional_date(raw_value: Optional[str], param_name: str) -> Optional[str]:
    if raw_value is None or not raw_value.strip():
        return None
    try:
        parsed = date.fromisoformat(raw_value.strip())
        return parsed.isoformat()
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {param_name} date format (expected YYYY-MM-DD).",
        )


def validate_optional_ward(raw_value: Optional[str]) -> Optional[str]:
    if raw_value is None:
        return None
    collapsed = " ".join(raw_value.strip().split())
    if not collapsed:
        return None
    if len(collapsed) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid ward filter parameter.",
        )
    return collapsed


def validate_optional_bool(raw_value: Optional[str], param_name: str) -> bool:
    if raw_value is None or raw_value.strip() == "":
        return False
    norm = raw_value.strip().lower()
    if norm in ("true", "1", "yes"):
        return True
    if norm in ("false", "0", "no"):
        return False
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Invalid boolean value for {param_name}.",
    )


class UpdateSlaRuleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sla_hours: int = Field(..., ge=1, le=8760)
    reminder_before_hours: int = Field(..., ge=0, le=8759)
    level2_after_hours: int = Field(..., ge=0, le=8760)
    level3_after_hours: int = Field(..., ge=1, le=17520)
    expected_updated_at: Optional[str] = Field(default=None, max_length=64)

    @field_validator("expected_updated_at")
    @classmethod
    def validate_expected_timestamp(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            return None
        try:
            datetime.fromisoformat(trimmed.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("expected_updated_at must be a valid ISO-8601 timestamp.")
        return trimmed

    @model_validator(mode="after")
    def validate_thresholds(self) -> "UpdateSlaRuleRequest":
        if self.reminder_before_hours >= self.sla_hours:
            raise ValueError("reminder_before_hours must be strictly less than sla_hours.")
        if self.level3_after_hours <= self.level2_after_hours:
            raise ValueError("level3_after_hours must be strictly greater than level2_after_hours.")
        return self


class ManualEscalationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(..., min_length=5, max_length=500)
    expected_updated_at: Optional[str] = Field(default=None, max_length=64)

    @field_validator("reason")
    @classmethod
    def validate_trimmed_reason(cls, value: str) -> str:
        trimmed = " ".join(value.strip().split())
        if len(trimmed) < 5:
            raise ValueError("Escalation reason must be at least 5 characters after trimming.")
        if len(trimmed) > 500:
            raise ValueError("Escalation reason must not exceed 500 characters.")
        return trimmed

    @field_validator("expected_updated_at")
    @classmethod
    def validate_expected_timestamp(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            return None
        try:
            datetime.fromisoformat(trimmed.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("expected_updated_at must be a valid ISO-8601 timestamp.")
        return trimmed


class CitizenFollowupResponse(BaseModel):
    is_followed_up: bool


class NotificationReadResponse(BaseModel):
    id: str
    is_read: bool


class SlaRuleItem(BaseModel):
    category: str
    sla_hours: int
    reminder_before_hours: int
    level2_after_hours: int
    level3_after_hours: int
    updated_at: str


class ManualEscalationResponse(BaseModel):
    escalation_id: str
    complaint_id: str
    from_level: int
    to_level: int
    status: str


class PaginatedResponse(BaseModel):
    items: List[Any]
    page: int
    page_size: int
    total: int
    total_pages: int


class OfficerTimelineStage(BaseModel):
    id: str
    status: str
    stage_title: str
    public_description: Optional[str] = None
    created_at: str


class OfficerEscalationSummary(BaseModel):
    id: str
    from_level: int
    to_level: int
    status: str
    reason: str
    triggered_by: str
    created_at: str


class OfficerComplaintDetailResponse(BaseModel):
    """
    Strictly allow-listed officer view of a complaint.
    Explicitly omits citizen PII (citizen_id, name, phone, ward), internal_note,
    legacy notes, actor_id, and admin assignment audit records.
    """

    id: str
    complaint_reference: str
    title: str
    category: str
    description: str
    location: str
    ward: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    status: str
    priority: str
    department_id: Optional[str] = None
    department_name: Optional[str] = None
    assigned_officer_id: Optional[str] = None
    sla_deadline: Optional[str] = None
    created_at: str
    updated_at: str
    current_level: int = 0
    overdue_marked_at: Optional[str] = None
    signed_image_url: Optional[str] = None
    signed_completion_url: Optional[str] = None
    timeline: List[OfficerTimelineStage] = Field(default_factory=list)
    escalations: List[OfficerEscalationSummary] = Field(default_factory=list)


class OfficerComplaintListItem(BaseModel):
    """Strictly allow-listed officer list item; omits citizen PII and raw storage paths."""

    id: str
    complaint_reference: str
    title: str
    category: str
    ward: str
    status: str
    priority: str
    created_at: str
    sla_deadline: Optional[str] = None
    thumbnail_url: Optional[str] = None


class OfficerComplaintListResponse(BaseModel):
    items: List[OfficerComplaintListItem]
    page: int
    page_size: int
    total: int
    total_pages: int
