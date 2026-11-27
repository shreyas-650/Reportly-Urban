"""
ReportlyUrban — Phase 9.3 Officer Auto-Assignment Service (Safety-First)
Evaluates eligible department officers (active, same department, exact ward match
or optional NULL-ward fallback only, under capacity, lowest workload + oldest
last-assigned) without overwriting staff assignments or breaking workflows.
"""

import logging
import time
from typing import Any, Dict, List, Optional
from fastapi import BackgroundTasks, HTTPException, status
import httpx

from app.config import parse_department_routing_mode, settings
from app.schemas.officer_routing import (
    AdminComplaintOfficerRoutingResponse,
    AdminOfficerAssignmentEventItem,
    AdminOfficerRoutingOverviewResponse,
    AdminOfficerRoutingTriggerResponse,
    AdminOfficerTriageQueueItem,
    CitizenOfficerRoutingTriggerResponse,
)
from app.services.ai_intelligence_service import (
    _user_headers,
    call_postgrest_rpc,
    extract_postgrest_error_details,
    verify_citizen_complaint_ownership,
)
from app.services.auth_service import AuthenticatedActor
from app.services.rate_limiter import InProcessSlidingWindowLimiter

logger = logging.getLogger("reportly.phase9_3.officer_routing")

_DB_TIMEOUT = httpx.Timeout(connect=10.0, read=12.0, write=10.0, pool=10.0)

officer_routing_user_limiter = InProcessSlidingWindowLimiter(
    limit_per_minute=30,
    window_seconds=60,
)


def get_officer_routing_mode() -> str:
    return parse_department_routing_mode(settings.OFFICER_AUTO_ASSIGN_MODE)


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


async def _evaluate_officer_routing_rpc(complaint_id: str) -> Optional[Dict[str, Any]]:
    mode = get_officer_routing_mode()
    if mode == "off":
        return {"mode": "off", "skipped": True, "applied": False}

    payload = {
        "p_complaint_id": complaint_id,
        "p_mode": mode,
        "p_max_open_complaints": settings.OFFICER_AUTO_ASSIGN_MAX_OPEN_COMPLAINTS,
        "p_allow_ward_fallback": bool(settings.OFFICER_AUTO_ASSIGN_ALLOW_NULL_WARD_FALLBACK),
    }
    res = await _call_rpc(
        "evaluate_and_assign_officer_ai",
        payload,
        context_id=complaint_id,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        raise RuntimeError(
            f"officer_routing_rpc_failed: status={res.status_code} code={err['code']}"
        )
    data = res.json()
    return data if isinstance(data, dict) else None


async def run_background_officer_routing(complaint_id: str) -> Optional[Dict[str, Any]]:
    """
    Runs Phase 9.3 officer evaluation/routing in background.
    Never raises, never blocks complaint submission or admin assignment.
    """
    started = time.monotonic()
    mode = get_officer_routing_mode()
    if mode == "off":
        return {"mode": "off", "skipped": True, "applied": False}

    try:
        result = await _evaluate_officer_routing_rpc(complaint_id)
        logger.info(
            "officer_routing stage=complete complaint_id=%s mode=%s applied=%s reason=%s duration_ms=%d",
            complaint_id,
            (result or {}).get("mode", mode),
            (result or {}).get("applied", False),
            (result or {}).get("reason_code", "-"),
            int((time.monotonic() - started) * 1000),
        )
        return result
    except Exception:
        logger.exception(
            "officer_routing stage=execute outcome=failed complaint_id=%s mode=%s",
            complaint_id,
            mode,
        )
        return None


async def schedule_citizen_officer_routing(
    background_tasks: BackgroundTasks,
    actor: AuthenticatedActor,
    complaint_id: str,
) -> CitizenOfficerRoutingTriggerResponse:
    """
    Verifies citizen ownership and queues idempotent Phase 9.3 officer routing.
    Returns strictly acceptance/mode metadata without leaking internal officer details.
    """
    await verify_citizen_complaint_ownership(actor, complaint_id)

    mode = get_officer_routing_mode()
    if mode == "off":
        return CitizenOfficerRoutingTriggerResponse(
            accepted=True, queued=False, mode="off"
        )

    try:
        await officer_routing_user_limiter.check_and_record(actor.user_id)
    except HTTPException:
        logger.warning(
            "officer_routing stage=trigger outcome=rate_limited complaint_id=%s",
            complaint_id,
        )
        return CitizenOfficerRoutingTriggerResponse(
            accepted=True, queued=False, mode=mode
        )

    background_tasks.add_task(run_background_officer_routing, complaint_id)
    return CitizenOfficerRoutingTriggerResponse(
        accepted=True, queued=True, mode=mode
    )


async def trigger_admin_officer_routing(
    actor: AuthenticatedActor,
    complaint_id: str,
) -> AdminOfficerRoutingTriggerResponse:
    """
    Admin-only trigger invoked right after assign_complaint_admin succeeds when a
    department is assigned without a manual officer. Idempotent and non-fatal.
    """
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    mode = get_officer_routing_mode()
    if mode == "off":
        return AdminOfficerRoutingTriggerResponse(
            accepted=True, mode="off", applied=False, reason_code="off"
        )

    res = await run_background_officer_routing(complaint_id)
    if not res:
        return AdminOfficerRoutingTriggerResponse(
            accepted=True, mode=mode, applied=False, reason_code="error"
        )

    return AdminOfficerRoutingTriggerResponse(
        accepted=True,
        mode=mode,
        applied=bool(res.get("applied", False)),
        reason_code=res.get("reason_code"),
        assigned_officer_id=res.get("assigned_officer_id"),
        proposed_officer_id=res.get("proposed_officer_id"),
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


async def get_admin_complaint_officer_routing(
    actor: AuthenticatedActor, complaint_id: str
) -> AdminComplaintOfficerRoutingResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    triage_rows = await _admin_rest_get(
        actor,
        "complaint_officer_triage_queue",
        [("complaint_id", f"eq.{complaint_id}"), ("limit", "1")],
    )
    event_rows = await _admin_rest_get(
        actor,
        "officer_assignment_events",
        [
            ("complaint_id", f"eq.{complaint_id}"),
            ("order", "created_at.desc"),
            ("limit", "50"),
        ],
    )

    return AdminComplaintOfficerRoutingResponse(
        mode=get_officer_routing_mode(),
        triage_entry=AdminOfficerTriageQueueItem(**triage_rows[0]) if triage_rows else None,
        events=[AdminOfficerAssignmentEventItem(**row) for row in event_rows],
    )


async def get_admin_officer_routing_overview(
    actor: AuthenticatedActor,
) -> AdminOfficerRoutingOverviewResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    triage_rows = await _admin_rest_get(
        actor,
        "complaint_officer_triage_queue",
        [("resolved_at", "is.null"), ("order", "created_at.desc"), ("limit", "100")],
    )

    return AdminOfficerRoutingOverviewResponse(
        mode=get_officer_routing_mode(),
        max_open_complaints=settings.OFFICER_AUTO_ASSIGN_MAX_OPEN_COMPLAINTS,
        allow_null_ward_fallback=bool(settings.OFFICER_AUTO_ASSIGN_ALLOW_NULL_WARD_FALLBACK),
        open_triage_queue=[AdminOfficerTriageQueueItem(**r) for r in triage_rows],
    )
