"""
ReportlyUrban — Phase 7.3 Escalation, SLA Management & Notification Service
Forwards the caller's cryptographically verified Supabase JWT to RLS-protected PostgREST
tables and SECURITY DEFINER RPCs. Never reads private tables for another user, never
exposes service_role keys or raw database details.
"""

from datetime import datetime, timezone
import logging
import math
from typing import Any, Dict, List, Optional, Tuple
import httpx
from fastapi import HTTPException, status

from app.config import settings
from app.schemas.sla import ManualEscalationRequest, UpdateSlaRuleRequest
from app.services.auth_service import AuthenticatedActor

logger = logging.getLogger("reportly.phase7.service")

_DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=10.0, write=10.0, pool=10.0)


def _auth_headers(token: str, *, count_exact: bool = False) -> Dict[str, str]:
    headers = {
        "apikey": settings.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if count_exact:
        headers["Prefer"] = "count=exact"
    return headers


def _parse_total_from_content_range(header_val: Optional[str], fallback_len: int) -> int:
    if not header_val or "/" not in header_val:
        return fallback_len
    total_part = header_val.split("/")[-1].strip()
    if total_part == "*":
        return fallback_len
    try:
        return max(0, int(total_part))
    except ValueError:
        return fallback_len


def _timestamps_equal_ms(ts_a: str, ts_b: str) -> bool:
    try:
        dt_a = datetime.fromisoformat(ts_a.replace("Z", "+00:00")).astimezone(timezone.utc)
        dt_b = datetime.fromisoformat(ts_b.replace("Z", "+00:00")).astimezone(timezone.utc)
        return int(dt_a.timestamp() * 1000) == int(dt_b.timestamp() * 1000)
    except Exception:
        return ts_a.strip() == ts_b.strip()


def _map_rpc_error(rpc_name: str, response: httpx.Response, *, not_found_on_42501: bool = False) -> HTTPException:
    code = ""
    message = ""
    try:
        body = response.json()
        if isinstance(body, dict):
            code = str(body.get("code", "")).strip()
            message = str(body.get("message", "")).strip()
    except ValueError:
        pass

    lower_msg = message.lower()
    logger.warning("Phase 7 RPC '%s' returned status=%s code=%s", rpc_name, response.status_code, code or "unknown")

    if code == "42501" or response.status_code in (401, 403):
        if not_found_on_42501:
            return HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Complaint not found or access denied.",
            )
        return HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to perform this action.",
        )

    if code == "P0002":
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Requested record was not found.",
        )

    if code == "40001":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Concurrency Conflict: Record was updated elsewhere. Refresh and retry.",
        )

    if code == "23505":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This escalation level has already been recorded for this complaint.",
        )

    if code == "P0001":
        if "terminal state" in lower_msg or "cannot escalate a resolved" in lower_msg or "cannot escalate a rejected" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Resolved or rejected complaints cannot be escalated.",
            )
        if "maximum escalation level" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Complaint is already at maximum escalation Level 3.",
            )
        if "no assigned officer" in lower_msg or "officer profile is missing" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Cannot escalate to Level 1: assign an active municipal officer first.",
            )
        if "no assigned department" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Cannot escalate to Level 2: assign a municipal department first.",
            )
        if "no_department_head" in lower_msg or "active department head" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Cannot escalate to Level 2: no active department head is configured for this department.",
            )
        if "reason" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A manual escalation reason of at least 5 characters is required.",
            )
        if "sla_hours" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="sla_hours must be between 1 and 8760.",
            )
        if "reminder_before_hours" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="reminder_before_hours must be >= 0 and strictly less than sla_hours.",
            )
        if "level2_after_hours" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="level2_after_hours must be >= 0.",
            )
        if "level3_after_hours" in lower_msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="level3_after_hours must be strictly greater than level2_after_hours.",
            )
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Operation rejected by escalation/SLA validation rules.",
        )

    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Service temporarily unavailable. Please try again shortly.",
    )


async def _rest_get(
    token: str,
    table: str,
    params: List[Tuple[str, str]],
    *,
    count_exact: bool = False,
) -> Tuple[List[Dict[str, Any]], int]:
    if not settings.SUPABASE_URL or not settings.SUPABASE_ANON_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase backend configuration is unavailable.",
        )

    url = f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/{table}"
    try:
        async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
            res = await client.get(url, params=params, headers=_auth_headers(token, count_exact=count_exact))
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Database query timed out. Please try again.",
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach database service.",
        )

    if res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to access this resource.",
        )
    if res.status_code != 200:
        logger.warning("PostgREST GET '%s' failed with status=%s", table, res.status_code)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to retrieve requested records.",
        )

    data = res.json()
    rows = data if isinstance(data, list) else []
    total = _parse_total_from_content_range(res.headers.get("content-range"), len(rows))
    return rows, total


