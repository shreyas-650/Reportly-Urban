"""
ReportlyUrban — Phase 6.3 Backend Unit & Mocked Endpoint Test Suite
Covers:
  1. All 7 /api/public/* routes unauthenticated HTTP 200 & Cache-Control headers.
  2. BoundedTTLCache hit, TTL expiration, filter-key isolation, ward whitespace normalization,
     concurrency stampede lock, LRU eviction, and zero error caching.
  3. /api/public/wards/names derivation strictly from public_ward_stats() excluding 'Other' & suppressed rows.
  4. HTTP 400 enforcement for invalid/unknown query params and P0400 RPC errors (never 422).
  5. HTTP 404 enforcement for malformed {reference} UUIDs and missing records.
  6. Strict 8-field allow-list stripping internal IDs, complaint_number, and PII.
  7. HTTP 503 generic error handling on timeouts / DB failures without leaking secrets or SQL.
  8. Per-IP 60 req/min sliding window rate limiter BEFORE cache lookup, Retry-After header,
     and TRUSTED_PROXY_HOPS IP extraction behavior.
"""

import asyncio
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.services.public_cache import BoundedTTLCache, public_cache
from app.services.rate_limiter import (
    InProcessSlidingWindowLimiter,
    extract_client_ip,
    public_rate_limiter,
)


VALID_UUID = "11111111-2222-3333-4444-555555555555"


def make_sample_item(extra_fields=None):
    item = {
        "public_reference": VALID_UUID,
        "title": "Road Pothole Issue",
        "category": "potholes",
        "ward": "Ward 4",
        "status": "in_progress",
        "submitted_date": "2026-11-20",
        "latitude": 19.076,
        "longitude": 72.877,
    }
    if extra_fields:
        item.update(extra_fields)
    return item


class Phase63PublicCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_lru_eviction_and_ttl_expiry(self):
        cache = BoundedTTLCache(max_entries=2)
        await cache.set("k1", {"v": 1}, ttl_seconds=60)
        await cache.set("k2", {"v": 2}, ttl_seconds=60)
        # Touch k1 so k2 becomes least-recently-used
        self.assertEqual(await cache.get("k1"), {"v": 1})
        await cache.set("k3", {"v": 3}, ttl_seconds=60)

        self.assertIsNone(await cache.get("k2"))
        self.assertEqual(await cache.get("k1"), {"v": 1})
        self.assertEqual(await cache.get("k3"), {"v": 3})

        # Simulate monotonic clock advancing past TTL
        with patch("app.services.public_cache.time.monotonic", return_value=1e9):
            self.assertIsNone(await cache.get("k1"))

    async def test_stampede_lock_and_no_error_caching(self):
        cache = BoundedTTLCache(max_entries=10)
        calls = 0

        async def slow_loader():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return {"ok": True}

        results = await asyncio.gather(
            cache.get_or_load("same-key", 60, slow_loader),
            cache.get_or_load("same-key", 60, slow_loader),
            cache.get_or_load("same-key", 60, slow_loader),
        )
        self.assertEqual(calls, 1)
        self.assertEqual(results, [{"ok": True}, {"ok": True}, {"ok": True}])

        # Failing loader must not cache anything
        fail_calls = 0

        async def failing_loader():
            nonlocal fail_calls
            fail_calls += 1
            raise RuntimeError("boom")

        with self.assertRaises(RuntimeError):
            await cache.get_or_load("err-key", 60, failing_loader)
        with self.assertRaises(RuntimeError):
            await cache.get_or_load("err-key", 60, failing_loader)
        self.assertEqual(fail_calls, 2)


