"""
ReportlyUrban — Phase 7.3 Officer Reminders, Escalations & Notifications Router
All routes enforce Supabase ES256 JWT + active officer role verification from
public.profiles and public.officers, scoped strictly to the authenticated officer.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Request, Response, UploadFile, status

from app.schemas.resolution import (
    RegisterResolutionPhotoRequest,
    ResolutionPhotoUploadResponse,
    ResolveComplaintRequest,
    ResolveComplaintResponse,
)
from app.schemas.sla import (
    NotificationReadResponse,
    OfficerComplaintDetailResponse,
    OfficerComplaintListResponse,
    VALID_COMPLAINT_STATUSES,
    VALID_NOTIFICATION_KINDS,
    VALID_REMINDER_KINDS,
    parse_uuid_param,
    reject_extra_query_params,
    validate_bounded_pagination,
    validate_optional_bool,
)
from app.services.auth_service import AuthenticatedActor, require_active_officer
from app.services.phase7_service import (
    get_officer_complaint_detail,
    list_actor_notifications,
    list_officer_complaints,
    list_officer_escalations,
    list_officer_reminders,
    mark_actor_notification_read,
)
from app.services.resolution_service import (
    handle_resolution_photo_upload,
    resolve_complaint_with_verified_photo,
    retry_register_resolution_photo,
)
from app.services.ai_resolution_service import schedule_post_resolve_ai_check

router = APIRouter(prefix="/api/officer", tags=["Officer Reminders & Notifications"])


@router.get("/reminders")
async def get_officer_reminders_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    reject_extra_query_params(request, frozenset({"kind", "page", "page_size"}))

    raw_kind = request.query_params.get("kind")
    kind = None
    if raw_kind is not None and raw_kind.strip() != "":
        kind = raw_kind.strip().lower()
        if kind not in VALID_REMINDER_KINDS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid reminder kind filter.",
            )

    page, page_size = validate_bounded_pagination(
        request.query_params.get("page"),
        request.query_params.get("page_size"),
        default_size=20,
        max_size=100,
    )

    data = await list_officer_reminders(actor, kind=kind, page=page, page_size=page_size)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.get("/escalations")
async def get_officer_escalations_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    reject_extra_query_params(request, frozenset({"page", "page_size"}))
    page, page_size = validate_bounded_pagination(
        request.query_params.get("page"),
        request.query_params.get("page_size"),
        default_size=20,
        max_size=100,
    )
    data = await list_officer_escalations(actor, page=page, page_size=page_size)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.get("/notifications")
async def get_officer_notifications_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    reject_extra_query_params(
        request, frozenset({"unread_only", "kind", "page", "page_size"})
    )
    unread_only = validate_optional_bool(request.query_params.get("unread_only"), "unread_only")
    raw_kind = request.query_params.get("kind")
    kind = None
    if raw_kind is not None and raw_kind.strip() != "":
        kind = raw_kind.strip().lower()
        if kind not in VALID_NOTIFICATION_KINDS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid notification kind filter.",
            )

    page, page_size = validate_bounded_pagination(
        request.query_params.get("page"),
        request.query_params.get("page_size"),
        default_size=20,
        max_size=100,
    )

    data = await list_actor_notifications(
        actor,
        unread_only=unread_only,
        kind=kind,
        page=page,
        page_size=page_size,
        include_reminder_kind=True,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@router.post("/notifications/{notification_id}/read", response_model=NotificationReadResponse)
async def mark_officer_notification_read_endpoint(
    notification_id: str,
    response: Response,
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    clean_id = parse_uuid_param(notification_id, "notification_id")
    data = await mark_actor_notification_read(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.get("/complaints", response_model=OfficerComplaintListResponse)
async def get_officer_complaints_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    reject_extra_query_params(request, frozenset({"status", "page", "page_size"}))

    raw_status = request.query_params.get("status")
    complaint_status = None
    if raw_status is not None and raw_status.strip() != "":
        complaint_status = raw_status.strip().lower()
        if complaint_status not in VALID_COMPLAINT_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid status filter.",
            )

    page, page_size = validate_bounded_pagination(
        request.query_params.get("page"),
        request.query_params.get("page_size"),
        default_size=20,
        max_size=100,
    )

    data = await list_officer_complaints(
        actor,
        complaint_status=complaint_status,
        page=page,
        page_size=page_size,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@router.get("/complaints/{complaint_id}", response_model=OfficerComplaintDetailResponse)
async def get_officer_complaint_detail_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_officer_complaint_detail(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.post(
    "/complaints/{complaint_id}/resolution-photo",
    response_model=ResolutionPhotoUploadResponse,
)
async def upload_officer_resolution_photo_endpoint(
    complaint_id: str,
    response: Response,
    file: UploadFile = File(...),
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    result = await handle_resolution_photo_upload(actor, clean_id, file)
    if isinstance(result, dict):
        response.headers["Cache-Control"] = "no-store"
    return result


@router.post(
    "/complaints/{complaint_id}/resolution-photo/register",
    response_model=ResolutionPhotoUploadResponse,
)
async def register_officer_resolution_photo_endpoint(
    complaint_id: str,
    payload: RegisterResolutionPhotoRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await retry_register_resolution_photo(actor, clean_id, payload)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.post(
    "/complaints/{complaint_id}/resolve",
    response_model=ResolveComplaintResponse,
)
async def resolve_officer_complaint_endpoint(
    complaint_id: str,
    payload: ResolveComplaintRequest,
    background_tasks: BackgroundTasks,
    response: Response,
    actor: AuthenticatedActor = Depends(require_active_officer),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await resolve_complaint_with_verified_photo(
        actor, clean_id, payload, allow_internal_note=False
    )
    schedule_post_resolve_ai_check(background_tasks, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data
