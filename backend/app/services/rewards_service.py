"""
ReportlyUrban — Phase 10 Citizen Rewards, Badges, Challenges & Leaderboards Service

All write paths fail loudly (Amendment A).
All citizen endpoints enforce REWARDS_FEATURE_ENABLED + DB phase10_rewards_settings (two-key default OFF)
and return strictly neutral/pseudonymous payloads (Amendments N, P).
"""

import logging
from typing import Any, Dict, Optional
from fastapi import HTTPException, status
import httpx

from app.config import settings
from app.schemas.rewards import (
    AdminAdjustRewardsRequest,
    AdminAdjustRewardsResponse,
    AdminChallengeListItem,
    AdminCreateChallengeRequest,
    AdminCreateChallengeResponse,
    AdminRewardEvaluationItem,
    AdminRewardsAuditResponse,
    AdminRewardsAuditSummary,
    AdminRewardsSettingsToggleResponse,
    CitizenRewardLedgerItem,
    CitizenRewardsLeaderboardResponse,
    CitizenRewardsSummaryResponse,
    CommunityChallengeItem,
    LeaderboardEntryItem,
    RewardBadgeItem,
)
from app.services.ai_intelligence_service import (
    call_postgrest_rpc,
    extract_postgrest_error_details,
)
from app.services.auth_service import AuthenticatedActor
from app.services.rate_limiter import InProcessSlidingWindowLimiter

logger = logging.getLogger("reportly.phase10.rewards")

_DB_TIMEOUT = httpx.Timeout(connect=10.0, read=12.0, write=10.0, pool=10.0)

citizen_rewards_limiter = InProcessSlidingWindowLimiter(
    limit_per_minute=30,
    window_seconds=60,
)


def is_rewards_feature_enabled() -> bool:
    """Fail-closed backend flag check (DB phase10_rewards_settings also enforces state)."""
    return settings.REWARDS_FEATURE_ENABLED is True


async def _call_user_rpc(
    rpc_name: str,
    payload: Dict[str, Any],
    *,
    actor: AuthenticatedActor,
    context_id: Optional[str] = None,
) -> httpx.Response:
    return await call_postgrest_rpc(
        rpc_name,
        payload,
        actor_token=actor.token,
        timeout=_DB_TIMEOUT,
        client_cls=httpx.AsyncClient,
        logger_obj=logger,
        context_id=context_id,
    )


def _raise_rpc_error(res: httpx.Response, *, fallback_msg: str) -> None:
    err = extract_postgrest_error_details(res)
    code = err["code"]
    msg = err["message"]
    if code == "42501" or res.status_code == 403:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied.",
        )
    if code == "P0002":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=msg or "Requested resource not found.",
        )
    if code in ("22023", "23514", "23505"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=msg or "Invalid rewards request parameter.",
        )
    if code == "P0001":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=msg or "Rewards operation could not be completed.",
        )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=fallback_msg,
    )


