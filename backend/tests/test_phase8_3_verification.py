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

    def test_reopen_limit_escalates_to_admin_and_env_config_applies(self):
        from app.config import Settings

        with patch.dict(os.environ, {"MAX_DISPUTE_REOPENS": "1", "CITIZEN_VERIFY_TIMEOUT_DAYS": "14"}):
            cfg = Settings()
            self.assertEqual(cfg.MAX_DISPUTE_REOPENS, 1)
            self.assertEqual(cfg.CITIZEN_VERIFY_TIMEOUT_DAYS, 14)

        app.dependency_overrides[get_authenticated_actor] = lambda: CITIZEN_ACTOR
        captured_rpc_payload = {}

        async def fake_post_escalate(client_self, url, **kwargs):
            captured_rpc_payload["json"] = kwargs.get("json")
            return _mock_http_response(
                200,
                {
                    "verification_id": VID_1,
                    "complaint_id": CID_1,
                    "evidence_id": EID_1,
                    "decision": "disputed",
                    "reason": "Third dispute after max reopens.",
                    "complaint_status": "resolved",
                    "action": "escalated_to_admin",
                    "reopened": False,
                    "escalated_to_admin": True,
                    "reopen_count": 2,
                    "max_reopens": 2,
                    "created_at": "2026-11-25T13:00:00Z",
                },
            )

        with patch("app.services.verification_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.verification_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("app.services.verification_service.settings.MAX_DISPUTE_REOPENS", 2), \
             patch("httpx.AsyncClient.post", new=fake_post_escalate):
            res = self.client.post(
                f"/api/complaints/{CID_1}/resolution/dispute",
                json={"evidence_id": EID_1, "reason": "Third dispute after max reopens."},
            )

        self.assertEqual(res.status_code, 200)
        self.assertEqual(captured_rpc_payload["json"]["p_max_reopens"], 2)
        body = res.json()
        self.assertFalse(body["reopened"])
        self.assertTrue(body["escalated_to_admin"])
        self.assertIn("administrator will review", body["message"].lower())

    def test_admin_disputes_list_and_decision_endpoints(self):
        # Citizen & officer cannot access admin dispute queue or decision endpoint
        for actor in (CITIZEN_ACTOR, OFFICER_ACTOR):
            app.dependency_overrides[get_authenticated_actor] = lambda a=actor: a
            self.assertEqual(self.client.get("/api/admin/disputes").status_code, 403)
            self.assertEqual(
                self.client.post(
                    f"/api/admin/complaints/{CID_1}/dispute-decision",
                    json={"action": "reopen", "note": "Valid admin note."},
                ).status_code,
                403,
            )

        app.dependency_overrides[get_authenticated_actor] = lambda: ADMIN_ACTOR
        self.assertEqual(self.client.get("/api/admin/disputes?status=bogus").status_code, 400)
        self.assertEqual(
            self.client.post(
                f"/api/admin/complaints/{CID_1}/dispute-decision",
                json={"action": "invalid", "note": "Valid admin note."},
            ).status_code,
            422,
        )

        async def fake_post_admin(client_self, url, **kwargs):
            if "/rpc/list_admin_disputed_complaints" in url:
                return _mock_http_response(
                    200,
                    {
                        "items": [
                            {
                                "complaint_id": CID_1,
                                "complaint_reference": "RU-2026-00999",
                                "title": "Broken Drain",
                                "category": "drainage",
                                "ward": "Ward 2",
                                "complaint_status": "resolved",
                                "dispute_state": "escalated_to_admin",
                                "reopen_count": 2,
                                "latest_reason": "Still blocked",
                                "citizen_display_name": "Asha R.",
                                "sla_deadline": "2026-11-28T10:00:00Z",
                                "updated_at": "2026-11-25T13:00:00Z",
                                "admin_decided_at": None,
                            }
                        ],
                        "page": 1,
                        "page_size": 20,
                        "total": 1,
                        "total_pages": 1,
                    },
                )
            if "/rpc/admin_decide_disputed_complaint" in url:
                return _mock_http_response(
                    200,
                    {
                        "complaint_id": CID_1,
                        "action": "close_unconfirmed",
                        "complaint_status": "not_confirmed_by_citizen",
                        "dispute_state": "admin_resolved",
                        "admin_resolution_note": "Verified closed on site.",
                        "admin_decided_at": "2026-11-25T14:00:00Z",
                    },
                )
            return _mock_http_response(404)

        with patch("app.services.verification_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.verification_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.post", new=fake_post_admin):
            list_res = self.client.get("/api/admin/disputes?status=escalated_to_admin")
            self.assertEqual(list_res.status_code, 200)
            self.assertEqual(list_res.headers.get("cache-control"), "no-store")
            self.assertEqual(list_res.json()["items"][0]["dispute_state"], "escalated_to_admin")

            dec_res = self.client.post(
                f"/api/admin/complaints/{CID_1}/dispute-decision",
                json={"action": "close_unconfirmed", "note": "Verified closed on site."},
            )
            self.assertEqual(dec_res.status_code, 200)
            self.assertEqual(dec_res.json()["complaint_status"], "not_confirmed_by_citizen")

    def test_internal_close_unconfirmed_dry_run_and_auth(self):
        secret = "test-sweep-secret-minimum-32-characters-long"
        with patch("app.services.sla_service.settings.SLA_SWEEP_SECRET", secret):
            self.assertEqual(self.client.post("/api/internal/close-unconfirmed", json={"dry_run": True}).status_code, 403)
            self.assertEqual(
                self.client.post(
                    "/api/internal/close-unconfirmed?timeout_days=0",
                    headers={"x-sweep-secret": secret},
                ).status_code,
                400,
            )

            with patch(
                "app.services.sla_service._call_public_rpc",
                new_callable=AsyncMock,
                return_value={"dry_run": True, "timeout_days": 7, "eligible_count": 3, "closed_count": 0},
            ) as mock_rpc:
                res = self.client.post(
                    "/api/internal/close-unconfirmed",
                    headers={"x-sweep-secret": secret},
                    json={"dry_run": True, "timeout_days": 7, "batch_limit": 50},
                )
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers.get("cache-control"), "no-store")
            self.assertTrue(res.json()["dry_run"])
            self.assertEqual(res.json()["eligible_count"], 3)
            self.assertEqual(res.json()["closed_count"], 0)
            mock_rpc.assert_awaited_once()


