"""
ReportlyUrban — Phase 9.2 Department Auto-Assignment Service (Safety-First)
Evaluates accuracy gates, ward-aware DB mappings, and atomic assignment without
modifying or overwriting staff assignments. Failures never block complaints.
"""

import logging
import time
from typing import Any, Dict, List, Optional
from fastapi import BackgroundTasks, HTTPException, status
import httpx

from app.config import parse_department_routing_mode, settings
from app.schemas.department_routing import (
    AdminAccuracyMetricItem,
    AdminComplaintDepartmentRoutingResponse,
    AdminDepartmentEventItem,
    AdminDepartmentRoutingOverviewResponse,
    AdminMappingResponse,
    AdminMappingUpsertRequest,
    AdminRefreshMetricsResponse,
    AdminTriageQueueItem,
    CitizenDepartmentRoutingTriggerResponse,
)
from app.services.ai_intelligence_service import (
    _ensure_service_config,
    _service_headers,
    _user_headers,
    call_postgrest_rpc,
    extract_postgrest_error_details,
    verify_citizen_complaint_ownership,
)
from app.services.auth_service import AuthenticatedActor
from app.services.rate_limiter import InProcessSlidingWindowLimiter

logger = logging.getLogger("reportly.phase9_2.department_routing")

_DB_TIMEOUT = httpx.Timeout(connect=10.0, read=12.0, write=10.0, pool=10.0)

department_routing_user_limiter = InProcessSlidingWindowLimiter(
    limit_per_minute=30,
    window_seconds=60,
)


def get_department_routing_mode() -> str:
    return parse_department_routing_mode(settings.DEPARTMENT_AUTO_ASSIGN_MODE)


async def _call_rpc(
    rpc_name: str,
    payload: Dict[str, Any],
    *,
    actor_token: Optional[str] = None,
    context_id: Optional[str] = None,
) -> httpx.Response:
    return await call_postgrest_rpc(
        rpc_name,
        payload,
        actor_token=actor_token,
        timeout=_DB_TIMEOUT,
        client_cls=httpx.AsyncClient,
        logger_obj=logger,
        context_id=context_id,
    )


async def _evaluate_department_routing_rpc(complaint_id: str) -> Optional[Dict[str, Any]]:
    mode = get_department_routing_mode()
    if mode == "off":
        return {"mode": "off", "skipped": True, "applied": False}

    payload = {
        "p_complaint_id": complaint_id,
        "p_mode": mode,
        "p_min_samples": settings.DEPARTMENT_AUTO_ASSIGN_MIN_SAMPLES,
        "p_min_accuracy": settings.DEPARTMENT_AUTO_ASSIGN_MIN_ACCURACY,
        "p_metrics_max_age_days": settings.DEPARTMENT_AUTO_ASSIGN_METRICS_MAX_AGE_DAYS,
        "p_min_confidence": settings.DEPARTMENT_AUTO_ASSIGN_MIN_CONFIDENCE,
    }
    res = await _call_rpc(
        "evaluate_and_assign_department_ai",
        payload,
        context_id=complaint_id,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        raise RuntimeError(
            f"department_routing_rpc_failed: status={res.status_code} code={err['code']}"
        )
    data = res.json()
    return data if isinstance(data, dict) else None


async def run_background_department_routing(complaint_id: str) -> Optional[Dict[str, Any]]:
    """
    Runs Phase 9.2 evaluation/routing in background.
    Never raises, never blocks complaint submission, and never overwrites staff assignments.
    """
    started = time.monotonic()
    mode = get_department_routing_mode()
    if mode == "off":
        return {"mode": "off", "skipped": True, "applied": False}

    try:
        result = await _evaluate_department_routing_rpc(complaint_id)
        logger.info(
            "department_routing stage=complete complaint_id=%s mode=%s applied=%s reason=%s duration_ms=%d",
            complaint_id,
            (result or {}).get("mode", mode),
            (result or {}).get("applied", False),
            (result or {}).get("reason_code", "-"),
            int((time.monotonic() - started) * 1000),
        )
        return result
    except Exception:
        logger.exception(
            "department_routing stage=execute outcome=failed complaint_id=%s mode=%s",
            complaint_id,
            mode,
        )
        return None


async def schedule_department_routing(
    background_tasks: BackgroundTasks,
    actor: AuthenticatedActor,
    complaint_id: str,
) -> CitizenDepartmentRoutingTriggerResponse:
    """
    Verifies citizen ownership and queues idempotent Phase 9.2 routing.
    Returns strictly acceptance/mode metadata without leaking internal gate details.
    """
    await verify_citizen_complaint_ownership(actor, complaint_id)

    mode = get_department_routing_mode()
    if mode == "off":
        return CitizenDepartmentRoutingTriggerResponse(
            accepted=True, queued=False, mode="off"
        )

    try:
        await department_routing_user_limiter.check_and_record(actor.user_id)
    except HTTPException:
        logger.warning(
            "department_routing stage=trigger outcome=rate_limited complaint_id=%s",
            complaint_id,
        )
        return CitizenDepartmentRoutingTriggerResponse(
            accepted=True, queued=False, mode=mode
        )

    background_tasks.add_task(run_background_department_routing, complaint_id)
    return CitizenDepartmentRoutingTriggerResponse(
        accepted=True, queued=True, mode=mode
    )


async def _admin_rest_get(
    actor: AuthenticatedActor,
    table_name: str,
    params: List[tuple],
) -> List[Dict[str, Any]]:
    if not settings.SUPABASE_URL or not settings.SUPABASE_ANON_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase configuration unavailable.",
        )
    base_url = settings.SUPABASE_URL.strip().rstrip("/")
    async with httpx.AsyncClient(timeout=_DB_TIMEOUT) as client:
        res = await client.get(
            f"{base_url}/rest/v1/{table_name}",
            params=params,
            headers=_user_headers(actor.token),
        )
    if res.status_code not in (200, 206):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Unable to read {table_name}.",
        )
    data = res.json()
    return data if isinstance(data, list) else []


