import json
from pathlib import Path
import re
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.config import parse_fail_closed_bool, settings
from app.main import app
from app.services import rewards_service as rew_svc
from app.services.auth_service import AuthenticatedActor, require_admin, require_citizen

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    REPO_ROOT / "supabase" / "migrations" / "20261212_phase10_citizen_rewards.sql"
)
ROLLBACK_PATH = (
    REPO_ROOT / "supabase" / "rollbacks" / "20261212_phase10_citizen_rewards_UNDO.sql"
)

CITIZEN_ID = "22222222-2222-4222-8222-222222222222"
ADMIN_ID = "33333333-3333-4333-8333-333333333333"
COMPLAINT_ID = "11111111-1111-4111-8111-111111111111"


def _json_response(status_code: int, body):
    return SimpleNamespace(
        status_code=status_code,
        json=lambda: body,
        text=json.dumps(body) if not isinstance(body, str) else body,
    )


class Phase10MigrationSafetyTests(unittest.TestCase):
    def test_migration_and_rollback_safety_and_amendments(self):
        self.assertTrue(MIGRATION_PATH.exists(), "Phase 10 migration missing")
        self.assertTrue(ROLLBACK_PATH.exists(), "Phase 10 UNDO missing")

        sql = MIGRATION_PATH.read_text(encoding="utf-8")
        undo_sql = ROLLBACK_PATH.read_text(encoding="utf-8")
        sql_no_comments = re.sub(r"--.*", "", sql)
        undo_no_comments = re.sub(r"--.*", "", undo_sql)

        # Required tables, FORCE RLS, and UNDO preserves historical tables
        for tbl in (
            "phase10_rewards_settings",
            "citizen_reward_accounts",
            "reward_badge_definitions",
            "community_challenges",
            "citizen_reward_ledger",
            "citizen_badge_events",
            "citizen_reward_evaluations",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS public.{tbl}", sql)
            self.assertIn(f"ALTER TABLE public.{tbl} FORCE ROW LEVEL SECURITY", sql)
            self.assertNotIn(f"DROP TABLE IF EXISTS public.{tbl}", undo_no_comments)

        # Zero seeded challenge badges (Amendment D)
        seed_block = re.search(
            r"INSERT INTO public\.reward_badge_definitions.*?ON CONFLICT \(badge_code\) DO NOTHING;",
            sql,
            re.DOTALL,
        )
        self.assertIsNotNone(seed_block)
        self.assertNotIn("'challenge'", seed_block.group(0))

        # Default OFF + first_enabled_at set once + compared against verification created_at (Amendments E, K)
        self.assertIn("('citizen_rewards', FALSE, NULL)", sql)
        self.assertIn("v_verif_created_at < v_first_enabled_at", sql)

        # Owner + not disputed check (Amendment C)
        self.assertIn("v_verif_citizen_id IS DISTINCT FROM v_citizen_id", sql)
        self.assertIn("v_is_disputed", sql)

        # Daily/weekly caps in both points & count, counting verified_award > 0 only (Amendments F, L)
        for cap_code in (
            "skipped_daily_count_cap",
            "skipped_daily_points_cap",
            "skipped_weekly_count_cap",
            "skipped_weekly_points_cap",
            "reversal_noop",
            "pending_flag_hold",
            "award_failed",
        ):
            self.assertIn(f"'{cap_code}'", sql)

        # Nested inner exception safety in trigger helper & NO artificial test backdoor (Amendments A, I, J)
        self.assertIn("EXCEPTION\n    WHEN OTHERS THEN", sql)
        self.assertNotIn("p_force_fail", sql)
        self.assertNotIn("TEST_FORCE_FAIL", sql)

        # Leaderboard floor 5 and one fixed window all_time (Amendment N, Decision 3)
        self.assertIn("GREATEST(5, COALESCE(p_min_group_size, 20))", sql)
        self.assertIn("'window', 'all_time'", sql)

        # Correct Phase 9.4 duplicate column names
        self.assertIn("dl.complaint_id = p_complaint_id OR dl.candidate_complaint_id = p_complaint_id", sql)

        # Trigger definitions & exact UPDATE column lists (Amendment B)
        self.assertIn("AFTER INSERT ON public.complaint_resolution_verifications", sql)
        self.assertIn("AFTER INSERT OR UPDATE OF status ON public.complaint_duplicate_links", sql)
        self.assertIn(
            "AFTER INSERT OR UPDATE OF review_status, admin_decision ON public.complaint_screening_reviews",
            sql,
        )
        self.assertIn("AFTER INSERT ON public.complaint_review_appeal_decisions", sql)

        # Real DB type & enum parity checks (never reference non-existent enums/labels)
        self.assertNotIn("complaint_category", sql)
        self.assertNotIn("'disputed'::public.complaint_status", sql)
        self.assertNotIn("'reopened'::public.complaint_status", sql)
        self.assertIn(
            "( 'potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure' )",
            re.sub(r"\s+", " ", sql),
        )

        # Immutable triggers on ledger & badge events
        self.assertIn("trg_guard_immutable_reward_ledger", sql)
        self.assertIn("trg_guard_immutable_badge_events", sql)

        # Standard SQL safety rules: search_path = '', zero RECORD vars, no pg_catalog.coalesce/least/greatest
        self.assertIn("SET search_path = ''", sql)
        self.assertIsNone(
            re.search(
                r"^\s*[a-z0-9_]+\s+RECORD\b",
                sql_no_comments,
                re.IGNORECASE | re.MULTILINE,
            )
        )
        self.assertIsNone(
            re.search(
                r"pg_catalog\.(least|greatest|coalesce)\s*\(",
                sql,
                re.IGNORECASE,
            )
        )


class Phase10BackendServiceAndEndpointsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        app.dependency_overrides.clear()
        rew_svc.citizen_rewards_limiter._hits.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_defaults_off_and_safe_config(self):
        self.assertFalse(parse_fail_closed_bool(None))
        self.assertFalse(parse_fail_closed_bool("false"))
        self.assertFalse(settings.REWARDS_FEATURE_ENABLED)
        self.assertGreaterEqual(settings.REWARDS_LEADERBOARD_MIN_GROUP_SIZE, 5)
        self.assertEqual(settings.REWARDS_DAILY_MAX_POINTS, 150)
        self.assertEqual(settings.REWARDS_DAILY_MAX_AWARDS, 3)
        self.assertEqual(settings.REWARDS_WEEKLY_MAX_POINTS, 500)
        self.assertEqual(settings.REWARDS_WEEKLY_MAX_AWARDS, 10)
        self.assertEqual(settings.REWARDS_TIMEZONE, "Asia/Kolkata")

    def test_citizen_endpoints_return_disabled_without_rpc_when_flag_off(self):
        citizen = AuthenticatedActor(user_id=CITIZEN_ID, role="citizen", token="cit-tok")
        app.dependency_overrides[require_citizen] = lambda: citizen

        with patch.object(settings, "REWARDS_FEATURE_ENABLED", False), patch.object(
            rew_svc, "_call_user_rpc", new=AsyncMock()
        ) as rpc_mock:
            res_sum = self.client.get("/api/citizen/rewards/summary")
            res_board = self.client.get("/api/citizen/rewards/leaderboard")

        self.assertEqual(res_sum.status_code, 200)
        self.assertFalse(res_sum.json()["feature_enabled"])
        self.assertIsNone(res_sum.json()["anonymous_handle"])
        self.assertEqual(res_board.status_code, 200)
        self.assertFalse(res_board.json()["feature_enabled"])
        self.assertFalse(res_board.json()["enough_data"])
        self.assertEqual(res_board.json()["entries"], [])
        rpc_mock.assert_not_awaited()

    def test_citizen_summary_and_leaderboard_hide_internal_flags_and_suppressed_totals(self):
        citizen = AuthenticatedActor(user_id=CITIZEN_ID, role="citizen", token="cit-tok")
        app.dependency_overrides[require_citizen] = lambda: citizen

        summary_payload = {
            "feature_enabled": True,
            "anonymous_handle": "Civic-Member-A1B2C3",
            "total_points": 50,
            "verified_reports_count": 1,
            "daily_points_used": 50,
            "daily_points_limit": 150,
            "daily_awards_used": 1,
            "daily_awards_limit": 3,
            "weekly_points_used": 50,
            "weekly_points_limit": 500,
            "weekly_awards_used": 1,
            "weekly_awards_limit": 10,
            "badges": [
                {
                    "badge_code": "first_verified_report",
                    "title": "First Verified Report",
                    "description": "Earned after your first resolution verification.",
                    "badge_kind": "milestone",
                    "earned_at": "2026-11-27T08:00:00Z",
                }
            ],
            "recent_ledger": [
                {
                    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "complaint_number": "URB-1001",
                    "points_delta": -50,
                    "summary_label": "Eligibility adjustment",
                    "created_at": "2026-11-27T08:05:00Z",
                }
            ],
            "active_challenges": [],
        }

        leaderboard_payload = {
            "feature_enabled": True,
            "window": "all_time",
            "scope": "ward",
            "ward": "Ward 12",
            "min_group_size": 20,
            "enough_data": False,
            "entries": [],
            "available_wards": [],
        }

        with patch.object(settings, "REWARDS_FEATURE_ENABLED", True), patch.object(
            rew_svc,
            "_call_user_rpc",
            new=AsyncMock(
                side_effect=[
                    _json_response(200, summary_payload),
                    _json_response(200, leaderboard_payload),
                ]
            ),
        ):
            r_sum = self.client.get("/api/citizen/rewards/summary")
            r_board = self.client.get("/api/citizen/rewards/leaderboard?ward=Ward%2012")

        self.assertEqual(r_sum.status_code, 200)
        sum_body = r_sum.json()
        self.assertEqual(sum_body["anonymous_handle"], "Civic-Member-A1B2C3")
        # Amendment P: strictly neutral ledger and zero internal flag/evaluation metadata
        serialized = json.dumps(sum_body).lower()
        for forbidden in ("suspicious", "pending_flag_hold", "duplicate_reversal", "evaluation", "blocked_screening"):
            self.assertNotIn(forbidden, serialized)

        self.assertEqual(r_board.status_code, 200)
        board_body = r_board.json()
        self.assertEqual(board_body["window"], "all_time")
        self.assertFalse(board_body["enough_data"])
        self.assertEqual(board_body["entries"], [])
        # Amendment N / Decision 3: zero total/residual/other fields
        for forbidden_key in ("total", "residual", "hidden_count", "other"):
            self.assertNotIn(forbidden_key, board_body)

    def test_role_enforcement_and_admin_writes_fail_loudly(self):
        # Citizen blocked from admin endpoints
        citizen = AuthenticatedActor(user_id=CITIZEN_ID, role="citizen", token="cit-tok")
        app.dependency_overrides[require_citizen] = lambda: citizen
        res_forbidden = self.client.get("/api/admin/rewards/audit")
        self.assertIn(res_forbidden.status_code, (401, 403))

        # Admin write errors propagate cleanly (Amendment A)
        admin = AuthenticatedActor(user_id=ADMIN_ID, role="admin", token="adm-tok")
        app.dependency_overrides[require_admin] = lambda: admin

        with patch.object(
            rew_svc,
            "_call_user_rpc",
            new=AsyncMock(
                return_value=_json_response(
                    500, {"code": "XX000", "message": "Database transaction aborted"}
                )
            ),
        ):
            r_toggle = self.client.put("/api/admin/rewards/settings", json={"is_enabled": True})
            r_chal = self.client.post(
                "/api/admin/rewards/challenges",
                json={
                    "title": "Clean Monsoon Drive",
                    "description": "Verify three drainage fixes this month.",
                    "badge_code": "monsoon_2026",
                    "badge_title": "Monsoon Watcher",
                    "badge_description": "Verified drainage fixes during drive.",
                    "required_verified_reports": 3,
                    "bonus_points": 50,
                    "starts_at": "2026-11-01T00:00:00Z",
                    "ends_at": "2026-11-30T23:59:59Z",
                },
            )
            r_adj = self.client.post(
                "/api/admin/rewards/adjust",
                json={
                    "citizen_id": CITIZEN_ID,
                    "points_delta": 25,
                    "reason": "Manual verification bonus",
                    "complaint_id": COMPLAINT_ID,
                },
            )

        self.assertEqual(r_toggle.status_code, 503)
        self.assertEqual(r_chal.status_code, 503)
        self.assertEqual(r_adj.status_code, 503)
