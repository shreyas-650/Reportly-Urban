"""
ReportlyUrban — Phase 8.1 Resolution Photo & Verified Resolve Service
Enforces trusted-boundary validation, EXIF/GPS stripping prior to storage,
registration retry handling, storage object existence checks, and safe error mapping.
"""

import logging
import uuid
from typing import Any, Dict, Optional
import httpx
from fastapi import HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from app.config import settings
from app.schemas.resolution import (
    RegisterResolutionPhotoRequest,
    ResolveComplaintRequest,
    validate_resolution_storage_path,
)
from app.services.auth_service import AuthenticatedActor
from app.services.image_service import (
    StrippedImageResult,
    read_validate_and_strip_resolution_image,
    verify_already_stripped_resolution_bytes,
)

logger = logging.getLogger("reportly.phase8_1.resolution")

_STORAGE_TIMEOUT = httpx.Timeout(connect=10.0, read=20.0, write=20.0, pool=10.0)
_RPC_TIMEOUT = httpx.Timeout(connect=10.0, read=12.0, write=10.0, pool=10.0)
_BUCKET_NAME = "complaint-images"


class RegistrationPendingError(Exception):
    """Raised when storage upload succeeded but evidence metadata registration failed."""

    def __init__(self, status_code: int, message: str, storage_path: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.storage_path = storage_path


def _ensure_supabase_anon_config() -> str:
    if not settings.SUPABASE_URL or not settings.SUPABASE_ANON_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Storage and database configuration is unavailable.",
        )
    return settings.SUPABASE_URL.rstrip("/")


def _ensure_supabase_service_config() -> str:
    base_url = _ensure_supabase_anon_config()
    if not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Resolution verification service configuration is incomplete.",
        )
    return base_url


def _user_headers(token: str, *, content_type: Optional[str] = "application/json") -> Dict[str, str]:
    headers = {
        "apikey": settings.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _service_headers() -> Dict[str, str]:
    return {
        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def _load_complaint_for_actor(actor: AuthenticatedActor, complaint_id: str) -> Dict[str, Any]:
    """Loads complaint through caller's RLS-scoped token and verifies current role & assignment."""
    base_url = _ensure_supabase_anon_config()
    url = f"{base_url}/rest/v1/complaints"
    params = [
        ("id", f"eq.{complaint_id}"),
        ("select", "id,status,assigned_officer_id,updated_at"),
    ]
    try:
        async with httpx.AsyncClient(timeout=_RPC_TIMEOUT) as client:
            res = await client.get(url, params=params, headers=_user_headers(actor.token))
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timed out while checking complaint details. Please try again.",
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach complaint service.",
        )

    if res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to access this complaint.",
        )
    if res.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to verify complaint status right now.",
        )

    rows = res.json()
    if not isinstance(rows, list) or len(rows) == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Complaint not found or access denied.",
        )

    complaint = rows[0]
    if actor.role == "officer":
        if not actor.officer_id or complaint.get("assigned_officer_id") != actor.officer_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the currently assigned officer can complete or upload evidence for this complaint.",
            )
    elif actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Staff privileges required.",
        )

    return complaint


def _require_in_progress(complaint: Dict[str, Any]) -> None:
    current_status = str(complaint.get("status") or "").strip().lower()
    if current_status == "resolved":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This complaint has already been marked resolved.",
        )
    if current_status == "rejected":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Rejected complaints cannot be resolved.",
        )
    if current_status != "in_progress":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Complaint must be in progress before attaching completion evidence or resolving.",
        )