async def fetch_citizen_rewards_summary(
    actor: AuthenticatedActor,
) -> CitizenRewardsSummaryResponse:
    if not is_rewards_feature_enabled():
        return CitizenRewardsSummaryResponse(
            feature_enabled=False,
            daily_points_limit=settings.REWARDS_DAILY_MAX_POINTS,
            daily_awards_limit=settings.REWARDS_DAILY_MAX_AWARDS,
            weekly_points_limit=settings.REWARDS_WEEKLY_MAX_POINTS,
            weekly_awards_limit=settings.REWARDS_WEEKLY_MAX_AWARDS,
        )

    await citizen_rewards_limiter.check_and_record(actor.user_id)

    res = await _call_user_rpc(
        "get_citizen_rewards_summary",
        {
            "p_daily_max_points": settings.REWARDS_DAILY_MAX_POINTS,
            "p_daily_max_awards": settings.REWARDS_DAILY_MAX_AWARDS,
            "p_weekly_max_points": settings.REWARDS_WEEKLY_MAX_POINTS,
            "p_weekly_max_awards": settings.REWARDS_WEEKLY_MAX_AWARDS,
            "p_timezone": settings.REWARDS_TIMEZONE,
        },
        actor=actor,
        context_id=actor.user_id,
    )
    if res.status_code != 200:
        _raise_rpc_error(res, fallback_msg="Unable to load citizen rewards summary.")

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid citizen rewards summary response.",
        )

    if not bool(data.get("feature_enabled", False)):
        return CitizenRewardsSummaryResponse(
            feature_enabled=False,
            daily_points_limit=settings.REWARDS_DAILY_MAX_POINTS,
            daily_awards_limit=settings.REWARDS_DAILY_MAX_AWARDS,
            weekly_points_limit=settings.REWARDS_WEEKLY_MAX_POINTS,
            weekly_awards_limit=settings.REWARDS_WEEKLY_MAX_AWARDS,
        )

    badges = [
        RewardBadgeItem(
            badge_code=str(item.get("badge_code", "")),
            title=str(item.get("title", "")),
            description=str(item.get("description", "")),
            badge_kind=str(item.get("badge_kind", "milestone")),
            earned_at=str(item.get("earned_at", "")),
        )
        for item in (data.get("badges") or [])
        if isinstance(item, dict)
    ]

    ledger = [
        CitizenRewardLedgerItem(
            id=str(item.get("id", "")),
            complaint_number=item.get("complaint_number"),
            points_delta=int(item.get("points_delta") or 0),
            summary_label=str(item.get("summary_label", "")),
            created_at=str(item.get("created_at", "")),
        )
        for item in (data.get("recent_ledger") or [])
        if isinstance(item, dict)
    ]

    challenges = [
        CommunityChallengeItem(
            id=str(item.get("id", "")),
            title=str(item.get("title", "")),
            description=str(item.get("description", "")),
            target_ward=item.get("target_ward"),
            target_category=item.get("target_category"),
            required_verified_reports=int(item.get("required_verified_reports") or 1),
            bonus_points=int(item.get("bonus_points") or 0),
            badge_code=str(item.get("badge_code", "")),
            starts_at=str(item.get("starts_at", "")),
            ends_at=str(item.get("ends_at", "")),
            progress_count=int(item.get("progress_count") or 0),
            completed=bool(item.get("completed", False)),
        )
        for item in (data.get("active_challenges") or [])
        if isinstance(item, dict)
    ]

    return CitizenRewardsSummaryResponse(
        feature_enabled=True,
        anonymous_handle=data.get("anonymous_handle"),
        total_points=int(data.get("total_points") or 0),
        verified_reports_count=int(data.get("verified_reports_count") or 0),
        daily_points_used=int(data.get("daily_points_used") or 0),
        daily_points_limit=int(data.get("daily_points_limit") or settings.REWARDS_DAILY_MAX_POINTS),
        daily_awards_used=int(data.get("daily_awards_used") or 0),
        daily_awards_limit=int(data.get("daily_awards_limit") or settings.REWARDS_DAILY_MAX_AWARDS),
        weekly_points_used=int(data.get("weekly_points_used") or 0),
        weekly_points_limit=int(data.get("weekly_points_limit") or settings.REWARDS_WEEKLY_MAX_POINTS),
        weekly_awards_used=int(data.get("weekly_awards_used") or 0),
        weekly_awards_limit=int(data.get("weekly_awards_limit") or settings.REWARDS_WEEKLY_MAX_AWARDS),
        badges=badges,
        recent_ledger=ledger,
        active_challenges=challenges,
    )


async def fetch_citizen_rewards_leaderboard(
    actor: AuthenticatedActor,
    *,
    ward: Optional[str] = None,
    limit: int = 25,
) -> CitizenRewardsLeaderboardResponse:
    clean_ward = (ward or "").strip() or None
    min_group = max(5, settings.REWARDS_LEADERBOARD_MIN_GROUP_SIZE)

    if not is_rewards_feature_enabled():
        return CitizenRewardsLeaderboardResponse(
            feature_enabled=False,
            window="all_time",
            scope="ward" if clean_ward else "citywide",
            ward=clean_ward,
            min_group_size=min_group,
            enough_data=False,
            entries=[],
            available_wards=[],
        )

    await citizen_rewards_limiter.check_and_record(actor.user_id)

    res = await _call_user_rpc(
        "get_citizen_rewards_leaderboard",
        {
            "p_ward": clean_ward,
            "p_min_group_size": min_group,
            "p_limit": limit,
        },
        actor=actor,
        context_id=actor.user_id,
    )
    if res.status_code != 200:
        _raise_rpc_error(res, fallback_msg="Unable to load rewards leaderboard.")

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid rewards leaderboard response.",
        )

    entries = [
        LeaderboardEntryItem(
            rank=int(item.get("rank") or 0),
            anonymous_handle=str(item.get("anonymous_handle", "")),
            points=int(item.get("points") or 0),
            verified_reports_count=int(item.get("verified_reports_count") or 0),
            is_self=bool(item.get("is_self", False)),
        )
        for item in (data.get("entries") or [])
        if isinstance(item, dict)
    ]

    wards = [
        str(w)
        for w in (data.get("available_wards") or [])
        if isinstance(w, str) and w.strip()
    ]

    return CitizenRewardsLeaderboardResponse(
        feature_enabled=bool(data.get("feature_enabled", False)),
        window="all_time",
        scope="ward" if clean_ward else "citywide",
        ward=data.get("ward"),
        min_group_size=int(data.get("min_group_size") or min_group),
        enough_data=bool(data.get("enough_data", False)),
        entries=entries,
        available_wards=wards,
    )


