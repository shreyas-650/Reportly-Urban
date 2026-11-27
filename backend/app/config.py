"""
ReportlyUrban — Backend Configuration
Loads configuration from environment variables with safe defaults.
"""

import os
from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel, Field
from dotenv import load_dotenv

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent

# Load from backend/.env then root .env then frontend/.env regardless of working directory
load_dotenv(_BACKEND_DIR / ".env")
load_dotenv(_REPO_ROOT / ".env")
load_dotenv(_REPO_ROOT / "frontend" / ".env")


def parse_fail_closed_bool(raw_value: Optional[str]) -> bool:
    """Fail-closed boolean parser: only literal 'true' (case-insensitive) returns True."""
    if not isinstance(raw_value, str):
        return False
    return raw_value.strip().lower() == "true"


def _parse_positive_int(raw_value: Optional[str], default: int) -> int:
    if not raw_value:
        return default
    try:
        val = int(raw_value.strip())
        return val if val > 0 else default
    except ValueError:
        return default


def _parse_non_negative_int(raw_value: Optional[str], default: int) -> int:
    if not raw_value:
        return default
    try:
        val = int(raw_value.strip())
        return val if val >= 0 else default
    except ValueError:
        return default

def _strip_env_value(raw_value: Optional[str], default: str = "") -> str:
    if not isinstance(raw_value, str):
        return default
    cleaned = raw_value.strip()
    if len(cleaned) >= 2 and (
        (cleaned[0] == '"' and cleaned[-1] == '"')
        or (cleaned[0] == "'" and cleaned[-1] == "'")
    ):
        cleaned = cleaned[1:-1].strip()
    return cleaned or default


def parse_department_routing_mode(raw_value: Optional[str]) -> str:
    """Strict routing mode parser: only off|shadow|active allowed, default shadow."""
    if not isinstance(raw_value, str):
        return "shadow"
    cleaned = raw_value.strip().lower()
    if cleaned in ("off", "shadow", "active"):
        return cleaned
    return "shadow"


def _parse_unit_float(raw_value: Optional[str], default: float) -> float:
    if not raw_value:
        return default
    try:
        val = float(raw_value.strip())
        if 0.0 <= val <= 1.0:
            return val
        return default
    except ValueError:
        return default


def _parse_optional_float(raw_value: Optional[str]) -> Optional[float]:
    if not raw_value or not isinstance(raw_value, str):
        return None
    cleaned = raw_value.strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


