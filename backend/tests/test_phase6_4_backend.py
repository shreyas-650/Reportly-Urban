"""
ReportlyUrban — Phase 6.4 Backend Hardening & Safeguard Tests
Verifies:
  1. Stampede lock cleanup after concurrent success and failure.
  2. Cache-Control: public on 200 vs Cache-Control: no-store on 400/404/429/503.
  3. Authorization headers and service-role keys never appear in logs.
  4. Explicit connect & read RPC timeouts map ConnectTimeout and ReadTimeout to 503.
  5. Production startup warning when ENVIRONMENT=production and TRUSTED_PROXY_HOPS=0.
"""

import asyncio
import logging
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from fastapi.testclient import TestClient

from app.main import app, check_production_proxy_warning
from app.services.public_cache import BoundedTTLCache, public_cache
from app.services.public_service import _build_rpc_timeout
from app.services.rate_limiter import public_rate_limiter


VALID_UUID = "11111111-2222-3333-4444-555555555555"


class _ListLogHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        self.messages.append(self.format(record))


class Phase64BackendHardeningTests(unittest.TestCase):
    def setUp(self):
        asyncio.run(public_cache.clear())
        asyncio.run(public_rate_limiter.reset())
        self.client = TestClient(app)

    def tearDown(self):
        asyncio.run(public_cache.clear())
        asyncio.run(public_rate_limiter.reset())

    def test_stampede_locks_removed_after_success_and_error(self):
        async def _run():
            cache = BoundedTTLCache(max_entries=16)

            async def ok_loader():
                await asyncio.sleep(0.01)
                return {"ok": 1}

            await asyncio.gather(
                cache.get_or_load("alpha", 60, ok_loader),
                cache.get_or_load("alpha", 60, ok_loader),
            )
            self.assertEqual(len(cache._key_locks), 0)
            self.assertEqual(len(cache._key_lock_waiters), 0)

            async def bad_loader():
                await asyncio.sleep(0.01)
                raise ValueError("fail")

            results = await asyncio.gather(
                cache.get_or_load("beta", 60, bad_loader),
                cache.get_or_load("beta", 60, bad_loader),
                return_exceptions=True,
            )
            self.assertTrue(all(isinstance(r, ValueError) for r in results))
            self.assertEqual(len(cache._key_locks), 0)
            self.assertEqual(len(cache._key_lock_waiters), 0)

        asyncio.run(_run())

    @patch("app.services.public_service._call_public_rpc", new_callable=AsyncMock)
    def test_cache_control_headers_public_on_200_and_no_store_on_errors(self, mock_rpc):
        mock_rpc.return_value = {
            "total": 5,
            "resolved": 2,
            "pending": 3,
            "rejected": None,
            "rejected_suppressed": True,
            "overdue": 0,
            "no_deadline_count": 3,
            "resolution_rate": 40.0,
            "avg_resolution_hours": 10.0,
        }
        r200 = self.client.get("/api/public/stats")
        self.assertEqual(r200.status_code, 200)
        self.assertEqual(r200.headers.get("cache-control"), "public, max-age=600")

        # 400 validation error -> no-store
        r400 = self.client.get("/api/public/complaints?page=0")
        self.assertEqual(r400.status_code, 400)
        self.assertEqual(r400.headers.get("cache-control"), "no-store")

        # 404 malformed UUID -> no-store
        r404_bad = self.client.get("/api/public/complaints/not-a-uuid")
        self.assertEqual(r404_bad.status_code, 404)
        self.assertEqual(r404_bad.headers.get("cache-control"), "no-store")

        # 404 unknown UUID -> no-store
        mock_rpc.return_value = None
        r404_missing = self.client.get(f"/api/public/complaints/{VALID_UUID}")
        self.assertEqual(r404_missing.status_code, 404)
        self.assertEqual(r404_missing.headers.get("cache-control"), "no-store")

        # 503 upstream failure -> no-store
        asyncio.run(public_cache.clear())
        mock_rpc.side_effect = None
        with patch("app.services.public_service._call_public_rpc", new_callable=AsyncMock) as fail_rpc:
            from fastapi import HTTPException
            fail_rpc.side_effect = HTTPException(status_code=503, detail="unavailable")
            r503 = self.client.get("/api/public/wards")
            self.assertEqual(r503.status_code, 503)
            self.assertEqual(r503.headers.get("cache-control"), "no-store")

        # 429 pre-cache rate limit -> no-store + Retry-After
        asyncio.run(public_rate_limiter.reset())
        mock_rpc.return_value = {
            "total": 1,
            "resolved": 1,
            "pending": 0,
            "rejected": None,
            "rejected_suppressed": True,
            "overdue": 0,
            "no_deadline_count": 0,
            "resolution_rate": 100.0,
            "avg_resolution_hours": 1.0,
        }
        for _ in range(60):
            res = self.client.get("/api/public/stats")
            self.assertEqual(res.status_code, 200)
        r429 = self.client.get("/api/public/stats")
        self.assertEqual(r429.status_code, 429)
        self.assertEqual(r429.headers.get("cache-control"), "no-store")
        self.assertIn("Retry-After", r429.headers)

    def test_connect_and_read_timeouts_and_no_secret_logging(self):
        timeout_cfg = _build_rpc_timeout()
        self.assertGreater(timeout_cfg.connect, 0)
        self.assertGreater(timeout_cfg.read, 0)
        self.assertEqual(timeout_cfg.connect, timeout_cfg.read)

        sentinel_key = "sb_secret_DO_NOT_LOG_PHASE64"
        handler = _ListLogHandler()
        root_logger = logging.getLogger()
        prev_level = root_logger.level
        root_logger.setLevel(logging.DEBUG)
        root_logger.addHandler(handler)

        try:
            for exc_cls in (httpx.ConnectTimeout, httpx.ReadTimeout):
                asyncio.run(public_cache.clear())
                with patch("app.services.public_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
                     patch("app.services.public_service.settings.SUPABASE_SERVICE_ROLE_KEY", sentinel_key), \
                     patch(
                         "app.services.public_service.httpx.AsyncClient.post",
                         side_effect=exc_cls("simulated timeout"),
                     ):
                    res = self.client.get("/api/public/stats")
                    self.assertEqual(res.status_code, 503)
                    self.assertEqual(res.headers.get("cache-control"), "no-store")

            # Also verify successful RPC response path does not log Authorization or service key
            asyncio.run(public_cache.clear())
            ok_resp = httpx.Response(
                200,
                json={
                    "total": 1,
                    "resolved": 1,
                    "pending": 0,
                    "rejected": None,
                    "rejected_suppressed": True,
                    "overdue": 0,
                    "no_deadline_count": 0,
                    "resolution_rate": 100.0,
                    "avg_resolution_hours": 1.0,
                },
            )
            with patch("app.services.public_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
                 patch("app.services.public_service.settings.SUPABASE_SERVICE_ROLE_KEY", sentinel_key), \
                 patch("app.services.public_service.httpx.AsyncClient.post", return_value=ok_resp):
                res_ok = self.client.get("/api/public/stats")
                self.assertEqual(res_ok.status_code, 200)

            joined_logs = "\n".join(handler.messages)
            self.assertNotIn(sentinel_key, joined_logs)
            self.assertNotIn("Authorization", joined_logs)
            self.assertNotIn("Bearer ", joined_logs)
        finally:
            root_logger.removeHandler(handler)
            root_logger.setLevel(prev_level)

    def test_startup_warning_when_production_and_trusted_proxy_hops_zero(self):
        with patch("app.main.settings.ENVIRONMENT", "production"), \
             patch("app.main.settings.TRUSTED_PROXY_HOPS", 0):
            with self.assertLogs("reportly.startup", level="WARNING") as cm:
                with TestClient(app):
                    pass
            self.assertTrue(
                any("TRUSTED_PROXY_HOPS=0" in msg for msg in cm.output),
                f"Expected startup warning in logs, got {cm.output}",
            )

        with patch("app.main.settings.ENVIRONMENT", "development"), \
             patch("app.main.settings.TRUSTED_PROXY_HOPS", 0):
            with self.assertNoLogs("reportly.startup", level="WARNING"):
                check_production_proxy_warning()

        with patch("app.main.settings.ENVIRONMENT", "production"), \
             patch("app.main.settings.TRUSTED_PROXY_HOPS", 1):
            with self.assertNoLogs("reportly.startup", level="WARNING"):
                check_production_proxy_warning()


if __name__ == "__main__":
    unittest.main()
