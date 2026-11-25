"""
ReportlyUrban — Phase 6.3 Public Accountability Router
Exposes unauthenticated read-only endpoints under /api/public/* backed by
Phase 6.2 PostgreSQL RPCs, strict query validation, rate limiting, and TTL caching.
"""

from fastapi import APIRouter, Depends, Request, Response

from app.schemas.public import (
    normalize_ward_filter,
    parse_public_reference_uuid,
    reject_unknown_query_params,
    validate_category_filter,
    validate_pagination_params,
    validate_status_filter,
)
from app.services.public_service import (
    DETAIL_CACHE_TTL_SECONDS,
    LIST_MAP_CACHE_TTL_SECONDS,
    STATS_CACHE_TTL_SECONDS,
    get_public_complaint_detail,
    get_public_complaint_list,
    get_public_dashboard_stats,
    get_public_department_stats,
    get_public_map_points,
    get_public_ward_names,
    get_public_ward_stats,
)
from app.services.rate_limiter import enforce_public_rate_limit

router = APIRouter(
    prefix="/api/public",
    tags=["Public Accountability"],
    dependencies=[Depends(enforce_public_rate_limit)],
)


def _set_public_cache_header(response: Response, max_age: int) -> None:
    response.headers["Cache-Control"] = f"public, max-age={max_age}"


@router.get("/stats")
async def public_stats(request: Request, response: Response):
    reject_unknown_query_params(request, set())
    data = await get_public_dashboard_stats()
    _set_public_cache_header(response, STATS_CACHE_TTL_SECONDS)
    return data


@router.get("/wards")
async def public_wards(request: Request, response: Response):
    reject_unknown_query_params(request, set())
    data = await get_public_ward_stats()
    _set_public_cache_header(response, STATS_CACHE_TTL_SECONDS)
    return data


@router.get("/wards/names")
async def public_ward_names(request: Request, response: Response):
    reject_unknown_query_params(request, set())
    data = await get_public_ward_names()
    _set_public_cache_header(response, STATS_CACHE_TTL_SECONDS)
    return data


@router.get("/departments")
async def public_departments(request: Request, response: Response):
    reject_unknown_query_params(request, set())
    data = await get_public_department_stats()
    _set_public_cache_header(response, STATS_CACHE_TTL_SECONDS)
    return data


@router.get("/map-points")
async def public_map_points(request: Request, response: Response):
    reject_unknown_query_params(request, {"ward", "category"})
    ward = normalize_ward_filter(request.query_params.get("ward"))
    category = validate_category_filter(request.query_params.get("category"))
    data = await get_public_map_points(ward=ward, category=category)
    _set_public_cache_header(response, LIST_MAP_CACHE_TTL_SECONDS)
    return data


@router.get("/complaints")
async def public_complaints(request: Request, response: Response):
    reject_unknown_query_params(
        request,
        {"ward", "category", "status", "page", "page_size"},
    )
    ward = normalize_ward_filter(request.query_params.get("ward"))
    category = validate_category_filter(request.query_params.get("category"))
    status_val = validate_status_filter(request.query_params.get("status"))
    page, page_size = validate_pagination_params(
        request.query_params.get("page"),
        request.query_params.get("page_size"),
    )
    data = await get_public_complaint_list(
        ward=ward,
        category=category,
        status_val=status_val,
        page=page,
        page_size=page_size,
    )
    _set_public_cache_header(response, LIST_MAP_CACHE_TTL_SECONDS)
    return data


@router.get("/complaints/{reference}")
async def public_complaint_detail(reference: str, request: Request, response: Response):
    reject_unknown_query_params(request, set())
    reference_uuid = parse_public_reference_uuid(reference)
    data = await get_public_complaint_detail(reference_uuid)
    _set_public_cache_header(response, DETAIL_CACHE_TTL_SECONDS)
    return data