class Settings(BaseModel):
    # Gemini Configuration
    GEMINI_API_KEY: str = _strip_env_value(os.getenv("GEMINI_API_KEY"), "")
    GEMINI_MODEL: str = _strip_env_value(os.getenv("GEMINI_MODEL"), "gemini-2.5-flash")
    
    # Supabase Configuration
    SUPABASE_URL: str = os.getenv("VITE_SUPABASE_URL") or os.getenv("SUPABASE_URL", "")
    SUPABASE_ANON_KEY: str = os.getenv("VITE_SUPABASE_ANON_KEY") or os.getenv("SUPABASE_ANON_KEY", "")
    SUPABASE_SERVICE_ROLE_KEY: str = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY", "")
    
    # Quota & Limits
    GLOBAL_DAILY_AI_CAP: int = int(os.getenv("GLOBAL_DAILY_AI_CAP", "500"))
    USER_DAILY_AI_LIMIT: int = int(os.getenv("USER_DAILY_AI_LIMIT", "10"))
    
    # Image Security Limits
    MAX_IMAGE_SIZE_BYTES: int = int(os.getenv("MAX_IMAGE_SIZE_BYTES", str(5 * 1024 * 1024))) # 5 MB
    MAX_IMAGE_PIXELS: int = int(os.getenv("MAX_IMAGE_PIXELS", "10000000")) # 10 MP (decompression bomb protection)
    
    # CORS Configuration
    CORS_ORIGINS: List[str] = [
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000").split(",")
        if origin.strip()
    ]
    
    # API Timeouts & Runtime Environment
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")
    GEMINI_TIMEOUT_SECONDS: float = float(os.getenv("GEMINI_TIMEOUT_SECONDS", "15.0"))

    # Phase 6 Public Accountability API Configuration
    PUBLIC_RPC_TIMEOUT_SECONDS: float = float(os.getenv("PUBLIC_RPC_TIMEOUT_SECONDS", "10.0"))
    PUBLIC_RATE_LIMIT_PER_MINUTE: int = int(os.getenv("PUBLIC_RATE_LIMIT_PER_MINUTE", "60"))
    TRUSTED_PROXY_HOPS: int = int(os.getenv("TRUSTED_PROXY_HOPS", "0"))
    PUBLIC_CACHE_MAX_ENTRIES: int = int(os.getenv("PUBLIC_CACHE_MAX_ENTRIES", "512"))

    # Phase 7.2 Internal SLA Sweep Configuration
    SLA_SWEEP_SECRET: str = os.getenv("SLA_SWEEP_SECRET", "")
    SLA_SWEEP_RATE_LIMIT_PER_MINUTE: int = int(os.getenv("SLA_SWEEP_RATE_LIMIT_PER_MINUTE", "6"))
    SLA_SWEEP_DEFAULT_BATCH: int = int(os.getenv("SLA_SWEEP_DEFAULT_BATCH", "100"))
    SLA_SWEEP_TIMEOUT_SECONDS: float = float(os.getenv("SLA_SWEEP_TIMEOUT_SECONDS", "30.0"))

    # Phase 8.2 Advisory AI Before-and-After Resolution Check (fail-closed default False)
    AI_RESOLUTION_CHECK_ENABLED: bool = Field(
        default_factory=lambda: parse_fail_closed_bool(os.getenv("AI_RESOLUTION_CHECK_ENABLED"))
    )
    AI_RESOLUTION_DAILY_CAP: int = _parse_positive_int(os.getenv("AI_RESOLUTION_DAILY_CAP"), default=200)
    AI_RESOLUTION_RERUN_PER_USER_PER_MINUTE: int = _parse_positive_int(
        os.getenv("AI_RESOLUTION_RERUN_PER_USER_PER_MINUTE"), default=6
    )
    AI_RESOLUTION_RERUN_GLOBAL_PER_MINUTE: int = _parse_positive_int(
        os.getenv("AI_RESOLUTION_RERUN_GLOBAL_PER_MINUTE"), default=20
    )
    AI_RESOLUTION_PENDING_TIMEOUT_MINUTES: int = _parse_positive_int(
        os.getenv("AI_RESOLUTION_PENDING_TIMEOUT_MINUTES"), default=5
    )

    # Phase 8.3/8.4 Citizen Verification Reopen Limit & Non-Response Auto-Close
    MAX_DISPUTE_REOPENS: int = Field(
        default_factory=lambda: _parse_non_negative_int(os.getenv("MAX_DISPUTE_REOPENS"), default=2)
    )
    CITIZEN_VERIFY_TIMEOUT_DAYS: int = Field(
        default_factory=lambda: _parse_positive_int(os.getenv("CITIZEN_VERIFY_TIMEOUT_DAYS"), default=7)
    )

    # Phase 9.1 AI Complaint Intelligence (Shadow Mode, fail-closed default False)
    AI_INTELLIGENCE_ENABLED: bool = Field(
        default_factory=lambda: parse_fail_closed_bool(os.getenv("AI_INTELLIGENCE_ENABLED"))
    )
    AI_INTELLIGENCE_DAILY_CAP: int = _parse_positive_int(
        os.getenv("AI_INTELLIGENCE_DAILY_CAP"), default=300
    )
    AI_INTELLIGENCE_PER_USER_PER_MINUTE: int = _parse_positive_int(
        os.getenv("AI_INTELLIGENCE_PER_USER_PER_MINUTE"), default=10
    )
    AI_INTELLIGENCE_GLOBAL_PER_MINUTE: int = _parse_positive_int(
        os.getenv("AI_INTELLIGENCE_GLOBAL_PER_MINUTE"), default=30
    )
    AI_INTELLIGENCE_PENDING_TIMEOUT_MINUTES: int = _parse_positive_int(
        os.getenv("AI_INTELLIGENCE_PENDING_TIMEOUT_MINUTES"), default=5
    )

    # Phase 9.4 Duplicate Detection Configuration
    DUPLICATE_DETECTION_RADIUS_METERS: float = float(
        _parse_positive_int(os.getenv("DUPLICATE_DETECTION_RADIUS_METERS"), default=250)
    )
    DUPLICATE_DETECTION_WINDOW_DAYS: int = _parse_positive_int(
        os.getenv("DUPLICATE_DETECTION_WINDOW_DAYS"), default=14
    )
    DUPLICATE_DETECTION_MAX_CANDIDATES: int = _parse_positive_int(
        os.getenv("DUPLICATE_DETECTION_MAX_CANDIDATES"), default=5
    )

    # Phase 9.2 AI Department Auto-Assignment (safety-first default: shadow)
    DEPARTMENT_AUTO_ASSIGN_MODE: str = Field(
        default_factory=lambda: parse_department_routing_mode(
            os.getenv("DEPARTMENT_AUTO_ASSIGN_MODE")
        )
    )
    DEPARTMENT_AUTO_ASSIGN_MIN_SAMPLES: int = _parse_positive_int(
        os.getenv("DEPARTMENT_AUTO_ASSIGN_MIN_SAMPLES"), default=50
    )
    DEPARTMENT_AUTO_ASSIGN_MIN_ACCURACY: float = _parse_unit_float(
        os.getenv("DEPARTMENT_AUTO_ASSIGN_MIN_ACCURACY"), default=0.95
    )
    DEPARTMENT_AUTO_ASSIGN_METRICS_MAX_AGE_DAYS: int = _parse_positive_int(
        os.getenv("DEPARTMENT_AUTO_ASSIGN_METRICS_MAX_AGE_DAYS"), default=14
    )
    DEPARTMENT_AUTO_ASSIGN_MIN_CONFIDENCE: float = _parse_unit_float(
        os.getenv("DEPARTMENT_AUTO_ASSIGN_MIN_CONFIDENCE"), default=0.85
    )

    # Phase 9.3 AI Officer Auto-Assignment (safety-first default: shadow)
    OFFICER_AUTO_ASSIGN_MODE: str = Field(
        default_factory=lambda: parse_department_routing_mode(
            os.getenv("OFFICER_AUTO_ASSIGN_MODE")
        )
    )
    OFFICER_AUTO_ASSIGN_MAX_OPEN_COMPLAINTS: int = _parse_positive_int(
        os.getenv("OFFICER_AUTO_ASSIGN_MAX_OPEN_COMPLAINTS"), default=10
    )
    OFFICER_AUTO_ASSIGN_ALLOW_NULL_WARD_FALLBACK: bool = Field(
        default_factory=lambda: (
            (os.getenv("OFFICER_AUTO_ASSIGN_ALLOW_NULL_WARD_FALLBACK") or "true")
            .strip()
            .lower()
            != "false"
        )
    )

    # Phase 9.5 Suspicious / False Claim Screening & Workflow Advancement (default: shadow)
    SCREENING_MODE: str = Field(
        default_factory=lambda: parse_department_routing_mode(
            os.getenv("SCREENING_MODE")
        )
    )
    SCREENING_VERSION: str = _strip_env_value(os.getenv("SCREENING_VERSION"), "v1.0")
    SCREENING_MIN_ADVANCE_CONFIDENCE: float = _parse_unit_float(
        os.getenv("SCREENING_MIN_ADVANCE_CONFIDENCE"), default=0.90
    )
    SCREENING_MIN_SAMPLES: int = _parse_positive_int(
        os.getenv("SCREENING_MIN_SAMPLES"), default=50
    )
    SCREENING_MIN_ACCURACY: float = _parse_unit_float(
        os.getenv("SCREENING_MIN_ACCURACY"), default=0.95
    )
    SCREENING_METRICS_MAX_AGE_DAYS: int = _parse_positive_int(
        os.getenv("SCREENING_METRICS_MAX_AGE_DAYS"), default=14
    )
    SCREENING_CITIZEN_AI_CAP_24H: int = _parse_positive_int(
        os.getenv("SCREENING_CITIZEN_AI_CAP_24H"), default=5
    )
    SCREENING_RATE_1H_LIMIT: int = _parse_positive_int(
        os.getenv("SCREENING_RATE_1H_LIMIT"), default=4
    )
    SCREENING_RATE_24H_LIMIT: int = _parse_positive_int(
        os.getenv("SCREENING_RATE_24H_LIMIT"), default=10
    )
    SCREENING_TEXT_SIMILARITY_THRESHOLD: float = _parse_unit_float(
        os.getenv("SCREENING_TEXT_SIMILARITY_THRESHOLD"), default=0.85
    )
    SCREENING_CITY_BBOX_MIN_LAT: Optional[float] = _parse_optional_float(
        os.getenv("SCREENING_CITY_BBOX_MIN_LAT")
    )
    SCREENING_CITY_BBOX_MAX_LAT: Optional[float] = _parse_optional_float(
        os.getenv("SCREENING_CITY_BBOX_MAX_LAT")
    )
    SCREENING_CITY_BBOX_MIN_LNG: Optional[float] = _parse_optional_float(
        os.getenv("SCREENING_CITY_BBOX_MIN_LNG")
    )
    SCREENING_CITY_BBOX_MAX_LNG: Optional[float] = _parse_optional_float(
        os.getenv("SCREENING_CITY_BBOX_MAX_LNG")
    )

    # Phase 9.6 Accuracy Dashboard & Citizen Review Appeals (appeal off by default)
    APPEAL_FEATURE_ENABLED: bool = Field(
        default_factory=lambda: parse_fail_closed_bool(
            os.getenv("APPEAL_FEATURE_ENABLED")
        )
    )
    SCREENING_APPEAL_MIN_AGE_DAYS: int = _parse_positive_int(
        os.getenv("SCREENING_APPEAL_MIN_AGE_DAYS"), default=3
    )
    SCREENING_APPEAL_DAILY_CAP: int = _parse_positive_int(
        os.getenv("SCREENING_APPEAL_DAILY_CAP"), default=3
    )
    SCREENING_APPEAL_COOLDOWN_HOURS: int = _parse_positive_int(
        os.getenv("SCREENING_APPEAL_COOLDOWN_HOURS"), default=72
    )
    SCREENING_APPEAL_LIFETIME_CAP: int = _parse_positive_int(
        os.getenv("SCREENING_APPEAL_LIFETIME_CAP"), default=3
    )
    DASHBOARD_MIN_SAMPLES: int = _parse_positive_int(
        os.getenv("DASHBOARD_MIN_SAMPLES"), default=20
    )
    DASHBOARD_WARD_MIN_SAMPLES: int = _parse_positive_int(
        os.getenv("DASHBOARD_WARD_MIN_SAMPLES"), default=20
    )

settings = Settings()
