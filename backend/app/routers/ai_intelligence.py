"""
ReportlyUrban — Phase 9.1 AI Complaint Intelligence Router (Shadow Mode)
Exposes admin-only category/priority suggestion review & accept/override endpoints,
plus a non-blocking citizen post-submit background trigger returning zero AI details.
"""

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Request, Response, status

from app.schemas.ai_intelligence import (
    AdminAiSuggestionAcceptRequest,
    AdminAiSuggestionDecisionResponse,
    AdminAiSuggestionIgnoreRequest,
    AdminAiSuggestionOverrideRequest,
    AdminAiSuggestionResponse,
    CitizenAiSuggestionTriggerResponse,
)
from app.schemas.sla import parse_uuid_param, reject_extra_query_params
from app.services.ai_intelligence_service import (
    decide_admin_ai_suggestion,
    get_admin_ai_suggestion,
    schedule_shadow_category_priority_suggestion,
)
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen

admin_router = APIRouter(
    prefix="/api/admin/complaints", tags=["Admin AI Intelligence (Phase 9.1)"]
)
citizen_router = APIRouter(
    prefix="/api/citizen/complaints", tags=["Citizen AI Shadow Trigger (Phase 9.1)"]
)


@citizen_router.post(
    "/{complaint_id}/ai-suggestions",
    response_model=CitizenAiSuggestionTriggerResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_citizen_shadow_ai_suggestion_endpoint(
    complaint_id: str,
    background_tasks: BackgroundTasks,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await schedule_shadow_category_priority_suggestion(
        background_tasks, actor, clean_id
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/{complaint_id}/ai-suggestions",
    response_model=AdminAiSuggestionResponse,
)
async def get_admin_ai_suggestions_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_admin_ai_suggestion(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/{complaint_id}/ai-suggestions/accept",
    response_model=AdminAiSuggestionDecisionResponse,
)
async def accept_admin_ai_suggestion_endpoint(
    complaint_id: str,
    response: Response,
    payload: AdminAiSuggestionAcceptRequest = Body(
        default_factory=AdminAiSuggestionAcceptRequest
    ),
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await decide_admin_ai_suggestion(
        actor,
        clean_id,
        decision="accepted",
        expected_updated_at=payload.expected_updated_at,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/{complaint_id}/ai-suggestions/override",
    response_model=AdminAiSuggestionDecisionResponse,
)
async def override_admin_ai_suggestion_endpoint(
    complaint_id: str,
    payload: AdminAiSuggestionOverrideRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await decide_admin_ai_suggestion(
        actor,
        clean_id,
        decision="overridden",
        final_category=payload.category,
        final_priority=payload.priority,
        expected_updated_at=payload.expected_updated_at,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/{complaint_id}/ai-suggestions/ignore",
    response_model=AdminAiSuggestionDecisionResponse,
)
async def ignore_admin_ai_suggestion_endpoint(
    complaint_id: str,
    response: Response,
    payload: AdminAiSuggestionIgnoreRequest = Body(
        default_factory=AdminAiSuggestionIgnoreRequest
    ),
    actor: AuthenticatedActor = Depends(require_admin),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await decide_admin_ai_suggestion(
        actor,
        clean_id,
        decision="ignored",
        expected_updated_at=payload.expected_updated_at,
    )
    response.headers["Cache-Control"] = "no-store"
    return data