async def _rest_rpc(
    token: str,
    rpc_name: str,
    payload: Dict[str, Any],
    *,
    not_found_on_42501: bool = False,
) -> Any:
    if not settings.SUPABASE_URL or not settings.SUPABASE_ANON_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase backend configuration is unavailable.",
        )

    url = f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/rpc/{rpc_name}"
    try:
        async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
            res = await client.post(url, json=payload, headers=_auth_headers(token))
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Database operation timed out. Please try again.",
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach database service.",
        )

    if res.status_code == 200:
        return res.json()

    raise _map_rpc_error(rpc_name, res, not_found_on_42501=not_found_on_42501)


async def _resolve_recipient_labels(
    token: str,
    officer_ids: List[str],
    profile_ids: List[str],
) -> Tuple[Dict[str, str], Dict[str, str]]:
    officer_map: Dict[str, str] = {}
    profile_map: Dict[str, str] = {}

    clean_off_ids = sorted({oid for oid in officer_ids if oid})
    clean_prof_ids = sorted({pid for pid in profile_ids if pid})

    if clean_off_ids:
        rows, _ = await _rest_get(
            token,
            "officers",
            [
                ("id", f"in.({','.join(clean_off_ids)})"),
                ("select", "id,official_name,designation"),
            ],
        )
        for row in rows:
            oid = row.get("id")
            if oid:
                name = row.get("official_name") or "Officer"
                desig = row.get("designation")
                officer_map[oid] = f"{name} ({desig})" if desig else name

    if clean_prof_ids:
        rows, _ = await _rest_get(
            token,
            "profiles",
            [
                ("id", f"in.({','.join(clean_prof_ids)})"),
                ("select", "id,full_name,role"),
            ],
        )
        for row in rows:
            pid = row.get("id")
            if pid:
                name = row.get("full_name") or "Administrator"
                role = row.get("role")
                profile_map[pid] = f"{name} ({role})" if role else name

    return officer_map, profile_map


def _format_recipient_label(
    esc: Dict[str, Any], officer_map: Dict[str, str], profile_map: Dict[str, str]
) -> str:
    if esc.get("status") == "blocked":
        return "Pending Assignment / Dept Head"
    oid = esc.get("recipient_officer_id")
    pid = esc.get("recipient_profile_id")
    if oid and oid in officer_map:
        return officer_map[oid]
    if pid and pid in profile_map:
        return profile_map[pid]
    return f"Level {esc.get('to_level')} Authority"


async def list_admin_escalations(
    token: str,
    *,
    level: Optional[int],
    esc_status: Optional[str],
    department_id: Optional[str],
    ward: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    page: int,
    page_size: int,
) -> Dict[str, Any]:
    params: List[Tuple[str, str]] = [
        (
            "select",
            "id,complaint_id,from_level,to_level,status,reason,triggered_by,"
            "recipient_profile_id,recipient_officer_id,created_at,"
            "complaints!inner(id,complaint_number,category,ward,status,department_id,sla_deadline,updated_at)",
        ),
        ("order", "created_at.desc"),
        ("limit", str(page_size)),
        ("offset", str((page - 1) * page_size)),
    ]

    if level is not None:
        params.append(("to_level", f"eq.{level}"))
    if esc_status is not None:
        params.append(("status", f"eq.{esc_status}"))
    if department_id is not None:
        params.append(("complaints.department_id", f"eq.{department_id}"))
    if ward is not None:
        params.append(("complaints.ward", f"eq.{ward}"))
    if date_from is not None:
        params.append(("created_at", f"gte.{date_from}T00:00:00Z"))
    if date_to is not None:
        params.append(("created_at", f"lte.{date_to}T23:59:59.999Z"))

    rows, total = await _rest_get(token, "complaint_escalations", params, count_exact=True)

    dept_rows, _ = await _rest_get(
        token,
        "departments",
        [("select", "id,name,is_active"), ("order", "name.asc")],
    )
    dept_map = {d["id"]: d["name"] for d in dept_rows if d.get("id")}

    complaint_ids = sorted({r["complaint_id"] for r in rows if r.get("complaint_id")})
    sla_level_map: Dict[str, int] = {}
    if complaint_ids:
        sla_rows, _ = await _rest_get(
            token,
            "complaint_sla_state",
            [
                ("complaint_id", f"in.({','.join(complaint_ids)})"),
                ("select", "complaint_id,current_level"),
            ],
        )
        for s in sla_rows:
            if s.get("complaint_id"):
                sla_level_map[s["complaint_id"]] = int(s.get("current_level", 0) or 0)

    officer_map, profile_map = await _resolve_recipient_labels(
        token,
        [r.get("recipient_officer_id") for r in rows],
        [r.get("recipient_profile_id") for r in rows],
    )

    items = []
    for row in rows:
        comp = row.get("complaints") or {}
        cid = row.get("complaint_id")
        dept_id = comp.get("department_id")
        items.append(
            {
                "id": row.get("id"),
                "complaint_id": cid,
                "complaint_reference": comp.get("complaint_number") or cid,
                "category": comp.get("category"),
                "ward": comp.get("ward"),
                "complaint_status": comp.get("status"),
                "department_id": dept_id,
                "department_name": dept_map.get(dept_id) if dept_id else None,
                "current_level": sla_level_map.get(cid, row.get("to_level") or 0),
                "from_level": row.get("from_level"),
                "to_level": row.get("to_level"),
                "status": row.get("status"),
                "recipient": _format_recipient_label(row, officer_map, profile_map),
                "reason": row.get("reason"),
                "triggered_by": row.get("triggered_by"),
                "created_at": row.get("created_at"),
            }
        )

    total_pages = max(1, math.ceil(total / page_size)) if total > 0 else 1
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
        "departments": [{"id": d["id"], "name": d["name"]} for d in dept_rows if d.get("id")],
    }


