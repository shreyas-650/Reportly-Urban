"""
ReportlyUrban — Phase 9.2 AI Department Auto-Assignment Router
"""

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response, status

from app.schemas.department_routing import (
    AdminComplaintDepartmentRoutingResponse,
    AdminDepartmentRoutingOverviewResponse,
    AdminMappingResponse,
    AdminMappingUpsertRequest,
    AdminRefreshMetricsResponse,
    CitizenDepartmentRoutingTriggerResponse,
)
from app.schemas.sla import parse_uuid_param, reject_extra_query_params
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen
from app.services.department_routing_service import (
    get_admin_complaint_department_routing,
    get_admin_department_routing_overview,
    refresh_admin_accuracy_metrics,
    schedule_department_routing,
    upsert_admin_category_department_mapping,
)

admin_router = APIRouter(
    prefix="/api/admin", tags=["Admin Department Routing (Phase 9.2)"]
)
citizen_router = APIRouter(
    prefix="/api/citizen/complaints", tags=["Citizen Department Routing (Phase 9.2)"]
)


@citizen_router.post(
    "/{complaint_id}/department-routing",
    response_model=CitizenDepartmentRoutingTriggerResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_citizen_department_routing_endpoint(
    complaint_id: str,
    background_tasks: BackgroundTasks,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await schedule_department_routing(background_tasks, actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/complaints/{complaint_id}/department-routing",
    response_model=AdminComplaintDepartmentRoutingResponse,
)
async def get_admin_complaint_department_routing_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_admin_complaint_department_routing(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.get(
    "/department-routing/overview",
    response_model=AdminDepartmentRoutingOverviewResponse,
)
async def get_admin_department_routing_overview_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    data = await get_admin_department_routing_overview(actor)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/department-routing/mappings",
    response_model=AdminMappingResponse,
)
async def upsert_admin_category_department_mapping_endpoint(
    payload: AdminMappingUpsertRequest,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    data = await upsert_admin_category_department_mapping(actor, payload)
    response.headers["Cache-Control"] = "no-store"
    return data


@admin_router.post(
    "/department-routing/refresh-metrics",
    response_model=AdminRefreshMetricsResponse,
)
async def refresh_admin_accuracy_metrics_endpoint(
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_admin),
):
    reject_extra_query_params(request, frozenset())
    data = await refresh_admin_accuracy_metrics(actor)
    response.headers["Cache-Control"] = "no-store"
    return data
