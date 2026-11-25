"""
ReportlyUrban — Phase 8.3 Citizen Resolution Verification & Dispute Service
Forwards verified caller JWTs to RLS-protected tables and SECURITY DEFINER RPCs.
Never triggers or touches AI resolution checks or citizen rewards.
"""

import logging
from typing import Any, Dict, List, Optional
import httpx
from fastapi import HTTPException, status

from app.config import settings
from app.services.auth_service import AuthenticatedActor
from app.services.rate_limiter import InProcessSlidingWindowLimiter

logger = logging.getLogger("reportly.phase8_3.verification")

_DB_TIMEOUT = httpx.Timeout(connect=10.0, read=12.0, write=10.0, pool=10.0)
dispute_user_limiter = InProcessSlidingWindowLimiter(limit_per_minute=10, window_seconds=60)


def _user_headers(token: str) -> Dict[str, str]:
    if not settings.SUPABASE_URL or not settings.SUPABASE_ANON_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Verification service configuration is unavailable.",
        )
    return {
        "apikey": settings.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _extract_pg_error(response: httpx.Response) -> tuple[str, str]:
    try:
        body = response.json()
        if isinstance(body, dict):
            return str(body.get("code", "")).strip(), str(body.get("message", "")).strip()
    except ValueError:
        pass
    return "", ""


async def get_citizen_verification_status(
    actor: AuthenticatedActor, complaint_id: str
) -> Dict[str, Any]:
    if actor.role != "citizen":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Citizen account privileges required.",
        )

    headers = _user_headers(actor.token)
    base_url = settings.SUPABASE_URL.rstrip("/")

    try:
        async with httpx.AsyncClient(timeout=_DB_TIMEOUT) as client:
            comp_res = await client.get(
                f"{base_url}/rest/v1/complaints",
                params=[
                    ("id", f"eq.{complaint_id}"),
                    ("citizen_id", f"eq.{actor.user_id}"),
                    ("select", "id,status"),
                    ("limit", "1"),
                ],
                headers=headers,
            )
            if comp_res.status_code in (401, 403):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="You are not authorized to access this complaint.",
                )
            if comp_res.status_code not in (200, 206):
                logger.warning("verification_status complaint_lookup status=%s", comp_res.status_code)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Unable to load complaint verification status.",
                )

            comp_rows = comp_res.json()
            if not isinstance(comp_rows, list) or not comp_rows:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Complaint not found or access denied.",
                )
            complaint = comp_rows[0]
            comp_status = str(complaint.get("status") or "")

            latest_evidence_id: Optional[str] = None
            if comp_status == "resolved":
                ev_res = await client.get(
                    f"{base_url}/rest/v1/complaint_resolution_evidence",
                    params=[
                        ("complaint_id", f"eq.{complaint_id}"),
                        ("upload_status", "eq.completed"),
                        ("exif_stripped", "eq.true"),
                        ("select", "id,created_at"),
                        ("order", "created_at.desc,id.desc"),
                        ("limit", "1"),
                    ],
                    headers=headers,
                )
                if ev_res.status_code in (200, 206):
                    ev_rows = ev_res.json()
                    if isinstance(ev_rows, list) and ev_rows:
                        latest_evidence_id = str(ev_rows[0]["id"])
                else:
                    logger.warning("verification_status evidence_lookup status=%s", ev_res.status_code)
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="Unable to load completion evidence verification state.",
                    )

            ver_res = await client.get(
                f"{base_url}/rest/v1/complaint_resolution_verifications",
                params=[
                    ("complaint_id", f"eq.{complaint_id}"),
                    ("citizen_id", f"eq.{actor.user_id}"),
                    ("select", "id,evidence_id,decision,reason,created_at"),
                    ("order", "created_at.desc,id.desc"),
                    ("limit", "20"),
                ],
                headers=headers,
            )
            if ver_res.status_code not in (200, 206):
                logger.warning("verification_status history_lookup status=%s", ver_res.status_code)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Unable to load verification history.",
                )
            ver_rows = ver_res.json()
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timed out while loading verification status.",
        )
    except httpx.RequestError:
        logger.exception("verification_status network_error")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach verification service.",
        )

    history: List[Dict[str, Any]] = [
        {
            "id": str(row["id"]),
            "evidence_id": str(row["evidence_id"]),
            "decision": str(row["decision"]),
            "reason": row.get("reason"),
            "created_at": str(row.get("created_at") or ""),
        }
        for row in (ver_rows if isinstance(ver_rows, list) else [])
    ]

    current_decision: Optional[Dict[str, Any]] = None
    if latest_evidence_id:
        for item in history:
            if item["evidence_id"] == latest_evidence_id:
                current_decision = item
                break

    can_verify = bool(comp_status == "resolved" and latest_evidence_id and current_decision is None)

    return {
        "complaint_id": str(complaint["id"]),
        "complaint_status": comp_status,
        "latest_evidence_id": latest_evidence_id,
        "can_verify": can_verify,
        "current_decision": current_decision,
        "history": history,
    }


