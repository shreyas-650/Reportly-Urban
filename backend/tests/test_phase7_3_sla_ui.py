"""
ReportlyUrban — Phase 7.3 Backend Unit & Mocked Integration Tests
Covers:
  1. 401 Unauthenticated & 403 Wrong-Role checks for every Phase 7.3 endpoint
     (admin, active officer, inactive officer, citizen isolation).
  2. Pydantic extra='forbid', bounded pagination (default 20, max 100), filter validation.
  3. Admin escalations retrieval, per-complaint history, manual escalation RPC invocation
     (forbidding client target_level/recipient), duplicate/conflict/validation mapping.
  4. Admin SLA rule retrieval, constraint checks, stale-data 409 detection, update RPC call.
  5. Admin & officer notification retrieval + mark-as-read RPC (404 when false).
  6. Officer reminders (pre_deadline vs overdue) and officer-scoped escalations.
  7. Citizen follow-up endpoint returning strictly {"is_followed_up": bool} and 404 on denied/missing.
"""

import unittest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException, status
from fastapi.testclient import TestClient

from app.main import app
from app.services.auth_service import AuthenticatedActor, get_authenticated_actor

CID_1 = "11111111-1111-4111-8111-111111111111"
CID_2 = "22222222-2222-4222-8222-222222222222"
NID_1 = "33333333-3333-4333-8333-333333333333"
DEPT_1 = "44444444-4444-4444-8444-444444444444"
OFF_1 = "55555555-5555-4555-8555-555555555555"

