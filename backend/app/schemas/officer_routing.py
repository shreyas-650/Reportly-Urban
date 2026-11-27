"""
ReportlyUrban — Phase 9.3 Officer Auto-Assignment Schemas
"""

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field


RoutingModeLiteral = Literal["off", "shadow", "active"]


class CitizenOfficerRoutingTriggerResponse(BaseModel):
    accepted: bool = True
    queued: bool
    mode: RoutingModeLiteral


class AdminOfficerRoutingTriggerResponse(BaseModel):
    accepted: bool = True
    mode: RoutingModeLiteral
    applied: bool = False
    reason_code: Optional[str] = None
    assigned_officer_id: Optional[str] = None
    proposed_officer_id: Optional[str] = None


class AdminOfficerTriageQueueItem(BaseModel):
    id: str
    complaint_id: str
    department_id: Optional[str] = None
    reason_code: str
    mode: str
    proposed_officer_id: Optional[str] = None
    workload_snapshot: Optional[Dict[str, Any]] = None
    resolved_at: Optional[str] = None
    resolved_by: Optional[str] = None
    created_at: str
    updated_at: str


class AdminOfficerAssignmentEventItem(BaseModel):
    id: str
    complaint_id: str
    actor_type: Literal["system_ai", "staff"]
    actor_id: Optional[str] = None
    department_id: Optional[str] = None
    prev_officer_id: Optional[str] = None
    new_officer_id: Optional[str] = None
    proposed_officer_id: Optional[str] = None
    mode: Optional[str] = None
    workload_snapshot: Optional[Dict[str, Any]] = None
    applied: bool
    is_ai_override: bool
    reason_code: Optional[str] = None
    created_at: str


class AdminComplaintOfficerRoutingResponse(BaseModel):
    mode: RoutingModeLiteral
    triage_entry: Optional[AdminOfficerTriageQueueItem] = None
    events: List[AdminOfficerAssignmentEventItem] = Field(default_factory=list)


class AdminOfficerRoutingOverviewResponse(BaseModel):
    mode: RoutingModeLiteral
    max_open_complaints: int
    allow_null_ward_fallback: bool
    open_triage_queue: List[AdminOfficerTriageQueueItem] = Field(default_factory=list)
