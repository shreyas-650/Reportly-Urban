"""
ReportlyUrban — Phase 6 Public Accountability Schemas & Validators
Enforces strict public field allow-lists, category/status validation,
whitespace normalization, pagination limits, and UUID parsing rules.
"""

import uuid
from typing import Any, Dict, FrozenSet, List, Optional, Set
from fastapi import HTTPException, Request, status
from pydantic import BaseModel

VALID_PUBLIC_CATEGORIES: FrozenSet[str] = frozenset({
    "potholes",
    "garbage",
    "streetlights",
    "water_leakage",
    "drainage",
    "public_infrastructure",
})

# 'rejected' is explicitly excluded from all public explorer filters
VALID_PUBLIC_STATUSES: FrozenSet[str] = frozenset({
    "submitted",
    "under_review",
    "in_progress",
    "resolved",
})

ALLOWED_PUBLIC_FIELDS: FrozenSet[str] = frozenset({
    "category",
    "latitude",
    "longitude",
    "public_reference",
    "status",
    "submitted_date",
    "title",
    "ward",
})


def normalize_ward_filter(ward: Optional[str]) -> Optional[str]:
    """Trims leading/trailing whitespace and collapses internal whitespace sequences."""
    if ward is None:
        return None
    collapsed = " ".join(ward.strip().split())
    if not collapsed:
        return None
    if len(collapsed) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid ward filter parameter.",
        )
    return collapsed


def validate_category_filter(category: Optional[str]) -> Optional[str]:
    if category is None:
        return None
    normalized = category.strip().lower()
    if not normalized:
        return None
    if normalized not in VALID_PUBLIC_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid category filter parameter.",
        )
    return normalized


def validate_status_filter(status_val: Optional[str]) -> Optional[str]:
    if status_val is None:
        return None
    normalized = status_val.strip().lower()
    if not normalized:
        return None
    if normalized not in VALID_PUBLIC_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid status filter parameter.",
        )
    return normalized


def validate_pagination_params(page_raw: Optional[str], page_size_raw: Optional[str]) -> tuple[int, int]:
    """Parses and validates page (>= 1) and page_size (1..50), raising HTTP 400 on invalid inputs."""
    page = 1
    page_size = 20

    if page_raw is not None and page_raw.strip() != "":
        try:
            page = int(page_raw)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid page parameter.",
            )
        if page < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid page parameter.",
            )

    if page_size_raw is not None and page_size_raw.strip() != "":
        try:
            page_size = int(page_size_raw)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid page_size parameter.",
            )
        if page_size < 1 or page_size > 50:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid page_size parameter.",
            )

    return page, page_size


def reject_unknown_query_params(request: Request, allowed_params: Set[str]) -> None:
    """Strictly rejects any unexpected query parameter with HTTP 400."""
    unknown = set(request.query_params.keys()) - allowed_params
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported query parameter.",
        )


def parse_public_reference_uuid(reference: str) -> str:
    """
    Validates canonical UUID syntax for public_reference lookups.
    Malformed inputs return HTTP 404 (not 422 or 500) per Phase 6.3 security spec.
    """
    try:
        parsed = uuid.UUID(reference.strip())
    except (ValueError, AttributeError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Complaint record not found.",
        )
    return str(parsed)


def sanitize_public_item(item: Any) -> Dict[str, Any]:
    """Enforces strict allow-list stripping all non-public fields from map/list/detail objects."""
    if not isinstance(item, dict):
        return {}
    return {k: v for k, v in item.items() if k in ALLOWED_PUBLIC_FIELDS}


class PublicDashboardStats(BaseModel):
    total: int
    resolved: int
    pending: int
    rejected: Optional[int] = None
    rejected_suppressed: bool
    overdue: int
    no_deadline_count: int
    resolution_rate: Optional[float] = None
    avg_resolution_hours: Optional[float] = None


class PublicWardNamesResponse(BaseModel):
    wards: List[str]
