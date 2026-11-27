"""
ReportlyUrban — Phase 9.3 AI Officer Auto-Assignment Router
"""

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response, status

from app.schemas.officer_routing import (
    AdminComplaintOfficerRoutingResponse,
    AdminOfficerRoutingOverviewResponse,
    AdminOfficerRoutingTriggerResponse,
    CitizenOfficerRoutingTriggerResponse,
)
from app.schemas.sla import parse_uuid_param, reject_extra_query_params
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen
from app.services.officer_routing_service import (
    get_admin_complaint_officer_routing,
    get_admin_officer_routing_overview,
    schedule_citizen_officer_routing,
    trigger_admin_officer_routing,
)

admin_router = APIRouter(
    prefix="/api/admin", tags=["Admin Officer Routing (Phase 9.3)"]
)
citizen_router = APIRouter(
    prefix="/api/citizen/complaints", tags=["Citizen Officer Routing (Phase 9.3)"]
)


@citizen_router.post(
    "/{complaint_id}/officer-routing",
    response_model=CitizenOfficerRoutingTriggerResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_citizen_officer_routing_endpoint(
    complaint_id: str,
    background_tasks: BackgroundTasks,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await schedule_citizen_officer_routing(background_tasks, actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/complaints/{complaint_id}/officer-routing",
    response_model=AdminOfficerRoutingTriggerResponse,
)
async def trigger_admin_officer_routing_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await trigger_admin_officer_routing(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/complaints/{complaint_id}/officer-routing",
    response_model=AdminComplaintOfficerRoutingResponse,
)
async def get_admin_complaint_officer_routing_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_admin_complaint_officer_routing(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/officer-routing/overview",
    response_model=AdminOfficerRoutingOverviewResponse,
)
async def get_admin_officer_routing_overview_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    data = await get_admin_officer_routing_overview(actor)
    response.headers["Cache-Control"] = "no-store"
    return data
