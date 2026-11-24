"""
ReportlyUrban — Health Router
Provides unauthenticated health check endpoint without exposing sensitive configuration.
"""

from fastapi import APIRouter

router = APIRouter(tags=["Health"])


@router.get("/health")
async def health_check():
    """
    Returns generic status confirmation for load balancers and uptime monitors.
    Never exposes API keys, project URLs, or internal system configurations.
    """
    return {
        "status": "healthy",
        "service": "reportly-ai-backend",
        "version": "1.0.0"
    }