async def submit_citizen_verification(
    actor: AuthenticatedActor,
    complaint_id: str,
    *,
    decision: str,
    reason: Optional[str] = None,
    evidence_id: Optional[str] = None,
) -> Dict[str, Any]:
    if actor.role != "citizen":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Citizen account privileges required.",
        )

    if decision == "disputed":
        await dispute_user_limiter.check_and_record(actor.user_id)

    headers = _user_headers(actor.token)
    base_url = settings.SUPABASE_URL.rstrip("/")

    try:
        async with httpx.AsyncClient(timeout=_DB_TIMEOUT) as client:
            resolved_evidence_id = evidence_id
            if not resolved_evidence_id:
                comp_res = await client.get(
                    f"{base_url}/rest/v1/complaints",
                    params=[
                        ("id", f"eq.{complaint_id}"),
                        ("citizen_id", f"eq.{actor.user_id}"),
                        ("select", "id,status"),
                        ("limit", "1"),
                    ],
                    headers=headers,
                )
                if comp_res.status_code not in (200, 206):
                    logger.warning("verification_submit complaint_precheck status=%s", comp_res.status_code)
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="Unable to verify complaint eligibility right now.",
                    )
                comp_rows = comp_res.json()
                if not isinstance(comp_rows, list) or not comp_rows:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Complaint not found or access denied.",
                    )
                if str(comp_rows[0].get("status") or "") != "resolved":
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Only resolved complaints can be verified or disputed.",
                    )

                ev_res = await client.get(
                    f"{base_url}/rest/v1/complaint_resolution_evidence",
                    params=[
                        ("complaint_id", f"eq.{complaint_id}"),
                        ("upload_status", "eq.completed"),
                        ("exif_stripped", "eq.true"),
                        ("select", "id"),
                        ("order", "created_at.desc,id.desc"),
                        ("limit", "1"),
                    ],
                    headers=headers,
                )
                if ev_res.status_code not in (200, 206):
                    logger.warning("verification_submit evidence_precheck status=%s", ev_res.status_code)
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="Unable to verify completion photograph right now.",
                    )
                ev_rows = ev_res.json()
                if not isinstance(ev_rows, list) or not ev_rows:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail="No verified completion photograph exists for this resolution.",
                    )
                resolved_evidence_id = str(ev_rows[0]["id"])

            rpc_res = await client.post(
                f"{base_url}/rest/v1/rpc/submit_resolution_verification",
                json={
                    "p_complaint_id": complaint_id,
                    "p_evidence_id": resolved_evidence_id,
                    "p_decision": decision,
                    "p_reason": reason,
                },
                headers=headers,
            )
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timed out while submitting your verification decision.",
        )
    except httpx.RequestError:
        logger.exception("verification_submit network_error")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach verification service.",
        )

    if rpc_res.status_code == 200:
        data = rpc_res.json()
        if not isinstance(data, dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Unexpected response from verification service.",
            )
        return {
            "verification_id": str(data.get("verification_id")),
            "complaint_id": str(data.get("complaint_id")),
            "evidence_id": str(data.get("evidence_id")),
            "decision": str(data.get("decision")),
            "reason": data.get("reason"),
            "complaint_status": str(data.get("complaint_status")),
            "created_at": str(data.get("created_at") or ""),
        }

    code, message = _extract_pg_error(rpc_res)
    lower_msg = message.lower()
    logger.warning(
        "submit_resolution_verification failed status=%s code=%s complaint_id=%s",
        rpc_res.status_code,
        code or "unknown",
        complaint_id,
    )

    if code == "42501" or rpc_res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Complaint not found or access denied.",
        )
    if code == "23505" or rpc_res.status_code == 409:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A verification decision has already been recorded for this resolution.",
        )
    if code == "P0001":
        if "only resolved" in lower_msg or "invalid state" in lower_msg:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Only resolved complaints can be verified or disputed.",
            )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Verification evidence is invalid or outdated. Please refresh and try again.",
        )
    if code == "22023":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid verification submission.",
        )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Unable to record verification decision right now.",
    )


async def get_admin_verification_history(
    actor: AuthenticatedActor, complaint_id: str
) -> Dict[str, Any]:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    headers = _user_headers(actor.token)
    base_url = settings.SUPABASE_URL.rstrip("/")

    try:
        async with httpx.AsyncClient(timeout=_DB_TIMEOUT) as client:
            rpc_res = await client.post(
                f"{base_url}/rest/v1/rpc/get_admin_complaint_verifications",
                json={"p_complaint_id": complaint_id},
                headers=headers,
            )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timed out while loading verification history.",
        )
    except httpx.RequestError:
        logger.exception("admin_verification_history network_error")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach verification service.",
        )

    if rpc_res.status_code == 200:
        data = rpc_res.json()
        if data is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Complaint not found or access denied.",
            )
        if not isinstance(data, dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Unable to load verification history.",
            )
        return {
            "complaint_id": str(data.get("complaint_id") or complaint_id),
            "complaint_status": str(data.get("complaint_status") or ""),
            "latest_evidence_id": str(data["latest_evidence_id"]) if data.get("latest_evidence_id") else None,
            "latest_decision": data.get("latest_decision"),
            "history": [
                {
                    "id": str(item.get("id")),
                    "evidence_id": str(item.get("evidence_id")),
                    "decision": str(item.get("decision")),
                    "reason": item.get("reason"),
                    "citizen_display_name": str(item.get("citizen_display_name") or "Reporting Citizen"),
                    "created_at": str(item.get("created_at") or ""),
                }
                for item in (data.get("history") if isinstance(data.get("history"), list) else [])
            ],
        }

    code, _ = _extract_pg_error(rpc_res)
    logger.warning(
        "get_admin_complaint_verifications failed status=%s code=%s",
        rpc_res.status_code,
        code or "unknown",
    )
    if code == "42501" or rpc_res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Unable to load verification history.",
    )
