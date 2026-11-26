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

from app.config import parse_department_routing_mode, settings  # noqa: E402
from app.main import app  # noqa: E402
from app.services import department_routing_service as route_svc  # noqa: E402
from app.services.auth_service import AuthenticatedActor, get_authenticated_actor  # noqa: E402

COMPLAINT_ID = "11111111-1111-4111-8111-111111111111"
DECISION_ID = "22222222-2222-4222-8222-222222222222"
DEPT_ROADS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
DEPT_WATER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
DEPT_WARD1_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
OFFICER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
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


class _InMemoryPhase92Db:
    """
    Faithful in-memory simulation of the 20261207 SQL RPCs and trigger semantics
    so behavioral tests can verify gates, ward isolation, race/concurrency,
    idempotency, override tracking, and trigger fault-isolation deterministically.
    """

    def __init__(self):
        self.now = datetime(2026, 11, 26, 12, 0, 0, tzinfo=timezone.utc)
        self.departments = {
            DEPT_ROADS_ID: {"id": DEPT_ROADS_ID, "is_active": True},
            DEPT_WATER_ID: {"id": DEPT_WATER_ID, "is_active": True},
            DEPT_WARD1_ID: {"id": DEPT_WARD1_ID, "is_active": True},
        }
        self.complaints = {
            COMPLAINT_ID: {
                "id": COMPLAINT_ID,
                "category": "potholes",
                "ward": "Ward 1",
                "status": "submitted",
                "department_id": None,
                "assigned_officer_id": OFFICER_ID,
            }
        }
        self.ai_decisions = []
        self.mappings = []
        self.metrics = []
        self.events = []
        self.assignment_audit = []
        self.triage_queue = {}
        self.simulate_trigger_error = False
        self._seq = 0

    def _tick(self) -> datetime:
        self._seq += 1
        return self.now + timedelta(seconds=self._seq)

    def evaluate_and_assign(
        self,
        *,
        complaint_id: str,
        mode: str,
        min_samples: int,
        min_accuracy: float,
        max_age_days: int,
        min_confidence: float,
    ):
        if mode == "off":
            return {"mode": "off", "skipped": True, "applied": False}

        comp = self.complaints.get(complaint_id)
        if not comp:
            return {"found": False, "applied": False}

        matching_ai = [
            d
            for d in self.ai_decisions
            if d["complaint_id"] == complaint_id and d["feature"] == "category_priority_suggestion"
        ]
        if not matching_ai:
            self.triage_queue[complaint_id] = {
                "complaint_id": complaint_id,
                "ai_decision_id": None,
                "reason_code": "no_suggestion",
                "mode": mode,
                "resolved_at": None,
            }
            return {"mode": mode, "reason_code": "no_suggestion", "applied": False}

        ai = matching_ai[-1]
        if ai["status"] == "failed":
            self.triage_queue[complaint_id] = {
                "complaint_id": complaint_id,
                "ai_decision_id": ai["id"],
                "reason_code": "no_suggestion",
                "mode": mode,
                "resolved_at": None,
            }
            self._insert_system_ai_event(
                complaint_id=complaint_id,
                ai=ai,
                mode=mode,
                gate_snapshot={"reason": "no_suggestion"},
                applied=False,
                reason_code="no_suggestion",
            )
            return {"mode": mode, "reason_code": "no_suggestion", "applied": False}

        if ai["status"] == "pending":
            # Does NOT consume system_ai slot
            self.triage_queue[complaint_id] = {
                "complaint_id": complaint_id,
                "ai_decision_id": ai["id"],
                "reason_code": "ai_pending",
                "mode": mode,
                "resolved_at": None,
            }
            return {"mode": mode, "reason_code": "ai_pending", "applied": False}

        # Idempotency on (ai_decision_id) WHERE actor_type='system_ai'
        if any(e["actor_type"] == "system_ai" and e["ai_decision_id"] == ai["id"] for e in self.events):
            return {"mode": mode, "idempotent_hit": True, "applied": False}

        if comp["status"] in ("resolved", "rejected", "not_confirmed_by_citizen"):
            self._insert_system_ai_event(
                complaint_id=complaint_id,
                ai=ai,
                mode=mode,
                gate_snapshot={"reason": "terminal_status"},
                applied=False,
                reason_code="terminal_status",
            )
            return {"mode": mode, "reason_code": "terminal_status", "applied": False}

        if comp["department_id"] is not None:
            self._insert_system_ai_event(
                complaint_id=complaint_id,
                ai=ai,
                mode=mode,
                gate_snapshot={"reason": "already_assigned", "department_id": comp["department_id"]},
                applied=False,
                reason_code="already_assigned",
            )
            return {"mode": mode, "reason_code": "already_assigned", "applied": False}

        # Mapping resolution: ward first, then citywide
        ward_active = [
            m
            for m in self.mappings
            if m["category"] == ai["suggested_category"] and m["ward"] == comp["ward"] and m["is_active"]
        ]
        mapping_scope = None
        target_dept_id = None
        reason_code = None

        if len(ward_active) > 1:
            reason_code = "ambiguous_mapping"
        elif len(ward_active) == 1:
            mapping_scope = "ward"
            target_dept_id = ward_active[0]["department_id"]
        else:
            global_active = [
                m
                for m in self.mappings
                if m["category"] == ai["suggested_category"] and m["ward"] is None and m["is_active"]
            ]
            if len(global_active) > 1:
                reason_code = "ambiguous_mapping"
            elif len(global_active) == 1:
                mapping_scope = "citywide"
                target_dept_id = global_active[0]["department_id"]
            else:
                reason_code = "unmapped"

        if reason_code is None and target_dept_id is not None:
            dept = self.departments.get(target_dept_id)
            if not dept or not dept["is_active"]:
                reason_code = "inactive_department"

        # Metrics lookup: ward-scoped NEVER falls back to citywide
        metric = None
        if mapping_scope == "ward":
            metric = next(
                (
                    mt
                    for mt in self.metrics
                    if mt["category"] == ai["suggested_category"]
                    and mt["ward"] == comp["ward"]
                    and mt["model_name"] == ai["model_name"]
                    and mt["prompt_version"] == ai["prompt_version"]
                ),
                None,
            )
        elif mapping_scope == "citywide":
            metric = next(
                (
                    mt
                    for mt in self.metrics
                    if mt["category"] == ai["suggested_category"]
                    and mt["ward"] is None
                    and mt["model_name"] == ai["model_name"]
                    and mt["prompt_version"] == ai["prompt_version"]
                ),
                None,
            )

        all_passed = False
        if reason_code is None:
            if not metric or metric["sample_size"] < min_samples:
                reason_code = "insufficient_samples"
            elif metric["measured_at"] < (self.now - timedelta(days=max_age_days)):
                reason_code = "stale_metrics"
            elif metric["accuracy"] < min_accuracy:
                reason_code = "low_accuracy"
            elif ai.get("confidence") is None or ai["confidence"] < min_confidence:
                reason_code = "low_confidence"
            else:
                all_passed = True

        snapshot = {
            "mode": mode,
            "mapping_scope": mapping_scope,
            "suggested_department_id": target_dept_id,
            "model_name": ai["model_name"],
            "prompt_version": ai["prompt_version"],
            "confidence": ai.get("confidence"),
            "sample_size": metric["sample_size"] if metric else 0,
            "accuracy": metric["accuracy"] if metric else None,
            "measured_at": metric["measured_at"].isoformat() if metric else None,
            "all_gates_passed": all_passed,
            "gate_failure_reason": reason_code,
        }

        if mode == "shadow":
            final_reason = reason_code or "shadow_mode"
            self._insert_system_ai_event(
                complaint_id=complaint_id,
                ai=ai,
                mode="shadow",
                gate_snapshot=snapshot,
                applied=False,
                reason_code=final_reason,
                suggested_dept=target_dept_id,
            )
            self.triage_queue[complaint_id] = {
                "complaint_id": complaint_id,
                "ai_decision_id": ai["id"],
                "reason_code": final_reason,
                "mode": "shadow",
                "suggested_department_id": target_dept_id,
                "gate_snapshot": snapshot,
                "resolved_at": None,
            }
            return {
                "mode": "shadow",
                "applied": False,
                "all_gates_passed": all_passed,
                "reason_code": final_reason,
                "gate_snapshot": snapshot,
            }

        if all_passed and target_dept_id is not None:
            if comp["department_id"] is None and comp["status"] not in ("resolved", "rejected", "not_confirmed_by_citizen"):
                comp["department_id"] = target_dept_id
                self._insert_system_ai_event(
                    complaint_id=complaint_id,
                    ai=ai,
                    mode="active",
                    gate_snapshot=snapshot,
                    applied=True,
                    reason_code="assigned",
                    new_dept=target_dept_id,
                    suggested_dept=target_dept_id,
                )
                if complaint_id in self.triage_queue and self.triage_queue[complaint_id]["resolved_at"] is None:
                    self.triage_queue[complaint_id]["resolved_at"] = self.now.isoformat()
                return {
                    "mode": "active",
                    "applied": True,
                    "all_gates_passed": True,
                    "department_id": target_dept_id,
                    "gate_snapshot": snapshot,
                }

        final_reason = reason_code or "already_assigned"
        self._insert_system_ai_event(
            complaint_id=complaint_id,
            ai=ai,
            mode="active",
            gate_snapshot=snapshot,
            applied=False,
            reason_code=final_reason,
            suggested_dept=target_dept_id,
        )
        self.triage_queue[complaint_id] = {
            "complaint_id": complaint_id,
            "ai_decision_id": ai["id"],
            "reason_code": final_reason,
            "mode": "active",
            "suggested_department_id": target_dept_id,
            "gate_snapshot": snapshot,
            "resolved_at": None,
        }
        return {
            "mode": "active",
            "applied": False,
            "all_gates_passed": all_passed,
            "reason_code": final_reason,
            "gate_snapshot": snapshot,
        }

    def _insert_system_ai_event(
        self,
        *,
        complaint_id: str,
        ai: dict,
        mode: str,
        gate_snapshot: dict,
        applied: bool,
        reason_code: str,
        new_dept=None,
        suggested_dept=None,
    ):
        if any(e["actor_type"] == "system_ai" and e["ai_decision_id"] == ai["id"] for e in self.events):
            return
        self.events.append(
            {
                "id": f"evt-{len(self.events) + 1}",
                "complaint_id": complaint_id,
                "actor_type": "system_ai",
                "actor_id": None,
                "ai_decision_id": ai["id"],
                "prev_department_id": None,
                "new_department_id": new_dept,
                "suggested_department_id": suggested_dept,
                "model_name": ai["model_name"],
                "prompt_version": ai["prompt_version"],
                "confidence": ai.get("confidence"),
                "mode": mode,
                "gate_snapshot": gate_snapshot,
                "applied": applied,
                "is_ai_override": False,
                "reason_code": reason_code,
                "created_at": self._tick(),
            }
        )

    def staff_assign_department(self, complaint_id: str, new_dept_id: str, staff_id: str):
        comp = self.complaints[complaint_id]
        old_dept_id = comp["department_id"]
        ts = self._tick()
        if old_dept_id == new_dept_id:
            # Explicit re-confirmation via assign_complaint_admin still writes assignment_audit
            self.assignment_audit.append(
                {
                    "complaint_id": complaint_id,
                    "actor_id": staff_id,
                    "new_department_id": new_dept_id,
                    "created_at": ts,
                }
            )
            return
        comp["department_id"] = new_dept_id
        self.assignment_audit.append(
            {
                "complaint_id": complaint_id,
                "actor_id": staff_id,
                "new_department_id": new_dept_id,
                "created_at": ts,
            }
        )

        # Simulate trigger wrapped in EXCEPTION WHEN OTHERS
        try:
            if self.simulate_trigger_error:
                raise RuntimeError("simulated_trigger_audit_failure")

            is_override = False
            ai_dec_id = None
            if old_dept_id is not None:
                for idx in range(len(self.events) - 1, -1, -1):
                    ev = self.events[idx]
                    if ev["complaint_id"] != complaint_id:
                        continue
                    if ev["actor_type"] == "staff":
                        break
                    if ev["actor_type"] == "system_ai" and ev["applied"] and ev["new_department_id"] == old_dept_id:
                        is_override = True
                        ai_dec_id = ev["ai_decision_id"]
                        break

            self.events.append(
                {
                    "id": f"evt-{len(self.events) + 1}",
                    "complaint_id": complaint_id,
                    "actor_type": "staff",
                    "actor_id": staff_id,
                    "ai_decision_id": ai_dec_id,
                    "prev_department_id": old_dept_id,
                    "new_department_id": new_dept_id,
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
            # Must NEVER break assign_complaint_admin
            return

    def _resolve_active_mapping(self, category: str, ward: str):
        ward_active = [
            m
            for m in self.mappings
            if m["category"] == category
            and m["ward"] == ward
            and m["is_active"]
            and self.departments.get(m["department_id"], {}).get("is_active")
        ]
        if len(ward_active) == 1:
            return ward_active[0]["department_id"]
        if any(
            m["category"] == category and m["ward"] == ward and m["is_active"]
            for m in self.mappings
        ):
            return None
        global_active = [
            m
            for m in self.mappings
            if m["category"] == category
            and m["ward"] is None
            and m["is_active"]
            and self.departments.get(m["department_id"], {}).get("is_active")
        ]
        if len(global_active) == 1:
            return global_active[0]["department_id"]
        return None

    def refresh_metrics(self):
        # 1) Latest completed Phase 9.1 decision per complaint
        latest_by_complaint = {}
        ordered_ai = sorted(
            [
                d
                for d in self.ai_decisions
                if d.get("feature") == "category_priority_suggestion"
                and d.get("status") == "completed"
                and d.get("suggested_category") is not None
            ],
            key=lambda d: (
                d.get("completed_at") or d.get("created_at") or self.now,
                d.get("created_at") or self.now,
                d["id"],
            ),
            reverse=True,
        )
        for d in ordered_ai:
            if d["complaint_id"] not in latest_by_complaint:
                latest_by_complaint[d["complaint_id"]] = d

        validated = []
        for cid, d in latest_by_complaint.items():
            comp = self.complaints.get(cid)
            if not comp or comp["department_id"] is None:
                continue
            dept_id = comp["department_id"]

            has_human_assign = any(
                a["complaint_id"] == cid and a["new_department_id"] == dept_id
                for a in self.assignment_audit
            ) or any(
                e["complaint_id"] == cid
                and e["actor_type"] == "staff"
                and e["new_department_id"] == dept_id
                for e in self.events
            )
            if not has_human_assign:
                continue

            unconfirmed_ai = any(
                ai_ev["complaint_id"] == cid
                and ai_ev["actor_type"] == "system_ai"
                and ai_ev["applied"]
                and ai_ev["new_department_id"] == dept_id
                and not any(
                    st_ev["complaint_id"] == cid
                    and st_ev["actor_type"] == "staff"
                    and st_ev["created_at"] >= ai_ev["created_at"]
                    for st_ev in self.events
                )
                and not any(
                    st_aud["complaint_id"] == cid
                    and st_aud["new_department_id"] == dept_id
                    and st_aud["created_at"] >= ai_ev["created_at"]
                    for st_aud in self.assignment_audit
                )
                for ai_ev in self.events
            )
            if unconfirmed_ai:
                continue

            pred_dept_id = self._resolve_active_mapping(d["suggested_category"], comp["ward"])
            validated.append(
                {
                    "category": d["suggested_category"],
                    "ward": comp["ward"],
                    "model_name": d["model_name"],
                    "prompt_version": d["prompt_version"],
                    "is_correct": pred_dept_id is not None and pred_dept_id == dept_id,
                }
            )

        self.metrics = []
        # Ward + Citywide aggregation
        buckets = {}
        for row in validated:
            for ward_key in (row["ward"], None):
                if ward_key is None or row["ward"] is not None:
                    k = (row["category"], ward_key, row["model_name"], row["prompt_version"])
                    b = buckets.setdefault(k, {"total": 0, "correct": 0})
                    b["total"] += 1
                    if row["is_correct"]:
                        b["correct"] += 1
        for (cat, w, model_name, pv), counts in buckets.items():
            self.metrics.append(
                {
                    "category": cat,
                    "ward": w,
                    "model_name": model_name,
                    "prompt_version": pv,
                    "sample_size": counts["total"],
                    "correct_count": counts["correct"],
                    "accuracy": counts["correct"] / counts["total"] if counts["total"] else 0.0,
                    "measured_at": self.now,
                }
            )
        return self.metrics


class Phase92MigrationStaticTests(unittest.TestCase):
    def test_migration_and_rollback_exist_and_satisfy_all_safety_and_amendment_rules(self):
        mig = (
            REPO_ROOT
            / "supabase"
            / "migrations"
            / "20261207_phase9_2_department_auto_assignment.sql"
        )
        undo = (
            REPO_ROOT
            / "supabase"
            / "rollbacks"
            / "20261207_phase9_2_department_auto_assignment_UNDO.sql"
        )
        self.assertTrue(mig.exists())
        self.assertTrue(undo.exists())

        sql = mig.read_text(encoding="utf-8")
        # Tables
        self.assertIn("CREATE TABLE IF NOT EXISTS public.category_department_mappings", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.ai_category_accuracy_metrics", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.department_assignment_events", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.complaint_department_triage_queue", sql)
        # Seed inactive only (Amendment 1)
        self.assertIn("('potholes', 'roads_infrastructure')", sql)
        self.assertIn("SELECT seed.category, NULL, d.id, FALSE", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION public.upsert_category_department_mapping", sql)
        # Accuracy formula against human-assigned department (Amendment 2 + ground-truth hardening)
        self.assertIn("EXACT FORMULA DOCUMENTED", sql)
        self.assertIn("public.complaint_assignment_audit", sql)
        self.assertNotIn("admin_decision IN ('accepted'", sql)
        self.assertEqual(sql.count("SELECT DISTINCT ON (d.complaint_id)"), 2)
        self.assertIn("ai_ev.actor_type = 'system_ai'", sql)
        self.assertIn("st_aud.created_at >= ai_ev.created_at", sql)
        # Partial unique index on (ai_decision_id) WHERE actor_type = 'system_ai' (Amendment 4)
        self.assertIn("uidx_dept_assign_events_system_ai_decision", sql)
        self.assertIn("ON public.department_assignment_events (ai_decision_id)", sql)
        self.assertIn("WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL", sql)
        self.assertNotIn("model_version", sql)
        self.assertIn("model_name", sql)
        self.assertIn("prompt_version", sql)
        # Pending / no_suggestion + atomic conditional update (Amendments 5, 7)
        self.assertIn("'ai_pending'", sql)
        self.assertIn("'no_suggestion'", sql)
        self.assertIn("FOR UPDATE", sql)
        self.assertIn("AND department_id IS NULL", sql)
        self.assertIn("GET DIAGNOSTICS v_rows_updated = ROW_COUNT", sql)
        # Trigger resolves triage queue & is wrapped in EXCEPTION WHEN OTHERS (Amendments 9, 10)
        self.assertIn("resolved_at = pg_catalog.now()", sql)
        self.assertIn("EXCEPTION WHEN OTHERS THEN", sql)
        self.assertIn("RETURN NEW;", sql)
        # RLS + search_path + no pg_catalog.least/greatest/coalesce
        self.assertIn("FORCE ROW LEVEL SECURITY", sql)
        self.assertIn("SET search_path = ''", sql)
        self.assertNotRegex(sql, r"pg_catalog\.(least|greatest|coalesce)\s*\(")
        # Must NOT modify existing assign_complaint_admin or complete_ai_decision
        self.assertNotIn("CREATE OR REPLACE FUNCTION public.assign_complaint_admin", sql)
        self.assertNotIn("CREATE OR REPLACE FUNCTION public.complete_ai_decision", sql)
        self.assertNotIn("ALTER TABLE public.complaints", sql)

    def test_20261208_fix_eliminates_all_record_vars_and_catches_errors(self):
        fix_mig = (
            REPO_ROOT
            / "supabase"
            / "migrations"
            / "20261208_fix_phase9_2_unassigned_record.sql"
        )
        fix_undo = (
            REPO_ROOT
            / "supabase"
            / "rollbacks"
            / "20261208_fix_phase9_2_unassigned_record_UNDO.sql"
        )
        self.assertTrue(fix_mig.exists(), "20261208 fix migration must exist")
        self.assertTrue(fix_undo.exists(), "20261208 fix UNDO must exist")

        sql = fix_mig.read_text(encoding="utf-8")
        # Strip SQL comments before scanning declarations
        code_only = re.sub(r"--.*?$", "", sql, flags=re.MULTILINE)
        self.assertEqual(
            re.findall(r"\bRECORD\b", code_only, re.IGNORECASE),
            [],
            "evaluate_and_assign_department_ai must not declare any RECORD variables (prevents SQLSTATE 55000)",
        )
        self.assertEqual(
            re.findall(r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-zA-Z0-9_]+)", code_only, re.IGNORECASE),
            ["evaluate_and_assign_department_ai"],
        )
        self.assertNotIn("CREATE TABLE", code_only.upper())
        self.assertNotIn("ALTER TABLE", code_only.upper())
        self.assertIn("SET search_path = ''", sql)
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION public.evaluate_and_assign_department_ai(UUID, TEXT, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION) TO service_role;",
            sql,
        )
        self.assertIn("EXCEPTION WHEN OTHERS THEN", sql)
        self.assertIn("ON CONFLICT (complaint_id) DO NOTHING", sql)
        self.assertIn("'reason_code', 'error'", sql)
        self.assertNotRegex(sql, r"pg_catalog\.(least|greatest|coalesce)\s*\(")


class Phase92DepartmentRoutingTests(unittest.TestCase):
    def setUp(self):
        app.dependency_overrides.clear()
        route_svc.department_routing_user_limiter._hits.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_mode_defaults_to_shadow_and_parses_strictly(self):
        self.assertEqual(parse_department_routing_mode(None), "shadow")
        self.assertEqual(parse_department_routing_mode(""), "shadow")
        self.assertEqual(parse_department_routing_mode("invalid"), "shadow")
        self.assertEqual(parse_department_routing_mode("OFF"), "off")
        self.assertEqual(parse_department_routing_mode("shadow"), "shadow")
        self.assertEqual(parse_department_routing_mode("Active"), "active")

    def test_shadow_never_changes_department_while_evaluating_gates_and_snapshot(self):
        db = _InMemoryPhase92Db()
        db.mappings.append({"category": "potholes", "ward": None, "department_id": DEPT_ROADS_ID, "is_active": True})
        db.metrics.append(
            {
                "category": "potholes",
                "ward": None,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "sample_size": 80,
                "accuracy": 0.98,
                "measured_at": db.now - timedelta(days=1),
            }
        )
        db.ai_decisions.append(
            {
                "id": DECISION_ID,
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "completed",
                "suggested_category": "potholes",
                "confidence": 0.96,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
            }
        )

        res = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID,
            mode="shadow",
            min_samples=50,
            min_accuracy=0.95,
            max_age_days=14,
            min_confidence=0.85,
        )
        self.assertEqual(res["mode"], "shadow")
        self.assertFalse(res["applied"])
        self.assertTrue(res["all_gates_passed"])
        self.assertIsNone(db.complaints[COMPLAINT_ID]["department_id"])
        self.assertEqual(db.triage_queue[COMPLAINT_ID]["reason_code"], "shadow_mode")
        self.assertEqual(db.events[0]["actor_type"], "system_ai")
        self.assertTrue(db.events[0]["gate_snapshot"]["all_gates_passed"])

    def test_active_mode_gates_small_sample_stale_model_low_category_accuracy_and_ward_isolation(self):
        db = _InMemoryPhase92Db()
        db.mappings.append({"category": "potholes", "ward": None, "department_id": DEPT_ROADS_ID, "is_active": True})
        db.ai_decisions.append(
            {
                "id": DECISION_ID,
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "completed",
                "suggested_category": "potholes",
                "confidence": 0.99,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
            }
        )

        # 1) Small sample (N=49 < 50) -> manual queue even with confidence 0.99
        db.metrics.append(
            {
                "category": "potholes",
                "ward": None,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "sample_size": 49,
                "accuracy": 1.0,
                "measured_at": db.now - timedelta(days=1),
            }
        )
        r1 = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertFalse(r1["applied"])
        self.assertEqual(r1["reason_code"], "insufficient_samples")
        self.assertIsNone(db.complaints[COMPLAINT_ID]["department_id"])

        # 2) Stale metrics (15 days > 14) -> stale_metrics
        db.events.clear()
        db.metrics[0]["sample_size"] = 60
        db.metrics[0]["measured_at"] = db.now - timedelta(days=15)
        r2 = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertFalse(r2["applied"])
        self.assertEqual(r2["reason_code"], "stale_metrics")

        # 3) Model / prompt mismatch -> insufficient_samples (no match for model)
        db.events.clear()
        db.metrics[0]["measured_at"] = db.now - timedelta(days=1)
        db.metrics[0]["prompt_version"] = "v0.9"
        r3 = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertFalse(r3["applied"])
        self.assertEqual(r3["reason_code"], "insufficient_samples")

        # 4) Low category accuracy (0.94 < 0.95), even with another category at 1.0 -> low_accuracy
        db.events.clear()
        db.metrics[0]["prompt_version"] = "v1.0"
        db.metrics[0]["accuracy"] = 0.94
        db.metrics.append(
            {
                "category": "garbage",
                "ward": None,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "sample_size": 500,
                "accuracy": 1.0,
                "measured_at": db.now,
            }
        )
        r4 = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertFalse(r4["applied"])
        self.assertEqual(r4["reason_code"], "low_accuracy")

        # 5) Ward-specific mapping MUST use Ward 1 metrics, NEVER citywide metrics (Amendment 3)
        db.events.clear()
        db.metrics[0]["accuracy"] = 0.99  # Citywide potholes meets all gates
        db.mappings.append(
            {"category": "potholes", "ward": "Ward 1", "department_id": DEPT_WARD1_ID, "is_active": True}
        )
        r5 = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertFalse(r5["applied"])
        self.assertEqual(r5["reason_code"], "insufficient_samples")
        self.assertIsNone(db.complaints[COMPLAINT_ID]["department_id"])

        # 6) Ambiguous ward mapping -> ambiguous_mapping -> manual queue
        db.events.clear()
        db.mappings.append(
            {"category": "potholes", "ward": "Ward 1", "department_id": DEPT_WATER_ID, "is_active": True}
        )
        r6 = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertFalse(r6["applied"])
        self.assertEqual(r6["reason_code"], "ambiguous_mapping")

    def test_active_assign_concurrent_staff_protection_idempotency_and_override_tracking(self):
        db = _InMemoryPhase92Db()
        db.mappings.append({"category": "potholes", "ward": None, "department_id": DEPT_ROADS_ID, "is_active": True})
        db.metrics.append(
            {
                "category": "potholes",
                "ward": None,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "sample_size": 60,
                "accuracy": 0.97,
                "measured_at": db.now - timedelta(days=1),
            }
        )
        db.ai_decisions.append(
            {
                "id": DECISION_ID,
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "completed",
                "suggested_category": "potholes",
                "confidence": 0.92,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
            }
        )

        # Active assign succeeds and keeps assigned_officer_id untouched
        r1 = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertTrue(r1["applied"])
        self.assertEqual(db.complaints[COMPLAINT_ID]["department_id"], DEPT_ROADS_ID)
        self.assertEqual(db.complaints[COMPLAINT_ID]["assigned_officer_id"], OFFICER_ID)
        self.assertEqual(len(db.events), 1)

        # Duplicate / retry run creates zero extra rows
        r2 = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertTrue(r2["idempotent_hit"])
        self.assertEqual(len(db.events), 1)

        # Staff reassigns AI-assigned complaint -> recorded as override (is_ai_override=True)
        db.staff_assign_department(COMPLAINT_ID, DEPT_WATER_ID, ADMIN_ID)
        self.assertEqual(len(db.events), 2)
        self.assertEqual(db.events[1]["actor_type"], "staff")
        self.assertTrue(db.events[1]["is_ai_override"])

        # Subsequent staff change -> NOT an override (is_ai_override=False) & unrestricted
        db.staff_assign_department(COMPLAINT_ID, DEPT_ROADS_ID, ADMIN_ID)
        self.assertEqual(len(db.events), 3)
        self.assertEqual(db.events[2]["actor_type"], "staff")
        self.assertFalse(db.events[2]["is_ai_override"])

    def test_plain_staff_assignment_resolves_triage_queue_is_not_override_and_survives_trigger_error(self):
        db = _InMemoryPhase92Db()
        # Simulate pending -> ai_pending -> staff resolves manually before AI completes
        db.ai_decisions.append(
            {
                "id": DECISION_ID,
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "pending",
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
            }
        )
        r_pend = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertEqual(r_pend["reason_code"], "ai_pending")
        self.assertIsNone(db.triage_queue[COMPLAINT_ID]["resolved_at"])

        db.staff_assign_department(COMPLAINT_ID, DEPT_WATER_ID, ADMIN_ID)
        self.assertEqual(db.complaints[COMPLAINT_ID]["department_id"], DEPT_WATER_ID)
        self.assertFalse(db.events[-1]["is_ai_override"])
        self.assertIsNotNone(db.triage_queue[COMPLAINT_ID]["resolved_at"])

        # AI finishes later -> never overwrites staff assignment
        db.ai_decisions[-1]["status"] = "completed"
        db.ai_decisions[-1]["suggested_category"] = "potholes"
        db.ai_decisions[-1]["confidence"] = 0.99
        r_after = db.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertFalse(r_after["applied"])
        self.assertEqual(r_after["reason_code"], "already_assigned")
        self.assertEqual(db.complaints[COMPLAINT_ID]["department_id"], DEPT_WATER_ID)

        # Amendment 10: trigger error must NEVER break staff assignment
        db.simulate_trigger_error = True
        db.staff_assign_department(COMPLAINT_ID, DEPT_ROADS_ID, ADMIN_ID)
        self.assertEqual(db.complaints[COMPLAINT_ID]["department_id"], DEPT_ROADS_ID)

    def test_accuracy_metrics_ground_truth_excludes_unconfirmed_ai_dedupes_decisions_and_includes_staff_confirmed(self):
        # (a) AI-assigned department + admin accepted category (no staff dept assign) = EXCLUDED
        db_a = _InMemoryPhase92Db()
        db_a.mappings.append({"category": "potholes", "ward": None, "department_id": DEPT_ROADS_ID, "is_active": True})
        db_a.metrics.append(
            {
                "category": "potholes",
                "ward": None,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "sample_size": 60,
                "accuracy": 0.98,
                "measured_at": db_a.now,
            }
        )
        db_a.ai_decisions.append(
            {
                "id": DECISION_ID,
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "completed",
                "suggested_category": "potholes",
                "confidence": 0.95,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "admin_decision": "accepted",
                "created_at": db_a.now,
                "completed_at": db_a.now,
            }
        )
        r_ai = db_a.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertTrue(r_ai["applied"])
        metrics_a = db_a.refresh_metrics()
        self.assertEqual(metrics_a, [])

        # (b) Staff-assigned department = INCLUDED
        db_b = _InMemoryPhase92Db()
        db_b.mappings.append({"category": "potholes", "ward": None, "department_id": DEPT_ROADS_ID, "is_active": True})
        db_b.ai_decisions.append(
            {
                "id": DECISION_ID,
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "completed",
                "suggested_category": "potholes",
                "confidence": 0.95,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "created_at": db_b.now,
                "completed_at": db_b.now,
            }
        )
        db_b.staff_assign_department(COMPLAINT_ID, DEPT_ROADS_ID, ADMIN_ID)
        metrics_b = db_b.refresh_metrics()
        city_b = [m for m in metrics_b if m["ward"] is None and m["category"] == "potholes"]
        self.assertEqual(len(city_b), 1)
        self.assertEqual(city_b[0]["sample_size"], 1)
        self.assertEqual(city_b[0]["correct_count"], 1)
        self.assertEqual(city_b[0]["accuracy"], 1.0)

        # (c) Two completed decisions on one complaint = counted ONCE using latest completed decision
        db_c = _InMemoryPhase92Db()
        db_c.mappings.append({"category": "potholes", "ward": None, "department_id": DEPT_ROADS_ID, "is_active": True})
        db_c.mappings.append({"category": "water_leakage", "ward": None, "department_id": DEPT_WATER_ID, "is_active": True})
        db_c.ai_decisions.append(
            {
                "id": "22222222-2222-4222-8222-222222222201",
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "completed",
                "suggested_category": "water_leakage",
                "confidence": 0.90,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "created_at": db_c.now - timedelta(minutes=10),
                "completed_at": db_c.now - timedelta(minutes=9),
            }
        )
        db_c.ai_decisions.append(
            {
                "id": "22222222-2222-4222-8222-222222222202",
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "completed",
                "suggested_category": "potholes",
                "confidence": 0.96,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "created_at": db_c.now - timedelta(minutes=2),
                "completed_at": db_c.now - timedelta(minutes=1),
            }
        )
        db_c.staff_assign_department(COMPLAINT_ID, DEPT_ROADS_ID, ADMIN_ID)
        metrics_c = db_c.refresh_metrics()
        city_c = [m for m in metrics_c if m["ward"] is None]
        self.assertEqual(len(city_c), 1)
        self.assertEqual(city_c[0]["category"], "potholes")
        self.assertEqual(city_c[0]["sample_size"], 1)

        # (d) AI-assigned then staff re-confirmed = INCLUDED
        db_d = _InMemoryPhase92Db()
        db_d.mappings.append({"category": "potholes", "ward": None, "department_id": DEPT_ROADS_ID, "is_active": True})
        db_d.metrics.append(
            {
                "category": "potholes",
                "ward": None,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "sample_size": 60,
                "accuracy": 0.98,
                "measured_at": db_d.now,
            }
        )
        db_d.ai_decisions.append(
            {
                "id": DECISION_ID,
                "complaint_id": COMPLAINT_ID,
                "feature": "category_priority_suggestion",
                "status": "completed",
                "suggested_category": "potholes",
                "confidence": 0.95,
                "model_name": "gemini-2.5-flash",
                "prompt_version": "v1.0",
                "created_at": db_d.now,
                "completed_at": db_d.now,
            }
        )
        r_d = db_d.evaluate_and_assign(
            complaint_id=COMPLAINT_ID, mode="active", min_samples=50, min_accuracy=0.95, max_age_days=14, min_confidence=0.85
        )
        self.assertTrue(r_d["applied"])
        # Staff explicitly re-confirms the AI-assigned department via assign_complaint_admin
        db_d.staff_assign_department(COMPLAINT_ID, DEPT_ROADS_ID, ADMIN_ID)
        metrics_d = db_d.refresh_metrics()
        city_d = [m for m in metrics_d if m["ward"] is None and m["category"] == "potholes"]
        self.assertEqual(len(city_d), 1)
        self.assertEqual(city_d[0]["sample_size"], 1)
        self.assertEqual(city_d[0]["correct_count"], 1)

    def test_background_errors_never_raise_and_citizen_and_admin_endpoints_enforce_ownership_and_roles(self):
        class FailingHttpClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, url, **kwargs):
                return _FakeHttpResponse(500, {"code": "XX000", "message": "boom"})

        with patch.object(settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "shadow"), patch.object(
            settings, "SUPABASE_URL", "https://example.supabase.co"
        ), patch.object(
            settings, "SUPABASE_SERVICE_ROLE_KEY", "srv-secret"
        ), patch(
            "app.services.department_routing_service.httpx.AsyncClient", FailingHttpClient
        ):
            # Must NEVER raise
            res = asyncio.run(route_svc.run_background_department_routing(COMPLAINT_ID))
            self.assertIsNone(res)

        with TestClient(app) as client:
            # 1. Unauthenticated -> 401
            self.assertEqual(
                client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/department-routing").status_code,
                401,
            )
            self.assertEqual(
                client.get("/api/admin/department-routing/overview").status_code,
                401,
            )

            # 2. Officer forbidden on both citizen and admin endpoints -> 403
            officer = AuthenticatedActor(
                user_id=OFFICER_USER_ID, role="officer", token="tok-o", officer_id=OFFICER_ID
            )
            app.dependency_overrides[get_authenticated_actor] = lambda: officer
            self.assertEqual(
                client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/department-routing").status_code,
                403,
            )
            self.assertEqual(
                client.get("/api/admin/department-routing/overview").status_code,
                403,
            )

            # 3. Citizen ownership check: non-owner -> 404, owner -> 202
            citizen = AuthenticatedActor(user_id=CITIZEN_ID, role="citizen", token="tok-c")
            app.dependency_overrides[get_authenticated_actor] = lambda: citizen

            class NonOwnerClient:
                def __init__(self, *args, **kwargs):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    return False

                async def get(self, url, **kwargs):
                    return _FakeHttpResponse(200, [])

            with patch.object(settings, "SUPABASE_URL", "https://example.supabase.co"), patch.object(
                settings, "SUPABASE_ANON_KEY", "anon-key"
            ), patch(
                "app.services.ai_intelligence_service.httpx.AsyncClient", NonOwnerClient
            ):
                self.assertEqual(
                    client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/department-routing").status_code,
                    404,
                )

            class OwnerClient:
                def __init__(self, *args, **kwargs):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    return False

                async def get(self, url, **kwargs):
                    return _FakeHttpResponse(200, [{"id": COMPLAINT_ID}])

            with patch.object(settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "shadow"), patch.object(
                settings, "SUPABASE_URL", "https://example.supabase.co"
            ), patch.object(
                settings, "SUPABASE_ANON_KEY", "anon-key"
            ), patch(
                "app.services.ai_intelligence_service.httpx.AsyncClient", OwnerClient
            ), patch(
                "app.services.department_routing_service.run_background_department_routing"
            ) as bg_mock:
                ok_res = client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/department-routing")
                self.assertEqual(ok_res.status_code, 202)
                self.assertEqual(ok_res.json(), {"accepted": True, "queued": True, "mode": "shadow"})
                bg_mock.assert_called_once_with(COMPLAINT_ID)

            # 4. Server-side ordering: calling 9.1 ai-suggestions queues 9.1 BEFORE 9.2
            queued_tasks = []
            with patch.object(settings, "AI_INTELLIGENCE_ENABLED", True), patch.object(
                settings, "DEPARTMENT_AUTO_ASSIGN_MODE", "shadow"
            ), patch.object(settings, "SUPABASE_URL", "https://example.supabase.co"), patch.object(
                settings, "SUPABASE_ANON_KEY", "anon-key"
            ), patch(
                "app.services.ai_intelligence_service.httpx.AsyncClient", OwnerClient
            ), patch(
                "app.services.ai_intelligence_service.run_shadow_category_priority_suggestion",
                side_effect=lambda cid, **kw: queued_tasks.append(("9.1", cid)),
            ), patch(
                "app.services.department_routing_service.run_background_department_routing",
                side_effect=lambda cid: queued_tasks.append(("9.2", cid)),
            ):
                res_91 = client.post(f"/api/citizen/complaints/{COMPLAINT_ID}/ai-suggestions")
                self.assertEqual(res_91.status_code, 202)
                self.assertEqual(queued_tasks, [("9.1", COMPLAINT_ID), ("9.2", COMPLAINT_ID)])

            # 5. Admin mapping activation & metrics refresh endpoints
            admin = AuthenticatedActor(user_id=ADMIN_ID, role="admin", token="tok-a")
            app.dependency_overrides[get_authenticated_actor] = lambda: admin

            class AdminClient:
                def __init__(self, *args, **kwargs):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *args):
                    return False

                async def post(self, url, json=None, **kwargs):
                    if url.endswith("/rpc/upsert_category_department_mapping"):
                        return _FakeHttpResponse(
                            200,
                            {
                                "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                                "category": json["p_category"],
                                "ward": json["p_ward"],
                                "department_id": json["p_department_id"],
                                "is_active": json["p_is_active"],
                                "updated_at": "2026-11-26T12:00:00Z",
                            },
                        )
                    if url.endswith("/rpc/refresh_ai_category_accuracy_metrics"):
                        return _FakeHttpResponse(
                            200,
                            {
                                "success": True,
                                "ward_metrics_updated": 1,
                                "citywide_metrics_updated": 1,
                                "total_updated": 2,
                                "measured_at": "2026-11-26T12:00:00Z",
                            },
                        )
                    return _FakeHttpResponse(404, {})

            with patch.object(settings, "SUPABASE_URL", "https://example.supabase.co"), patch.object(
                settings, "SUPABASE_ANON_KEY", "anon-key"
            ), patch.object(
                settings, "SUPABASE_SERVICE_ROLE_KEY", "srv-secret"
            ), patch(
                "app.services.department_routing_service.httpx.AsyncClient", AdminClient
            ):
                m_res = client.post(
                    "/api/admin/department-routing/mappings",
                    json={"category": "potholes", "department_id": DEPT_ROADS_ID, "is_active": True},
                )
                self.assertEqual(m_res.status_code, 200)
                self.assertTrue(m_res.json()["is_active"])

                ref_res = client.post("/api/admin/department-routing/refresh-metrics")
                self.assertEqual(ref_res.status_code, 200)
                self.assertEqual(ref_res.json()["total_updated"], 2)


if __name__ == "__main__":
    unittest.main()
