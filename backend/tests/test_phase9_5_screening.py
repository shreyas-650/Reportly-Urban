import asyncio
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import BackgroundTasks
from fastapi.testclient import TestClient

from app.config import parse_department_routing_mode, settings
from app.main import app
from app.schemas.screening import parse_and_validate_screening_output
from app.services import (
    ai_intelligence_service as ai_svc,
    department_routing_service as dept_svc,
    officer_routing_service as off_svc,
    screening_service as scr_svc,
)
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = REPO_ROOT / "supabase" / "migrations" / "20261210_phase9_5_suspicious_claim_screening.sql"
ROLLBACK_PATH = REPO_ROOT / "supabase" / "rollbacks" / "20261210_phase9_5_suspicious_claim_screening_UNDO.sql"

COMPLAINT_ID = "11111111-1111-4111-8111-111111111111"
CITIZEN_ID = "22222222-2222-4222-8222-222222222222"
ADMIN_ID = "33333333-3333-4333-8333-333333333333"
DECISION_ID = "44444444-4444-4444-8444-444444444444"


def _json_response(status_code: int, body):
    return SimpleNamespace(
        status_code=status_code,
        json=lambda: body,
        text=json.dumps(body) if not isinstance(body, str) else body,
    )


def _sample_signals(**overrides):
    base = {
        "id": COMPLAINT_ID,
        "title": "Large pothole near hospital gate",
        "category": "potholes",
        "description": "Deep pothole blocking left lane near main municipal hospital entrance.",
        "priority": "high",
        "status": "submitted",
        "has_coordinates": True,
        "latitude": 19.0760,
        "longitude": 72.8777,
        "image_url_present": True,
        "storage_object_found": True,
        "storage_mime": "image/jpeg",
        "storage_size": 102400,
        "reused_photo_count": 0,
        "rate_1h": 1,
        "rate_24h": 1,
        "recent_texts": [],
        "dup_check_ok": True,
        "dup_suspected_count": 0,
        "dup_confirmed_count": 0,
        "dup_candidate_count": 0,
        "review_found": False,
        "existing_admin_decision": "none",
        "existing_advancement_outcome": "none",
        "admin_touched": False,
    }
    base.update(overrides)
    return base


