"""
ReportlyUrban — Phase 9.6 AI Accuracy Dashboard, Ward Fairness & Review Appeals Service

All write paths fail loudly (never swallow exceptions or return fake acknowledgements).
All citizen appeal paths return strictly neutral payloads with zero AI/flag metadata.
All dashboard and ward fairness aggregations run inside hardened SQL RPCs.
"""

import logging
from typing import Any, Dict, Optional
from fastapi import HTTPException, status
import httpx

from app.config import settings
from app.schemas.accuracy_appeals import (
    VALID_APPEAL_FILTERS,
    VALID_DASHBOARD_WINDOWS,
    AdminAccuracyDashboardResponse,
    AdminAppealDecisionResponse,
    AdminAppealFeatureToggleResponse,
    AdminAppealQueueItem,
    AdminAppealsListResponse,
    AdminWardFairnessResponse,
    CitizenAppealStatusResponse,
    CitizenAppealSubmitResponse,
    WardFairnessItem,
    AccuracyFeatureCard,
)
from app.services.ai_intelligence_service import (
    call_postgrest_rpc,
    extract_postgrest_error_details,
)
from app.services.auth_service import AuthenticatedActor
from app.services.rate_limiter import InProcessSlidingWindowLimiter

logger = logging.getLogger("reportly.phase9_6.accuracy_appeals")

_DB_TIMEOUT = httpx.Timeout(connect=10.0, read=12.0, write=10.0, pool=10.0)

citizen_appeal_limiter = InProcessSlidingWindowLimiter(
    limit_per_minute=15,
    window_seconds=60,
)


def is_appeal_feature_enabled() -> bool:
    """Fail-closed backend flag check (SQL phase9_feature_settings also enforces DB-level state)."""
    return settings.APPEAL_FEATURE_ENABLED is True


async def _call_user_rpc(
    rpc_name: str,
    payload: Dict[str, Any],
    *,
    actor: AuthenticatedActor,
    context_id: Optional[str] = None,
) -> httpx.Response:
    return await call_postgrest_rpc(
        rpc_name,
        payload,
        actor_token=actor.token,
        timeout=_DB_TIMEOUT,
        client_cls=httpx.AsyncClient,
        logger_obj=logger,
        context_id=context_id,
    )


async def get_citizen_appeal_status(
    actor: AuthenticatedActor, complaint_id: str
) -> CitizenAppealStatusResponse:
    if not is_appeal_feature_enabled():
        return CitizenAppealStatusResponse(
            eligible=False, has_open_appeal=False, appeal_status="none"
        )

    res = await _call_user_rpc(
        "get_citizen_review_appeal_status",
        {
            "p_complaint_id": complaint_id,
            "p_min_age_days": settings.SCREENING_APPEAL_MIN_AGE_DAYS,
            "p_cooldown_hours": settings.SCREENING_APPEAL_COOLDOWN_HOURS,
            "p_lifetime_cap": settings.SCREENING_APPEAL_LIFETIME_CAP,
        },
        actor=actor,
        context_id=complaint_id,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        code = err["code"]
        if code == "42501" or res.status_code == 403:
            # Decision (4): non-owner receives 404 without revealing complaint existence
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Complaint not found or access denied.",
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to retrieve review request eligibility.",
        )

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid review request eligibility response.",
        )

    return CitizenAppealStatusResponse(
        eligible=bool(data.get("eligible", False)),
        has_open_appeal=bool(data.get("has_open_appeal", False)),
        appeal_status=str(data.get("appeal_status") or "none"),
    )


async def submit_citizen_appeal(
    actor: AuthenticatedActor,
    complaint_id: str,
    appeal_text: str,
) -> CitizenAppealSubmitResponse:
    if not is_appeal_feature_enabled():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Review requests are currently disabled.",
        )

    await citizen_appeal_limiter.check_and_record(actor.user_id)

    res = await _call_user_rpc(
        "submit_complaint_review_appeal",
        {
            "p_complaint_id": complaint_id,
            "p_appeal_text": appeal_text,
            "p_min_age_days": settings.SCREENING_APPEAL_MIN_AGE_DAYS,
            "p_daily_cap": settings.SCREENING_APPEAL_DAILY_CAP,
            "p_cooldown_hours": settings.SCREENING_APPEAL_COOLDOWN_HOURS,
            "p_lifetime_cap": settings.SCREENING_APPEAL_LIFETIME_CAP,
        },
        actor=actor,
        context_id=complaint_id,
    )

    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        code, msg = err["code"], err["message"]
        if code == "42501" or res.status_code == 403:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Complaint not found or access denied.",
            )
        if code == "22023":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=msg or "Invalid review request input.",
            )
        if code == "P0001":
            lower_msg = (msg or "").lower()
            if "feature disabled" in lower_msg:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Review requests are currently disabled.",
                )
            if "daily limit" in lower_msg:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail=msg or "Daily review request limit reached.",
                )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=msg or "This complaint is not currently eligible for a review request.",
            )
        logger.warning(
            "appeal_submit failed status=%s code=%s complaint_id=%s",
            res.status_code,
            code,
            complaint_id,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to submit review request right now. Please try again later.",
        )

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict) or data.get("submitted") is not True:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Review request could not be verified.",
        )

    return CitizenAppealSubmitResponse(submitted=True, status="open")


