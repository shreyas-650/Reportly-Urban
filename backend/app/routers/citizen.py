"""
ReportlyUrban — Phase 7.3 Citizen Follow-Up Status Router
Exposes strictly a privacy-safe boolean indicator on an authenticated, ownership-checked endpoint.
"""

from fastapi import APIRouter, Body, Depends, Request, Response

from app.schemas.sla import (
    CitizenFollowupResponse,
    parse_uuid_param,
    reject_extra_query_params,
)
from app.schemas.verification import (
    CitizenVerificationStatusResponse,
    ResolutionDisputeRequest,
    ResolutionVerifyRequest,
    VerificationSubmissionResponse,
)
from app.services.auth_service import AuthenticatedActor, require_citizen
from app.services.phase7_service import get_citizen_followup_status
from app.services.verification_service import (
    get_citizen_verification_status,
    submit_citizen_verification,
)

router = APIRouter(prefix="/api/citizen", tags=["Citizen Complaint Status"])
complaints_router = APIRouter(prefix="/api/complaints", tags=["Citizen Resolution Verification"])


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


@complaints_router.get(
    "/{complaint_id}/resolution/verification",
    response_model=CitizenVerificationStatusResponse,
)
async def get_citizen_resolution_verification_endpoint(
    complaint_id: str,
    request: Request,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    reject_extra_query_params(request, frozenset())
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await get_citizen_verification_status(actor, clean_id)
    response.headers["Cache-Control"] = "no-store"
    return data


@complaints_router.post(
    "/{complaint_id}/resolution/verify",
    response_model=VerificationSubmissionResponse,
)
async def verify_complaint_resolution_endpoint(
    complaint_id: str,
    response: Response,
    payload: ResolutionVerifyRequest = Body(default_factory=ResolutionVerifyRequest),
    actor: AuthenticatedActor = Depends(require_citizen),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await submit_citizen_verification(
        actor,
        clean_id,
        decision="verified",
        reason=payload.reason,
        evidence_id=payload.evidence_id,
    )
    response.headers["Cache-Control"] = "no-store"
    return data


@complaints_router.post(
    "/{complaint_id}/resolution/dispute",
    response_model=VerificationSubmissionResponse,
)
async def dispute_complaint_resolution_endpoint(
    complaint_id: str,
    payload: ResolutionDisputeRequest,
    response: Response,
    actor: AuthenticatedActor = Depends(require_citizen),
):
    clean_id = parse_uuid_param(complaint_id, "complaint_id")
    data = await submit_citizen_verification(
        actor,
        clean_id,
        decision="disputed",
        reason=payload.reason,
        evidence_id=payload.evidence_id,
    )
    response.headers["Cache-Control"] = "no-store"
    return data
