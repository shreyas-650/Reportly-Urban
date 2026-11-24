"""
ReportlyUrban — AI Analysis Schemas & Enums
Enforces category whitelist and length validation conforming strictly to database constraints.
"""

from typing import Optional, Literal
from pydantic import BaseModel, Field, field_validator

# Whitelist matching EXACT check constraint in public.complaints:
# CHECK (category IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure'))
VALID_CIVIC_CATEGORIES = (
    'potholes',
    'garbage',
    'streetlights',
    'water_leakage',
    'drainage',
    'public_infrastructure',
)

CivicCategoryType = Literal[
    'potholes',
    'garbage',
    'streetlights',
    'water_leakage',
    'drainage',
    'public_infrastructure',
]


class CivicAnalysisGeminiRaw(BaseModel):
    """
    Direct response schema supplied to Gemini Vision API.
    All fields are validated upon receipt from the model.
    """
    is_civic_issue: bool
    detected_issue: Optional[str] = Field(default=None, max_length=200)
    suggested_category: Optional[str] = None
    suggested_title: Optional[str] = Field(default=None, max_length=150)
    suggested_description: Optional[str] = Field(default=None, max_length=1000)
    confidence: float = Field(ge=0.0, le=1.0)
    uncertainty_reason: Optional[str] = Field(default=None, max_length=300)


class CivicSuggestions(BaseModel):
    """
    Validated suggestions safe for presentation to the citizen.
    Title and description conform strictly to database length limits.
    """
    category: CivicCategoryType
    title: str = Field(min_length=5, max_length=100)
    description: str = Field(min_length=15, max_length=500)
    confidence: float = Field(ge=0.0, le=1.0)
    detected_issue: str = Field(min_length=3, max_length=150)


class AIAnalysisResponse(BaseModel):
    """
    Final JSON response returned to the frontend.
    If is_civic_issue is false or confidence is low, suggestions is null.
    """
    is_civic_issue: bool
    confidence: float
    suggestions: Optional[CivicSuggestions] = None
    uncertainty_reason: Optional[str] = None
    quota_remaining: Optional[int] = None