class Phase95MigrationStaticTests(unittest.TestCase):
    def test_migration_and_rollback_satisfy_safety_and_sql_rules(self):
        self.assertTrue(MIGRATION_PATH.exists(), "Phase 9.5 migration missing")
        self.assertTrue(ROLLBACK_PATH.exists(), "Phase 9.5 UNDO missing")

        sql = MIGRATION_PATH.read_text(encoding="utf-8")
        undo_sql = ROLLBACK_PATH.read_text(encoding="utf-8")

        # Required tables, FORCE RLS, and admin-only policies
        for tbl in (
            "complaint_screening_reviews",
            "complaint_screening_events",
            "ai_screening_accuracy_metrics",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS public.{tbl}", sql)
            self.assertIn(f"ALTER TABLE public.{tbl} FORCE ROW LEVEL SECURITY", sql)
            self.assertIn(f"DROP TABLE IF EXISTS public.{tbl}", undo_sql)

        # Fairness: no ward segmentation on accuracy metrics or risk reasons
        self.assertNotIn("location_mismatch", sql)
        self.assertIn("CONSTRAINT uidx_screening_accuracy_version UNIQUE (model_name, prompt_version, screening_version)", sql)
        self.assertIn("rejection_rate", sql)

        # Zero RECORD variable declarations across Phase 9.5 SQL bodies
        sql_no_comments = re.sub(r"--.*", "", sql)
        self.assertIsNone(re.search(r"^\s*[a-z0-9_]+\s+RECORD\b", sql_no_comments, re.IGNORECASE | re.MULTILINE))

        # Never schema-qualify LEAST / GREATEST / COALESCE
        self.assertIsNone(re.search(r"pg_catalog\.(least|greatest|coalesce)\s*\(", sql, re.IGNORECASE))

        # SET search_path = '' and EXCEPTION WHEN OTHERS fallback
        self.assertIn("SET search_path = ''", sql)
        self.assertIn("EXCEPTION WHEN OTHERS THEN", sql)

        # Never alter complaint_status enum or existing transition / 9.2 / 9.3 functions
        self.assertNotIn("ALTER TYPE public.complaint_status", sql)
        self.assertNotIn("CREATE OR REPLACE FUNCTION public.transition_complaint_status", sql)
        self.assertNotIn("CREATE OR REPLACE FUNCTION public.evaluate_and_assign_department_ai", sql)
        self.assertNotIn("CREATE OR REPLACE FUNCTION public.evaluate_and_assign_officer_ai", sql)

        # Exact manual submitted -> under_review history title
        self.assertIn("'Under Municipal Review'", sql)
        # Never transitions to rejected inside screening RPCs
        self.assertNotIn("SET status = 'rejected'", sql)


class Phase95ScreeningUnitAndIntegrationTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides.clear()
        scr_svc.screening_trigger_user_limiter._hits.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_mode_defaults_to_shadow(self):
        self.assertEqual(parse_department_routing_mode(None), "shadow")
        self.assertEqual(parse_department_routing_mode("invalid"), "shadow")
        self.assertEqual(parse_department_routing_mode("active"), "active")

    def test_prompt_excludes_pii_and_ward_and_rejects_injection(self):
        signals = _sample_signals(
            citizen_id="secret-citizen-uuid",
            full_name="Alice Citizen",
            phone_number="+919999999999",
            email="alice@example.com",
            ward="Ward 99 North",
            location="123 Main Street",
        )
        prompt = scr_svc.build_screening_prompt_payload(signals)
        for forbidden in (
            "secret-citizen-uuid",
            "Alice Citizen",
            "+919999999999",
            "alice@example.com",
            "Ward 99 North",
            "123 Main Street",
            "19.076",
            "72.8777",
        ):
            self.assertNotIn(forbidden, prompt)
        self.assertIn("<UNTRUSTED_COMPLAINT_DATA>", prompt)

        # Prompt injection / elevated risk with missing reason codes or extra fields rejected
        bad1, err1 = parse_and_validate_screening_output(
            '{"risk_level": "high", "reason_codes": [], "confidence": 0.99, "needs_clarification": false}'
        )
        self.assertIsNone(bad1)
        self.assertEqual(err1, "missing_reason_codes_for_elevated_risk")

        bad2, err2 = parse_and_validate_screening_output(
            '{"risk_level": "low", "reason_codes": [], "confidence": 0.95, "needs_clarification": false, "auto_reject": true}'
        )
        self.assertIsNone(bad2)
        self.assertEqual(err2, "schema_validation_failed")

    def test_duplicate_gates_block_suspected_confirmed_missing_and_allow_clean(self):
        # Suspected duplicate blocks advancement operationally (never sets fraud reason)
        sus = scr_svc.evaluate_deterministic_signals(_sample_signals(dup_suspected_count=1))
        self.assertIn("duplicate_suspected", sus["operational_flags"])
        self.assertEqual(sus["reason_codes"], [])
        self.assertEqual(sus["risk_level"], "low")

        # Confirmed duplicate blocks advancement operationally
        conf = scr_svc.evaluate_deterministic_signals(_sample_signals(dup_confirmed_count=1))
        self.assertIn("duplicate_confirmed", conf["operational_flags"])

        # Missing/failed duplicate check fails closed
        miss = scr_svc.evaluate_deterministic_signals(_sample_signals(dup_check_ok=False))
        self.assertIn("duplicate_missing", miss["operational_flags"])

        # Clean after admin marked links not_duplicate (0 suspected, 0 confirmed, 0 candidates, check_ok True)
        clean = scr_svc.evaluate_deterministic_signals(_sample_signals())
        self.assertEqual(clean["operational_flags"], [])
        self.assertEqual(clean["reason_codes"], [])
        self.assertEqual(clean["risk_level"], "low")

    def test_amendment_f_caps_rate_reused_photo_and_text_spam_at_medium_and_fairness(self):
        rate_det = scr_svc.evaluate_deterministic_signals(_sample_signals(rate_1h=8, rate_24h=20))
        self.assertEqual(rate_det["risk_level"], "medium")
        self.assertIn("rate_abuse", rate_det["reason_codes"])

        reuse_det = scr_svc.evaluate_deterministic_signals(_sample_signals(reused_photo_count=2))
        self.assertEqual(reuse_det["risk_level"], "medium")
        self.assertIn("no_evidence", reuse_det["reason_codes"])

        spam_det = scr_svc.evaluate_deterministic_signals(
            _sample_signals(
                recent_texts=[
                    {
                        "id": "99999999-9999-4999-8999-999999999999",
                        "title": "Large pothole near hospital gate",
                        "description": "Deep pothole blocking left lane near main municipal hospital entrance.",
                    }
                ]
            )
        )
        self.assertEqual(spam_det["risk_level"], "medium")
        self.assertIn("duplicate_spam", spam_det["reason_codes"])

        # Ward & language invariance
        a = scr_svc.evaluate_deterministic_signals(_sample_signals(ward="Ward 1", title="Pothole on avenue"))
        b = scr_svc.evaluate_deterministic_signals(_sample_signals(ward="Ward 42", title="Pothole on avenue"))
        self.assertEqual(a["risk_level"], b["risk_level"])
        self.assertEqual(a["reason_codes"], b["reason_codes"])

    def test_gemini_failure_fails_open_never_high_risk_never_auto_rejects(self):
        captured = {}

        async def fake_record(complaint_id, **kwargs):
            captured.update(kwargs)
            return {"mode": kwargs["mode"], "applied_advance": False, "review_status": "clear"}

        with patch.object(settings, "SCREENING_MODE", "active"), \
             patch.object(settings, "AI_INTELLIGENCE_ENABLED", True), \
             patch.object(scr_svc, "_fetch_deterministic_signals_service", AsyncMock(return_value=_sample_signals())), \
             patch.object(scr_svc, "_count_citizen_screening_calls_24h", AsyncMock(return_value=0)), \
             patch.object(scr_svc, "_claim_screening_ai_decision", AsyncMock(return_value=DECISION_ID)), \
             patch.object(scr_svc, "reserve_intelligence_ai_quota", AsyncMock(return_value=SimpleNamespace(reservation_id="r1", status="reserved"))), \
             patch.object(scr_svc, "release_intelligence_ai_quota", AsyncMock()), \
             patch.object(scr_svc, "_complete_screening_ai_decision", AsyncMock(return_value=True)), \
             patch.object(scr_svc, "_invoke_gemini_screening_with_retry", AsyncMock(side_effect=asyncio.TimeoutError())), \
             patch.object(scr_svc, "_record_screening_rpc", side_effect=fake_record):
            res = asyncio.run(scr_svc.run_background_complaint_screening(COMPLAINT_ID))

        self.assertFalse(res["applied_advance"])
        self.assertEqual(captured["risk_level"], "low")
        self.assertEqual(captured["reason_codes"], [])
        self.assertIn("error", captured["operational_flags"])
        self.assertFalse(captured["would_advance"])

    def test_shadow_mode_records_without_advancing_or_blocking_92_93(self):
        # Amendment A & B: In shadow mode, 9.1 -> 9.2 -> 9.3 runs intact and never blocks on flag check error
        bg = BackgroundTasks()
        actor = AuthenticatedActor(user_id=CITIZEN_ID, role="citizen", token="jwt")

        with patch.object(settings, "AI_INTELLIGENCE_ENABLED", True), \
             patch.object(settings, "SCREENING_MODE", "shadow"), \
             patch.object(settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "active"), \
             patch.object(ai_svc, "verify_citizen_complaint_ownership", AsyncMock()), \
             patch.object(ai_svc.ai_intelligence_user_limiter, "check_and_record", AsyncMock()), \
             patch.object(ai_svc.ai_intelligence_global_limiter, "check_and_record", AsyncMock()):
            asyncio.run(ai_svc.schedule_shadow_category_priority_suggestion(bg, actor, COMPLAINT_ID))

        task_funcs = [t.func.__name__ for t in bg.tasks]
        self.assertEqual(
            task_funcs,
            [
                "run_shadow_category_priority_suggestion",
                "run_background_department_routing",
                "run_background_complaint_screening",
            ],
        )

        # In shadow mode, dept routing proceeds even if screening gate check would error
        with patch.object(settings, "SCREENING_MODE", "shadow"), \
             patch.object(settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "active"), \
             patch.object(scr_svc, "fetch_active_screening_gate_for_routing", AsyncMock(side_effect=RuntimeError("boom"))), \
             patch.object(dept_svc, "_evaluate_department_routing_rpc", AsyncMock(return_value={"applied": True, "mode": "active"})) as mock_dept, \
             patch.object(off_svc, "get_officer_routing_mode", return_value="off"):
            dept_res = asyncio.run(dept_svc.run_background_department_routing(COMPLAINT_ID))
        self.assertTrue(dept_res["applied"])
        mock_dept.assert_awaited_once()

    def test_active_mode_orders_95_before_92_93_and_blocks_flagged_or_unavailable(self):
        # Amendment B: Active mode schedules 9.5 BEFORE 9.2
        bg = BackgroundTasks()
        actor = AuthenticatedActor(user_id=CITIZEN_ID, role="citizen", token="jwt")

        with patch.object(settings, "AI_INTELLIGENCE_ENABLED", True), \
             patch.object(settings, "SCREENING_MODE", "active"), \
             patch.object(settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "active"), \
             patch.object(ai_svc, "verify_citizen_complaint_ownership", AsyncMock()), \
             patch.object(ai_svc.ai_intelligence_user_limiter, "check_and_record", AsyncMock()), \
             patch.object(ai_svc.ai_intelligence_global_limiter, "check_and_record", AsyncMock()):
            asyncio.run(ai_svc.schedule_shadow_category_priority_suggestion(bg, actor, COMPLAINT_ID))

        task_funcs = [t.func.__name__ for t in bg.tasks]
        self.assertEqual(
            task_funcs,
            [
                "run_shadow_category_priority_suggestion",
                "run_background_complaint_screening",
                "run_background_department_routing",
            ],
        )

        # Amendment A: In active mode, flagged or unavailable screening blocks 9.2 and 9.3 cleanly
        with patch.object(settings, "SCREENING_MODE", "active"), \
             patch.object(settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "active"), \
             patch.object(settings, "OFFICER_AUTO_ASSIGN_MODE", "active"), \
             patch.object(scr_svc, "_call_rpc", AsyncMock(return_value=_json_response(200, {"found": True, "completed": True, "flagged": True}))), \
             patch.object(dept_svc, "_evaluate_department_routing_rpc", AsyncMock()) as mock_dept, \
             patch.object(off_svc, "_evaluate_officer_routing_rpc", AsyncMock()) as mock_off:
            d_res = asyncio.run(dept_svc.run_background_department_routing(COMPLAINT_ID))
            o_res = asyncio.run(off_svc.run_background_officer_routing(COMPLAINT_ID))

        self.assertFalse(d_res["applied"])
        self.assertEqual(d_res["reason_code"], "screening_flagged")
        self.assertFalse(o_res["applied"])
        self.assertEqual(o_res["reason_code"], "screening_flagged")
        mock_dept.assert_not_awaited()
        mock_off.assert_not_awaited()

        # Unavailable helper -> fail closed without crash
        with patch.object(settings, "SCREENING_MODE", "active"), \
             patch.object(settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "active"), \
             patch.object(scr_svc, "_call_rpc", AsyncMock(side_effect=RuntimeError("db_down"))):
            d_unavail = asyncio.run(dept_svc.run_background_department_routing(COMPLAINT_ID))
        self.assertFalse(d_unavail["applied"])
        self.assertEqual(d_unavail["reason_code"], "screening_unavailable")

    def test_citizen_secrecy_ownership_and_admin_endpoints_role_checks(self):
        client = TestClient(app)

        # Unauthenticated
        self.assertEqual(client.get("/api/admin/screening").status_code, 401)
        self.assertEqual(client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/screening-check").status_code, 401)

        # Citizen triggers own screening-check -> receives strictly {accepted: True}
        app.dependency_overrides[require_citizen] = lambda: AuthenticatedActor(
            user_id=CITIZEN_ID, role="citizen", token="cit-jwt"
        )
        with patch.object(settings, "SCREENING_MODE", "shadow"), \
             patch.object(scr_svc, "verify_citizen_complaint_ownership", AsyncMock()), \
             patch("app.services.screening_service.run_background_complaint_screening", AsyncMock()):
            cit_res = client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/screening-check")
        self.assertEqual(cit_res.status_code, 202)
        self.assertEqual(cit_res.json(), {"accepted": True})

        # Non-admin authenticated actor calling admin endpoint gets 403
        app.dependency_overrides[require_admin] = lambda: (_ for _ in ()).throw(
            __import__("fastapi").HTTPException(status_code=403, detail="Admin required")
        )
        self.assertEqual(client.get("/api/admin/screening").status_code, 403)

        # Admin queue, details, and revert validation
        app.dependency_overrides[require_admin] = lambda: AuthenticatedActor(
            user_id=ADMIN_ID, role="admin", token="adm-jwt"
        )
        with patch.object(scr_svc, "_call_rpc", AsyncMock(return_value=_json_response(200, {"items": [], "total": 0, "page": 1, "page_size": 20, "total_pages": 1}))):
            q_res = client.get("/api/admin/screening?status=needs_review")
        self.assertEqual(q_res.status_code, 200)
        self.assertEqual(q_res.json()["items"], [])

        with patch.object(scr_svc, "_call_rpc", AsyncMock(return_value=_json_response(400, {"code": "22023", "message": "Invalid Parameter: reason min 5 chars"}))):
            rev_res = client.post(
                f"/api/admin/complaints/{COMPLAINT_ID}/screening/revert-advancement",
                json={"reason": "bad"},
            )
        self.assertEqual(rev_res.status_code, 422)

    def test_dismissed_flag_is_idempotent_and_never_calls_gemini_again(self):
        with patch.object(settings, "SCREENING_MODE", "active"), \
             patch.object(settings, "AI_INTELLIGENCE_ENABLED", True), \
             patch.object(scr_svc, "_fetch_deterministic_signals_service", AsyncMock(return_value=_sample_signals(existing_admin_decision="false_alarm"))), \
             patch.object(scr_svc, "_invoke_gemini_screening_with_retry", AsyncMock()) as mock_gem, \
             patch.object(scr_svc, "_record_screening_rpc", AsyncMock()) as mock_rec:
            res = asyncio.run(scr_svc.run_background_complaint_screening(COMPLAINT_ID))

        self.assertTrue(res["idempotent_hit"])
        self.assertFalse(res["applied_advance"])
        mock_gem.assert_not_awaited()
        mock_rec.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