async def _upload_bytes_to_storage(
    token: str, storage_path: str, image_bytes: bytes, mime_type: str
) -> None:
    """Uploads stripped image bytes using the caller's verified JWT so Storage RLS is enforced."""
    base_url = _ensure_supabase_anon_config()
    url = f"{base_url}/storage/v1/object/{_BUCKET_NAME}/{storage_path}"
    headers = {
        "apikey": settings.SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": mime_type,
        "x-upsert": "false",
        "cache-control": "3600",
    }
    try:
        async with httpx.AsyncClient(timeout=_STORAGE_TIMEOUT) as client:
            res = await client.post(url, content=image_bytes, headers=headers)
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Uploading the completion photograph timed out. Please try again.",
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach photo storage service.",
        )

    if res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not permitted to upload completion evidence for this complaint.",
        )
    if res.status_code == 409:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A completion photo with this identifier already exists.",
        )
    if res.status_code not in (200, 201):
        logger.warning("Storage upload failed status=%s", res.status_code)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to store the verified completion photograph. Please try again.",
        )


async def _download_storage_object_bytes(token: str, storage_path: str) -> bytes:
    """Fetches stored completion photo bytes through caller's JWT to verify existence & cleanliness."""
    base_url = _ensure_supabase_anon_config()
    url = f"{base_url}/storage/v1/object/authenticated/{_BUCKET_NAME}/{storage_path}"
    try:
        async with httpx.AsyncClient(timeout=_STORAGE_TIMEOUT) as client:
            res = await client.get(url, headers=_user_headers(token, content_type=None))
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timed out while verifying stored completion photograph.",
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach photo storage service.",
        )

    if res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to verify this completion photograph.",
        )
    if res.status_code == 404:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Completion photograph was not found in storage. Please upload it again.",
        )
    if res.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Failed to verify stored completion photograph.",
        )
    return res.content


async def _check_storage_object_exists(token: str, storage_path: str) -> bool:
    """Confirms stored completion photo exists in Supabase Storage using caller JWT."""
    base_url = _ensure_supabase_anon_config()
    url = f"{base_url}/storage/v1/object/authenticated/{_BUCKET_NAME}/{storage_path}"
    try:
        async with httpx.AsyncClient(timeout=_RPC_TIMEOUT) as client:
            res = await client.head(url, headers=_user_headers(token, content_type=None))
            if res.status_code == 405:
                res = await client.get(url, headers=_user_headers(token, content_type=None))
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timed out while confirming stored completion photograph.",
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach photo storage service.",
        )

    if res.status_code == 200:
        return True
    if res.status_code == 404:
        return False
    if res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to access this completion photograph.",
        )
    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Unable to confirm stored completion photograph.",
    )


def _extract_pg_error_code_and_message(response: httpx.Response) -> tuple[str, str]:
    try:
        body = response.json()
        if isinstance(body, dict):
            return str(body.get("code", "")).strip(), str(body.get("message", "")).strip().lower()
    except ValueError:
        pass
    return "", ""


async def _register_evidence_record(
    actor: AuthenticatedActor,
    complaint_id: str,
    storage_path: str,
    stripped: StrippedImageResult,
) -> str:
    """Calls trusted service_role RPC register_resolution_evidence without leaking internal errors."""
    base_url = _ensure_supabase_service_config()
    url = f"{base_url}/rest/v1/rpc/register_resolution_evidence"
    payload = {
        "p_complaint_id": complaint_id,
        "p_storage_path": storage_path,
        "p_uploaded_by": actor.user_id,
        "p_file_size_bytes": len(stripped.image_bytes),
        "p_mime_type": stripped.mime_type,
        "p_exif_stripped": True,
        "p_image_width": stripped.width,
        "p_image_height": stripped.height,
        "p_sha256_hash": stripped.sha256_hash,
    }
    try:
        async with httpx.AsyncClient(timeout=_RPC_TIMEOUT) as client:
            res = await client.post(url, json=payload, headers=_service_headers())
    except httpx.TimeoutException:
        raise RegistrationPendingError(
            status.HTTP_504_GATEWAY_TIMEOUT,
            "The photo was uploaded, but saving its completion record timed out. Please retry saving the record.",
            storage_path,
        )
    except httpx.RequestError:
        raise RegistrationPendingError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The photo was uploaded, but the database could not be reached to save its record. Please retry saving.",
            storage_path,
        )

    if res.status_code == 200:
        data = res.json()
        return str(data)

    code, msg = _extract_pg_error_code_and_message(res)
    logger.warning("register_resolution_evidence failed status=%s code=%s", res.status_code, code or "unknown")
    if code == "42501" or res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to register completion evidence for this complaint.",
        )
    if code == "23503":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Uploaded completion photograph could not be verified in storage.",
        )
    if code == "P0001" and "in_progress" in msg:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Complaint is no longer in progress.",
        )
    raise RegistrationPendingError(
        status.HTTP_502_BAD_GATEWAY,
        "The photo was uploaded, but saving its completion record failed. Please retry saving the record.",
        storage_path,
    )


