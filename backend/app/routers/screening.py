"""
ReportlyUrban — Phase 9.5 Suspicious / False Claim Screening & Workflow Advancement Router
"""

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Query, Request, Response, status

from app.schemas.screening import (
    AdminComplaintScreeningResponse,
    AdminScreeningActionRequest,
    AdminScreeningDecisionResponse,
    AdminScreeningQueueResponse,
    CitizenScreeningTriggerResponse,
)
from app.schemas.sla import parse_uuid_param, reject_extra_query_params
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen
from app.services.screening_service import (
    admin_decide_complaint_screening_action,
    get_admin_complaint_screening_details,
    list_admin_screening_queue_items,
    schedule_citizen_screening_check,
)

admin_router = APIRouter(
    prefix="/api/admin", tags=["Admin Screening & Workflow (Phase 9.5)"]
)
citizen_router = APIRouter(
    prefix="/api/citizen/complaints", tags=["Citizen Screening Trigger (Phase 9.5)"]
)


@citizen_router.post(
    "/{complaint_id}/screening-check",
    response_model=CitizenScreeningTriggerResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_citizen_screening_endpoint(
    complaint_id: str,
    background_tasks: BackgroundTasks,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await schedule_citizen_screening_check(background_tasks, actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/screening",
    response_model=AdminScreeningQueueResponse,
)
async def list_admin_screening_endpoint(
    request: Request,
    response: Response,
    filter_status: str = Query(default="needs_review", alias="status"),
    page: int = Query(default=1, ge=1, le=500),
    page_size: int = Query(default=20, ge=1, le=100),
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset({"status", "page", "page_size"}))
    data = await list_admin_screening_queue_items(
        actor, filter_by=filter_status, page=page, page_size=page_size
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/complaints/{complaint_id}/screening",
    response_model=AdminComplaintScreeningResponse,
)
async def get_admin_complaint_screening_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_admin_complaint_screening_details(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/complaints/{complaint_id}/screening/dismiss",
    response_model=AdminScreeningDecisionResponse,
)
async def dismiss_complaint_screening_endpoint(
    complaint_id: str,
    response: Response,
    payload: AdminScreeningActionRequest = Body(default_factory=AdminScreeningActionRequest),
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await admin_decide_complaint_screening_action(
        actor, clean_id, decision="dismiss", reason=payload.reason
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/complaints/{complaint_id}/screening/confirm",
    response_model=AdminScreeningDecisionResponse,
)
async def confirm_complaint_screening_endpoint(
    complaint_id: str,
    response: Response,
    payload: AdminScreeningActionRequest = Body(default_factory=AdminScreeningActionRequest),
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await admin_decide_complaint_screening_action(
        actor, clean_id, decision="confirmed_suspicious", reason=payload.reason
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/complaints/{complaint_id}/screening/keep-advancement",
    response_model=AdminScreeningDecisionResponse,
)
async def keep_screening_advancement_endpoint(
    complaint_id: str,
    response: Response,
    payload: AdminScreeningActionRequest = Body(default_factory=AdminScreeningActionRequest),
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await admin_decide_complaint_screening_action(
        actor, clean_id, decision="keep_advancement", reason=payload.reason
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/complaints/{complaint_id}/screening/revert-advancement",
    response_model=AdminScreeningDecisionResponse,
)
async def revert_screening_advancement_endpoint(
    complaint_id: str,
    payload: AdminScreeningActionRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await admin_decide_complaint_screening_action(
        actor, clean_id, decision="revert_advancement", reason=payload.reason
    )
    response.headers["Cache-Control"] = "no-store"
    return data
