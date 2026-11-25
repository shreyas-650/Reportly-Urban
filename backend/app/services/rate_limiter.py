"""
ReportlyUrban — Per-IP Public API Rate Limiter
Enforces per-IP requests per minute on /api/public/* endpoints BEFORE cache or DB execution.

Deployment Assumption / Single-Worker Limitation:
  This in-process sliding-window rate limiter stores state in Python process memory.
  It enforces accurate global limits under a single-worker Uvicorn process (default).
  If deployed with multiple workers (--workers > 1) or multiple replicas behind a load balancer,
  state is not shared across worker processes and an external store (e.g. Redis) is required.
"""

import asyncio
import ipaddress
import logging
import math
import time
from collections import deque
from typing import Deque, Dict
from fastapi import HTTPException, Request, status

from app.config import settings

logger = logging.getLogger("reportly.public.ratelimit")


def extract_client_ip(request: Request, trusted_proxy_hops: int = 0) -> str:
    """
    Derives client IP safely from the socket connection or configured trusted proxy hops.
    Never trusts X-Forwarded-For when trusted_proxy_hops <= 0.
    """
    socket_ip = request.client.host if (request.client and request.client.host) else "unknown"
    xff = request.headers.get("x-forwarded-for")

    if trusted_proxy_hops <= 0:
        if xff and not extract_client_ip._warned_xff:
            extract_client_ip._warned_xff = True
            logger.warning(
                "X-Forwarded-For header detected while TRUSTED_PROXY_HOPS=0; ignoring forwarded header and using socket IP."
            )
        return socket_ip

    if not xff:
        return socket_ip

    parts = [p.strip() for p in xff.split(",") if p.strip()]
    if not parts:
        return socket_ip

    # Walk right-to-left over trusted proxy hops to pick the original client IP
    idx = max(0, len(parts) - trusted_proxy_hops)
    candidate = parts[idx]
    try:
        ipaddress.ip_address(candidate)
        return candidate
    except ValueError:
        return socket_ip


extract_client_ip._warned_xff = False


class InProcessSlidingWindowLimiter:
    """Per-IP sliding 60-second window limiter."""

    def __init__(self, limit_per_minute: int = 60, window_seconds: int = 60, max_tracked_ips: int = 10000):
        self.limit_per_minute = max(1, limit_per_minute)
        self.window_seconds = window_seconds
        self.max_tracked_ips = max_tracked_ips
        self._hits: Dict[str, Deque[float]] = {}
        self._lock = asyncio.Lock()

    async def check_and_record(self, client_ip: str) -> None:
        now = time.monotonic()
        cutoff = now - self.window_seconds

        async with self._lock:
            # Bound memory footprint of IP tracking dictionary
            if client_ip not in self._hits and len(self._hits) >= self.max_tracked_ips:
                stale_ips = [ip for ip, dq in self._hits.items() if not dq or dq[-1] <= cutoff]
                for ip in stale_ips:
                    self._hits.pop(ip, None)
                if len(self._hits) >= self.max_tracked_ips:
                    oldest_ip = next(iter(self._hits))
                    self._hits.pop(oldest_ip, None)

            dq = self._hits.setdefault(client_ip, deque())
            while dq and dq[0] <= cutoff:
                dq.popleft()

            if len(dq) >= self.limit_per_minute:
                retry_after = max(1, math.ceil(self.window_seconds - (now - dq[0])))
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Rate limit exceeded. Please try again shortly.",
                    headers={"Retry-After": str(retry_after)},
                )

            dq.append(now)

    async def reset(self) -> None:
        async with self._lock:
            self._hits.clear()


public_rate_limiter = InProcessSlidingWindowLimiter(
    limit_per_minute=settings.PUBLIC_RATE_LIMIT_PER_MINUTE,
    window_seconds=60,
)

sweep_rate_limiter = InProcessSlidingWindowLimiter(
    limit_per_minute=settings.SLA_SWEEP_RATE_LIMIT_PER_MINUTE,
    window_seconds=60,
)


async def enforce_public_rate_limit(request: Request) -> None:
    """FastAPI dependency executing per-IP rate limiting prior to caching or DB calls."""
    client_ip = extract_client_ip(request, trusted_proxy_hops=settings.TRUSTED_PROXY_HOPS)
    await public_rate_limiter.check_and_record(client_ip)


async def enforce_sweep_rate_limit(request: Request) -> None:
    """Dedicated per-IP rate limiter for POST /api/internal/sla-sweep."""
    client_ip = extract_client_ip(request, trusted_proxy_hops=settings.TRUSTED_PROXY_HOPS)
    await sweep_rate_limiter.check_and_record(client_ip)
