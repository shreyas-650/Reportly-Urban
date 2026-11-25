"""
ReportlyUrban — Phase 7.3 Citizen Follow-Up Status Router
Exposes strictly a privacy-safe boolean indicator on an authenticated, ownership-checked endpoint.
"""

from fastapi import APIRouter, Depends, Request, Response

from app.schemas.sla import (
    CitizenFollowupResponse,
    parse_uuid_param,
    reject_extra_query_params,
)
from app.services.auth_service import AuthenticatedActor, require_citizen
from app.services.phase7_service import get_citizen_followup_status

router = APIRouter(prefix="/api/citizen", tags=["Citizen Complaint Status"])


@router.get("/complaints/{complaint_id}/followup", response_model=CitizenFollowupResponse)
async def get_citizen_followup_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_citizen_followup_status(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data