async def get_admin_complaint_escalations(token: str, complaint_id: str) -> Dict[str, Any]:
    comp_rows, _ = await _rest_get(
        token,
        "complaints",
        [
            ("id", f"eq.{complaint_id}"),
            (
                "select",
                "id,complaint_number,title,category,ward,status,department_id,"
                "assigned_officer_id,sla_deadline,created_at,updated_at,"
                "departments(id,name),complaint_sla_state(current_level,overdue_marked_at,last_escalated_at)",
            ),
        ],
    )
    if not comp_rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Complaint not found.")

    comp = comp_rows[0]
    sla_state_raw = comp.get("complaint_sla_state")
    if isinstance(sla_state_raw, list):
        sla_state = sla_state_raw[0] if sla_state_raw else {}
    elif isinstance(sla_state_raw, dict):
        sla_state = sla_state_raw
    else:
        sla_state = {}

    esc_rows, _ = await _rest_get(
        token,
        "complaint_escalations",
        [
            ("complaint_id", f"eq.{complaint_id}"),
            (
                "select",
                "id,complaint_id,from_level,to_level,status,reason,triggered_by,"
                "recipient_profile_id,recipient_officer_id,created_at",
            ),
            ("order", "created_at.desc"),
        ],
    )

    officer_map, profile_map = await _resolve_recipient_labels(
        token,
        [r.get("recipient_officer_id") for r in esc_rows],
        [r.get("recipient_profile_id") for r in esc_rows],
    )

    history = [
        {
            "id": r.get("id"),
            "from_level": r.get("from_level"),
            "to_level": r.get("to_level"),
            "status": r.get("status"),
            "reason": r.get("reason"),
            "triggered_by": r.get("triggered_by"),
            "recipient": _format_recipient_label(r, officer_map, profile_map),
            "created_at": r.get("created_at"),
        }
        for r in esc_rows
    ]

    dept = comp.get("departments") if isinstance(comp.get("departments"), dict) else {}
    return {
        "complaint": {
            "id": comp.get("id"),
            "complaint_reference": comp.get("complaint_number"),
            "title": comp.get("title"),
            "category": comp.get("category"),
            "ward": comp.get("ward"),
            "status": comp.get("status"),
            "department_id": comp.get("department_id"),
            "department_name": dept.get("name"),
            "sla_deadline": comp.get("sla_deadline"),
            "updated_at": comp.get("updated_at"),
            "current_level": int(sla_state.get("current_level", 0) or 0),
            "overdue_marked_at": sla_state.get("overdue_marked_at"),
            "last_escalated_at": sla_state.get("last_escalated_at"),
        },
        "history": history,
    }


