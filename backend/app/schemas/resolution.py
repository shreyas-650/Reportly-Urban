"""
ReportlyUrban — Phase 8.1 Verified Completion Photo & Resolution Schemas
Strict Pydantic models with extra='forbid' for resolution photo upload, registration retry,
and guarded complaint resolution.
"""

from datetime import datetime
import re
from typing import Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator

RESOLUTION_PATH_REGEX = re.compile(
    r"^resolution/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/"
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$",
    re.IGNORECASE,
)


def validate_resolution_storage_path(value: str, complaint_id: Optional[str] = None) -> str:
    if not isinstance(value, str):
        raise ValueError("Invalid resolution storage path.")
    trimmed = value.strip()
    if not RESOLUTION_PATH_REGEX.match(trimmed):
        raise ValueError("Invalid resolution image path format.")
    if complaint_id and not trimmed.lower().startswith(f"resolution/{complaint_id.lower()}/"):
        raise ValueError("Resolution image path does not belong to the target complaint.")
    return trimmed


class ResolutionPhotoUploadResponse(BaseModel):
    evidence_id: str
    storage_path: str
    mime_type: Literal["image/jpeg", "image/png", "image/webp"]
    file_size_bytes: int
    width: int
    height: int
    sha256_hash: str
    upload_status: Literal["completed"]
    exif_stripped: bool


class RegisterResolutionPhotoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    storage_path: str = Field(..., min_length=20, max_length=256)

    @field_validator("storage_path")
    @classmethod
    def check_storage_path(cls, value: str) -> str:
        return validate_resolution_storage_path(value)


class ResolveComplaintRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_updated_at: str = Field(..., min_length=10, max_length=64)
    public_description: str = Field(..., min_length=10, max_length=2000)
    resolution_image_path: str = Field(..., min_length=20, max_length=256)
    internal_note: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("expected_updated_at")
    @classmethod
    def check_expected_updated_at(cls, value: str) -> str:
        trimmed = value.strip()
        try:
            datetime.fromisoformat(trimmed.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("expected_updated_at must be a valid ISO-8601 timestamp.")
        return trimmed

    @field_validator("public_description")
    @classmethod
    def check_public_description(cls, value: str) -> str:
        trimmed = value.strip()
        if len(trimmed) < 10:
            raise ValueError("Public resolution statement must be at least 10 characters.")
        return trimmed

    @field_validator("resolution_image_path")
    @classmethod
    def check_resolution_image_path(cls, value: str) -> str:
        return validate_resolution_storage_path(value)


class ResolveComplaintResponse(BaseModel):
    complaint_id: str
    status: Literal["resolved"]
    resolution_image_path: str
