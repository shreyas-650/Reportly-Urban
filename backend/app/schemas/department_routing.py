"""
ReportlyUrban — Phase 9.2 Department Auto-Assignment Schemas
"""

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

from app.schemas.ai import CivicCategoryType


RoutingModeLiteral = Literal["off", "shadow", "active"]


class CitizenDepartmentRoutingTriggerResponse(BaseModel):
    accepted: bool = True
    queued: bool
    mode: RoutingModeLiteral


class AdminMappingUpsertRequest(BaseModel):
    category: CivicCategoryType
    department_id: str = Field(..., min_length=36, max_length=36)
    ward: Optional[str] = Field(default=None, max_length=100)
    is_active: bool = False
    mapping_id: Optional[str] = Field(default=None, min_length=36, max_length=36)


class AdminMappingResponse(BaseModel):
    id: str
    category: str
    ward: Optional[str] = None
    department_id: str
    is_active: bool
    updated_at: Optional[str] = None


class AdminAccuracyMetricItem(BaseModel):
    id: str
    category: str
    ward: Optional[str] = None
    model_name: str
    prompt_version: str
    sample_size: int
    correct_count: int
    accuracy: float
    measured_at: str


class AdminTriageQueueItem(BaseModel):
    id: str
    complaint_id: str
    ai_decision_id: Optional[str] = None
    reason_code: str
    mode: str
    suggested_department_id: Optional[str] = None
    gate_snapshot: Optional[Dict[str, Any]] = None
    resolved_at: Optional[str] = None
    resolved_by: Optional[str] = None
    created_at: str
    updated_at: str


class AdminDepartmentEventItem(BaseModel):
    id: str
    complaint_id: str
    actor_type: Literal["system_ai", "staff"]
    actor_id: Optional[str] = None
    ai_decision_id: Optional[str] = None
    prev_department_id: Optional[str] = None
    new_department_id: Optional[str] = None
    suggested_department_id: Optional[str] = None
    model_name: Optional[str] = None
    prompt_version: Optional[str] = None
    confidence: Optional[float] = None
    mode: Optional[str] = None
    gate_snapshot: Optional[Dict[str, Any]] = None
    applied: bool
    is_ai_override: bool
    reason_code: Optional[str] = None
    created_at: str


class AdminComplaintDepartmentRoutingResponse(BaseModel):
    mode: RoutingModeLiteral
    triage_entry: Optional[AdminTriageQueueItem] = None
    events: List[AdminDepartmentEventItem] = Field(default_factory=list)


class AdminDepartmentRoutingOverviewResponse(BaseModel):
    mode: RoutingModeLiteral
    min_samples: int
    min_accuracy: float
    metrics_max_age_days: int
    min_confidence: float
    mappings: List[AdminMappingResponse] = Field(default_factory=list)
    metrics: List[AdminAccuracyMetricItem] = Field(default_factory=list)
    open_triage_queue: List[AdminTriageQueueItem] = Field(default_factory=list)


class AdminRefreshMetricsResponse(BaseModel):
    success: bool
    ward_metrics_updated: int
    citywide_metrics_updated: int
    total_updated: int
    measured_at: str
