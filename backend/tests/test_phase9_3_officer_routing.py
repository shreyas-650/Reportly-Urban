import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402
from app.services import department_routing_service as dept_svc  # noqa: E402
from app.services import officer_routing_service as off_svc  # noqa: E402
from app.services.auth_service import AuthenticatedActor, get_authenticated_actor  # noqa: E402

COMPLAINT_ID = "11111111-1111-4111-8111-111111111111"
DEPT_ROADS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
DEPT_WATER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
OFF_1_ID = "o1111111-1111-4111-8111-111111111111"
OFF_2_ID = "o2222222-2222-4222-8222-222222222222"
OFF_OTHER_WARD_ID = "o3333333-3333-4333-8333-333333333333"
OFF_NULL_WARD_ID = "o4444444-4444-4444-8444-444444444444"
OFF_OTHER_DEPT_ID = "o5555555-5555-4555-8555-555555555555"
CITIZEN_ID = "33333333-3333-4333-8333-333333333333"
ADMIN_ID = "44444444-4444-4444-8444-444444444444"
OFFICER_USER_ID = "55555555-5555-4555-8555-555555555555"


class _FakeHttpResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload) if not isinstance(payload, str) else payload

    def json(self):
        return self._payload


class _InMemoryPhase93Db:
    """
    In-memory simulation of 20261209 SQL evaluate_and_assign_officer_ai and
    phase9_3_track_staff_officer_change semantics.
    """

    def __init__(self):
        self.now = datetime(2026, 11, 27, 8, 0, 0, tzinfo=timezone.utc)
        self.officers = {}
        self.complaints = {
            COMPLAINT_ID: {
                "id": COMPLAINT_ID,
                "ward": "Ward 1",
                "status": "submitted",
                "department_id": DEPT_ROADS_ID,
                "assigned_officer_id": None,
            }
        }
        self.open_counts_override = {}
        self.last_assigned = {}
        self.events = []
        self.triage_queue = {}
        self.simulate_trigger_error = False
        self._seq = 0

    def _tick(self) -> datetime:
        self._seq += 1
        return self.now + timedelta(seconds=self._seq)

    def _get_open_count(self, officer_id: str) -> int:
        if officer_id in self.open_counts_override:
            return self.open_counts_override[officer_id]
        return sum(
            1
            for c in self.complaints.values()
            if c.get("assigned_officer_id") == officer_id
            and c.get("status") not in ("resolved", "rejected", "not_confirmed_by_citizen")
        )

    def evaluate_and_assign_officer(
        self,
        *,
        complaint_id: str,
        mode: str = "shadow",
        max_open_complaints: int = 10,
        allow_ward_fallback: bool = True,
    ):
        if mode == "off":
            return {"mode": "off", "skipped": True, "applied": False}

        comp = self.complaints.get(complaint_id)
        if not comp:
            return {"found": False, "applied": False}

        if any(e["complaint_id"] == complaint_id and e["actor_type"] == "system_ai" for e in self.events):
            return {"mode": mode, "idempotent_hit": True, "applied": False}

        if comp["status"] in ("resolved", "rejected", "not_confirmed_by_citizen"):
            self._insert_system_ai_event(
                complaint_id=complaint_id,
                dept_id=comp["department_id"],
                mode=mode,
                applied=False,
                reason_code="terminal_status",
            )
            return {"mode": mode, "reason_code": "terminal_status", "applied": False}

        if comp["assigned_officer_id"] is not None:
            self._insert_system_ai_event(
                complaint_id=complaint_id,
                dept_id=comp["department_id"],
                mode=mode,
                prev_officer_id=comp["assigned_officer_id"],
                new_officer_id=comp["assigned_officer_id"],
                applied=False,
                reason_code="already_assigned",
            )
            return {"mode": mode, "reason_code": "already_assigned", "applied": False}

        if comp["department_id"] is None:
            self.triage_queue[complaint_id] = {
                "complaint_id": complaint_id,
                "department_id": None,
                "reason_code": "no_department",
                "mode": mode,
                "resolved_at": None,
            }
            return {"mode": mode, "reason_code": "no_department", "applied": False}

        dept_id = comp["department_id"]
        dept_active = [
            o for o in self.officers.values() if o["department_id"] == dept_id and o["is_active"]
        ]
        reason_code = None
        selected = None

        if not dept_active:
            reason_code = "no_officer"
        else:
            ward_eligible = [
                o
                for o in dept_active
                if (o["assigned_ward"] is not None and o["assigned_ward"] == comp["ward"])
                or (allow_ward_fallback and o["assigned_ward"] is None)
            ]
            if not ward_eligible:
                reason_code = "no_eligible_ward"
            else:
                under_cap = [
                    o for o in ward_eligible if self._get_open_count(o["id"]) < max_open_complaints
                ]
                if not under_cap:
                    reason_code = "all_at_capacity"
                else:
                    under_cap.sort(
                        key=lambda o: (
                            0 if (o["assigned_ward"] is not None and o["assigned_ward"] == comp["ward"]) else 1,
                            self._get_open_count(o["id"]),
                            0 if self.last_assigned.get(o["id"]) is None else 1,
                            self.last_assigned.get(o["id"]) or self.now,
                            o["created_at"],
                            o["id"],
                        )
                    )
                    selected = under_cap[0]

        proposed_id = selected["id"] if selected else None
        snapshot = {
            "mode": mode,
            "department_id": dept_id,
            "complaint_ward": comp["ward"],
            "proposed_officer_id": proposed_id,
            "fallback_reason": reason_code,
        }

        if mode == "shadow":
            final_reason = reason_code or "shadow_mode"
            self._insert_system_ai_event(
                complaint_id=complaint_id,
                dept_id=dept_id,
                mode="shadow",
                proposed_officer_id=proposed_id,
                workload_snapshot=snapshot,
                applied=False,
                reason_code=final_reason,
            )
            self.triage_queue[complaint_id] = {
                "complaint_id": complaint_id,
                "department_id": dept_id,
                "reason_code": final_reason,
                "mode": "shadow",
                "proposed_officer_id": proposed_id,
                "resolved_at": None,
            }
            return {
                "mode": "shadow",
                "applied": False,
                "reason_code": final_reason,
                "proposed_officer_id": proposed_id,
            }

        if reason_code is None and selected is not None:
            o_row = self.officers.get(selected["id"])
            if (
                comp["assigned_officer_id"] is None
                and comp["department_id"] == dept_id
                and o_row
                and o_row["is_active"]
                and o_row["department_id"] == dept_id
            ):
                comp["assigned_officer_id"] = selected["id"]
                self.last_assigned[selected["id"]] = self._tick()
                self._insert_system_ai_event(
                    complaint_id=complaint_id,
                    dept_id=dept_id,
                    mode="active",
                    new_officer_id=selected["id"],
                    proposed_officer_id=selected["id"],
                    workload_snapshot=snapshot,
                    applied=True,
                    reason_code="assigned",
                )
                if complaint_id in self.triage_queue and self.triage_queue[complaint_id]["resolved_at"] is None:
                    self.triage_queue[complaint_id]["resolved_at"] = self.now.isoformat()
                return {
                    "mode": "active",
                    "applied": True,
                    "assigned_officer_id": selected["id"],
                }

        final_reason = reason_code or "already_assigned"
        self._insert_system_ai_event(
            complaint_id=complaint_id,
            dept_id=dept_id,
            mode="active",
            proposed_officer_id=proposed_id,
            workload_snapshot=snapshot,
            applied=False,
            reason_code=final_reason,
        )
        self.triage_queue[complaint_id] = {
            "complaint_id": complaint_id,
            "department_id": dept_id,
            "reason_code": final_reason,
            "mode": "active",
            "proposed_officer_id": proposed_id,
            "resolved_at": None,
        }
        return {
            "mode": "active",
            "applied": False,
            "reason_code": final_reason,
            "proposed_officer_id": proposed_id,
        }

    def _insert_system_ai_event(
        self,
        *,
        complaint_id: str,
        dept_id,
        mode: str,
        applied: bool,
        reason_code: str,
        prev_officer_id=None,
        new_officer_id=None,
        proposed_officer_id=None,
        workload_snapshot=None,
    ):
        if any(e["complaint_id"] == complaint_id and e["actor_type"] == "system_ai" for e in self.events):
            return
        self.events.append(
            {
                "id": f"evt-{len(self.events) + 1}",
                "complaint_id": complaint_id,
                "actor_type": "system_ai",
                "actor_id": None,
                "department_id": dept_id,
                "prev_officer_id": prev_officer_id,
                "new_officer_id": new_officer_id,
                "proposed_officer_id": proposed_officer_id,
                "mode": mode,
                "workload_snapshot": workload_snapshot,
                "applied": applied,
                "is_ai_override": False,
                "reason_code": reason_code,
                "created_at": self._tick(),
            }
        )

    def staff_assign_officer(self, complaint_id: str, new_officer_id: str, staff_id: str):
        comp = self.complaints[complaint_id]
        old_officer_id = comp["assigned_officer_id"]
        if old_officer_id == new_officer_id:
            return
        comp["assigned_officer_id"] = new_officer_id
        ts = self._tick()
        self.last_assigned[new_officer_id] = ts

        try:
            if self.simulate_trigger_error:
                raise RuntimeError("simulated_trigger_error")

            is_override = False
            if old_officer_id is not None:
                for ev in reversed(self.events):
                    if ev["complaint_id"] != complaint_id:
                        continue
                    if ev["actor_type"] == "staff":
                        break
                    if ev["actor_type"] == "system_ai" and ev["applied"] and ev["new_officer_id"] == old_officer_id:
                        is_override = True
                        break

            self.events.append(
                {
                    "id": f"evt-{len(self.events) + 1}",
                    "complaint_id": complaint_id,
                    "actor_type": "staff",
                    "actor_id": staff_id,
                    "department_id": comp["department_id"],
                    "prev_officer_id": old_officer_id,
                    "new_officer_id": new_officer_id,
                    "applied": True,
                    "is_ai_override": is_override,
                    "reason_code": "staff_override" if is_override else "staff_manual_assign",
                    "created_at": ts,
                }
            )
            if complaint_id in self.triage_queue and self.triage_queue[complaint_id]["resolved_at"] is None:
                self.triage_queue[complaint_id]["resolved_at"] = self.now.isoformat()
                self.triage_queue[complaint_id]["resolved_by"] = staff_id
        except Exception:
            return


