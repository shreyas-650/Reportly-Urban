"""
ReportlyUrban — Phase 9.6 AI Accuracy Dashboard, Ward Fairness & Review Appeals Schemas
"""

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator

VALID_DASHBOARD_WINDOWS = ("7d", "30d", "90d", "all")
VALID_APPEAL_FILTERS = ("open", "needs_more_info", "released", "upheld", "reviewed", "all")
VALID_APPEAL_OUTCOMES = ("upheld", "released", "needs_more_info", "reviewed")


class CitizenAppealStatusResponse(BaseModel):
    """Amendment G: strict neutral status payload with zero AI/flag info."""

    model_config = ConfigDict(extra="forbid")

    eligible: bool
    has_open_appeal: bool
    appeal_status: Literal["none", "open", "reviewed"]


class CitizenAppealSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    appeal_text: str = Field(..., min_length=10, max_length=500)

    @field_validator("appeal_text")
    @classmethod
    def normalize_appeal_text(cls, value: str) -> str:
        cleaned = value.strip()
        if len(cleaned) < 10:
            raise ValueError("Review request explanation must be at least 10 characters.")
        if len(cleaned) > 500:
            raise ValueError("Review request explanation cannot exceed 500 characters.")
        return cleaned


class CitizenAppealSubmitResponse(BaseModel):
    """Amendment G: strictly neutral acknowledgement."""

    model_config = ConfigDict(extra="forbid")

    submitted: bool
    status: Literal["open"]


class AccuracyFeatureCard(BaseModel):
    feature: str
    label: str
    sample_size: int
    agreed_count: int
    disagreed_count: int
    excluded_count: int
    enough_data: bool
    agreement_rate: Optional[float] = None
    override_rate: Optional[float] = None
    disagreement_rate: Optional[float] = None
    false_positive_rate: Optional[float] = None
    rejected_count: Optional[int] = None
    rejection_rate: Optional[float] = None
    corrected_decisions_count: Optional[int] = None


class AdminAccuracyDashboardResponse(BaseModel):
    window: str
    date_from: str
    date_to: str
    min_samples: int
    plain_review_appeals_count: int
    cards: List[AccuracyFeatureCard] = Field(default_factory=list)


class WardFairnessItem(BaseModel):
    ward: str
    is_other: bool
    sample_size: int
    agreed_count: int
    agreement_rate: float
    disparity_vs_overall: Optional[float] = None


class AdminWardFairnessResponse(BaseModel):
    scope: str
    fixed_window: str
    ward_min_samples: int
    fairness_notice: str
    displayed_sample_total: int
    displayed_overall_rate: Optional[float] = None
    enough_data: bool
    wards: List[WardFairnessItem] = Field(default_factory=list)


class AdminAppealQueueItem(BaseModel):
    appeal_id: str
    complaint_id: str
    complaint_number: str
    complaint_title: str
    complaint_category: str
    complaint_ward: str
    complaint_status: str
    appeal_text: str
    appeal_status: str
    had_active_flag: bool
    screening_review_id: Optional[str] = None
    screening_version: Optional[str] = None
    risk_level: Optional[str] = None
    reason_codes: Optional[List[str]] = None
    review_status: Optional[str] = None
    latest_decision_id: Optional[str] = None
    latest_outcome: Optional[str] = None
    latest_reason: Optional[str] = None
    latest_is_correction: Optional[bool] = None
    latest_decided_at: Optional[str] = None
    created_at: str


class AdminAppealsListResponse(BaseModel):
    appeal_feature_enabled: bool
    backend_flag_enabled: bool
    items: List[AdminAppealQueueItem] = Field(default_factory=list)
    total: int
    page: int
    page_size: int
    total_pages: int


class AdminAppealDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outcome: Literal["upheld", "released", "needs_more_info", "reviewed"]
    reason: Optional[str] = Field(default=None, max_length=500)
    is_correction: bool = False


class AdminAppealDecisionResponse(BaseModel):
    success: bool
    appeal_id: str
    decision_id: str
    complaint_id: str
    outcome: str
    is_ai_held: bool
    is_correction: bool
    complaint_status: str
    decided_at: str


class AdminAppealFeatureToggleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_enabled: bool


class AdminAppealFeatureToggleResponse(BaseModel):
    feature_key: str
    is_enabled: bool
    updated_at: str
