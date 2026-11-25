"""
ReportlyUrban — AI Problem Detection & Public Accountability FastAPI Entry Point
"""

from contextlib import asynccontextmanager
import logging
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.routers import health, ai, public

logger = logging.getLogger("reportly.startup")


def check_production_proxy_warning() -> None:
    """
    Emits a startup warning if running in production with TRUSTED_PROXY_HOPS=0,
    because reverse-proxied requests share a single socket IP unless trusted hops
    are explicitly configured.
    """
    env = settings.ENVIRONMENT.strip().lower()
    if env in ("production", "prod") and settings.TRUSTED_PROXY_HOPS <= 0:
        logger.warning(
            "ENVIRONMENT is '%s' while TRUSTED_PROXY_HOPS=%s; /api/public/* rate limiting "
            "will ignore X-Forwarded-For and fall back to socket peer IP.",
            settings.ENVIRONMENT,
            settings.TRUSTED_PROXY_HOPS,
        )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    check_production_proxy_warning()
    yield


app = FastAPI(
    title="ReportlyUrban AI Vision Service",
    description="Automated civic issue identification and structured reporting assistance powered by Google Gemini Vision.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

# Enforce strict CORS origins (No wildcards)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
    max_age=3600,
)


@app.middleware("http")
async def enforce_public_cache_control_headers(request: Request, call_next):
    """
    Guarantees Cache-Control: no-store on all /api/public/* error responses
    (400, 404, 429, 503, etc.) so CDNs/browsers never cache failures.
    """
    response = await call_next(request)
    if request.url.path.startswith("/api/public") and response.status_code >= 400:
        response.headers["Cache-Control"] = "no-store"
    return response


# Register endpoints
app.include_router(health.router)
app.include_router(ai.router)
app.include_router(public.router)


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    """Safe global exception handler that logs errors without leaking secrets or payload data."""
    headers = {"Cache-Control": "no-store"} if request.url.path.startswith("/api/public") else None
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An internal server error occurred. Please try again later."},
        headers=headers,
    )