class Phase83MigrationStaticReviewTests(unittest.TestCase):
    def test_migration_and_rollback_integrity(self):
        mig1 = (REPO_ROOT / "supabase/migrations/20261130_phase8_3_verification_dispute.sql").read_text(encoding="utf-8")
        undo1 = (REPO_ROOT / "supabase/rollbacks/20261130_phase8_3_verification_dispute_UNDO.sql").read_text(encoding="utf-8")
        mig_enum = (REPO_ROOT / "supabase/migrations/20261201_phase8_4_status_enum_extend.sql").read_text(encoding="utf-8")
        mig2 = (REPO_ROOT / "supabase/migrations/20261202_phase8_4_complete_verification_and_disputes.sql").read_text(encoding="utf-8")
        undo2 = (REPO_ROOT / "supabase/rollbacks/20261202_phase8_4_complete_verification_and_disputes_UNDO.sql").read_text(encoding="utf-8")

        self.assertIn("CREATE TABLE IF NOT EXISTS public.complaint_resolution_verifications", mig1)
        self.assertIn("CONSTRAINT uq_resolution_verification_evidence_citizen UNIQUE (evidence_id, citizen_id)", mig1)
        self.assertIn("ENABLE ROW LEVEL SECURITY", mig1)
        self.assertIn("FORCE ROW LEVEL SECURITY", mig1)
        self.assertIn("BEFORE UPDATE OR DELETE ON public.complaint_resolution_verifications", mig1)
        self.assertIn("BEFORE TRUNCATE ON public.complaint_resolution_verifications", mig1)
        self.assertIn("SET search_path = ''", mig1)
        self.assertIn("pg_catalog.aclexplode", mig1)
        self.assertNotIn("has_table_privilege('PUBLIC'", mig1)
        self.assertNotIn("has_function_privilege('PUBLIC'", mig1)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.get_ai_resolution_check_inputs(UUID) TO service_role;", mig1)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.count_ai_resolution_checks_since(TIMESTAMPTZ, UUID) TO service_role;", mig1)
        self.assertIn("DROP TABLE IF EXISTS public.complaint_resolution_verifications;", undo1)

        self.assertIn("ADD VALUE IF NOT EXISTS 'not_confirmed_by_citizen'", mig_enum)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.complaint_dispute_cases", mig2)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.complaint_verification_history", mig2)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT, INT) TO authenticated;", mig2)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.close_unconfirmed_resolved_complaints(INT, INT, BOOLEAN) TO service_role;", mig2)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.list_admin_disputed_complaints(TEXT, INT, INT) TO authenticated;", mig2)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.admin_decide_disputed_complaint(UUID, TEXT, TEXT) TO authenticated;", mig2)
        self.assertIn("pg_catalog.aclexplode", mig2)
        self.assertIn("DROP TABLE IF EXISTS public.complaint_verification_history;", undo2)

        # Privacy prompts check (Step 3)
        from app.services.gemini_service import SYSTEM_INSTRUCTION
        from app.services.ai_resolution_service import AI_COMPARISON_SYSTEM_INSTRUCTION
        for prompt_text in (SYSTEM_INSTRUCTION, AI_COMPARISON_SYSTEM_INSTRUCTION):
            self.assertIn("faces", prompt_text.lower())
            self.assertIn("number plates", prompt_text.lower())
