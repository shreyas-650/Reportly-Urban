"""
ReportlyUrban — Phase 9.6 AI Accuracy Dashboard, Ward Fairness & Review Appeals Router
"""

from typing import Optional
from fastapi import APIRouter, Depends, Query, Request, Response, status

from app.schemas.accuracy_appeals import (
    AdminAccuracyDashboardResponse,
    AdminAppealDecisionRequest,
    AdminAppealDecisionResponse,
    AdminAppealFeatureToggleRequest,
    AdminAppealFeatureToggleResponse,
    AdminAppealsListResponse,
    AdminWardFairnessResponse,
    CitizenAppealStatusResponse,
    CitizenAppealSubmitRequest,
    CitizenAppealSubmitResponse,
)
from app.schemas.sla import parse_uuid_param, reject_extra_query_params
from app.services.accuracy_appeals_service import (
    decide_admin_appeal,
    fetch_admin_accuracy_dashboard,
    fetch_admin_appeals_queue,
    fetch_admin_ward_fairness,
    get_citizen_appeal_status,
    submit_citizen_appeal,
    toggle_admin_appeal_feature,
)
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen

admin_router = APIRouter(
    prefix="/api/admin", tags=["Admin AI Accuracy & Appeals (Phase 9.6)"]
)
citizen_router = APIRouter(
    prefix="/api/citizen/complaints", tags=["Citizen Review Appeals (Phase 9.6)"]
)


@citizen_router.get(
    "/{complaint_id}/review-appeal/status",
    response_model=CitizenAppealStatusResponse,
)
async def get_citizen_appeal_status_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_citizen_appeal_status(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@citizen_router.post(
    "/{complaint_id}/review-appeal",
    response_model=CitizenAppealSubmitResponse,
    status_code=status.HTTP_201_CREATED,
)
async def submit_citizen_appeal_endpoint(
    complaint_id: str,
    payload: CitizenAppealSubmitRequest,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await submit_citizen_appeal(actor, clean_id, payload.appeal_text)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/ai-accuracy",
    response_model=AdminAccuracyDashboardResponse,
)
async def get_admin_ai_accuracy_endpoint(
    request: Request,
    response: Response,
    window: str = Query(default="30d"),
    min_samples: Optional[int] = Query(default=None, ge=5, le=1000),
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset({"window", "min_samples"}))
    data = await fetch_admin_accuracy_dashboard(
        actor, window=window, min_samples=min_samples
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/ai-accuracy/wards",
    response_model=AdminWardFairnessResponse,
)
async def get_admin_ward_fairness_endpoint(
    request: Request,
    response: Response,
    ward_min_samples: Optional[int] = Query(default=None, ge=5, le=1000),
    actor: AuthenticatedActor = Depends(require_admin),
):
    # Note: ONE fixed window only (Amendment C: no window filter permitted)
    reject_extra_query_params(request, frozenset({"ward_min_samples"}))
    data = await fetch_admin_ward_fairness(
        actor, ward_min_samples=ward_min_samples
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/appeals",
    response_model=AdminAppealsListResponse,
)
async def list_admin_appeals_endpoint(
    request: Request,
    response: Response,
    filter_status: str = Query(default="open", alias="status"),
    page: int = Query(default=1, ge=1, le=500),
    page_size: int = Query(default=20, ge=1, le=100),
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset({"status", "page", "page_size"}))
    data = await fetch_admin_appeals_queue(
        actor, status_filter=filter_status, page=page, page_size=page_size
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/appeals/{appeal_id}/decide",
    response_model=AdminAppealDecisionResponse,
)
async def decide_admin_appeal_endpoint(
    appeal_id: str,
    payload: AdminAppealDecisionRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(appeal_id, "appeal_id")
    data = await decide_admin_appeal(
        actor,
        clean_id,
        outcome=payload.outcome,
        reason=payload.reason,
        is_correction=payload.is_correction,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.put(
    "/appeals/settings",
    response_model=AdminAppealFeatureToggleResponse,
)
async def toggle_admin_appeal_setting_endpoint(
    payload: AdminAppealFeatureToggleRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    data = await toggle_admin_appeal_feature(actor, payload.is_enabled)
    response.headers["Cache-Control"] = "no-store"
    return data