ADMIN_ACTOR = AuthenticatedActor(user_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role="admin", token="tok-admin")
OFFICER_ACTOR = AuthenticatedActor(
    user_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    role="officer",
    token="tok-officer",
    officer_id=OFF_1,
    department_id=DEPT_1,
)
INACTIVE_OFFICER_ACTOR = AuthenticatedActor(
    user_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    role="officer",
    token="tok-inactive",
    officer_id=None,
    department_id=None,
)
CITIZEN_ACTOR = AuthenticatedActor(user_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd", role="citizen", token="tok-citizen")


class Phase73BackendTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        app.dependency_overrides.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_unauthenticated_returns_401_on_every_new_endpoint(self):
        endpoints = [
            ("GET", "/api/admin/escalations"),
            ("GET", f"/api/admin/complaints/{CID_1}/escalations"),
            ("POST", f"/api/admin/complaints/{CID_1}/escalate"),
            ("GET", "/api/admin/sla-rules"),
            ("PUT", "/api/admin/sla-rules/potholes"),
            ("GET", "/api/admin/notifications"),
            ("POST", f"/api/admin/notifications/{NID_1}/read"),
            ("GET", "/api/officer/reminders"),
            ("GET", "/api/officer/escalations"),
            ("GET", "/api/officer/notifications"),
            ("POST", f"/api/officer/notifications/{NID_1}/read"),
            ("GET", f"/api/citizen/complaints/{CID_1}/followup"),
        ]
        for method, path in endpoints:
            kwargs = {"json": {}} if method in ("POST", "PUT") else {}
            res = self.client.request(method, path, **kwargs)
            self.assertEqual(res.status_code, 401, f"{method} {path} should return 401 without Authorization")

    def test_role_enforcement_returns_403_across_all_endpoints(self):
        admin_endpoints = [
            ("GET", "/api/admin/escalations", None),
            ("GET", f"/api/admin/complaints/{CID_1}/escalations", None),
            ("POST", f"/api/admin/complaints/{CID_1}/escalate", {"reason": "Valid escalation reason"}),
            ("GET", "/api/admin/sla-rules", None),
            (
                "PUT",
                "/api/admin/sla-rules/potholes",
                {"sla_hours": 48, "reminder_before_hours": 12, "level2_after_hours": 24, "level3_after_hours": 72},
            ),
            ("GET", "/api/admin/notifications", None),
            ("POST", f"/api/admin/notifications/{NID_1}/read", None),
        ]
        officer_endpoints = [
            ("GET", "/api/officer/reminders", None),
            ("GET", "/api/officer/escalations", None),
            ("GET", "/api/officer/notifications", None),
            ("POST", f"/api/officer/notifications/{NID_1}/read", None),
        ]
        citizen_endpoints = [
            ("GET", f"/api/citizen/complaints/{CID_1}/followup", None),
        ]

        # Citizen blocked from admin and officer endpoints
        app.dependency_overrides[get_authenticated_actor] = lambda: CITIZEN_ACTOR
        for method, path, body in admin_endpoints + officer_endpoints:
            res = self.client.request(method, path, json=body)
            self.assertEqual(res.status_code, 403, f"Citizen on {method} {path} must return 403")

        # Active officer blocked from admin and citizen endpoints
        app.dependency_overrides[get_authenticated_actor] = lambda: OFFICER_ACTOR
        for method, path, body in admin_endpoints + citizen_endpoints:
            res = self.client.request(method, path, json=body)
            self.assertEqual(res.status_code, 403, f"Officer on {method} {path} must return 403")

        # Inactive officer blocked from officer endpoints
        app.dependency_overrides[get_authenticated_actor] = lambda: INACTIVE_OFFICER_ACTOR
        for method, path, body in officer_endpoints:
            res = self.client.request(method, path, json=body)
            self.assertEqual(res.status_code, 403, f"Inactive officer on {method} {path} must return 403")

        # Admin blocked from officer and citizen endpoints
        app.dependency_overrides[get_authenticated_actor] = lambda: ADMIN_ACTOR
        for method, path, body in officer_endpoints + citizen_endpoints:
            res = self.client.request(method, path, json=body)
            self.assertEqual(res.status_code, 403, f"Admin on {method} {path} must return 403")

    @patch("app.services.phase7_service._rest_get", new_callable=AsyncMock)
    def test_admin_escalations_filters_pagination_and_mapping(self, mock_get):
        app.dependency_overrides[get_authenticated_actor] = lambda: ADMIN_ACTOR

        mock_get.side_effect = [
            (
                [
                    {
                        "id": "esc-1",
                        "complaint_id": CID_1,
                        "from_level": 0,
                        "to_level": 1,
                        "status": "completed",
                        "reason": "Overdue field verification",
                        "triggered_by": "system",
                        "recipient_profile_id": "prof-1",
                        "recipient_officer_id": OFF_1,
                        "created_at": "2026-11-25T10:00:00Z",
                        "complaints": {
                            "id": CID_1,
                            "complaint_number": "RU-2026-00010",
                            "category": "potholes",
                            "ward": "Ward 1 - North Central",
                            "status": "in_progress",
                            "department_id": DEPT_1,
                            "sla_deadline": "2026-11-26T10:00:00Z",
                            "updated_at": "2026-11-25T09:00:00Z",
                        },
                    }
                ],
                1,
            ),
            ([{"id": DEPT_1, "name": "Roads & Bridges", "is_active": True}], 1),
            ([{"complaint_id": CID_1, "current_level": 1}], 1),
            ([{"id": OFF_1, "official_name": "A. Verma", "designation": "Junior Engineer"}], 1),
            ([{"id": "prof-1", "full_name": "A. Verma", "role": "officer"}], 1),
        ]

        res = self.client.get(
            f"/api/admin/escalations?level=1&status=completed&department_id={DEPT_1}&ward=Ward+1&date_from=2026-11-24&date_to=2026-11-26&page=1&page_size=20"
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers.get("cache-control"), "no-store")
        body = res.json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["items"][0]["complaint_reference"], "RU-2026-00010")
        self.assertEqual(body["items"][0]["recipient"], "A. Verma (Junior Engineer)")

        # Invalid filters / bounds
        self.assertEqual(self.client.get("/api/admin/escalations?level=9").status_code, 400)
        self.assertEqual(self.client.get("/api/admin/escalations?page_size=101").status_code, 400)
        self.assertEqual(self.client.get("/api/admin/escalations?unknown_param=1").status_code, 400)
        self.assertEqual(self.client.get("/api/admin/escalations?date_from=2026-11-26&date_to=2026-11-20").status_code, 400)

    @patch("app.services.phase7_service._rest_rpc", new_callable=AsyncMock)
    def test_manual_escalation_validation_forbids_client_level_and_maps_conflict(self, mock_rpc):
        app.dependency_overrides[get_authenticated_actor] = lambda: ADMIN_ACTOR

        # Client attempting to supply target level / recipient rejected (extra='forbid' -> 422)
        res_extra = self.client.post(
            f"/api/admin/complaints/{CID_1}/escalate",
            json={"reason": "Escalating now", "to_level": 3},
        )
        self.assertEqual(res_extra.status_code, 422)

        # Too-short reason rejected
        res_short = self.client.post(
            f"/api/admin/complaints/{CID_1}/escalate",
            json={"reason": "   ab  "},
        )
        self.assertEqual(res_short.status_code, 422)

        # Valid call invokes escalate_complaint_manual without target level
        mock_rpc.return_value = {
            "escalation_id": "esc-99",
            "complaint_id": CID_1,
            "from_level": 0,
            "to_level": 1,
            "status": "completed",
        }
        res_ok = self.client.post(
            f"/api/admin/complaints/{CID_1}/escalate",
            json={"reason": "SLA deadline elapsed without action", "expected_updated_at": "2026-11-25T10:00:00Z"},
        )
        self.assertEqual(res_ok.status_code, 200)
        self.assertEqual(res_ok.headers.get("cache-control"), "no-store")
        self.assertEqual(res_ok.json()["to_level"], 1)
        mock_rpc.assert_awaited_once_with(
            "tok-admin",
            "escalate_complaint_manual",
            {
                "p_complaint_id": CID_1,
                "p_reason": "SLA deadline elapsed without action",
                "p_expected_updated_at": "2026-11-25T10:00:00Z",
            },
        )

        # Repeat / skipped / conflict error mapped cleanly (409)
        mock_rpc.side_effect = HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This escalation level has already been recorded for this complaint.",
        )
        res_dup = self.client.post(
            f"/api/admin/complaints/{CID_1}/escalate",
            json={"reason": "Repeat escalation attempt"},
        )
        self.assertEqual(res_dup.status_code, 409)

    @patch("app.services.phase7_service._rest_rpc", new_callable=AsyncMock)
    @patch("app.services.phase7_service._rest_get", new_callable=AsyncMock)
    def test_sla_rule_update_validation_stale_check_and_rpc(self, mock_get, mock_rpc):
        app.dependency_overrides[get_authenticated_actor] = lambda: ADMIN_ACTOR

        # Invalid thresholds rejected before RPC
        bad_payload = {
            "sla_hours": 24,
            "reminder_before_hours": 24,  # must be strictly < sla_hours
            "level2_after_hours": 12,
            "level3_after_hours": 12,  # must be > level2_after_hours
        }
        self.assertEqual(self.client.put("/api/admin/sla-rules/potholes", json=bad_payload).status_code, 422)

        # Stale updated_at returns 409 Conflict
        mock_get.return_value = ([{"category": "potholes", "updated_at": "2026-11-25T11:00:00+00:00"}], 1)
        stale_payload = {
            "sla_hours": 36,
            "reminder_before_hours": 8,
            "level2_after_hours": 16,
            "level3_after_hours": 48,
            "expected_updated_at": "2026-11-25T09:00:00+00:00",
        }
        res_stale = self.client.put("/api/admin/sla-rules/potholes", json=stale_payload)
        self.assertEqual(res_stale.status_code, 409)

        # Fresh timestamp updates cleanly via update_category_sla_rule
        mock_rpc.return_value = {
            "category": "potholes",
            "sla_hours": 36,
            "reminder_before_hours": 8,
            "level2_after_hours": 16,
            "level3_after_hours": 48,
            "updated_at": "2026-11-25T11:30:00+00:00",
        }
        fresh_payload = {**stale_payload, "expected_updated_at": "2026-11-25T11:00:00+00:00"}
        res_ok = self.client.put("/api/admin/sla-rules/potholes", json=fresh_payload)
        self.assertEqual(res_ok.status_code, 200)
        self.assertEqual(res_ok.json()["sla_hours"], 36)

    @patch("app.services.phase7_service._rest_rpc", new_callable=AsyncMock)
    @patch("app.services.phase7_service._rest_get", new_callable=AsyncMock)
    def test_officer_reminders_notifications_and_read_rpc(self, mock_get, mock_rpc):
        app.dependency_overrides[get_authenticated_actor] = lambda: OFFICER_ACTOR

        mock_get.return_value = (
            [
                {
                    "id": "rem-1",
                    "complaint_id": CID_1,
                    "kind": "overdue",
                    "created_at": "2026-11-25T11:00:00Z",
                    "complaints": {
                        "id": CID_1,
                        "complaint_number": "RU-2026-00021",
                        "category": "garbage",
                        "ward": "Ward 4",
                        "status": "in_progress",
                        "sla_deadline": "2026-11-25T09:00:00Z",
                        "assigned_officer_id": OFF_1,
                    },
                }
            ],
            1,
        )
        res_rem = self.client.get("/api/officer/reminders?kind=overdue")
        self.assertEqual(res_rem.status_code, 200)
        self.assertEqual(res_rem.json()["items"][0]["kind"], "overdue")
        # Confirm backend filtered strictly on officer's own profile & officer_id
        called_params = dict(mock_get.call_args.args[2])
        self.assertEqual(called_params["recipient_profile_id"], f"eq.{OFFICER_ACTOR.user_id}")
        self.assertEqual(called_params["recipient_officer_id"], f"eq.{OFF_1}")

        # Mark notification read: true -> 200, false -> 404
        mock_rpc.return_value = True
        res_read = self.client.post(f"/api/officer/notifications/{NID_1}/read")
        self.assertEqual(res_read.status_code, 200)
        self.assertEqual(res_read.json(), {"id": NID_1, "is_read": True})

        mock_rpc.return_value = False
        res_missing = self.client.post(f"/api/officer/notifications/{NID_1}/read")
        self.assertEqual(res_missing.status_code, 404)

    @patch("app.services.phase7_service._rest_rpc", new_callable=AsyncMock)
    def test_citizen_followup_returns_strict_boolean_only(self, mock_rpc):
        app.dependency_overrides[get_authenticated_actor] = lambda: CITIZEN_ACTOR

        mock_rpc.return_value = {"is_followed_up": True, "extra_ignored": "leak"}
        res = self.client.get(f"/api/citizen/complaints/{CID_1}/followup")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers.get("cache-control"), "no-store")
        self.assertEqual(res.json(), {"is_followed_up": True})
        self.assertEqual(set(res.json().keys()), {"is_followed_up"})

        mock_rpc.side_effect = HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Complaint not found or access denied.",
        )
        res_denied = self.client.get(f"/api/citizen/complaints/{CID_2}/followup")
        self.assertEqual(res_denied.status_code, 404)
