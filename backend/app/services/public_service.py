"""
ReportlyUrban — Phase 6.3 Public Accountability Data Service
Calls Phase 6.2 read-only PostgreSQL RPCs using the backend service-role client,
applies bounded in-process caching, enforces strict public field allow-lists,
and sanitizes all upstream database/network failures.
"""

import logging
from typing import Any, Dict, List, Optional
import httpx
from fastapi import HTTPException, status

from app.config import settings
from app.schemas.public import sanitize_public_item
from app.services.public_cache import public_cache

logger = logging.getLogger("reportly.public.service")
# Prevent verbose third-party transport logs from emitting request metadata
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

STATS_CACHE_TTL_SECONDS = 600
LIST_MAP_CACHE_TTL_SECONDS = 120
DETAIL_CACHE_TTL_SECONDS = 300


def _build_rpc_timeout(timeout_seconds: Optional[float] = None) -> httpx.Timeout:
    """Builds explicit connect, read, write, and pool timeouts for RPC calls."""
    t = float(timeout_seconds if timeout_seconds is not None else settings.PUBLIC_RPC_TIMEOUT_SECONDS)
    return httpx.Timeout(connect=t, read=t, write=t, pool=t)


async def _call_public_rpc(
    rpc_name: str,
    payload: Optional[Dict[str, Any]] = None,
    timeout_seconds: Optional[float] = None,
    service_label: str = "Public accountability",
) -> Any:
    """
    Executes a Supabase PostgreSQL RPC via PostgREST using the backend service-role key
    and configured timeout. Never exposes raw DB errors, connection strings, or credentials.
    """
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        logger.error("RPC '%s' failed: Supabase backend configuration missing.", rpc_name)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{service_label} service is temporarily unavailable.",
        )

    rpc_url = f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/rpc/{rpc_name}"
    headers = {
        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    effective_timeout = (
        timeout_seconds if timeout_seconds is not None else settings.PUBLIC_RPC_TIMEOUT_SECONDS
    )

    try:
        async with httpx.AsyncClient(timeout=_build_rpc_timeout(effective_timeout)) as client:
            response = await client.post(rpc_url, json=payload or {}, headers=headers)
    except httpx.TimeoutException:
        logger.warning(
            "RPC '%s' timed out after %.1fs.",
            rpc_name,
            effective_timeout,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{service_label} request timed out. Please try again shortly.",
        )
    except httpx.RequestError as exc:
        logger.error("RPC '%s' transport error: %s", rpc_name, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{service_label} service is temporarily unavailable.",
        )

    if response.status_code == 200:
        try:
            return response.json()
        except ValueError:
            logger.error("RPC '%s' returned invalid JSON payload.", rpc_name)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"{service_label} service returned an unexpected response.",
            )

    # Check structured PostgREST error payload for P0400 parameter validation failure
    error_code = ""
    if response.status_code in (400, 422):
        try:
            err_body = response.json()
            if isinstance(err_body, dict):
                error_code = str(err_body.get("code", ""))
        except ValueError:
            error_code = ""
        if error_code == "P0400":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid filter parameter.",
            )

    logger.error(
        "RPC '%s' failed with upstream status %s (code=%s).",
        rpc_name,
        response.status_code,
        error_code or "unknown",
    )
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"{service_label} service is temporarily unavailable.",
    )


async def get_public_dashboard_stats() -> Dict[str, Any]:
    async def _load() -> Dict[str, Any]:
        data = await _call_public_rpc("public_dashboard_stats")
        if not isinstance(data, dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Public accountability service returned an unexpected response.",
            )
        return data

    return await public_cache.get_or_load("stats:citywide", STATS_CACHE_TTL_SECONDS, _load)


async def get_public_ward_stats() -> List[Dict[str, Any]]:
    async def _load() -> List[Dict[str, Any]]:
        data = await _call_public_rpc("public_ward_stats")
        if not isinstance(data, list):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Public accountability service returned an unexpected response.",
            )
        return data

    return await public_cache.get_or_load("wards:stats", STATS_CACHE_TTL_SECONDS, _load)


