"""
ReportlyUrban — Phase 7.2 Internal Scheduler Router
Exposes POST /api/internal/sla-sweep for server-to-server scheduled execution only.
Enforces dedicated per-IP rate limiting, constant-time secret header auth,
strict input validation, and Cache-Control: no-store.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.services.rate_limiter import enforce_sweep_rate_limit
from app.services.sla_service import (
    trigger_sla_sweep,
    trigger_unconfirmed_auto_close,
    validate_batch_limit,
    validate_timeout_days,
    verify_sweep_secret,
)

router = APIRouter(
    prefix="/api/internal",
    tags=["Internal Scheduler"],
    dependencies=[Depends(enforce_sweep_rate_limit)],
)


@router.post("/sla-sweep")
async def run_sla_sweep_endpoint(request: Request, response: Response):
    verify_sweep_secret(request.headers.get("x-sweep-secret"))

    unknown_query = set(request.query_params.keys()) - {"batch_limit"}
    if unknown_query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported query parameter.",
            headers={"Cache-Control": "no-store"},
        )

    raw_batch_limit = request.query_params.get("batch_limit")
    raw_body = await request.body()
    if raw_body and raw_body.strip():
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid JSON payload.",
                headers={"Cache-Control": "no-store"},
            )
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid request payload.",
                headers={"Cache-Control": "no-store"},
            )
        unknown_body = set(payload.keys()) - {"batch_limit"}
        if unknown_body:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported payload field.",
                headers={"Cache-Control": "no-store"},
            )
        if raw_batch_limit is None and "batch_limit" in payload:
            raw_batch_limit = payload.get("batch_limit")

    batch_limit = validate_batch_limit(raw_batch_limit)
    result = await trigger_sla_sweep(batch_limit=batch_limit)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/close-unconfirmed")
async def close_unconfirmed_resolved_endpoint(request: Request, response: Response):
    verify_sweep_secret(request.headers.get("x-sweep-secret"))

    unknown_query = set(request.query_params.keys()) - {"batch_limit", "timeout_days", "dry_run"}
    if unknown_query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported query parameter.",
            headers={"Cache-Control": "no-store"},
        )

    raw_batch_limit = request.query_params.get("batch_limit")
    raw_timeout_days = request.query_params.get("timeout_days")
    raw_dry_run = request.query_params.get("dry_run")

    raw_body = await request.body()
    if raw_body and raw_body.strip():
        try:
            payload = await request.json()
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid JSON payload.",
                headers={"Cache-Control": "no-store"},
            )
        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid request payload.",
                headers={"Cache-Control": "no-store"},
            )
        unknown_body = set(payload.keys()) - {"batch_limit", "timeout_days", "dry_run"}
        if unknown_body:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported payload field.",
                headers={"Cache-Control": "no-store"},
            )
        if raw_batch_limit is None and "batch_limit" in payload:
            raw_batch_limit = payload.get("batch_limit")
        if raw_timeout_days is None and "timeout_days" in payload:
            raw_timeout_days = payload.get("timeout_days")
        if raw_dry_run is None and "dry_run" in payload:
            raw_dry_run = payload.get("dry_run")

    dry_run = False
    if raw_dry_run is not None:
        if isinstance(raw_dry_run, bool):
            dry_run = raw_dry_run
        elif isinstance(raw_dry_run, str) and raw_dry_run.strip().lower() in ("true", "1", "yes"):
            dry_run = True
        elif isinstance(raw_dry_run, str) and raw_dry_run.strip().lower() in ("false", "0", "no"):
            dry_run = False
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid dry_run parameter.",
                headers={"Cache-Control": "no-store"},
            )

    batch_limit = validate_batch_limit(raw_batch_limit)
    timeout_days = validate_timeout_days(raw_timeout_days)
    result = await trigger_unconfirmed_auto_close(
        timeout_days=timeout_days,
        batch_limit=batch_limit,
        dry_run=dry_run,
    )
    response.headers["Cache-Control"] = "no-store"
    return result
