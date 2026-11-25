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

settings = Settings()
