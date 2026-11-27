"""
ReportlyUrban — Phase 10 Citizen Rewards, Badges, Challenges & Leaderboards Schemas
"""

from datetime import datetime
import re
from typing import List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator


class RewardBadgeItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    badge_code: str
    title: str
    description: str
    badge_kind: Literal["milestone", "challenge"]
    earned_at: str


class CitizenRewardLedgerItem(BaseModel):
    """Strictly neutral ledger item (Amendment P: zero internal flag/hold/reason details)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    complaint_number: Optional[str] = None
    points_delta: int
    summary_label: str
    created_at: str


class CommunityChallengeItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    description: str
    target_ward: Optional[str] = None
    target_category: Optional[str] = None
    required_verified_reports: int
    bonus_points: int
    badge_code: str
    starts_at: str
    ends_at: str
    progress_count: int = 0
    completed: bool = False


class CitizenRewardsSummaryResponse(BaseModel):
    """Amendment P: strictly citizen-safe summary with zero evaluation/hold/screening fields."""

    model_config = ConfigDict(extra="forbid")

    feature_enabled: bool
    anonymous_handle: Optional[str] = None
    total_points: int = 0
    verified_reports_count: int = 0
    daily_points_used: int = 0
    daily_points_limit: int = 150
    daily_awards_used: int = 0
    daily_awards_limit: int = 3
    weekly_points_used: int = 0
    weekly_points_limit: int = 500
    weekly_awards_used: int = 0
    weekly_awards_limit: int = 10
    badges: List[RewardBadgeItem] = Field(default_factory=list)
    recent_ledger: List[CitizenRewardLedgerItem] = Field(default_factory=list)
    active_challenges: List[CommunityChallengeItem] = Field(default_factory=list)


class LeaderboardEntryItem(BaseModel):
    """Amendment N: pseudonymous random handle only, never PII or derived handle."""

    model_config = ConfigDict(extra="forbid")

    rank: int
    anonymous_handle: str
    points: int
    verified_reports_count: int
    is_self: bool = False


class CitizenRewardsLeaderboardResponse(BaseModel):
    """Decision 3 & Amendment N: one fixed window, no residual/other/total when suppressed."""

    model_config = ConfigDict(extra="forbid")

    feature_enabled: bool
    window: Literal["all_time"] = "all_time"
    scope: Literal["citywide", "ward"] = "citywide"
    ward: Optional[str] = None
    min_group_size: int = 20
    enough_data: bool = False
    entries: List[LeaderboardEntryItem] = Field(default_factory=list)
    available_wards: List[str] = Field(default_factory=list)


class AdminRewardsSettingsToggleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_enabled: bool


class AdminRewardsSettingsToggleResponse(BaseModel):
    feature_enabled: bool
    first_enabled_at: Optional[str] = None
    updated_at: Optional[str] = None


class AdminCreateChallengeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(..., min_length=3, max_length=120)
    description: str = Field(..., min_length=10, max_length=500)
    badge_code: str = Field(..., min_length=3, max_length=64)
    badge_title: str = Field(..., min_length=3, max_length=80)
    badge_description: str = Field(..., min_length=5, max_length=240)
    required_verified_reports: int = Field(..., ge=1, le=100)
    bonus_points: int = Field(..., ge=5, le=200)
    starts_at: datetime
    ends_at: datetime
    target_ward: Optional[str] = Field(default=None, max_length=100)
    target_category: Optional[
        Literal[
            "potholes",
            "garbage",
            "streetlights",
            "water_leakage",
            "drainage",
            "public_infrastructure",
        ]
    ] = None

    @field_validator("badge_code")
    @classmethod
    def validate_badge_code(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9_]{3,64}", cleaned):
            raise ValueError("badge_code must match ^[a-z0-9_]{3,64}$.")
        return cleaned

    @field_validator("title", "description", "badge_title", "badge_description")
    @classmethod
    def validate_non_blank(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Field cannot be blank.")
        return cleaned

    @field_validator("ends_at")
    @classmethod
    def validate_dates(cls, ends_at: datetime, info) -> datetime:
        starts_at = info.data.get("starts_at")
        if starts_at is not None and ends_at <= starts_at:
            raise ValueError("ends_at must be strictly after starts_at.")
        return ends_at


class AdminCreateChallengeResponse(BaseModel):
    id: str
    title: str
    badge_code: str
    required_verified_reports: int
    bonus_points: int
    target_ward: Optional[str] = None
    target_category: Optional[str] = None
    starts_at: str
    ends_at: str
    is_active: bool


class AdminAdjustRewardsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    citizen_id: str
    points_delta: int = Field(..., ge=-500, le=500)
    reason: str = Field(..., min_length=5, max_length=300)
    complaint_id: Optional[str] = None

    @field_validator("points_delta")
    @classmethod
    def non_zero_delta(cls, value: int) -> int:
        if value == 0:
            raise ValueError("points_delta must be non-zero.")
        return value

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, value: str) -> str:
        cleaned = value.strip()
        if len(cleaned) < 5:
            raise ValueError("reason must be at least 5 characters.")
        return cleaned


class AdminAdjustRewardsResponse(BaseModel):
    ledger_id: str
    citizen_id: str
    anonymous_handle: str
    points_delta: int
    new_total_points: int


class AdminRewardEvaluationItem(BaseModel):
    id: str
    complaint_id: Optional[str] = None
    complaint_number: Optional[str] = None
    citizen_id: Optional[str] = None
    source_table: str
    outcome: str
    points_delta: int
    detail: Optional[str] = None
    created_at: str


class AdminChallengeListItem(BaseModel):
    id: str
    title: str
    description: str
    target_ward: Optional[str] = None
    target_category: Optional[str] = None
    required_verified_reports: int
    bonus_points: int
    badge_code: str
    starts_at: str
    ends_at: str
    is_active: bool
    created_at: str


class AdminRewardsAuditSummary(BaseModel):
    total_points_awarded: int = 0
    total_points_reversed: int = 0
    pending_holds_logged: int = 0
    cap_skips_logged: int = 0
    trigger_failures_logged: int = 0


class AdminRewardsAuditResponse(BaseModel):
    feature_enabled: bool
    backend_flag_enabled: bool
    first_enabled_at: Optional[str] = None
    settings_updated_at: Optional[str] = None
    summary: AdminRewardsAuditSummary
    evaluations: List[AdminRewardEvaluationItem] = Field(default_factory=list)
    challenges: List[AdminChallengeListItem] = Field(default_factory=list)