async def fetch_admin_rewards_audit(
    actor: AuthenticatedActor,
    *,
    outcome: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> AdminRewardsAuditResponse:
    res = await _call_user_rpc(
        "admin_get_citizen_rewards_audit",
        {
            "p_outcome": (outcome or "").strip() or None,
            "p_limit": limit,
            "p_offset": offset,
        },
        actor=actor,
        context_id=actor.user_id,
    )
    if res.status_code != 200:
        _raise_rpc_error(res, fallback_msg="Unable to load rewards audit data.")

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid rewards audit response.",
        )

    raw_summary = data.get("summary") or {}
    evaluations = [
        AdminRewardEvaluationItem(
            id=str(item.get("id", "")),
            complaint_id=item.get("complaint_id"),
            complaint_number=item.get("complaint_number"),
            citizen_id=item.get("citizen_id"),
            source_table=str(item.get("source_table", "")),
            outcome=str(item.get("outcome", "")),
            points_delta=int(item.get("points_delta") or 0),
            detail=item.get("detail"),
            created_at=str(item.get("created_at", "")),
        )
        for item in (data.get("evaluations") or [])
        if isinstance(item, dict)
    ]

    challenges = [
        AdminChallengeListItem(
            id=str(item.get("id", "")),
            title=str(item.get("title", "")),
            description=str(item.get("description", "")),
            target_ward=item.get("target_ward"),
            target_category=item.get("target_category"),
            required_verified_reports=int(item.get("required_verified_reports") or 1),
            bonus_points=int(item.get("bonus_points") or 0),
            badge_code=str(item.get("badge_code", "")),
            starts_at=str(item.get("starts_at", "")),
            ends_at=str(item.get("ends_at", "")),
            is_active=bool(item.get("is_active", True)),
            created_at=str(item.get("created_at", "")),
        )
        for item in (data.get("challenges") or [])
        if isinstance(item, dict)
    ]

    return AdminRewardsAuditResponse(
        feature_enabled=bool(data.get("feature_enabled", False)),
        backend_flag_enabled=is_rewards_feature_enabled(),
        first_enabled_at=data.get("first_enabled_at"),
        settings_updated_at=data.get("settings_updated_at"),
        summary=AdminRewardsAuditSummary(
            total_points_awarded=int(raw_summary.get("total_points_awarded") or 0),
            total_points_reversed=int(raw_summary.get("total_points_reversed") or 0),
            pending_holds_logged=int(raw_summary.get("pending_holds_logged") or 0),
            cap_skips_logged=int(raw_summary.get("cap_skips_logged") or 0),
            trigger_failures_logged=int(raw_summary.get("trigger_failures_logged") or 0),
        ),
        evaluations=evaluations,
        challenges=challenges,
    )


async def toggle_admin_rewards_feature(
    actor: AuthenticatedActor,
    is_enabled: bool,
) -> AdminRewardsSettingsToggleResponse:
    res = await _call_user_rpc(
        "admin_set_rewards_feature_enabled",
        {"p_is_enabled": bool(is_enabled)},
        actor=actor,
        context_id=actor.user_id,
    )
    if res.status_code != 200:
        logger.warning(
            "rewards_toggle failed status=%s admin_id=%s",
            res.status_code,
            actor.user_id,
        )
        _raise_rpc_error(res, fallback_msg="Unable to update rewards feature setting.")

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid rewards toggle response.",
        )

    return AdminRewardsSettingsToggleResponse(
        feature_enabled=bool(data.get("feature_enabled", False)),
        first_enabled_at=data.get("first_enabled_at"),
        updated_at=data.get("updated_at"),
    )


async def create_admin_challenge(
    actor: AuthenticatedActor,
    payload: AdminCreateChallengeRequest,
) -> AdminCreateChallengeResponse:
    res = await _call_user_rpc(
        "create_admin_community_challenge",
        {
            "p_title": payload.title,
            "p_description": payload.description,
            "p_badge_code": payload.badge_code,
            "p_badge_title": payload.badge_title,
            "p_badge_description": payload.badge_description,
            "p_required_verified_reports": payload.required_verified_reports,
            "p_bonus_points": payload.bonus_points,
            "p_starts_at": payload.starts_at.isoformat(),
            "p_ends_at": payload.ends_at.isoformat(),
            "p_target_ward": (payload.target_ward or "").strip() or None,
            "p_target_category": payload.target_category,
        },
        actor=actor,
        context_id=actor.user_id,
    )
    if res.status_code != 200:
        logger.warning(
            "rewards_create_challenge failed status=%s admin_id=%s",
            res.status_code,
            actor.user_id,
        )
        _raise_rpc_error(res, fallback_msg="Unable to create community challenge.")

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid challenge creation response.",
        )

    return AdminCreateChallengeResponse(**data)


async def adjust_admin_citizen_rewards(
    actor: AuthenticatedActor,
    payload: AdminAdjustRewardsRequest,
) -> AdminAdjustRewardsResponse:
    res = await _call_user_rpc(
        "admin_adjust_citizen_rewards",
        {
            "p_citizen_id": payload.citizen_id,
            "p_points_delta": payload.points_delta,
            "p_reason": payload.reason,
            "p_complaint_id": payload.complaint_id,
        },
        actor=actor,
        context_id=payload.citizen_id,
    )
    if res.status_code != 200:
        logger.warning(
            "rewards_manual_adjust failed status=%s admin_id=%s",
            res.status_code,
            actor.user_id,
        )
        _raise_rpc_error(res, fallback_msg="Unable to adjust citizen rewards.")

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid rewards adjustment response.",
        )

    return AdminAdjustRewardsResponse(**data)
