"""
ReportlyUrban — Phase 10 Citizen Rewards, Badges, Challenges & Leaderboards Router
"""

from typing import Optional
from fastapi import APIRouter, Depends, Query, Request, Response, status

from app.schemas.rewards import (
    AdminAdjustRewardsRequest,
    AdminAdjustRewardsResponse,
    AdminCreateChallengeRequest,
    AdminCreateChallengeResponse,
    AdminRewardsAuditResponse,
    AdminRewardsSettingsToggleRequest,
    AdminRewardsSettingsToggleResponse,
    CitizenRewardsLeaderboardResponse,
    CitizenRewardsSummaryResponse,
)
from app.schemas.sla import parse_uuid_param, reject_extra_query_params
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen
from app.services.rewards_service import (
    adjust_admin_citizen_rewards,
    create_admin_challenge,
    fetch_admin_rewards_audit,
    fetch_citizen_rewards_leaderboard,
    fetch_citizen_rewards_summary,
    toggle_admin_rewards_feature,
)

citizen_router = APIRouter(
    prefix="/api/citizen/rewards",
    tags=["Citizen Rewards (Phase 10)"],
)
admin_router = APIRouter(
    prefix="/api/admin/rewards",
    tags=["Admin Rewards & Challenges (Phase 10)"],
)


@citizen_router.get(
    "/summary",
    response_model=CitizenRewardsSummaryResponse,
)
async def get_citizen_rewards_summary_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    data = await fetch_citizen_rewards_summary(actor)
    response.headers["Cache-Control"] = "no-store"
    return data


@citizen_router.get(
    "/leaderboard",
    response_model=CitizenRewardsLeaderboardResponse,
)
async def get_citizen_rewards_leaderboard_endpoint(
    request: Request,
    response: Response,
    ward: Optional[str] = Query(default=None, max_length=100),
    limit: int = Query(default=25, ge=5, le=50),
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset({"ward", "limit"}))
    data = await fetch_citizen_rewards_leaderboard(actor, ward=ward, limit=limit)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/audit",
    response_model=AdminRewardsAuditResponse,
)
async def get_admin_rewards_audit_endpoint(
    request: Request,
    response: Response,
    outcome: Optional[str] = Query(default=None, max_length=64),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset({"outcome", "limit", "offset"}))
    data = await fetch_admin_rewards_audit(
        actor, outcome=outcome, limit=limit, offset=offset
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.put(
    "/settings",
    response_model=AdminRewardsSettingsToggleResponse,
)
async def toggle_admin_rewards_settings_endpoint(
    payload: AdminRewardsSettingsToggleRequest,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    data = await toggle_admin_rewards_feature(actor, payload.is_enabled)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/challenges",
    response_model=AdminCreateChallengeResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_admin_challenge_endpoint(
    payload: AdminCreateChallengeRequest,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    data = await create_admin_challenge(actor, payload)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/adjust",
    response_model=AdminAdjustRewardsResponse,
    status_code=status.HTTP_201_CREATED,
)
async def adjust_admin_citizen_rewards_endpoint(
    payload: AdminAdjustRewardsRequest,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    payload.citizen_id = parse_uuid_param(payload.citizen_id, "citizen_id")
    if payload.complaint_id is not None:
        payload.complaint_id = parse_uuid_param(payload.complaint_id, "complaint_id")
    data = await adjust_admin_citizen_rewards(actor, payload)
    response.headers["Cache-Control"] = "no-store"
    return data
