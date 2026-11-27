from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.config import parse_fail_closed_bool, settings
from app.main import app
from app.services import accuracy_appeals_service as aa_svc
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = REPO_ROOT / "supabase" / "migrations" / "20261211_phase9_6_accuracy_dashboard_and_appeals.sql"
ROLLBACK_PATH = REPO_ROOT / "supabase" / "rollbacks" / "20261211_phase9_6_accuracy_dashboard_and_appeals_UNDO.sql"

COMPLAINT_ID = "11111111-1111-4111-8111-111111111111"
APPEAL_ID = "55555555-5555-4555-8555-555555555555"
CITIZEN_ID = "22222222-2222-4222-8222-222222222222"
ADMIN_ID = "33333333-3333-4333-8333-333333333333"


def _json_response(status_code: int, body):
    return SimpleNamespace(
        status_code=status_code,
        json=lambda: body,
        text=json.dumps(body) if not isinstance(body, str) else body,
    )


class Phase96MigrationAndIsolationStaticTests(unittest.TestCase):
    def test_migration_and_rollback_safety_undo_immutability_and_ward_isolation(self):
        self.assertTrue(MIGRATION_PATH.exists(), "Phase 9.6 migration missing")
        self.assertTrue(ROLLBACK_PATH.exists(), "Phase 9.6 UNDO missing")

        sql = MIGRATION_PATH.read_text(encoding="utf-8")
        undo_sql = ROLLBACK_PATH.read_text(encoding="utf-8")

        # Required tables + FORCE RLS
        for tbl in (
            "phase9_feature_settings",
            "complaint_review_appeals",
            "complaint_review_appeal_decisions",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS public.{tbl}", sql)
            self.assertIn(f"ALTER TABLE public.{tbl} FORCE ROW LEVEL SECURITY", sql)
            # Safety Correction 10: UNDO must NOT drop historical appeal/decision/settings tables
            non_comment_undo = re.sub(r"--.*", "", undo_sql)
            self.assertNotIn(f"DROP TABLE IF EXISTS public.{tbl}", non_comment_undo)

        # DB default OFF for screening_appeal
        self.assertIn("('screening_appeal', FALSE)", sql)
        self.assertIn("is_enabled", sql)

        # Immutable decisions trigger + delete guard
        self.assertIn("trg_guard_immutable_appeal_decisions", sql)
        self.assertIn("BEFORE UPDATE OR DELETE ON public.complaint_review_appeal_decisions", sql)

        # Hard floor 5 & SQL-enforced lifetime cap 3 & 1 open unique index
        self.assertIn("GREATEST(5, COALESCE(p_min_samples, 20))", sql)
        self.assertIn("GREATEST(5, COALESCE(p_ward_min_samples, 20))", sql)
        self.assertIn("uidx_open_appeal_per_complaint", sql)
        self.assertIn("p_lifetime_cap INT DEFAULT 3", sql)

        # Clarification 5 / Amendment F: 9.3 uses in_progress/resolved without aged-7d fallback
        self.assertIn("IN ('in_progress'::public.complaint_status, 'resolved'::public.complaint_status)", sql)

        # Clarification 1 & 4: 9.5B latest decided_at DESC, id DESC + corrected_decisions_count
        self.assertIn("ORDER BY cand.decided_at DESC, cand.row_id DESC", sql)
        self.assertIn("corrected_decisions_count", sql)

        # Zero RECORD variable declarations across SQL
        sql_no_comments = re.sub(r"--.*", "", sql)
        self.assertIsNone(re.search(r"^\s*[a-z0-9_]+\s+RECORD\b", sql_no_comments, re.IGNORECASE | re.MULTILINE))
        self.assertIsNone(re.search(r"pg_catalog\.(least|greatest|coalesce)\s*\(", sql, re.IGNORECASE))
        self.assertIn("SET search_path = ''", sql)

        # Decision functions from 9.1 - 9.5 NEVER read Phase 9.6 ward stats
        for p_file in (
            "supabase/migrations/20261203_phase9_1_ai_decisions_shadow_mode.sql",
            "supabase/migrations/20261204_phase9_4_duplicate_detection.sql",
            "supabase/migrations/20261209_phase9_3_officer_auto_assignment.sql",
            "supabase/migrations/20261210_phase9_5_suspicious_claim_screening.sql",
        ):
            content = (REPO_ROOT / p_file).read_text(encoding="utf-8")
            self.assertNotIn("get_admin_ward_accuracy_fairness", content)


class _InMemoryAppealLifecycleDb:
    """Models Clarification 2 & Amendment A/D/H DB invariants accurately for tests."""

    def __init__(self, *, feature_on: bool = True, age_days: int = 5, status: str = "submitted"):
        self.feature_on = feature_on
        self.complaint_status = status
        self.created_at = datetime.now(timezone.utc) - timedelta(days=age_days)
        self.appeals = []
        self.decisions = []

    def submit(self, citizen_id: str, text: str):
        if not self.feature_on:
            return 400, {"code": "P0001", "message": "Feature Disabled: Review appeal requests are currently disabled."}
        if self.complaint_status != "submitted":
            return 400, {"code": "P0001", "message": "Ineligible: status is not submitted"}
        if (datetime.now(timezone.utc) - self.created_at) < timedelta(days=3):
            return 400, {"code": "P0001", "message": "Ineligible: minimum age 3 days"}
        # Idempotent retry while open (Clarification 2: MUST NOT consume daily/lifetime/cooldown!)
        if any(a["status"] == "open" for a in self.appeals):
            return 200, {"submitted": True, "status": "open"}
        # Lifetime cap = 3
        if len(self.appeals) >= 3:
            return 400, {"code": "P0001", "message": "Limit Exceeded: Maximum lifetime review requests (3) reached."}
        # Cooldown 72h
        if self.decisions:
            latest_dec = max(d["decided_at"] for d in self.decisions)
            if (datetime.now(timezone.utc) - latest_dec) < timedelta(hours=72):
                return 400, {"code": "P0001", "message": "Cooldown Active"}
        # Rolling 24h cap = 3
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        daily = [a for a in self.appeals if a["citizen_id"] == citizen_id and a["created_at"] >= since]
        if len(daily) >= 3:
            return 400, {"code": "P0001", "message": "Daily Limit Exceeded"}
        self.appeals.append({"id": f"app-{len(self.appeals) + 1}", "citizen_id": citizen_id, "text": text, "status": "open", "created_at": datetime.now(timezone.utc)})
        return 200, {"submitted": True, "status": "open"}

    def close_latest_appeal(self, outcome: str, hours_ago: int = 80):
        for a in reversed(self.appeals):
            if a["status"] == "open":
                a["status"] = outcome
                self.decisions.append({"appeal_id": a["id"], "outcome": outcome, "decided_at": datetime.now(timezone.utc) - timedelta(hours=hours_ago)})
                return


class Phase96EndpointsAndInvariantsTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides.clear()
        aa_svc.citizen_appeal_limiter._hits.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_appeal_feature_defaults_off_and_neutral_when_disabled(self):
        self.assertFalse(parse_fail_closed_bool(None))
        self.assertFalse(parse_fail_closed_bool("false"))

        client = TestClient(app)
        app.dependency_overrides[require_citizen] = lambda: AuthenticatedActor(
            user_id=CITIZEN_ID, role="citizen", token="cit-jwt"
        )
        with patch.object(settings, "APPEAL_FEATURE_ENABLED", False):
            st_res = client.get(f"/api/citizen/complaints/{COMPLAINT_ID}/review-appeal/status")
            sub_res = client.post(
                f"/api/citizen/complaints/{COMPLAINT_ID}/review-appeal",
                json={"appeal_text": "Please review my complaint submitted last week."},
            )
        self.assertEqual(st_res.status_code, 200)
        self.assertEqual(st_res.json(), {"eligible": False, "has_open_appeal": False, "appeal_status": "none"})
        self.assertEqual(sub_res.status_code, 403)

    def test_citizen_response_strictly_neutral_and_non_owner_returns_404(self):
        client = TestClient(app)
        app.dependency_overrides[require_citizen] = lambda: AuthenticatedActor(
            user_id=CITIZEN_ID, role="citizen", token="cit-jwt"
        )

        # Exact allowed keys only (Amendment G)
        with patch.object(settings, "APPEAL_FEATURE_ENABLED", True), \
             patch.object(aa_svc, "_call_user_rpc", AsyncMock(return_value=_json_response(200, {"eligible": True, "has_open_appeal": False, "appeal_status": "none"}))):
            ok_st = client.get(f"/api/citizen/complaints/{COMPLAINT_ID}/review-appeal/status")
        self.assertEqual(ok_st.status_code, 200)
        self.assertEqual(set(ok_st.json().keys()), {"eligible", "has_open_appeal", "appeal_status"})

        # Non-owner -> 42501 mapped to 404 (Decision 4)
        with patch.object(settings, "APPEAL_FEATURE_ENABLED", True), \
             patch.object(aa_svc, "_call_user_rpc", AsyncMock(return_value=_json_response(403, {"code": "42501", "message": "denied"}))):
            non_owner = client.get(f"/api/citizen/complaints/{COMPLAINT_ID}/review-appeal/status")
        self.assertEqual(non_owner.status_code, 404)

    def test_idempotent_retry_does_not_consume_caps_and_lifetime_cap_enforced(self):
        db = _InMemoryAppealLifecycleDb(feature_on=True, age_days=5)

        client = TestClient(app)
        app.dependency_overrides[require_citizen] = lambda: AuthenticatedActor(
            user_id=CITIZEN_ID, role="citizen", token="cit-jwt"
        )

        async def rpc_dispatch(_rpc_name, payload, **_kwargs):
            code, body = db.submit(CITIZEN_ID, payload["p_appeal_text"])
            return _json_response(code, body)

        with patch.object(settings, "APPEAL_FEATURE_ENABLED", True), \
             patch.object(aa_svc, "_call_user_rpc", side_effect=rpc_dispatch):
            # 1st submit creates row #1
            r1 = client.post(
                f"/api/citizen/complaints/{COMPLAINT_ID}/review-appeal",
                json={"appeal_text": "Waiting for municipal department update."},
            )
            # Duplicate retry while open -> returns neutral ack WITHOUT adding row #2 (Clarification 2)
            r1_retry = client.post(
                f"/api/citizen/complaints/{COMPLAINT_ID}/review-appeal",
                json={"appeal_text": "Waiting for municipal department update."},
            )
        self.assertEqual(r1.status_code, 201)
        self.assertEqual(r1.json(), {"submitted": True, "status": "open"})
        self.assertEqual(r1_retry.status_code, 201)
        self.assertEqual(r1_retry.json(), {"submitted": True, "status": "open"})
        self.assertEqual(len(db.appeals), 1)

        # Advance 2nd & 3rd historical appeals past 72h cooldown -> reach lifetime cap 3
        db.close_latest_appeal("reviewed", hours_ago=80)
        db.appeals[0]["created_at"] = datetime.now(timezone.utc) - timedelta(days=5)
        self.assertEqual(db.submit(CITIZEN_ID, "Follow up second request cleanly.")[0], 200)
        db.close_latest_appeal("reviewed", hours_ago=80)
        db.appeals[1]["created_at"] = datetime.now(timezone.utc) - timedelta(days=3)
        self.assertEqual(db.submit(CITIZEN_ID, "Follow up third request cleanly.")[0], 200)
        db.close_latest_appeal("reviewed", hours_ago=80)

        # 4th appeal fails lifetime cap (Amendment A)
        with patch.object(settings, "APPEAL_FEATURE_ENABLED", True), \
             patch.object(aa_svc, "_call_user_rpc", side_effect=rpc_dispatch):
            r4 = client.post(
                f"/api/citizen/complaints/{COMPLAINT_ID}/review-appeal",
                json={"appeal_text": "Fourth attempt should fail lifetime cap."},
            )
        self.assertEqual(r4.status_code, 409)
        self.assertEqual(len(db.appeals), 3)

    def test_write_rpc_failures_fail_loudly_never_fake_success(self):
        # Amendment H: never swallow errors into fake {submitted: true} or {success: true}
        client = TestClient(app)
        app.dependency_overrides[require_citizen] = lambda: AuthenticatedActor(
            user_id=CITIZEN_ID, role="citizen", token="cit-jwt"
        )
        with patch.object(settings, "APPEAL_FEATURE_ENABLED", True), \
             patch.object(aa_svc, "_call_user_rpc", AsyncMock(return_value=_json_response(500, {"code": "XX000", "message": "db crash"}))):
            res = client.post(
                f"/api/citizen/complaints/{COMPLAINT_ID}/review-appeal",
                json={"appeal_text": "Valid length appeal message submitted."},
            )
        self.assertEqual(res.status_code, 503)

        app.dependency_overrides[require_admin] = lambda: AuthenticatedActor(
            user_id=ADMIN_ID, role="admin", token="adm-jwt"
        )
        with patch.object(aa_svc, "_call_user_rpc", AsyncMock(return_value=_json_response(400, {"code": "P0001", "message": "Conflict: This review appeal has already been decided."}))):
            adm_conflict = client.post(
                f"/api/admin/appeals/{APPEAL_ID}/decide",
                json={"outcome": "released"},
            )
        self.assertEqual(adm_conflict.status_code, 409)

    def test_admin_dashboard_ward_fixed_window_and_role_enforcement(self):
        client = TestClient(app)
        self.assertEqual(client.get("/api/admin/ai-accuracy").status_code, 401)
        self.assertEqual(client.get("/api/admin/ai-accuracy/wards").status_code, 401)

        app.dependency_overrides[require_admin] = lambda: (_ for _ in ()).throw(
            __import__("fastapi").HTTPException(status_code=403, detail="Admin required")
        )
        self.assertEqual(client.get("/api/admin/ai-accuracy").status_code, 403)
        self.assertEqual(client.get("/api/admin/appeals").status_code, 403)

        app.dependency_overrides[require_admin] = lambda: AuthenticatedActor(
            user_id=ADMIN_ID, role="admin", token="adm-jwt"
        )
        # Amendment C: ward endpoint accepts NO window query param (400 if attempted)
        self.assertEqual(client.get("/api/admin/ai-accuracy/wards?window=7d").status_code, 400)

        sample_dash = {
            "window": "30d",
            "date_from": "2026-10-28T00:00:00Z",
            "date_to": "2026-11-27T00:00:00Z",
            "min_samples": 20,
            "plain_review_appeals_count": 2,
            "cards": [
                {
                    "feature": "category_priority",
                    "label": "9.1 Category & Priority",
                    "sample_size": 5,
                    "agreed_count": 4,
                    "disagreed_count": 1,
                    "excluded_count": 3,
                    "enough_data": False,
                    "agreement_rate": None,
                    "override_rate": None,
                }
            ],
        }
        with patch.object(aa_svc, "_call_user_rpc", AsyncMock(return_value=_json_response(200, sample_dash))):
            d_res = client.get("/api/admin/ai-accuracy?window=30d")
        self.assertEqual(d_res.status_code, 200)
        self.assertFalse(d_res.json()["cards"][0]["enough_data"])
        self.assertIsNone(d_res.json()["cards"][0]["agreement_rate"])


if __name__ == "__main__":
    unittest.main()