async def fetch_admin_accuracy_dashboard(
    actor: AuthenticatedActor,
    *,
    window: str = "30d",
    min_samples: Optional[int] = None,
) -> AdminAccuracyDashboardResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    clean_win = (window or "30d").strip().lower()
    if clean_win not in VALID_DASHBOARD_WINDOWS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid dashboard time window.",
        )

    eff_min = max(5, min_samples if min_samples is not None else settings.DASHBOARD_MIN_SAMPLES)

    res = await _call_user_rpc(
        "get_admin_accuracy_dashboard",
        {"p_window": clean_win, "p_min_samples": eff_min},
        actor=actor,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        if res.status_code == 403 or err["code"] == "42501":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator privileges required.")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to compute accuracy dashboard metrics.",
        )

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid dashboard response.",
        )

    cards_raw = data.get("cards") if isinstance(data.get("cards"), list) else []
    return AdminAccuracyDashboardResponse(
        window=str(data.get("window") or clean_win),
        date_from=str(data.get("date_from") or ""),
        date_to=str(data.get("date_to") or ""),
        min_samples=int(data.get("min_samples", eff_min)),
        plain_review_appeals_count=int(data.get("plain_review_appeals_count", 0)),
        cards=[AccuracyFeatureCard(**c) for c in cards_raw],
    )


async def fetch_admin_ward_fairness(
    actor: AuthenticatedActor, *, ward_min_samples: Optional[int] = None
) -> AdminWardFairnessResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    eff_min = max(
        5,
        ward_min_samples
        if ward_min_samples is not None
        else settings.DASHBOARD_WARD_MIN_SAMPLES,
    )

    res = await _call_user_rpc(
        "get_admin_ward_accuracy_fairness",
        {"p_ward_min_samples": eff_min},
        actor=actor,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        if res.status_code == 403 or err["code"] == "42501":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator privileges required.")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to retrieve ward fairness metrics.",
        )

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Invalid ward fairness response.",
        )

    wards_raw = data.get("wards") if isinstance(data.get("wards"), list) else []
    return AdminWardFairnessResponse(
        scope=str(data.get("scope") or "category_priority"),
        fixed_window=str(data.get("fixed_window") or "all_time"),
        ward_min_samples=int(data.get("ward_min_samples", eff_min)),
        fairness_notice=str(data.get("fairness_notice") or "Fairness monitoring, informational only."),
        displayed_sample_total=int(data.get("displayed_sample_total", 0)),
        displayed_overall_rate=data.get("displayed_overall_rate"),
        enough_data=bool(data.get("enough_data", False)),
        wards=[WardFairnessItem(**w) for w in wards_raw],
    )


async def fetch_admin_appeals_queue(
    actor: AuthenticatedActor,
    *,
    status_filter: str = "open",
    page: int = 1,
    page_size: int = 20,
) -> AdminAppealsListResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    clean_filter = (status_filter or "open").strip().lower()
    if clean_filter not in VALID_APPEAL_FILTERS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid appeal filter.")

    res = await _call_user_rpc(
        "list_admin_review_appeals",
        {"p_status": clean_filter, "p_page": page, "p_page_size": page_size},
        actor=actor,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        if res.status_code == 403 or err["code"] == "42501":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator privileges required.")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to load review appeals queue.",
        )

    payload = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Invalid appeals queue response.")

    raw_items = payload.get("items") if isinstance(payload.get("items"), list) else []
    return AdminAppealsListResponse(
        appeal_feature_enabled=bool(payload.get("appeal_feature_enabled", False)),
        backend_flag_enabled=is_appeal_feature_enabled(),
        items=[AdminAppealQueueItem(**row) for row in raw_items],
        total=int(payload.get("total", len(raw_items))),
        page=int(payload.get("page", page)),
        page_size=int(payload.get("page_size", page_size)),
        total_pages=max(1, int(payload.get("total_pages", 1))),
    )


async def decide_admin_appeal(
    actor: AuthenticatedActor,
    appeal_id: str,
    *,
    outcome: str,
    reason: Optional[str] = None,
    is_correction: bool = False,
) -> AdminAppealDecisionResponse:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges required.",
        )

    res = await _call_user_rpc(
        "admin_decide_complaint_review_appeal",
        {
            "p_appeal_id": appeal_id,
            "p_outcome": outcome,
            "p_reason": reason,
            "p_is_correction": is_correction,
        },
        actor=actor,
        context_id=appeal_id,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        code, msg = err["code"], err["message"]
        if res.status_code == 403 or code == "42501":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator privileges required.")
        if code == "P0002":
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=msg or "Appeal not found.")
        if code == "P0001" or res.status_code == 409:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=msg or "Appeal has already been decided.")
        if code == "22023":
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=msg or "Invalid appeal decision.")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Unable to record appeal decision.")

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict) or data.get("success") is not True:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Appeal decision could not be confirmed.")

    return AdminAppealDecisionResponse(**data)


async def toggle_admin_appeal_feature(
    actor: AuthenticatedActor, is_enabled: bool
) -> AdminAppealFeatureToggleResponse:
    if actor.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator privileges required.")

    res = await _call_user_rpc(
        "admin_set_appeal_feature_enabled",
        {"p_enabled": bool(is_enabled)},
        actor=actor,
    )
    if res.status_code != 200:
        err = extract_postgrest_error_details(res)
        if res.status_code == 403 or err["code"] == "42501":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator privileges required.")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Unable to update appeal feature setting.")

    data = res.json() if isinstance(res.json(), dict) else None
    if not isinstance(data, dict):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Invalid setting update response.")

    return AdminAppealFeatureToggleResponse(**data)
