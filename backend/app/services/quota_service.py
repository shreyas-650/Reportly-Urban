"""
ReportlyUrban — Quota Management & Atomic Rate Limiting Service
Coordinates database-level and concurrency-safe quota reservation, finalization, and refunds.
"""

import asyncio
from typing import Optional, Dict
from datetime import datetime, timezone, timedelta
import httpx
from fastapi import HTTPException, status

from app.config import settings

# In-memory concurrency lock for requests
_user_locks: Dict[str, asyncio.Lock] = {}

def get_user_lock(citizen_id: str) -> asyncio.Lock:
    if citizen_id not in _user_locks:
        _user_locks[citizen_id] = asyncio.Lock()
    return _user_locks[citizen_id]


class QuotaReservation:
    def __init__(self, reservation_id: str, citizen_id: str, is_db_backed: bool = False):
        self.reservation_id = reservation_id
        self.citizen_id = citizen_id
        self.is_db_backed = is_db_backed
        self.status = "reserved"


# In-memory reservation tracker (used as local fallback when DB migration is pending)
_local_usage_log = []


async def reserve_quota(citizen_id: str) -> QuotaReservation:
    """
    Attempts to atomically reserve quota for a citizen.
    First tries the database RPC (reserve_ai_analysis_quota) if service key is configured.
    Falls back to strict concurrency-locked local tracking when migration is pending.
    """
    user_lock = get_user_lock(citizen_id)
    await user_lock.acquire()
    
    try:
        # Check if database service key is configured
        if settings.SUPABASE_SERVICE_ROLE_KEY and settings.SUPABASE_URL:
            rpc_url = f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/rpc/reserve_ai_analysis_quota"
            headers = {
                "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
            }
            payload = {
                "p_citizen_id": citizen_id,
                "p_global_daily_cap": settings.GLOBAL_DAILY_AI_CAP,
            }
            
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    res = await client.post(rpc_url, json=payload, headers=headers)
                
                if res.status_code == 200:
                    reservation_id = res.json()
                    return QuotaReservation(
                        reservation_id=str(reservation_id),
                        citizen_id=citizen_id,
                        is_db_backed=True
                    )
                elif res.status_code == 400 or res.status_code == 409 or res.status_code == 422:
                    err_msg = res.text
                    if "P0429" in err_msg or "42901" in err_msg or "User daily AI analysis limit" in err_msg:
                        raise HTTPException(
                            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail=f"Daily AI analysis quota reached ({settings.USER_DAILY_AI_LIMIT}/{settings.USER_DAILY_AI_LIMIT}). You may still file grievances manually."
                        )
                    if "P0430" in err_msg or "42902" in err_msg or "Global daily AI quota" in err_msg:
                        raise HTTPException(
                            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="Municipal AI analysis service has reached its daily system quota. Please submit manually."
                        )
            except HTTPException:
                raise
            except Exception:
                # If DB function does not exist yet (migration unapplied), proceed to strict local enforcement
                pass

        # Concurrency-safe local rate limiter (UTC timezone accounting)
        now_utc = datetime.now(timezone.utc)
        rolling_24h = now_utc - timedelta(hours=24)
        today_utc = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Count user usage in rolling 24h
        user_active = [
            u for u in _local_usage_log
            if u["citizen_id"] == citizen_id
            and u["status"] in ("reserved", "succeeded")
            and u["timestamp"] > rolling_24h
        ]
        if len(user_active) >= settings.USER_DAILY_AI_LIMIT:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Daily AI analysis quota reached ({settings.USER_DAILY_AI_LIMIT}/{settings.USER_DAILY_AI_LIMIT}). You may still file grievances manually."
            )
        
        # Count global usage today
        global_active = [
            u for u in _local_usage_log
            if u["status"] in ("reserved", "succeeded")
            and u["timestamp"] >= today_utc
        ]
        if len(global_active) >= settings.GLOBAL_DAILY_AI_CAP:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Municipal AI analysis service has reached its daily system quota. Please submit manually."
            )
        
        import uuid
        res_id = str(uuid.uuid4())
        _local_usage_log.append({
            "id": res_id,
            "citizen_id": citizen_id,
            "status": "reserved",
            "timestamp": now_utc
        })
        
        return QuotaReservation(reservation_id=res_id, citizen_id=citizen_id, is_db_backed=False)
    finally:
        user_lock.release()


async def finalize_quota(reservation: QuotaReservation) -> None:
    """Finalizes quota reservation upon successful model execution."""
    if reservation.status != "reserved":
        return
    
    reservation.status = "succeeded"
    
    if reservation.is_db_backed and settings.SUPABASE_SERVICE_ROLE_KEY:
        rpc_url = f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/rpc/finalize_ai_analysis_quota"
        headers = {
            "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(rpc_url, json={"p_reservation_id": reservation.reservation_id}, headers=headers)
        except Exception:
            pass
    else:
        for u in _local_usage_log:
            if u["id"] == reservation.reservation_id:
                u["status"] = "succeeded"
                break


async def refund_quota(reservation: QuotaReservation, error_reason: Optional[str] = None) -> None:
    """Refunds quota reservation if Gemini fails, times out, or response is invalid."""
    if reservation.status != "reserved":
        return  # Prevent duplicate refunds
    
    reservation.status = "refunded"
    
    if reservation.is_db_backed and settings.SUPABASE_SERVICE_ROLE_KEY:
        rpc_url = f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/rpc/refund_ai_analysis_quota"
        headers = {
            "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    rpc_url,
                    json={
                        "p_reservation_id": reservation.reservation_id,
                        "p_error_reason": error_reason or "Analysis failed"
                    },
                    headers=headers
                )
        except Exception:
            pass
    else:
        for u in _local_usage_log:
            if u["id"] == reservation.reservation_id:
                u["status"] = "refunded"
                break


def get_remaining_quota_count(citizen_id: str) -> int:
    """Computes remaining quota count for a citizen within rolling 24h."""
    now_utc = datetime.now(timezone.utc)
    rolling_24h = now_utc - timedelta(hours=24)
    used = sum(
        1 for u in _local_usage_log
        if u["citizen_id"] == citizen_id
        and u["status"] in ("reserved", "succeeded")
        and u["timestamp"] > rolling_24h
    )
    return max(0, settings.USER_DAILY_AI_LIMIT - used)
