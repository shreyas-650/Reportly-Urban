"""
ReportlyUrban — Phase 7.2 Backend SLA Sweep Unit & Mocked Tests
Covers:
  1. Secret validation (valid >=32 chars, wrong/missing/empty -> 403 generic,
     unset/short env secret -> 503 + startup warning).
  2. Batch limit validation (default 100, 1..250, invalid/bool/out-of-range -> 400).
  3. Dedicated sweep rate limiter (6/min default -> 7th returns 429 + Retry-After + no-store).
  4. CORS & browser Origin rejection on /api/internal/sla-sweep (403, zero Access-Control-* headers).
  5. Method check (GET -> 405), unknown fields / triggered_by rejection (400), hardcoded 'fastapi-scheduler'.
  6. Mocked RPC paths: success counts (strict 7 keys), skipped_locked -> 200, error_count > 0 -> 200 + counts-only warning, DB 500 -> 503, Connect/ReadTimeout -> 503.
  7. Zero secret/Authorization leakage in logs across all paths.
"""

import asyncio
import logging
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from fastapi.testclient import TestClient

from app.main import app, check_sla_sweep_secret_warning
from app.services.rate_limiter import sweep_rate_limiter


TEST_VALID_SECRET = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"


class _ListLogHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(self.format(record))


class Phase72SlaSweepTests(unittest.TestCase):
    def setUp(self):
        asyncio.run(sweep_rate_limiter.reset())
        self.client = TestClient(app)

    def tearDown(self):
        asyncio.run(sweep_rate_limiter.reset())

    def test_secret_validation_startup_warning_and_error_codes(self):
        # Empty / short env secret -> startup warning + HTTP 503
        for bad_env in ("", "too-short-secret"):
            with patch("app.main.settings.SLA_SWEEP_SECRET", bad_env), \
                 patch("app.services.sla_service.settings.SLA_SWEEP_SECRET", bad_env):
                with self.assertLogs("reportly.startup", level="WARNING") as cm:
                    check_sla_sweep_secret_warning()
                self.assertTrue(any("SLA_SWEEP_SECRET" in msg for msg in cm.output))

                res = self.client.post(
                    "/api/internal/sla-sweep",
                    headers={"X-Sweep-Secret": TEST_VALID_SECRET},
                )
                self.assertEqual(res.status_code, 503)
                self.assertEqual(res.headers.get("cache-control"), "no-store")
                self.assertNotIn("SLA_SWEEP_SECRET", res.text)

        # Missing / empty / wrong supplied secret -> generic 403 with no-store
        with patch("app.services.sla_service.settings.SLA_SWEEP_SECRET", TEST_VALID_SECRET):
            r_missing = self.client.post("/api/internal/sla-sweep")
            r_empty = self.client.post("/api/internal/sla-sweep", headers={"X-Sweep-Secret": ""})
            r_wrong = self.client.post("/api/internal/sla-sweep", headers={"X-Sweep-Secret": "wrong-secret"})

            for r in (r_missing, r_empty, r_wrong):
                self.assertEqual(r.status_code, 403)
                self.assertEqual(r.headers.get("cache-control"), "no-store")
                self.assertEqual(r.json(), {"detail": "Forbidden."})

    def test_browser_origin_rejected_and_zero_cors_headers(self):
        with patch("app.services.sla_service.settings.SLA_SWEEP_SECRET", TEST_VALID_SECRET):
            r_post = self.client.post(
                "/api/internal/sla-sweep",
                headers={
                    "Origin": "http://localhost:5173",
                    "X-Sweep-Secret": TEST_VALID_SECRET,
                },
            )
            self.assertEqual(r_post.status_code, 403)
            self.assertEqual(r_post.headers.get("cache-control"), "no-store")
            for k in r_post.headers.keys():
                self.assertFalse(k.lower().startswith("access-control-"), f"Unexpected CORS header {k}")

            r_opt = self.client.options(
                "/api/internal/sla-sweep",
                headers={
                    "Origin": "http://localhost:5173",
                    "Access-Control-Request-Method": "POST",
                },
            )
            self.assertEqual(r_opt.status_code, 403)
            for k in r_opt.headers.keys():
                self.assertFalse(k.lower().startswith("access-control-"), f"Unexpected CORS header {k}")

            r_get = self.client.get(
                "/api/internal/sla-sweep",
                headers={"X-Sweep-Secret": TEST_VALID_SECRET},
            )
            self.assertEqual(r_get.status_code, 405)
            self.assertEqual(r_get.headers.get("cache-control"), "no-store")

    @patch("app.services.sla_service._call_public_rpc", new_callable=AsyncMock)
    def test_batch_limit_validation_and_fixed_triggered_by(self, mock_rpc):
        mock_rpc.return_value = {
            "run_id": "11111111-2222-3333-4444-555555555555",
            "status": "completed",
            "scanned_count": 4,
            "reminders_sent_count": 2,
            "escalations_completed_count": 1,
            "escalations_blocked_count": 0,
            "error_count": 0,
            "error_details": [{"secret_leak": "must-be-stripped"}],
        }

        with patch("app.services.sla_service.settings.SLA_SWEEP_SECRET", TEST_VALID_SECRET):
            # Default batch_limit=100 + triggered_by hardcoded to fastapi-scheduler
            res = self.client.post(
                "/api/internal/sla-sweep",
                headers={"X-Sweep-Secret": TEST_VALID_SECRET},
            )
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers.get("cache-control"), "no-store")
            self.assertEqual(
                set(res.json().keys()),
                {
                    "status",
                    "run_id",
                    "scanned",
                    "reminders_sent",
                    "escalations_completed",
                    "escalations_blocked",
                    "error_count",
                },
            )
            mock_rpc.assert_awaited_once()
            self.assertEqual(
                mock_rpc.call_args.kwargs["payload"],
                {"p_batch_limit": 100, "p_triggered_by": "fastapi-scheduler"},
            )

            # Invalid batch limits & triggered_by override attempts -> 400
            for bad_qs in ("?batch_limit=0", "?batch_limit=251", "?batch_limit=abc", "?triggered_by=evil"):
                r_bad = self.client.post(
                    f"/api/internal/sla-sweep{bad_qs}",
                    headers={"X-Sweep-Secret": TEST_VALID_SECRET},
                )
                self.assertEqual(r_bad.status_code, 400)
                self.assertEqual(r_bad.headers.get("cache-control"), "no-store")

            r_bad_body = self.client.post(
                "/api/internal/sla-sweep",
                json={"batch_limit": True},
                headers={"X-Sweep-Secret": TEST_VALID_SECRET},
            )
            self.assertEqual(r_bad_body.status_code, 400)

            asyncio.run(sweep_rate_limiter.reset())
            r_bad_override = self.client.post(
                "/api/internal/sla-sweep",
                json={"batch_limit": 50, "triggered_by": "attacker"},
                headers={"X-Sweep-Secret": TEST_VALID_SECRET},
            )
            self.assertEqual(r_bad_override.status_code, 400)

            # Boundary batch_limit=250 succeeds
            r_ok_250 = self.client.post(
                "/api/internal/sla-sweep",
                json={"batch_limit": 250},
                headers={"X-Sweep-Secret": TEST_VALID_SECRET},
            )
            self.assertEqual(r_ok_250.status_code, 200)

    @patch("app.services.sla_service._call_public_rpc", new_callable=AsyncMock)
    def test_skipped_locked_partial_errors_and_rate_limit(self, mock_rpc):
        with patch("app.services.sla_service.settings.SLA_SWEEP_SECRET", TEST_VALID_SECRET):
            mock_rpc.return_value = {
                "run_id": "22222222-2222-3333-4444-555555555555",
                "status": "skipped_locked",
                "scanned_count": 0,
                "reminders_sent_count": 0,
                "escalations_completed_count": 0,
                "escalations_blocked_count": 0,
                "error_count": 0,
            }
            r_skip = self.client.post(
                "/api/internal/sla-sweep",
                headers={"X-Sweep-Secret": TEST_VALID_SECRET},
            )
            self.assertEqual(r_skip.status_code, 200)
            self.assertEqual(r_skip.json()["status"], "skipped_locked")
            self.assertEqual(r_skip.headers.get("cache-control"), "no-store")

            # Partial error_count > 0 returns 200 & logs counts-only warning
            mock_rpc.return_value = {
                "run_id": "33333333-2222-3333-4444-555555555555",
                "status": "completed",
                "scanned_count": 5,
                "reminders_sent_count": 3,
                "escalations_completed_count": 1,
                "escalations_blocked_count": 0,
                "error_count": 1,
            }
            with self.assertLogs("reportly.internal.sla_sweep", level="WARNING") as cm:
                r_err = self.client.post(
                    "/api/internal/sla-sweep",
                    headers={"X-Sweep-Secret": TEST_VALID_SECRET},
                )
            self.assertEqual(r_err.status_code, 200)
            self.assertEqual(r_err.json()["error_count"], 1)
            self.assertTrue(any("error_count=1" in msg for msg in cm.output))

            # Exhaust remaining 4 requests (2 sent above + 4 = 6 allowed/min), 7th -> 429
            for _ in range(4):
                r_ok = self.client.post(
                    "/api/internal/sla-sweep",
                    headers={"X-Sweep-Secret": TEST_VALID_SECRET},
                )
                self.assertEqual(r_ok.status_code, 200)

            r_limited = self.client.post(
                "/api/internal/sla-sweep",
                headers={"X-Sweep-Secret": TEST_VALID_SECRET},
            )
            self.assertEqual(r_limited.status_code, 429)
            self.assertEqual(r_limited.headers.get("cache-control"), "no-store")
            self.assertIn("Retry-After", r_limited.headers)

    def test_db_errors_timeouts_and_zero_secret_logging(self):
        sentinel_role = "sb_secret_NEVER_LOG_ROLE_PHASE72"
        sentinel_sweep = "SuppliedSweepSecret_NEVER_LOG_32CHARS_LONG"
        handler = _ListLogHandler()
        root_logger = logging.getLogger()
        prev_level = root_logger.level
        root_logger.setLevel(logging.DEBUG)
        root_logger.addHandler(handler)

        try:
            with patch("app.services.public_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
                 patch("app.services.public_service.settings.SUPABASE_SERVICE_ROLE_KEY", sentinel_role), \
                 patch("app.services.sla_service.settings.SLA_SWEEP_SECRET", sentinel_sweep):

                # Wrong secret request must not log supplied or env secret
                wrong_supplied = "WrongSuppliedSecret_MUST_NOT_BE_LOGGED_12345"
                r_wrong = self.client.post(
                    "/api/internal/sla-sweep",
                    headers={"X-Sweep-Secret": wrong_supplied},
                )
                self.assertEqual(r_wrong.status_code, 403)

                # ConnectTimeout & ReadTimeout -> 503
                for exc_cls in (httpx.ConnectTimeout, httpx.ReadTimeout):
                    with patch(
                        "app.services.public_service.httpx.AsyncClient.post",
                        side_effect=exc_cls("timed out"),
                    ):
                        r_to = self.client.post(
                            "/api/internal/sla-sweep",
                            headers={"X-Sweep-Secret": sentinel_sweep},
                        )
                        self.assertEqual(r_to.status_code, 503)
                        self.assertEqual(r_to.headers.get("cache-control"), "no-store")

                # Upstream DB 500 -> 503 with generic detail
                fake_500 = httpx.Response(500, json={"message": "SELECT * FROM complaints"})
                with patch("app.services.public_service.httpx.AsyncClient.post", return_value=fake_500):
                    r_db = self.client.post(
                        "/api/internal/sla-sweep",
                        headers={"X-Sweep-Secret": sentinel_sweep},
                    )
                    self.assertEqual(r_db.status_code, 503)
                    self.assertNotIn("SELECT", r_db.text)

            joined = "\n".join(handler.records)
            self.assertNotIn(sentinel_role, joined)
            self.assertNotIn(sentinel_sweep, joined)
            self.assertNotIn(wrong_supplied, joined)
            self.assertNotIn("Authorization", joined)
            self.assertNotIn("Bearer ", joined)
        finally:
            root_logger.removeHandler(handler)
            root_logger.setLevel(prev_level)


if __name__ == "__main__":
    unittest.main()
