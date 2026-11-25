"""
ReportlyUrban — Phase 7.2 Internal SLA Sweep Service
Validates sweep secret with constant-time comparison, enforces strict batch caps,
invokes public.run_sla_sweep() via the shared service-role PostgREST helper,
and strips all non-count / error details from responses and logs.
"""

import hmac
import logging
from typing import Any, Dict, Optional
from fastapi import HTTPException, status

from app.config import settings
from app.services.public_service import _call_public_rpc

logger = logging.getLogger("reportly.internal.sla_sweep")

MIN_SWEEP_SECRET_LENGTH = 32
MAX_SWEEP_BATCH_LIMIT = 250
FIXED_TRIGGERED_BY = "fastapi-scheduler"


def is_sweep_secret_configured() -> bool:
    configured = settings.SLA_SWEEP_SECRET
    return isinstance(configured, str) and len(configured.strip()) >= MIN_SWEEP_SECRET_LENGTH


def verify_sweep_secret(supplied_secret: Optional[str]) -> None:
    """
    Validates X-Sweep-Secret against SLA_SWEEP_SECRET using hmac.compare_digest.
    - Returns 503 if server env secret is missing or shorter than 32 chars.
    - Returns generic 403 on missing, empty, or mismatched supplied secret.
    - Never logs the configured or supplied secret.
    """
    if not is_sweep_secret_configured():
        logger.error("SLA sweep request rejected: SLA_SWEEP_SECRET is unset or below minimum length.")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service unavailable.",
            headers={"Cache-Control": "no-store"},
        )

    configured = settings.SLA_SWEEP_SECRET.strip()
    if not supplied_secret or not isinstance(supplied_secret, str):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden.",
            headers={"Cache-Control": "no-store"},
        )

    if not hmac.compare_digest(supplied_secret.encode("utf-8"), configured.encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden.",
            headers={"Cache-Control": "no-store"},
        )


def validate_batch_limit(raw_value: Any = None) -> int:
    """Validates batch_limit within [1, 250], defaulting to SLA_SWEEP_DEFAULT_BATCH."""
    if raw_value is None or raw_value == "":
        val = settings.SLA_SWEEP_DEFAULT_BATCH
    elif isinstance(raw_value, bool):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid batch_limit parameter.",
            headers={"Cache-Control": "no-store"},
        )
    else:
        try:
            val = int(raw_value)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid batch_limit parameter.",
                headers={"Cache-Control": "no-store"},
            )

    if val < 1 or val > MAX_SWEEP_BATCH_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid batch_limit parameter.",
            headers={"Cache-Control": "no-store"},
        )
    return val


def sanitize_sweep_result(raw: Any) -> Dict[str, Any]:
    """Extracts strictly the safe operational counters and run_id from run_sla_sweep()."""
    if not isinstance(raw, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SLA sweep service returned an unexpected response.",
            headers={"Cache-Control": "no-store"},
        )

    result = {
        "status": str(raw.get("status", "completed")),
        "run_id": raw.get("run_id"),
        "scanned": int(raw.get("scanned_count", raw.get("scanned", 0)) or 0),
        "reminders_sent": int(raw.get("reminders_sent_count", raw.get("reminders_sent", 0)) or 0),
        "escalations_completed": int(
            raw.get("escalations_completed_count", raw.get("escalations_completed", 0)) or 0
        ),
        "escalations_blocked": int(
            raw.get("escalations_blocked_count", raw.get("escalations_blocked", 0)) or 0
        ),
        "error_count": int(raw.get("error_count", 0) or 0),
    }

    if result["error_count"] > 0:
        logger.warning(
            "SLA sweep run %s completed with partial errors (scanned=%s, error_count=%s).",
            result["run_id"],
            result["scanned"],
            result["error_count"],
        )

    return result


async def trigger_sla_sweep(batch_limit: int) -> Dict[str, Any]:
    """Executes public.run_sla_sweep() as service_role with fixed triggered_by='fastapi-scheduler'."""
    raw = await _call_public_rpc(
        "run_sla_sweep",
        payload={
            "p_batch_limit": batch_limit,
            "p_triggered_by": FIXED_TRIGGERED_BY,
        },
        timeout_seconds=settings.SLA_SWEEP_TIMEOUT_SECONDS,
        service_label="SLA sweep",
    )
    return sanitize_sweep_result(raw)