async def _fetch_registered_evidence(
    token: str, complaint_id: str, storage_path: str
) -> Optional[Dict[str, Any]]:
    base_url = _ensure_supabase_anon_config()
    url = f"{base_url}/rest/v1/complaint_resolution_evidence"
    params = [
        ("complaint_id", f"eq.{complaint_id}"),
        ("storage_path", f"eq.{storage_path}"),
        ("select", "id,complaint_id,storage_path,file_size_bytes,mime_type,upload_status,exif_stripped"),
    ]
    try:
        async with httpx.AsyncClient(timeout=_RPC_TIMEOUT) as client:
            res = await client.get(url, params=params, headers=_user_headers(token))
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timed out while verifying completion photo record.",
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach database while verifying completion photo.",
        )

    if res.status_code in (401, 403):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to inspect completion evidence for this complaint.",
        )
    if res.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to verify completion photo record right now.",
        )

    rows = res.json()
    return rows[0] if isinstance(rows, list) and len(rows) > 0 else None


async def upload_and_register_resolution_photo(
    actor: AuthenticatedActor, complaint_id: str, file: UploadFile
) -> Dict[str, Any]:
    complaint = await _load_complaint_for_actor(actor, complaint_id)
    _require_in_progress(complaint)

    stripped = await read_validate_and_strip_resolution_image(file)
    storage_path = f"resolution/{complaint_id}/{uuid.uuid4()}.{stripped.extension}"

    await _upload_bytes_to_storage(actor.token, storage_path, stripped.image_bytes, stripped.mime_type)
    evidence_id = await _register_evidence_record(actor, complaint_id, storage_path, stripped)

    return {
        "evidence_id": evidence_id,
        "storage_path": storage_path,
        "mime_type": stripped.mime_type,
        "file_size_bytes": len(stripped.image_bytes),
        "width": stripped.width,
        "height": stripped.height,
        "sha256_hash": stripped.sha256_hash,
        "upload_status": "completed",
        "exif_stripped": True,
    }


async def retry_register_resolution_photo(
    actor: AuthenticatedActor,
    complaint_id: str,
    body: RegisterResolutionPhotoRequest,
) -> Dict[str, Any]:
    try:
        clean_path = validate_resolution_storage_path(body.storage_path, complaint_id=complaint_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid completion photograph path for this complaint.",
        )

    complaint = await _load_complaint_for_actor(actor, complaint_id)
    _require_in_progress(complaint)

    raw_bytes = await _download_storage_object_bytes(actor.token, clean_path)
    verified = verify_already_stripped_resolution_bytes(raw_bytes)
    evidence_id = await _register_evidence_record(actor, complaint_id, clean_path, verified)

    return {
        "evidence_id": evidence_id,
        "storage_path": clean_path,
        "mime_type": verified.mime_type,
        "file_size_bytes": len(verified.image_bytes),
        "width": verified.width,
        "height": verified.height,
        "sha256_hash": verified.sha256_hash,
        "upload_status": "completed",
        "exif_stripped": True,
    }