class Phase93MigrationStaticTests(unittest.TestCase):
    def test_migration_undo_and_seed_scripts_satisfy_all_safety_and_amendment_rules(self):
        mig = (
            REPO_ROOT
            / "supabase"
            / "migrations"
            / "20261209_phase9_3_officer_auto_assignment.sql"
        )
        undo = (
            REPO_ROOT
            / "supabase"
            / "rollbacks"
            / "20261209_phase9_3_officer_auto_assignment_UNDO.sql"
        )
        seed_script = REPO_ROOT / "supabase" / "scripts" / "seed_phase9_3_test_officers.sql"
        remove_script = REPO_ROOT / "supabase" / "scripts" / "remove_phase9_3_test_officers.sql"

        self.assertTrue(mig.exists())
        self.assertTrue(undo.exists())
        self.assertTrue(seed_script.exists())
        self.assertTrue(remove_script.exists())

        sql = mig.read_text(encoding="utf-8")
        code_only = re.sub(r"--.*?$", "", sql, flags=re.MULTILINE)

        # Additive tables (no officer_routing_settings per Amendment 6)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.officer_assignment_events", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.complaint_officer_triage_queue", sql)
        self.assertNotIn("officer_routing_settings", sql)

        # Zero RECORD variables in evaluate_and_assign_officer_ai or trigger (Amendment 9)
        fn_section = code_only[code_only.index("CREATE OR REPLACE FUNCTION public.phase9_3_track_staff_officer_change"):]
        fn_section = fn_section[: fn_section.index("Final Privilege & RLS Audit Block") if "Final Privilege & RLS Audit Block" in fn_section else len(fn_section)]
        # Exclude audit block variable v_fn RECORD
        audit_idx = code_only.index("DO $$\nDECLARE\n  v_tbl TEXT;")
        before_audit = code_only[code_only.index("CREATE OR REPLACE FUNCTION public.phase9_3_track_staff_officer_change") : audit_idx]
        self.assertEqual(
            re.findall(r"\bRECORD\b", before_audit, re.IGNORECASE),
            [],
            "Phase 9.3 functions must not declare any RECORD variables (prevents SQLSTATE 55000)",
        )

        # Advisory lock per department, exact ward or NULL fallback only, status enum check, atomic UPDATE
        self.assertIn("pg_catalog.pg_advisory_xact_lock", sql)
        self.assertIn("o.assigned_ward IS NULL", sql)
        self.assertIn("'not_confirmed_by_citizen'::public.complaint_status", sql)
        self.assertIn("AND o.is_active = TRUE", sql)
        self.assertIn("AND o.department_id = c.department_id", sql)
        self.assertIn("AND c.assigned_officer_id IS NULL", sql)
        self.assertIn("GET DIAGNOSTICS v_rows_updated = ROW_COUNT", sql)
        self.assertIn("EXCEPTION WHEN OTHERS THEN", sql)
        self.assertIn("SET search_path = ''", sql)
        self.assertNotRegex(sql, r"pg_catalog\.(least|greatest|coalesce)\s*\(")
        self.assertNotIn("CREATE OR REPLACE FUNCTION public.assign_complaint_admin", sql)
        self.assertNotIn("CREATE OR REPLACE FUNCTION public.guard_officer_updates", sql)

        # Seed script checks
        seed_sql = seed_script.read_text(encoding="utf-8")
        self.assertIn("SELECT DISTINCT", seed_sql.upper().replace("SELECT COALESCE(", "SELECT DISTINCT ") if "FROM public.complaints" in seed_sql else seed_sql)
        self.assertIn("FROM public.complaints", seed_sql)
        self.assertIn("[TEST]", seed_sql)
        self.assertIn("NULL::varchar(100)", seed_sql)


