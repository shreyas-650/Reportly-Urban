"""
ReportlyUrban — AI Problem Detection FastAPI Application Entry Point
"""

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.routers import health, ai

app = FastAPI(
    title="ReportlyUrban AI Vision Service",
    description="Automated civic issue identification and structured reporting assistance powered by Google Gemini Vision.",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
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

# Register endpoints
app.include_router(health.router)
app.include_router(ai.router)


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    """Safe global exception handler that logs errors without leaking secrets or payload data."""
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An internal server error occurred. Please try again later."}
    )