class Phase63RateLimiterTests(unittest.IsolatedAsyncioTestCase):
    async def test_sliding_window_blocks_61st_request_and_respects_trusted_hops(self):
        limiter = InProcessSlidingWindowLimiter(limit_per_minute=60, window_seconds=60)
        for _ in range(60):
            await limiter.check_and_record("198.51.100.10")

        with self.assertRaises(Exception) as ctx:
            await limiter.check_and_record("198.51.100.10")

        exc = ctx.exception
        self.assertEqual(getattr(exc, "status_code", None), 429)
        self.assertIn("Retry-After", exc.headers)
        self.assertGreaterEqual(int(exc.headers["Retry-After"]), 1)

        # Fake client request for proxy header tests
        class DummyClient:
            host = "10.0.0.1"

        class DummyReq:
            client = DummyClient()
            headers = {"x-forwarded-for": "203.0.113.5, 10.0.0.2"}

        extract_client_ip._warned_xff = False
        self.assertEqual(extract_client_ip(DummyReq(), trusted_proxy_hops=0), "10.0.0.1")
        self.assertEqual(extract_client_ip(DummyReq(), trusted_proxy_hops=1), "10.0.0.2")
        self.assertEqual(extract_client_ip(DummyReq(), trusted_proxy_hops=2), "203.0.113.5")