async def trigger_manual_escalation(
    token: str, complaint_id: str, payload: ManualEscalationRequest
) -> Dict[str, Any]:
    res = await _rest_rpc(
        token,
        "escalate_complaint_manual",
        {
            "p_complaint_id": complaint_id,
            "p_reason": payload.reason,
            "p_expected_updated_at": payload.expected_updated_at,
        },
    )
    if not isinstance(res, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unexpected response from escalation service.",
        )
    return {
        "escalation_id": str(res.get("escalation_id", "")),
        "complaint_id": str(res.get("complaint_id", complaint_id)),
        "from_level": int(res.get("from_level", 0)),
        "to_level": int(res.get("to_level", 0)),
        "status": str(res.get("status", "completed")),
    }


async def list_admin_sla_rules(token: str) -> List[Dict[str, Any]]:
    rows, _ = await _rest_get(
        token,
        "category_sla_rules",
        [
            ("select", "category,sla_hours,reminder_before_hours,level2_after_hours,level3_after_hours,updated_at"),
            ("order", "category.asc"),
        ],
    )
    return rows


async def update_admin_sla_rule(
    token: str, category: str, payload: UpdateSlaRuleRequest
) -> Dict[str, Any]:
    if payload.expected_updated_at:
        existing_rows, _ = await _rest_get(
            token,
            "category_sla_rules",
            [("category", f"eq.{category}"), ("select", "category,updated_at")],
        )
        if not existing_rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Category SLA rule not found.",
            )
        current_updated = str(existing_rows[0].get("updated_at") or "")
        if current_updated and not _timestamps_equal_ms(current_updated, payload.expected_updated_at):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Stale SLA rule data: this rule was modified by another administrator. Refresh before saving.",
            )

    res = await _rest_rpc(
        token,
        "update_category_sla_rule",
        {
            "p_category": category,
            "p_sla_hours": payload.sla_hours,
            "p_reminder_before_hours": payload.reminder_before_hours,
            "p_level2_after_hours": payload.level2_after_hours,
            "p_level3_after_hours": payload.level3_after_hours,
        },
    )
    if not isinstance(res, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unexpected response updating SLA rule.",
        )
    return res


async def list_actor_notifications(
    actor: AuthenticatedActor,
    *,
    unread_only: bool,
    kind: Optional[str],
    page: int,
    page_size: int,
    include_reminder_kind: bool = False,
) -> Dict[str, Any]:
    params: List[Tuple[str, str]] = [
        ("recipient_profile_id", f"eq.{actor.user_id}"),
        ("select", "id,complaint_id,kind,title,message,event_key,is_read,read_at,created_at"),
        ("order", "created_at.desc"),
        ("limit", str(page_size)),
        ("offset", str((page - 1) * page_size)),
    ]
    if unread_only:
        params.append(("is_read", "eq.false"))
    if kind is not None:
        params.append(("kind", f"eq.{kind}"))

    rows, total = await _rest_get(actor.token, "notifications", params, count_exact=True)

    _, unread_count = await _rest_get(
        actor.token,
        "notifications",
        [
            ("recipient_profile_id", f"eq.{actor.user_id}"),
            ("is_read", "eq.false"),
            ("select", "id"),
            ("limit", "1"),
        ],
        count_exact=True,
    )

    complaint_ids = sorted({r["complaint_id"] for r in rows if r.get("complaint_id")})
    comp_map: Dict[str, Dict[str, Any]] = {}
    if complaint_ids:
        comp_rows, _ = await _rest_get(
            actor.token,
            "complaints",
            [
                ("id", f"in.({','.join(complaint_ids)})"),
                ("select", "id,complaint_number,category,ward,status"),
            ],
        )
        for c in comp_rows:
            if c.get("id"):
                comp_map[c["id"]] = c

    reminder_kind_map: Dict[str, str] = {}
    if include_reminder_kind:
        rem_ids: List[str] = []
        for r in rows:
            ek = str(r.get("event_key") or "")
            if ek.startswith("reminder:"):
                rem_ids.append(ek.split(":", 1)[1])
        if rem_ids:
            rem_rows, _ = await _rest_get(
                actor.token,
                "complaint_reminders",
                [
                    ("id", f"in.({','.join(sorted(set(rem_ids)))})"),
                    ("select", "id,kind"),
                ],
            )
            for rr in rem_rows:
                if rr.get("id"):
                    reminder_kind_map[rr["id"]] = rr.get("kind")

    items = []
    for r in rows:
        cid = r.get("complaint_id")
        comp = comp_map.get(cid, {}) if cid else {}
        ek = str(r.get("event_key") or "")
        rem_kind = None
        if include_reminder_kind and ek.startswith("reminder:"):
            rem_kind = reminder_kind_map.get(ek.split(":", 1)[1])
        items.append(
            {
                "id": r.get("id"),
                "complaint_id": cid,
                "complaint_reference": comp.get("complaint_number"),
                "category": comp.get("category"),
                "ward": comp.get("ward"),
                "complaint_status": comp.get("status"),
                "kind": r.get("kind"),
                "reminder_kind": rem_kind,
                "title": r.get("title"),
                "message": r.get("message"),
                "is_read": bool(r.get("is_read", False)),
                "read_at": r.get("read_at"),
                "created_at": r.get("created_at"),
            }
        )

    total_pages = max(1, math.ceil(total / page_size)) if total > 0 else 1
    return {
        "items": items,
        "unread_count": unread_count,
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
    }


