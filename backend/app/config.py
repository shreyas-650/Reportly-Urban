"""
ReportlyUrban — Backend Configuration
Loads configuration from environment variables with safe defaults.
"""

import os
from pathlib import Path
from typing import List
from pydantic import BaseModel
from dotenv import load_dotenv

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent

# Load from backend/.env then root .env then frontend/.env regardless of working directory
load_dotenv(_BACKEND_DIR / ".env")
load_dotenv(_REPO_ROOT / ".env")
load_dotenv(_REPO_ROOT / "frontend" / ".env")

class Settings(BaseModel):
    # Gemini Configuration
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    
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
    
    # API Timeouts
    GEMINI_TIMEOUT_SECONDS: float = float(os.getenv("GEMINI_TIMEOUT_SECONDS", "15.0"))

settings = Settings()
