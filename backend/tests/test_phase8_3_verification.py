"""
ReportlyUrban — Phase 8.3 Citizen Verification/Dispute, Reopen & Verification History Tests
All tests are local and mocked; never calls live Supabase or live Gemini API.
"""

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.main import app  # noqa: E402
from app.services.auth_service import AuthenticatedActor, get_authenticated_actor  # noqa: E402
from app.services import verification_service  # noqa: E402

REPO_ROOT = Path(BACKEND_DIR).parent
CID_1 = "11111111-1111-4111-8111-111111111111"
EID_1 = "22222222-2222-4222-8222-222222222222"
VID_1 = "33333333-3333-4333-8333-333333333333"

CITIZEN_ACTOR = AuthenticatedActor(
    user_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    role="citizen",
    token="tok-citizen",
)
OTHER_CITIZEN_ACTOR = AuthenticatedActor(
    user_id="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    role="citizen",
    token="tok-other-citizen",
)
ADMIN_ACTOR = AuthenticatedActor(
    user_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role="admin",
    token="tok-admin",
)
OFFICER_ACTOR = AuthenticatedActor(
    user_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    role="officer",
    token="tok-officer",
    officer_id="55555555-5555-4555-8555-555555555555",
    department_id="44444444-4444-4444-8444-444444444444",
)


def _mock_http_response(status_code: int, json_body=None) -> httpx.Response:
    res = AsyncMock(spec=httpx.Response)
    res.status_code = status_code
    res.json.return_value = json_body
    res.headers = httpx.Headers({})
    return res