async def mark_actor_notification_read(actor: AuthenticatedActor, notification_id: str) -> Dict[str, Any]:
    res = await _rest_rpc(
        actor.token,
        "mark_notification_read",
        {"p_notification_id": notification_id},
    )
    if res is not True:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Notification not found or you are no longer authorized to update it.",
        )
    return {"id": notification_id, "is_read": True}


async def list_officer_reminders(
    actor: AuthenticatedActor,
    *,
    kind: Optional[str],
    page: int,
    page_size: int,
) -> Dict[str, Any]:
    params: List[Tuple[str, str]] = [
        ("recipient_profile_id", f"eq.{actor.user_id}"),
        ("recipient_officer_id", f"eq.{actor.officer_id}"),
        (
            "select",
            "id,complaint_id,kind,created_at,"
            "complaints!inner(id,complaint_number,category,ward,status,sla_deadline,assigned_officer_id)",
        ),
        ("order", "created_at.desc"),
        ("limit", str(page_size)),
        ("offset", str((page - 1) * page_size)),
    ]
    if kind is not None:
        params.append(("kind", f"eq.{kind}"))

    rows, total = await _rest_get(actor.token, "complaint_reminders", params, count_exact=True)

    items = []
    for r in rows:
        comp = r.get("complaints") or {}
        items.append(
            {
                "id": r.get("id"),
                "complaint_id": r.get("complaint_id"),
                "complaint_reference": comp.get("complaint_number") or r.get("complaint_id"),
                "category": comp.get("category"),
                "ward": comp.get("ward"),
                "complaint_status": comp.get("status"),
                "sla_deadline": comp.get("sla_deadline"),
                "kind": r.get("kind"),
                "created_at": r.get("created_at"),
            }
        )

    total_pages = max(1, math.ceil(total / page_size)) if total > 0 else 1
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
    }


async def list_officer_escalations(
    actor: AuthenticatedActor,
    *,
    page: int,
    page_size: int,
) -> Dict[str, Any]:
    params: List[Tuple[str, str]] = [
        ("recipient_profile_id", f"eq.{actor.user_id}"),
        ("status", "eq.completed"),
        (
            "select",
            "id,complaint_id,from_level,to_level,reason,triggered_by,created_at,"
            "complaints!inner(id,complaint_number,category,ward,status,sla_deadline)",
        ),
        ("order", "created_at.desc"),
        ("limit", str(page_size)),
        ("offset", str((page - 1) * page_size)),
    ]
    rows, total = await _rest_get(actor.token, "complaint_escalations", params, count_exact=True)

    items = []
    for r in rows:
        comp = r.get("complaints") or {}
        items.append(
            {
                "id": r.get("id"),
                "complaint_id": r.get("complaint_id"),
                "complaint_reference": comp.get("complaint_number") or r.get("complaint_id"),
                "category": comp.get("category"),
                "ward": comp.get("ward"),
                "complaint_status": comp.get("status"),
                "sla_deadline": comp.get("sla_deadline"),
                "from_level": r.get("from_level"),
                "to_level": r.get("to_level"),
                "reason": r.get("reason"),
                "triggered_by": r.get("triggered_by"),
                "created_at": r.get("created_at"),
            }
        )

    total_pages = max(1, math.ceil(total / page_size)) if total > 0 else 1
    return {
        "items": items,
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages,
    }


async def get_citizen_followup_status(actor: AuthenticatedActor, complaint_id: str) -> Dict[str, bool]:
    res = await _rest_rpc(
        actor.token,
        "get_citizen_complaint_followup_status",
        {"p_complaint_id": complaint_id},
        not_found_on_42501=True,
    )
    if not isinstance(res, dict):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to retrieve complaint follow-up status.",
        )
    return {"is_followed_up": bool(res.get("is_followed_up", False))}
