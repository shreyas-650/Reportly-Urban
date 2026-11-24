"""
ReportlyUrban — AI Problem Detection Router
Handles authenticated citizen image submissions, quota enforcement, and Gemini Vision requests.
"""

import asyncio
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, status
from app.config import settings
from app.schemas.ai import AIAnalysisResponse
from app.services.auth_service import get_citizen_user
from app.services.image_service import read_and_validate_image_file
from app.services.gemini_service import analyze_civic_image
from app.services.quota_service import (
    reserve_quota,
    finalize_quota,
    refund_quota,
    get_remaining_quota_count,
)

router = APIRouter(prefix="/api/ai", tags=["AI Problem Detection"])


@router.post("/analyze-issue", response_model=AIAnalysisResponse)
async def analyze_issue_endpoint(
    file: UploadFile = File(...),
    citizen_id: str = Depends(get_citizen_user),
):
    """
    Analyzes an uploaded civic complaint photograph using Gemini Vision.
    
    Security & Validation Pipeline:
    1. Authenticates citizen via Supabase ES256 JWT; denies officers/admins (403).
    2. Streams & validates image: limits to 5 MB, verifies magic bytes, checks decompression bomb limits.
    3. Concurrency-safe quota reservation (max 10/day per citizen).
    4. Analyzes with Gemini Vision under fixed prompt and strict response schema.
    5. Finalizes quota on success; refunds quota on AI timeout or provider error.
    """
    # 1. Validate image format & size before allocating processing time
    image_bytes, mime_type = await read_and_validate_image_file(file)
    
    # 2. Reserve daily quota (atomic per-user & global check)
    reservation = await reserve_quota(citizen_id)
    
    # 3. Execute Gemini Vision analysis with strict timeout
    try:
        analysis_result = await asyncio.wait_for(
            analyze_civic_image(image_bytes, mime_type),
            timeout=settings.GEMINI_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        await refund_quota(reservation, "Gemini Vision request timed out")
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="AI analysis service timed out. Please try again or fill in the details manually."
        )
    except Exception as exc:
        await refund_quota(reservation, str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI vision service encountered a processing error. Manual submission remains available."
        )
    
    # 4. Finalize quota reservation on successful completion
    await finalize_quota(reservation)
    
    # 5. Attach remaining quota count
    analysis_result.quota_remaining = get_remaining_quota_count(citizen_id)
    
    return analysis_result