async def get_admin_complaint_department_routing(
    actor: AuthenticatedActor, complaint_id: str
) -> AdminComplaintDepartmentRoutingResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    triage_rows = await _admin_rest_get(
        actor,
        "complaint_department_triage_queue",
        [("complaint_id", f"eq.{complaint_id}"), ("limit", "1")],
    )
    event_rows = await _admin_rest_get(
        actor,
        "department_assignment_events",
        [
            ("complaint_id", f"eq.{complaint_id}"),
            ("order", "created_at.desc"),
            ("limit", "50"),
        ],
    )

    return AdminComplaintDepartmentRoutingResponse(
        mode=get_department_routing_mode(),
        triage_entry=AdminTriageQueueItem(**triage_rows[0]) if triage_rows else None,
        events=[AdminDepartmentEventItem(**row) for row in event_rows],
    )


async def get_admin_department_routing_overview(
    actor: AuthenticatedActor,
) -> AdminDepartmentRoutingOverviewResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    mappings_rows = await _admin_rest_get(
        actor,
        "category_department_mappings",
        [("order", "category.asc,ward.asc.nullsfirst"), ("limit", "200")],
    )
    metrics_rows = await _admin_rest_get(
        actor,
        "ai_category_accuracy_metrics",
        [("order", "category.asc,ward.asc.nullsfirst,measured_at.desc"), ("limit", "200")],
    )
    triage_rows = await _admin_rest_get(
        actor,
        "complaint_department_triage_queue",
        [("resolved_at", "is.null"), ("order", "created_at.desc"), ("limit", "100")],
    )

    return AdminDepartmentRoutingOverviewResponse(
        mode=get_department_routing_mode(),
        min_samples=settings.DEPARTMENT_AUTO_ASSIGN_MIN_SAMPLES,
        min_accuracy=settings.DEPARTMENT_AUTO_ASSIGN_MIN_ACCURACY,
        metrics_max_age_days=settings.DEPARTMENT_AUTO_ASSIGN_METRICS_MAX_AGE_DAYS,
        min_confidence=settings.DEPARTMENT_AUTO_ASSIGN_MIN_CONFIDENCE,
        mappings=[AdminMappingResponse(**r) for r in mappings_rows],
        metrics=[AdminAccuracyMetricItem(**r) for r in metrics_rows],
        open_triage_queue=[AdminTriageQueueItem(**r) for r in triage_rows],
    )


async def upsert_admin_category_department_mapping(
    actor: AuthenticatedActor,
    req: AdminMappingUpsertRequest,
) -> AdminMappingResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    payload = {
        "p_category": req.category,
        "p_department_id": req.department_id,
        "p_ward": req.ward,
        "p_is_active": req.is_active,
        "p_mapping_id": req.mapping_id,
    }
    res = await _call_rpc(
        "upsert_category_department_mapping",
        payload,
        actor_token=actor.token,
        context_id=req.department_id,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        code, msg = err["code"], err["message"]
        if res.status_code == 403 or code == "42501":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Administrator privileges required.",
            )
        if code == "P0002":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=msg or "Department or mapping not found.",
            )
        if code == "22023":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=msg or "Invalid mapping input.",
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to update category-department mapping.",
        )

    data = res.json() if isinstance(res.json(), dict) else {}
    return AdminMappingResponse(**data)


async def refresh_admin_accuracy_metrics(
    actor: AuthenticatedActor,
) -> AdminRefreshMetricsResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    res = await _call_rpc(
        "refresh_ai_category_accuracy_metrics",
        {},
        context_id=actor.user_id,
    )
    if res.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to refresh AI category accuracy metrics.",
        )
    data = res.json() if isinstance(res.json(), dict) else {}
    return AdminRefreshMetricsResponse(**data)