def _map_transition_rpc_error(res: httpx.Response) -> HTTPException:
    code, msg = _extract_pg_error_code_and_message(res)
    logger.warning("transition_complaint_status failed status=%s code=%s", res.status_code, code or "unknown")

    if code == "42501" or res.status_code in (401, 403):
        return HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are no longer authorized or assigned to resolve this complaint.",
        )
    if code == "40001":
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This complaint was updated by another session. Refreshing latest status.",
        )
    if code == "23503":
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Stored completion photograph was not found. Please upload a completion photo again.",
        )
    if code == "P0001":
        if "terminal state" in msg:
            return HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This complaint is already closed and cannot be updated again.",
            )
        if "incomplete" in msg or "pending" in msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Completion photograph upload is still pending and must finish before resolving.",
            )
        if "unverified" in msg or "metadata" in msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Completion photograph must pass server verification before resolving.",
            )
        if "resolution evidence required" in msg or "invalid evidence path" in msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A completed completion photograph belonging to this complaint is required.",
            )
        if "statement required" in msg:
            return HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A public resolution statement of at least 10 characters is required.",
            )
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Unable to resolve complaint with the current status or evidence.",
        )

    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Unable to complete resolution right now. Please try again shortly.",
    )


async def resolve_complaint_with_verified_photo(
    actor: AuthenticatedActor,
    complaint_id: str,
    body: ResolveComplaintRequest,
    *,
    allow_internal_note: bool = False,
) -> Dict[str, Any]:
    try:
        clean_path = validate_resolution_storage_path(
            body.resolution_image_path, complaint_id=complaint_id
        )
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Completion photograph path is invalid or belongs to another complaint.",
        )

    # 1. Recheck caller's role & CURRENT assignment and status at resolution time
    complaint = await _load_complaint_for_actor(actor, complaint_id)
    _require_in_progress(complaint)

    # 2. Verify registered completion evidence exists for this complaint and is complete + stripped
    evidence = await _fetch_registered_evidence(actor.token, complaint_id, clean_path)
    if not evidence:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Completion photograph is not registered for this complaint yet. Please finish or retry photo saving.",
        )
    if evidence.get("upload_status") != "completed":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Completion photograph upload is still pending and cannot be used to resolve yet.",
        )
    if evidence.get("exif_stripped") is not True:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Completion photograph has not passed server metadata removal verification.",
        )

    # 3. Verify stored object actually exists in Storage before calling DB transition
    exists_in_storage = await _check_storage_object_exists(actor.token, clean_path)
    if not exists_in_storage:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Stored completion photograph is missing from storage. Please re-upload before resolving.",
        )

    # 4. Execute atomic DB transition as verified caller JWT
    base_url = _ensure_supabase_anon_config()
    url = f"{base_url}/rest/v1/rpc/transition_complaint_status"
    payload = {
        "p_complaint_id": complaint_id,
        "p_new_status": "resolved",
        "p_expected_updated_at": body.expected_updated_at,
        "p_public_description": body.public_description,
        "p_internal_note": body.internal_note if allow_internal_note and body.internal_note else None,
        "p_resolution_image_path": clean_path,
    }
    try:
        async with httpx.AsyncClient(timeout=_RPC_TIMEOUT) as client:
            res = await client.post(url, json=payload, headers=_user_headers(actor.token))
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="The resolve request timed out. Checking complaint status before retrying is recommended.",
        )
    except httpx.RequestError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reach resolution service. Please check status before retrying.",
        )

    if res.status_code not in (200, 204):
        raise _map_transition_rpc_error(res)

    return {
        "complaint_id": complaint_id,
        "status": "resolved",
        "resolution_image_path": clean_path,
    }


async def handle_resolution_photo_upload(
    actor: AuthenticatedActor, complaint_id: str, file: UploadFile
):
    """Shared router helper returning safe partial-failure JSONResponse if registration fails."""
    try:
        return await upload_and_register_resolution_photo(actor, complaint_id, file)
    except RegistrationPendingError as pending_err:
        return JSONResponse(
            status_code=pending_err.status_code,
            content={
                "detail": pending_err.message,
                "storage_path": pending_err.storage_path,
                "registration_pending": True,
            },
            headers={"Cache-Control": "no-store"},
        )
