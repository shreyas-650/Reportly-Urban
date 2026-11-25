"""
ReportlyUrban — Phase 7.3 Admin Escalation, SLA Management & Notifications Router
All routes enforce Supabase ES256 JWT + authoritative public.profiles admin role verification.
"""

from fastapi import APIRouter, BackgroundTasks, Body, Depends, File, HTTPException, Request, Response, UploadFile, status

from app.schemas.ai_resolution import AiResolutionCheckResponse, AiResolutionRerunRequest
from app.schemas.verification import AdminVerificationHistoryResponse

from app.schemas.resolution import (
    RegisterResolutionPhotoRequest,
    ResolutionPhotoUploadResponse,
    ResolveComplaintRequest,
    ResolveComplaintResponse,
)
from app.schemas.sla import (
    ManualEscalationRequest,
    ManualEscalationResponse,
    NotificationReadResponse,
    SlaRuleItem,
    UpdateSlaRuleRequest,
    VALID_ESCALATION_STATUSES,
    VALID_NOTIFICATION_KINDS,
    parse_uuid_param,
    reject_extra_query_params,
    validate_bounded_pagination,
    validate_optional_bool,
    validate_optional_date,
    validate_optional_ward,
    validate_sla_category,
)
from app.services.auth_service import AuthenticatedActor, require_admin
from app.services.phase7_service import (
    get_admin_complaint_escalations,
    list_actor_notifications,
    list_admin_escalations,
    list_admin_sla_rules,
    mark_actor_notification_read,
    trigger_manual_escalation,
    update_admin_sla_rule,
)
from app.services.resolution_service import (
    handle_resolution_photo_upload,
    resolve_complaint_with_verified_photo,
    retry_register_resolution_photo,
)
from app.services.ai_resolution_service import (
    get_admin_ai_resolution_checks,
    rerun_admin_ai_resolution_check,
    schedule_post_resolve_ai_check,
)
from app.services.verification_service import get_admin_verification_history

router = APIRouter(prefix="/api/admin", tags=["Admin SLA & Escalations"])


@router.get("/escalations")
async def get_admin_escalations_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(
        request,
        frozenset({"level", "status", "department_id", "ward", "date_from", "date_to", "page", "page_size"}),
    )

    raw_level = request.query_params.get("level")
    level = None
    if raw_level is not None and raw_level.strip() != "":
        try:
            level = int(raw_level)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid escalation level filter.")
        if level not in (1, 2, 3):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Escalation level must be 1, 2, or 3.")

    raw_status = request.query_params.get("status")
    esc_status = None
    if raw_status is not None and raw_status.strip() != "":
        esc_status = raw_status.strip().lower()
        if esc_status not in VALID_ESCALATION_STATUSES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid escalation status filter.")

    raw_dept = request.query_params.get("department_id")
    department_id = (
        parse_uuid_param(raw_dept, "department_id")
        if raw_dept is not None and raw_dept.strip() != ""
        else None
    )

    ward = validate_optional_ward(request.query_params.get("ward"))
    date_from = validate_optional_date(request.query_params.get("date_from"), "date_from")
    date_to = validate_optional_date(request.query_params.get("date_to"), "date_to")
    if date_from and date_to and date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="date_from cannot be after date_to.",
        )

    page, page_size = validate_bounded_pagination(
        request.query_params.get("page"),
        request.query_params.get("page_size"),
        default_size=20,
        max_size=100,
    )

    data = await list_admin_escalations(
        actor.token,
        level=level,
        esc_status=esc_status,
        department_id=department_id,
        ward=ward,
        date_from=date_from,
        date_to=date_to,
        page=page,
        page_size=page_size,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@router.get("/complaints/{complaint_id}/escalations")
async def get_complaint_escalation_history_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_admin_complaint_escalations(actor.token, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.post("/complaints/{complaint_id}/escalate", response_model=ManualEscalationResponse)
async def escalate_complaint_manual_endpoint(
    complaint_id: str,
    payload: ManualEscalationRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await trigger_manual_escalation(actor.token, clean_id, payload)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.get("/sla-rules")
async def get_admin_sla_rules_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    rules = await list_admin_sla_rules(actor.token)
    response.headers["Cache-Control"] = "no-store"
    return {"items": rules}


@router.put("/sla-rules/{category}", response_model=SlaRuleItem)
async def update_admin_sla_rule_endpoint(
    category: str,
    payload: UpdateSlaRuleRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_category = validate_sla_category(category)
    updated = await update_admin_sla_rule(actor.token, clean_category, payload)
    response.headers["Cache-Control"] = "no-store"
    return updated


@router.get("/notifications")
async def get_admin_notifications_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
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
        include_reminder_kind=False,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@router.post("/notifications/{notification_id}/read", response_model=NotificationReadResponse)
async def mark_admin_notification_read_endpoint(
    notification_id: str,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(notification_id, "notification_id")
    data = await mark_actor_notification_read(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.post(
    "/complaints/{complaint_id}/resolution-photo",
    response_model=ResolutionPhotoUploadResponse,
)
async def upload_admin_resolution_photo_endpoint(
    complaint_id: str,
    response: Response,
    file: UploadFile = File(...),
    actor: AuthenticatedActor = Depends(require_admin),
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
async def register_admin_resolution_photo_endpoint(
    complaint_id: str,
    payload: RegisterResolutionPhotoRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await retry_register_resolution_photo(actor, clean_id, payload)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.post(
    "/complaints/{complaint_id}/resolve",
    response_model=ResolveComplaintResponse,
)
async def resolve_admin_complaint_endpoint(
    complaint_id: str,
    payload: ResolveComplaintRequest,
    background_tasks: BackgroundTasks,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await resolve_complaint_with_verified_photo(
        actor, clean_id, payload, allow_internal_note=True
    )
    schedule_post_resolve_ai_check(background_tasks, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.get(
    "/complaints/{complaint_id}/ai-resolution-check",
    response_model=AiResolutionCheckResponse,
)
async def get_admin_ai_resolution_check_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_admin_ai_resolution_checks(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.post(
    "/complaints/{complaint_id}/ai-resolution-check/rerun",
    response_model=AiResolutionCheckResponse,
)
async def rerun_admin_ai_resolution_check_endpoint(
    complaint_id: str,
    response: Response,
    payload: AiResolutionRerunRequest = Body(default_factory=AiResolutionRerunRequest),
    actor: AuthenticatedActor = Depends(require_admin),
):
    _ = payload  # Validated with extra='forbid'; no client-controlled values used
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await rerun_admin_ai_resolution_check(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@router.get(
    "/complaints/{complaint_id}/verifications",
    response_model=AdminVerificationHistoryResponse,
)
async def get_admin_complaint_verifications_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_admin_verification_history(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data
