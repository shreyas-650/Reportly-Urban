"""
ReportlyUrban — Phase 9.4 Duplicate Detection Router
Admin-only endpoints to list suspected duplicate links and confirm/dismiss pairs,
plus a silent citizen post-create background trigger.
"""

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Request, Response, status

from app.schemas.duplicate_detection import (
    VALID_DUPLICATE_FILTERS,
    AdminComplaintDuplicatesResponse,
    AdminDuplicateDecisionRequest,
    AdminDuplicateDecisionResponse,
    AdminDuplicatesListResponse,
    CitizenDuplicateTriggerResponse,
)
from app.schemas.sla import parse_uuid_param, reject_extra_query_params, validate_bounded_pagination
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen
from app.services.duplicate_detection_service import (
    decide_admin_duplicate_link,
    get_admin_complaint_duplicates_list,
    list_admin_duplicates_queue,
    schedule_duplicate_detection_check,
)

admin_router = APIRouter(prefix="/api/admin", tags=["Admin Duplicate Detection (Phase 9.4)"])
citizen_router = APIRouter(prefix="/api/citizen/complaints", tags=["Citizen Duplicate Trigger (Phase 9.4)"])


@citizen_router.post(
    "/{complaint_id}/duplicate-check",
    response_model=CitizenDuplicateTriggerResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_citizen_duplicate_check_endpoint(
    complaint_id: str,
    background_tasks: BackgroundTasks,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await schedule_duplicate_detection_check(background_tasks, actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/complaints/{complaint_id}/duplicates",
    response_model=AdminComplaintDuplicatesResponse,
)
async def get_admin_complaint_duplicates_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_admin_complaint_duplicates_list(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/duplicates",
    response_model=AdminDuplicatesListResponse,
)
async def list_admin_duplicates_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset({"status", "page", "page_size"}))
    raw_status = request.query_params.get("status")
    clean_status = (raw_status or "suspected").strip().lower()
    if clean_status not in VALID_DUPLICATE_FILTERS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid duplicate status filter.",
        )

    page, page_size = validate_bounded_pagination(
        request.query_params.get("page"),
        request.query_params.get("page_size"),
        default_size=20,
        max_size=100,
    )

    data = await list_admin_duplicates_queue(
        actor,
        status_filter=clean_status,
        page=page,
        page_size=page_size,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/duplicates/{link_id}/confirm",
    response_model=AdminDuplicateDecisionResponse,
)
async def confirm_admin_duplicate_link_endpoint(
    link_id: str,
    response: Response,
    payload: AdminDuplicateDecisionRequest = Body(default_factory=AdminDuplicateDecisionRequest),
    actor: AuthenticatedActor = Depends(require_admin),
):
    _ = payload
    clean_link_id = parse_uuid_param(link_id, "link_id")
    data = await decide_admin_duplicate_link(
        actor, clean_link_id, decision="confirmed_duplicate"
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/duplicates/{link_id}/not-duplicate",
    response_model=AdminDuplicateDecisionResponse,
)
async def dismiss_admin_duplicate_link_endpoint(
    link_id: str,
    response: Response,
    payload: AdminDuplicateDecisionRequest = Body(default_factory=AdminDuplicateDecisionRequest),
    actor: AuthenticatedActor = Depends(require_admin),
):
    _ = payload
    clean_link_id = parse_uuid_param(link_id, "link_id")
    data = await decide_admin_duplicate_link(
        actor, clean_link_id, decision="not_duplicate"
    )
    response.headers["Cache-Control"] = "no-store"
    return data