async def get_public_ward_names() -> Dict[str, List[str]]:
    """
    Derives public ward dropdown names ONLY from public_ward_stats(), excluding
    suppressed/grouped buckets ('Other', is_other=True, is_suppressed=True).
    """
    async def _load() -> Dict[str, List[str]]:
        ward_stats = await get_public_ward_stats()
        names: List[str] = []
        seen = set()
        for row in ward_stats:
            if not isinstance(row, dict):
                continue
            if row.get("is_other") or row.get("is_suppressed"):
                continue
            ward_name = row.get("ward")
            if not isinstance(ward_name, str):
                continue
            cleaned = " ".join(ward_name.strip().split())
            if not cleaned or cleaned == "Other" or cleaned in seen:
                continue
            seen.add(cleaned)
            names.append(cleaned)
        names.sort()
        return {"wards": names}

    return await public_cache.get_or_load("wards:names", STATS_CACHE_TTL_SECONDS, _load)


async def get_public_department_stats() -> List[Dict[str, Any]]:
    async def _load() -> List[Dict[str, Any]]:
        data = await _call_public_rpc("public_department_stats")
        if not isinstance(data, list):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Public accountability service returned an unexpected response.",
            )
        return data

    return await public_cache.get_or_load("departments:stats", STATS_CACHE_TTL_SECONDS, _load)


async def get_public_map_points(
    ward: Optional[str] = None,
    category: Optional[str] = None,
) -> Dict[str, Any]:
    cache_key = f"map:w={ward or ''}:c={category or ''}"

    async def _load() -> Dict[str, Any]:
        data = await _call_public_rpc(
            "public_map_points",
            {"p_ward": ward, "p_category": category},
        )
        if not isinstance(data, dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Public accountability service returned an unexpected response.",
            )
        raw_points = data.get("points") or []
        return {
            "points": [sanitize_public_item(pt) for pt in raw_points],
            "truncated": bool(data.get("truncated", False)),
            "total_count": data.get("total_count"),
            "unmapped_count": int(data.get("unmapped_count") or 0),
            "count_suppressed": bool(data.get("count_suppressed", False)),
        }

    return await public_cache.get_or_load(cache_key, LIST_MAP_CACHE_TTL_SECONDS, _load)


async def get_public_complaint_list(
    ward: Optional[str] = None,
    category: Optional[str] = None,
    status_val: Optional[str] = None,
    page: int = 1,
    page_size: int = 20,
) -> Dict[str, Any]:
    cache_key = (
        f"list:w={ward or ''}:c={category or ''}:s={status_val or ''}:p={page}:ps={page_size}"
    )

    async def _load() -> Dict[str, Any]:
        data = await _call_public_rpc(
            "public_complaint_list",
            {
                "p_ward": ward,
                "p_category": category,
                "p_status": status_val,
                "p_page": page,
                "p_page_size": page_size,
            },
        )
        if not isinstance(data, dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Public accountability service returned an unexpected response.",
            )
        raw_items = data.get("items") or []
        return {
            "items": [sanitize_public_item(item) for item in raw_items],
            "total_count": data.get("total_count"),
            "count_suppressed": bool(data.get("count_suppressed", False)),
            "page": int(data.get("page", page)),
            "page_size": int(data.get("page_size", page_size)),
        }

    return await public_cache.get_or_load(cache_key, LIST_MAP_CACHE_TTL_SECONDS, _load)


async def get_public_complaint_detail(reference_uuid: str) -> Dict[str, Any]:
    cache_key = f"detail:{reference_uuid}"

    async def _load() -> Dict[str, Any]:
        data = await _call_public_rpc(
            "public_complaint_detail",
            {"p_reference": reference_uuid},
        )
        if data is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Complaint record not found.",
            )
        if not isinstance(data, dict):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Public accountability service returned an unexpected response.",
            )
        return sanitize_public_item(data)

    return await public_cache.get_or_load(cache_key, DETAIL_CACHE_TTL_SECONDS, _load)