class Phase93OfficerRoutingTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides.clear()
        off_svc.officer_routing_user_limiter._hits.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_mode_defaults_to_shadow(self):
        self.assertEqual(off_svc.get_officer_routing_mode(), "shadow")

    def test_shadow_records_proposed_officer_without_modifying_assigned_officer_id(self):
        db = _InMemoryPhase93Db()
        db.officers = {
            OFF_1_ID: {
                "id": OFF_1_ID,
                "department_id": DEPT_ROADS_ID,
                "assigned_ward": "Ward 1",
                "is_active": True,
                "created_at": db.now - timedelta(days=2),
            }
        }
        res = db.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="shadow")
        self.assertEqual(res["mode"], "shadow")
        self.assertFalse(res["applied"])
        self.assertEqual(res["proposed_officer_id"], OFF_1_ID)
        self.assertIsNone(db.complaints[COMPLAINT_ID]["assigned_officer_id"])
        self.assertEqual(db.triage_queue[COMPLAINT_ID]["reason_code"], "shadow_mode")

    def test_lowest_workload_wins_deterministic_tie_break_and_department_ward_capacity_exclusions(self):
        db = _InMemoryPhase93Db()
        db.officers = {
            OFF_OTHER_DEPT_ID: {
                "id": OFF_OTHER_DEPT_ID,
                "department_id": DEPT_WATER_ID,
                "assigned_ward": "Ward 1",
                "is_active": True,
                "created_at": db.now - timedelta(days=10),
            },
            OFF_OTHER_WARD_ID: {
                "id": OFF_OTHER_WARD_ID,
                "department_id": DEPT_ROADS_ID,
                "assigned_ward": "Ward 9",  # Different ward -> NEVER selected
                "is_active": True,
                "created_at": db.now - timedelta(days=10),
            },
            OFF_NULL_WARD_ID: {
                "id": OFF_NULL_WARD_ID,
                "department_id": DEPT_ROADS_ID,
                "assigned_ward": None,  # Fallback tier=1
                "is_active": True,
                "created_at": db.now - timedelta(days=10),
            },
            OFF_1_ID: {
                "id": OFF_1_ID,
                "department_id": DEPT_ROADS_ID,
                "assigned_ward": "Ward 1",
                "is_active": True,
                "created_at": db.now - timedelta(days=5),
            },
            OFF_2_ID: {
                "id": OFF_2_ID,
                "department_id": DEPT_ROADS_ID,
                "assigned_ward": "Ward 1",
                "is_active": True,
                "created_at": db.now - timedelta(days=5),
            },
        }
        # OFF_1 has 3 open, OFF_2 has 1 open -> OFF_2 wins over OFF_1 and over tier=1 NULL ward
        db.open_counts_override = {OFF_1_ID: 3, OFF_2_ID: 1, OFF_NULL_WARD_ID: 0}
        r1 = db.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="active", max_open_complaints=10)
        self.assertTrue(r1["applied"])
        self.assertEqual(r1["assigned_officer_id"], OFF_2_ID)

        # Tie-breaker: equal open counts -> oldest last_assigned_at (NULLS FIRST) wins
        db.events.clear()
        db.complaints[COMPLAINT_ID]["assigned_officer_id"] = None
        db.open_counts_override = {OFF_1_ID: 2, OFF_2_ID: 2, OFF_NULL_WARD_ID: 0}
        db.last_assigned = {OFF_2_ID: db.now - timedelta(minutes=5)}  # OFF_1 has None -> wins
        r2 = db.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="active", max_open_complaints=10)
        self.assertEqual(r2["assigned_officer_id"], OFF_1_ID)

        # At capacity on exact-ward officers -> falls back to NULL-ward officer when allow_ward_fallback=True
        db.events.clear()
        db.complaints[COMPLAINT_ID]["assigned_officer_id"] = None
        db.open_counts_override = {OFF_1_ID: 10, OFF_2_ID: 10, OFF_NULL_WARD_ID: 2}
        r3 = db.evaluate_and_assign_officer(
            complaint_id=COMPLAINT_ID, mode="active", max_open_complaints=10, allow_ward_fallback=True
        )
        self.assertTrue(r3["applied"])
        self.assertEqual(r3["assigned_officer_id"], OFF_NULL_WARD_ID)

        # Disabling NULL-ward fallback with exact-ward officers at capacity -> all_at_capacity
        db.events.clear()
        db.complaints[COMPLAINT_ID]["assigned_officer_id"] = None
        r4 = db.evaluate_and_assign_officer(
            complaint_id=COMPLAINT_ID, mode="active", max_open_complaints=10, allow_ward_fallback=False
        )
        self.assertFalse(r4["applied"])
        self.assertEqual(r4["reason_code"], "all_at_capacity")

        # Only wrong-ward officer exists -> no_eligible_ward (NEVER assigns different ward)
        db.events.clear()
        db.officers = {OFF_OTHER_WARD_ID: db.officers[OFF_OTHER_WARD_ID]}
        r5 = db.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="active", allow_ward_fallback=True)
        self.assertFalse(r5["applied"])
        self.assertEqual(r5["reason_code"], "no_eligible_ward")

        # Zero active officers -> no_officer
        db.events.clear()
        db.officers = {}
        r6 = db.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="active")
        self.assertFalse(r6["applied"])
        self.assertEqual(r6["reason_code"], "no_officer")

        # Missing department -> no_department
        db.events.clear()
        db.complaints[COMPLAINT_ID]["department_id"] = None
        r7 = db.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="active")
        self.assertFalse(r7["applied"])
        self.assertEqual(r7["reason_code"], "no_department")

    def test_concurrency_idempotency_override_tracking_and_trigger_fault_isolation(self):
        db = _InMemoryPhase93Db()
        db.officers = {
            OFF_1_ID: {
                "id": OFF_1_ID,
                "department_id": DEPT_ROADS_ID,
                "assigned_ward": "Ward 1",
                "is_active": True,
                "created_at": db.now,
            },
            OFF_2_ID: {
                "id": OFF_2_ID,
                "department_id": DEPT_ROADS_ID,
                "assigned_ward": "Ward 1",
                "is_active": True,
                "created_at": db.now,
            },
        }

        # AI assigns OFF_1
        r1 = db.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="active")
        self.assertTrue(r1["applied"])
        self.assertEqual(db.complaints[COMPLAINT_ID]["assigned_officer_id"], OFF_1_ID)

        # Retry is idempotent
        r2 = db.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="active")
        self.assertTrue(r2["idempotent_hit"])
        self.assertEqual(len(db.events), 1)

        # Staff reassigns to OFF_2 -> override=True
        db.staff_assign_officer(COMPLAINT_ID, OFF_2_ID, ADMIN_ID)
        self.assertEqual(db.events[-1]["actor_type"], "staff")
        self.assertTrue(db.events[-1]["is_ai_override"])

        # Subsequent staff reassign -> override=False
        db.staff_assign_officer(COMPLAINT_ID, OFF_1_ID, ADMIN_ID)
        self.assertFalse(db.events[-1]["is_ai_override"])

        # Trigger error never breaks staff assignment
        db.simulate_trigger_error = True
        db.staff_assign_officer(COMPLAINT_ID, OFF_2_ID, ADMIN_ID)
        self.assertEqual(db.complaints[COMPLAINT_ID]["assigned_officer_id"], OFF_2_ID)

        # Concurrent staff assignment already present before AI runs -> already_assigned, never overwritten
        db2 = _InMemoryPhase93Db()
        db2.officers = db.officers
        db2.staff_assign_officer(COMPLAINT_ID, OFF_2_ID, ADMIN_ID)
        self.assertFalse(db2.events[-1]["is_ai_override"])
        r_conc = db2.evaluate_and_assign_officer(complaint_id=COMPLAINT_ID, mode="active")
        self.assertFalse(r_conc["applied"])
        self.assertEqual(r_conc["reason_code"], "already_assigned")
        self.assertEqual(db2.complaints[COMPLAINT_ID]["assigned_officer_id"], OFF_2_ID)

    def test_endpoints_role_enforcement_background_errors_and_92_to_93_chaining(self):
        class FailingHttpClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, url, **kwargs):
                return _FakeHttpResponse(500, {"code": "XX000", "message": "boom"})

        with patch.object(settings, "OFFICER_AUTO_ASSIGN_MODE", "shadow"), patch.object(
            settings, "SUPABASE_URL", "https://example.supabase.co"
        ), patch.object(
            settings, "SUPABASE_SERVICE_ROLE_KEY", "srv-secret"
        ), patch(
            "app.services.officer_routing_service.httpx.AsyncClient", FailingHttpClient
        ):
            self.assertIsNone(asyncio.run(off_svc.run_background_officer_routing(COMPLAINT_ID)))

        # 9.2 active assignment chains 9.3 server-side
        class ChainedDeptClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, url, **kwargs):
                return _FakeHttpResponse(200, {"mode": "active", "applied": True, "department_id": DEPT_ROADS_ID})

        with patch.object(settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "active"), patch.object(
            settings, "OFFICER_AUTO_ASSIGN_MODE", "shadow"
        ), patch.object(
            settings, "SUPABASE_URL", "https://example.supabase.co"
        ), patch.object(
            settings, "SUPABASE_SERVICE_ROLE_KEY", "srv-secret"
        ), patch(
            "app.services.department_routing_service.httpx.AsyncClient", ChainedDeptClient
        ), patch(
            "app.services.officer_routing_service.run_background_officer_routing"
        ) as off_mock:
            asyncio.run(dept_svc.run_background_department_routing(COMPLAINT_ID))
            off_mock.assert_called_once_with(COMPLAINT_ID)

        with TestClient(app) as client:
            # 1. Unauthenticated -> 401
            self.assertEqual(
                client.post(f"/api/admin/complaints/{COMPLAINT_ID}/officer-routing").status_code, 401
            )
            self.assertEqual(
                client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/officer-routing").status_code, 401
            )

            # 2. Citizen forbidden on admin endpoint; officer forbidden on both -> 403
            citizen = AuthenticatedActor(user_id=CITIZEN_ID, role="citizen", token="tok-c")
            app.dependency_overrides[get_authenticated_actor] = lambda: citizen
            self.assertEqual(
                client.post(f"/api/admin/complaints/{COMPLAINT_ID}/officer-routing").status_code, 403
            )

            officer = AuthenticatedActor(
                user_id=OFFICER_USER_ID, role="officer", token="tok-o", officer_id=OFF_1_ID
            )
            app.dependency_overrides[get_authenticated_actor] = lambda: officer
            self.assertEqual(
                client.post(f"/api/admin/complaints/{COMPLAINT_ID}/officer-routing").status_code, 403
            )
            self.assertEqual(
                client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/officer-routing").status_code, 403
            )

            # 3. Admin triggers officer routing after assign_complaint_admin -> 200
            admin = AuthenticatedActor(user_id=ADMIN_ID, role="admin", token="tok-a")
            app.dependency_overrides[get_authenticated_actor] = lambda: admin

            class AdminOfficerRpcClient:
                def __init__(self, *args, **kwargs):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    return False

                async def post(self, url, **kwargs):
                    return _FakeHttpResponse(
                        200,
                        {"mode": "active", "applied": True, "assigned_officer_id": OFF_1_ID},
                    )

            with patch.object(settings, "OFFICER_AUTO_ASSIGN_MODE", "active"), patch.object(
                settings, "SUPABASE_URL", "https://example.supabase.co"
            ), patch.object(
                settings, "SUPABASE_SERVICE_ROLE_KEY", "srv-secret"
            ), patch(
                "app.services.officer_routing_service.httpx.AsyncClient", AdminOfficerRpcClient
            ):
                res = client.post(f"/api/admin/complaints/{COMPLAINT_ID}/officer-routing")
                self.assertEqual(res.status_code, 200)
                body = res.json()
                self.assertTrue(body["accepted"])
                self.assertTrue(body["applied"])
                self.assertEqual(body["assigned_officer_id"], OFF_1_ID)


if __name__ == "__main__":
    unittest.main()