class Phase63PublicEndpointTests(unittest.TestCase):
    def setUp(self):
        asyncio.run(public_cache.clear())
        asyncio.run(public_rate_limiter.reset())
        self.client = TestClient(app)

    def tearDown(self):
        asyncio.run(public_cache.clear())
        asyncio.run(public_rate_limiter.reset())

    @patch("app.services.public_service._call_public_rpc", new_callable=AsyncMock)
    def test_all_seven_endpoints_and_cache_isolation(self, mock_rpc):
        def rpc_side_effect(rpc_name, payload=None):
            if rpc_name == "public_dashboard_stats":
                return {
                    "total": 12,
                    "resolved": 7,
                    "pending": 5,
                    "rejected": None,
                    "rejected_suppressed": True,
                    "overdue": 1,
                    "no_deadline_count": 3,
                    "resolution_rate": 58.3,
                    "avg_resolution_hours": 26.5,
                }
            if rpc_name == "public_ward_stats":
                return [
                    {
                        "ward": "Ward 4",
                        "total": 8,
                        "resolved": 5,
                        "unresolved": 3,
                        "overdue": 1,
                        "no_deadline_count": 2,
                        "resolution_rate": 62.5,
                        "avg_resolution_hours": 18.0,
                        "is_other": False,
                        "is_suppressed": False,
                    },
                    {
                        "ward": "Ward 9",
                        "total": 4,
                        "resolved": None,
                        "unresolved": None,
                        "overdue": None,
                        "no_deadline_count": None,
                        "resolution_rate": None,
                        "avg_resolution_hours": None,
                        "is_other": False,
                        "is_suppressed": True,
                    },
                    {
                        "ward": "Other",
                        "total": None,
                        "resolved": None,
                        "unresolved": None,
                        "overdue": None,
                        "no_deadline_count": None,
                        "resolution_rate": None,
                        "avg_resolution_hours": None,
                        "is_other": True,
                        "is_suppressed": True,
                    },
                ]
            if rpc_name == "public_department_stats":
                return [
                    {
                        "department_code": "ROADS",
                        "department_name": "Roads & Bridges",
                        "assigned_total": 10,
                        "resolved": 6,
                        "pending": 4,
                        "overdue": 1,
                        "no_deadline_count": 2,
                        "resolution_rate": 60.0,
                        "avg_resolution_hours": 24.0,
                        "is_other": False,
                        "is_suppressed": False,
                    }
                ]
            if rpc_name == "public_map_points":
                return {
                    "points": [
                        make_sample_item(
                            {
                                "id": 999,
                                "complaint_number": "RU-2026-00999",
                                "citizen_id": "secret-user",
                            }
                        )
                    ],
                    "truncated": False,
                    "total_count": 8,
                    "unmapped_count": 1,
                    "count_suppressed": False,
                }
            if rpc_name == "public_complaint_list":
                return {
                    "items": [
                        make_sample_item(
                            {
                                "id": 999,
                                "complaint_number": "RU-2026-00999",
                                "email": "leak@example.com",
                            }
                        )
                    ],
                    "total_count": 8,
                    "count_suppressed": False,
                    "page": 1,
                    "page_size": 20,
                }
            if rpc_name == "public_complaint_detail":
                return make_sample_item(
                    {
                        "id": 999,
                        "complaint_number": "RU-2026-00999",
                        "phone": "555-0100",
                    }
                )
            raise AssertionError(f"Unexpected RPC {rpc_name}")

        mock_rpc.side_effect = rpc_side_effect

        # 1. /stats + cache hit
        r1 = self.client.get("/api/public/stats")
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.headers.get("cache-control"), "public, max-age=600")
        self.assertEqual(r1.json()["total"], 12)
        self.client.get("/api/public/stats")
        stats_calls = [c for c in mock_rpc.call_args_list if c.args[0] == "public_dashboard_stats"]
        self.assertEqual(len(stats_calls), 1)

        # 2. /wards & 3. /wards/names (must derive solely from public_ward_stats & exclude Other/suppressed)
        rw = self.client.get("/api/public/wards")
        self.assertEqual(rw.status_code, 200)
        self.assertEqual(rw.headers.get("cache-control"), "public, max-age=600")

        rwn = self.client.get("/api/public/wards/names")
        self.assertEqual(rwn.status_code, 200)
        self.assertEqual(rwn.headers.get("cache-control"), "public, max-age=600")
        self.assertEqual(rwn.json(), {"wards": ["Ward 4"]})
        self.assertEqual(
            len([c for c in mock_rpc.call_args_list if c.args[0] == "public_ward_stats"]),
            1,
        )

        # 4. /departments
        rd = self.client.get("/api/public/departments")
        self.assertEqual(rd.status_code, 200)
        self.assertEqual(rd.headers.get("cache-control"), "public, max-age=600")

        # 5. /map-points + normalized whitespace cache hit + allow-list stripping
        rm1 = self.client.get("/api/public/map-points?ward=%20Ward%20%204%20&category=potholes")
        rm2 = self.client.get("/api/public/map-points?ward=Ward+4&category=potholes")
        self.assertEqual(rm1.status_code, 200)
        self.assertEqual(rm2.status_code, 200)
        self.assertEqual(rm1.headers.get("cache-control"), "public, max-age=120")
        pt = rm1.json()["points"][0]
        self.assertNotIn("id", pt)
        self.assertNotIn("complaint_number", pt)
        self.assertNotIn("citizen_id", pt)
        self.assertEqual(
            len([c for c in mock_rpc.call_args_list if c.args[0] == "public_map_points"]),
            1,
        )

        # Different filter gets separate cache key
        rm3 = self.client.get("/api/public/map-points?ward=Ward+4&category=garbage")
        self.assertEqual(rm3.status_code, 200)
        self.assertEqual(
            len([c for c in mock_rpc.call_args_list if c.args[0] == "public_map_points"]),
            2,
        )

        # 6. /complaints + allow-list stripping
        rl = self.client.get("/api/public/complaints?ward=Ward+4&status=in_progress&page=1&page_size=20")
        self.assertEqual(rl.status_code, 200)
        self.assertEqual(rl.headers.get("cache-control"), "public, max-age=120")
        list_item = rl.json()["items"][0]
        self.assertNotIn("id", list_item)
        self.assertNotIn("complaint_number", list_item)
        self.assertNotIn("email", list_item)

        # 7. /complaints/{reference} + allow-list stripping
        rdet = self.client.get(f"/api/public/complaints/{VALID_UUID}")
        self.assertEqual(rdet.status_code, 200)
        self.assertEqual(rdet.headers.get("cache-control"), "public, max-age=300")
        det_item = rdet.json()
        self.assertNotIn("id", det_item)
        self.assertNotIn("complaint_number", det_item)
        self.assertNotIn("phone", det_item)

    def test_validation_errors_return_400_and_malformed_uuid_returns_404(self):
        # Unknown query params -> 400 across endpoints
        self.assertEqual(self.client.get("/api/public/stats?foo=bar").status_code, 400)
        self.assertEqual(self.client.get("/api/public/wards?foo=bar").status_code, 400)
        self.assertEqual(self.client.get("/api/public/complaints?unknown=1").status_code, 400)
        self.assertEqual(
            self.client.get(f"/api/public/complaints/{VALID_UUID}?extra=1").status_code, 400
        )

        # Invalid filters / pagination -> 400 (not 422)
        self.assertEqual(
            self.client.get("/api/public/complaints?category=invalid_cat").status_code, 400
        )
        self.assertEqual(
            self.client.get("/api/public/complaints?status=rejected").status_code, 400
        )
        self.assertEqual(
            self.client.get("/api/public/complaints?page=0").status_code, 400
        )
        self.assertEqual(
            self.client.get("/api/public/complaints?page=abc").status_code, 400
        )
        self.assertEqual(
            self.client.get("/api/public/complaints?page_size=51").status_code, 400
        )
        self.assertEqual(
            self.client.get(f"/api/public/map-points?ward={'x' * 101}").status_code, 400
        )

        # Malformed UUID -> 404 (not 422)
        for bad_ref in ("not-a-uuid", "12345", "RU-2026-00001"):
            res = self.client.get(f"/api/public/complaints/{bad_ref}")
            self.assertEqual(res.status_code, 404)

    @patch("app.services.public_service._call_public_rpc", new_callable=AsyncMock)
    def test_not_found_is_not_cached(self, mock_rpc):
        # Valid UUID not found -> 404
        mock_rpc.return_value = None
        r404 = self.client.get(f"/api/public/complaints/{VALID_UUID}")
        self.assertEqual(r404.status_code, 404)

        # Next request still invokes RPC (404 was not cached)
        mock_rpc.return_value = make_sample_item()
        r200 = self.client.get(f"/api/public/complaints/{VALID_UUID}")
        self.assertEqual(r200.status_code, 200)
        self.assertEqual(mock_rpc.call_count, 2)

    def test_rpc_timeout_p0400_and_upstream_db_error_mapping(self):
        async def fake_timeout(*args, **kwargs):
            raise httpx.TimeoutException("upstream socket timeout")

        with patch("app.services.public_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.public_service.settings.SUPABASE_SERVICE_ROLE_KEY", "SECRET_ROLE_KEY_LEAK_CHECK"), \
             patch("app.services.public_service.httpx.AsyncClient.post", side_effect=fake_timeout):
            res = self.client.get("/api/public/stats")
            self.assertEqual(res.status_code, 503)
            self.assertNotIn("SECRET_ROLE_KEY_LEAK_CHECK", res.text)
            self.assertNotIn("supabase.co", res.text)

        # Upstream PostgREST P0400 -> 400
        fake_p0400_resp = httpx.Response(400, json={"code": "P0400", "message": "Invalid filter"})
        with patch("app.services.public_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.public_service.settings.SUPABASE_SERVICE_ROLE_KEY", "SECRET_ROLE_KEY_LEAK_CHECK"), \
             patch("app.services.public_service.httpx.AsyncClient.post", return_value=fake_p0400_resp):
            res_p0400 = self.client.get("/api/public/complaints?ward=Test")
            self.assertEqual(res_p0400.status_code, 400)

        # Upstream PostgREST error with sensitive SQL text must sanitize to 503
        fake_500_resp = httpx.Response(
            500,
            json={"message": "SELECT * FROM private_users WHERE secret=1"},
        )
        with patch("app.services.public_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.public_service.settings.SUPABASE_SERVICE_ROLE_KEY", "SECRET_ROLE_KEY_LEAK_CHECK"), \
             patch("app.services.public_service.httpx.AsyncClient.post", return_value=fake_500_resp):
            res2 = self.client.get("/api/public/wards")
            self.assertEqual(res2.status_code, 503)
            self.assertNotIn("SELECT", res2.text)
            self.assertNotIn("private_users", res2.text)

    @patch("app.services.public_service._call_public_rpc", new_callable=AsyncMock)
    def test_rate_limit_enforced_before_cache_lookup(self, mock_rpc):
        mock_rpc.return_value = {
            "total": 1,
            "resolved": 1,
            "pending": 0,
            "rejected": None,
            "rejected_suppressed": True,
            "overdue": 0,
            "no_deadline_count": 0,
            "resolution_rate": 100.0,
            "avg_resolution_hours": 2.0,
        }

        for i in range(60):
            res = self.client.get("/api/public/stats")
            self.assertEqual(res.status_code, 200, f"Request {i+1} unexpectedly failed")

        # RPC called once thanks to cache
        self.assertEqual(mock_rpc.call_count, 1)

        # 61st request hits cached endpoint yet is STILL rate-limited
        r61 = self.client.get("/api/public/stats")
        self.assertEqual(r61.status_code, 429)
        self.assertIn("Retry-After", r61.headers)


if __name__ == "__main__":
    unittest.main()