class Phase83VerificationEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        app.dependency_overrides.clear()
        verification_service.dispute_user_limiter._hits.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_unauthenticated_returns_401_and_wrong_roles_return_403(self):
        self.assertEqual(self.client.get(f"/api/complaints/{CID_1}/resolution/verification").status_code, 401)
        self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/verify", json={}).status_code, 401)
        self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/dispute", json={"reason": "Still broken"}).status_code, 401)
        self.assertEqual(self.client.get(f"/api/admin/complaints/{CID_1}/verifications").status_code, 401)

        for non_citizen in (ADMIN_ACTOR, OFFICER_ACTOR):
            app.dependency_overrides[get_authenticated_actor] = lambda a=non_citizen: a
            self.assertEqual(self.client.get(f"/api/complaints/{CID_1}/resolution/verification").status_code, 403)
            self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/verify", json={}).status_code, 403)
            self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/dispute", json={"reason": "Still broken"}).status_code, 403)

        for non_admin in (CITIZEN_ACTOR, OFFICER_ACTOR):
            app.dependency_overrides[get_authenticated_actor] = lambda a=non_admin: a
            self.assertEqual(self.client.get(f"/api/admin/complaints/{CID_1}/verifications").status_code, 403)

    def test_dispute_without_reason_or_script_payload_returns_422(self):
        app.dependency_overrides[get_authenticated_actor] = lambda: CITIZEN_ACTOR
        self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/dispute", json={}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/dispute", json={"reason": "   "}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/dispute", json={"reason": "<script>alert(1)</script>"}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/dispute", json={"reason": "x" * 1001}).status_code, 422)
        self.assertEqual(self.client.post(f"/api/complaints/{CID_1}/resolution/verify", json={"extra": 1}).status_code, 422)

    def test_non_reporter_wrong_status_and_duplicate_decision_mapping(self):
        # 1. Non-reporter rejected (42501 from RPC -> 404)
        app.dependency_overrides[get_authenticated_actor] = lambda: OTHER_CITIZEN_ACTOR

        async def fake_post_forbidden(client_self, url, **kwargs):
            return _mock_http_response(403, {"code": "42501", "message": "Not reporting citizen"})

        with patch("app.services.verification_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.verification_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.post", new=fake_post_forbidden):
            res_non_rep = self.client.post(
                f"/api/complaints/{CID_1}/resolution/verify",
                json={"evidence_id": EID_1},
            )
        self.assertEqual(res_non_rep.status_code, 404)

        # 2. Wrong complaint status -> 409 Conflict
        app.dependency_overrides[get_authenticated_actor] = lambda: CITIZEN_ACTOR

        async def fake_get_in_progress(client_self, url, **kwargs):
            return _mock_http_response(200, [{"id": CID_1, "status": "in_progress"}])

        with patch("app.services.verification_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.verification_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new=fake_get_in_progress):
            res_wrong_status = self.client.post(
                f"/api/complaints/{CID_1}/resolution/dispute",
                json={"reason": "Not repaired"},
            )
        self.assertEqual(res_wrong_status.status_code, 409)

        # 3. Duplicate decision -> 409 Conflict
        async def fake_post_dup(client_self, url, **kwargs):
            return _mock_http_response(409, {"code": "23505", "message": "duplicate key value"})

        with patch("app.services.verification_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.verification_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.post", new=fake_post_dup):
            res_dup = self.client.post(
                f"/api/complaints/{CID_1}/resolution/verify",
                json={"evidence_id": EID_1},
            )
        self.assertEqual(res_dup.status_code, 409)

    def test_verify_and_dispute_use_citizen_jwt_contain_zero_ai_fields_and_never_trigger_ai(self):
        app.dependency_overrides[get_authenticated_actor] = lambda: CITIZEN_ACTOR

        async def fake_get(client_self, url, **kwargs):
            headers = kwargs.get("headers") or {}
            self.assertEqual(headers.get("Authorization"), "Bearer tok-citizen")
            if "/rest/v1/complaints" in url:
                return _mock_http_response(200, [{"id": CID_1, "status": "resolved"}])
            if "/rest/v1/complaint_resolution_evidence" in url:
                return _mock_http_response(200, [{"id": EID_1, "created_at": "2026-11-25T10:00:00Z"}])
            if "/rest/v1/complaint_resolution_verifications" in url:
                return _mock_http_response(200, [])
            return _mock_http_response(404)

        async def fake_post_dispute(client_self, url, **kwargs):
            headers = kwargs.get("headers") or {}
            self.assertEqual(headers.get("Authorization"), "Bearer tok-citizen")
            self.assertIn("/rpc/submit_resolution_verification", url)
            return _mock_http_response(
                200,
                {
                    "verification_id": VID_1,
                    "complaint_id": CID_1,
                    "evidence_id": EID_1,
                    "decision": "disputed",
                    "reason": "Pothole is still open.",
                    "complaint_status": "in_progress",
                    "created_at": "2026-11-25T12:00:00Z",
                },
            )

        with patch("app.services.verification_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.verification_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("app.services.ai_resolution_service.run_automatic_ai_resolution_check", new_callable=AsyncMock) as mock_auto_ai, \
             patch("httpx.AsyncClient.get", new=fake_get), \
             patch("httpx.AsyncClient.post", new=fake_post_dispute):
            status_res = self.client.get(f"/api/complaints/{CID_1}/resolution/verification")
            self.assertEqual(status_res.status_code, 200)
            self.assertEqual(status_res.headers.get("cache-control"), "no-store")
            self.assertTrue(status_res.json()["can_verify"])
            for forbidden in ("verdict", "confidence", "ai_", "appears_fixed"):
                self.assertNotIn(forbidden, status_res.text)

            dispute_res = self.client.post(
                f"/api/complaints/{CID_1}/resolution/dispute",
                json={"reason": "Pothole is still open."},
            )
            self.assertEqual(dispute_res.status_code, 200)
            self.assertEqual(dispute_res.headers.get("cache-control"), "no-store")
            self.assertEqual(dispute_res.json()["complaint_status"], "in_progress")
            for forbidden in ("verdict", "confidence", "ai_", "appears_fixed"):
                self.assertNotIn(forbidden, dispute_res.text)
            mock_auto_ai.assert_not_called()

    def test_admin_verification_history_returns_sanitized_history(self):
        app.dependency_overrides[get_authenticated_actor] = lambda: ADMIN_ACTOR

        async def fake_post(client_self, url, **kwargs):
            headers = kwargs.get("headers") or {}
            self.assertEqual(headers.get("Authorization"), "Bearer tok-admin")
            return _mock_http_response(
                200,
                {
                    "complaint_id": CID_1,
                    "complaint_status": "in_progress",
                    "latest_evidence_id": EID_1,
                    "latest_decision": "disputed",
                    "history": [
                        {
                            "id": VID_1,
                            "evidence_id": EID_1,
                            "decision": "disputed",
                            "reason": "Water still leaking.",
                            "citizen_display_name": "Asha R.",
                            "created_at": "2026-11-25T12:00:00Z",
                        }
                    ],
                },
            )

        with patch("app.services.verification_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.verification_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.post", new=fake_post):
            res = self.client.get(f"/api/admin/complaints/{CID_1}/verifications")

        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers.get("cache-control"), "no-store")
        body = res.json()
        self.assertEqual(body["latest_decision"], "disputed")
        self.assertEqual(body["history"][0]["citizen_display_name"], "Asha R.")


class Phase83MigrationStaticReviewTests(unittest.TestCase):
    def test_migration_and_rollback_integrity(self):
        mig = (REPO_ROOT / "supabase/migrations/20261130_phase8_3_verification_dispute.sql").read_text(encoding="utf-8")
        undo = (REPO_ROOT / "supabase/rollbacks/20261130_phase8_3_verification_dispute_UNDO.sql").read_text(encoding="utf-8")

        self.assertIn("CREATE TABLE IF NOT EXISTS public.complaint_resolution_verifications", mig)
        self.assertIn("CONSTRAINT uq_resolution_verification_evidence_citizen UNIQUE (evidence_id, citizen_id)", mig)
        self.assertIn("ENABLE ROW LEVEL SECURITY", mig)
        self.assertIn("FORCE ROW LEVEL SECURITY", mig)
        self.assertIn("BEFORE UPDATE OR DELETE ON public.complaint_resolution_verifications", mig)
        self.assertIn("BEFORE TRUNCATE ON public.complaint_resolution_verifications", mig)
        self.assertIn("SET search_path = ''", mig)
        self.assertIn("pg_catalog.aclexplode", mig)
        self.assertNotIn("has_table_privilege('PUBLIC'", mig)
        self.assertNotIn("has_function_privilege('PUBLIC'", mig)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT) TO authenticated;", mig)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.get_ai_resolution_check_inputs(UUID) TO service_role;", mig)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.count_ai_resolution_checks_since(TIMESTAMPTZ, UUID) TO service_role;", mig)
        self.assertIn("DROP TABLE IF EXISTS public.complaint_resolution_verifications;", undo)
