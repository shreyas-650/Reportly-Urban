"""
ReportlyUrban — AI Problem Detection, Public Accountability & Internal Scheduler FastAPI Entry Point
"""

from contextlib import asynccontextmanager
import logging
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.routers import health, ai, public, internal, admin_sla, officer, citizen, ai_intelligence, duplicate_detection, department_routing, officer_routing, screening, accuracy_appeals, rewards
from app.services.sla_service import is_sweep_secret_configured

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


def check_sla_sweep_secret_warning() -> None:
    """Emits a startup warning if SLA_SWEEP_SECRET is unset or shorter than 32 characters."""
    if not is_sweep_secret_configured():
        logger.warning(
            "SLA_SWEEP_SECRET is unset or shorter than 32 characters; "
            "POST /api/internal/sla-sweep will reject requests with 503 until configured."
        )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    check_production_proxy_warning()
    check_sla_sweep_secret_warning()
    yield


app = FastAPI(
    title="ReportlyUrban AI Vision Service",
    description="Automated civic issue identification and structured reporting assistance powered by Google Gemini Vision.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

# Enforce strict CORS origins (No wildcards) for public/citizen/AI endpoints
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
    max_age=3600,
)


@app.middleware("http")
async def enforce_cache_and_internal_origin_isolation(request: Request, call_next):
    """
    - Blocks browser Origin requests and strips CORS headers on /api/internal/*.
    - Enforces Cache-Control: no-store on all /api/internal/* responses.
    - Guarantees Cache-Control: no-store on all /api/public/* error responses.
    """
    is_internal = request.url.path.startswith("/api/internal")
    if is_internal and "origin" in request.headers:
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"detail": "Forbidden."},
            headers={"Cache-Control": "no-store"},
        )

    response = await call_next(request)

    if is_internal:
        for hdr in list(response.headers.keys()):
            if hdr.lower().startswith("access-control-"):
                del response.headers[hdr]
        response.headers["Cache-Control"] = "no-store"
    elif request.url.path.startswith("/api/public") and response.status_code >= 400:
        response.headers["Cache-Control"] = "no-store"

    return response


# Register endpoints
app.include_router(health.router)
app.include_router(ai.router)
app.include_router(public.router)
app.include_router(internal.router)
app.include_router(admin_sla.router)
app.include_router(officer.router)
app.include_router(citizen.router)
app.include_router(citizen.complaints_router)
app.include_router(ai_intelligence.admin_router)
app.include_router(ai_intelligence.citizen_router)
app.include_router(duplicate_detection.admin_router)
app.include_router(duplicate_detection.citizen_router)
app.include_router(department_routing.admin_router)
app.include_router(department_routing.citizen_router)
app.include_router(officer_routing.admin_router)
app.include_router(officer_routing.citizen_router)
app.include_router(screening.admin_router)
app.include_router(screening.citizen_router)
app.include_router(accuracy_appeals.admin_router)
app.include_router(accuracy_appeals.citizen_router)
app.include_router(rewards.admin_router)
app.include_router(rewards.citizen_router)


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    """Safe global exception handler that logs errors without leaking secrets or payload data."""
    headers = (
        {"Cache-Control": "no-store"}
        if (request.url.path.startswith("/api/public") or request.url.path.startswith("/api/internal"))
        else None
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An internal server error occurred. Please try again later."},
        headers=headers,
    )
