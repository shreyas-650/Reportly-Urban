"""
Backend unit & mocked integration tests for Officer Assigned Complaints list
and Officer Complaint Detail signed photo URLs.
"""

import unittest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from app.main import app
from app.services.auth_service import AuthenticatedActor, get_authenticated_actor

CID_1 = "11111111-1111-4111-8111-111111111111"
CID_2 = "22222222-2222-4222-8222-222222222222"
DEPT_1 = "44444444-4444-4444-8444-444444444444"
OFF_1 = "55555555-5555-4555-8555-555555555555"
OFF_2 = "66666666-6666-4666-8666-666666666666"

OFFICER_1 = AuthenticatedActor(
    user_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    role="officer",
    token="tok-officer-1",
    officer_id=OFF_1,
    department_id=DEPT_1,
)
INACTIVE_OFFICER = AuthenticatedActor(
    user_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    role="officer",
    token="tok-inactive",
    officer_id=None,
    department_id=None,
)
CITIZEN_ACTOR = AuthenticatedActor(
    user_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    role="citizen",
    token="tok-citizen",
)
ADMIN_ACTOR = AuthenticatedActor(
    user_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role="admin",
    token="tok-admin",
)


class OfficerComplaintsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        app.dependency_overrides.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_unauthenticated_returns_401(self):
        res = self.client.get("/api/officer/complaints")
        self.assertEqual(res.status_code, 401)

    def test_wrong_roles_return_403(self):
        for actor in (CITIZEN_ACTOR, ADMIN_ACTOR, INACTIVE_OFFICER):
            app.dependency_overrides[get_authenticated_actor] = lambda a=actor: a
            res = self.client.get("/api/officer/complaints")
            self.assertEqual(res.status_code, 403)

    @patch("app.services.phase7_service._create_signed_complaint_image_url", new_callable=AsyncMock)
    @patch("app.services.phase7_service._rest_get", new_callable=AsyncMock)
    def test_list_returns_only_assigned_officer_complaints_without_pii(self, mock_get, mock_sign):
        app.dependency_overrides[get_authenticated_actor] = lambda: OFFICER_1
        mock_sign.return_value = "https://signed.example/thumb.jpg?token=abc"
        mock_get.return_value = (
            [
                {
                    "id": CID_1,
                    "complaint_number": "RU-2026-00101",
                    "title": "Deep pothole",
                    "category": "potholes",
                    "ward": "Ward 5",
                    "status": "in_progress",
                    "priority": "high",
                    "sla_deadline": "2026-11-28T12:00:00Z",
                    "created_at": "2026-11-25T08:00:00Z",
                    "assigned_officer_id": OFF_1,
                    "image_url": "cit-1/pothole.jpg",
                    "citizen_id": "secret-cit-id",
                    "citizen": {"full_name": "Secret Name", "phone_number": "9876543210"},
                },
                {
                    "id": CID_2,
                    "complaint_number": "RU-2026-00102",
                    "title": "Other officer issue",
                    "category": "garbage",
                    "ward": "Ward 9",
                    "status": "submitted",
                    "priority": "normal",
                    "sla_deadline": None,
                    "created_at": "2026-11-25T09:00:00Z",
                    "assigned_officer_id": OFF_2,
                    "image_url": "cit-2/other.jpg",
                },
            ],
            1,
        )

        res = self.client.get("/api/officer/complaints?status=in_progress")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers.get("cache-control"), "no-store")
        body = res.json()
        self.assertEqual(body["page"], 1)
        self.assertEqual(body["page_size"], 20)
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["id"], CID_1)
        self.assertEqual(body["items"][0]["complaint_reference"], "RU-2026-00101")
        self.assertEqual(body["items"][0]["thumbnail_url"], "https://signed.example/thumb.jpg?token=abc")

        text = res.text
        self.assertNotIn("secret-cit-id", text)
        self.assertNotIn("Secret Name", text)
        self.assertNotIn("9876543210", text)
        self.assertNotIn("cit-1/pothole.jpg", text)
        self.assertNotIn("RU-2026-00102", text)

    def test_list_pagination_and_status_validation(self):
        app.dependency_overrides[get_authenticated_actor] = lambda: OFFICER_1

        self.assertEqual(self.client.get("/api/officer/complaints?page=0").status_code, 400)
        self.assertEqual(self.client.get("/api/officer/complaints?page_size=0").status_code, 400)
        self.assertEqual(self.client.get("/api/officer/complaints?page_size=101").status_code, 400)
        self.assertEqual(self.client.get("/api/officer/complaints?status=invalid_status").status_code, 400)
        self.assertEqual(self.client.get("/api/officer/complaints?unknown=1").status_code, 400)

    @patch("app.services.phase7_service._create_signed_complaint_image_url", new_callable=AsyncMock)
    @patch("app.services.phase7_service._rest_get", new_callable=AsyncMock)
    def test_detail_returns_signed_photos_only_for_assigned_officer(self, mock_get, mock_sign):
        app.dependency_overrides[get_authenticated_actor] = lambda: OFFICER_1
        mock_sign.side_effect = [
            "https://signed.example/problem.jpg?token=1",
            "https://signed.example/completion.jpg?token=2",
        ]
        mock_get.side_effect = [
            (
                [
                    {
                        "id": CID_1,
                        "complaint_number": "RU-2026-00101",
                        "title": "Deep pothole",
                        "category": "potholes",
                        "description": "Large pothole on main road.",
                        "location": "Main Road",
                        "ward": "Ward 5",
                        "latitude": 12.97,
                        "longitude": 77.59,
                        "status": "resolved",
                        "priority": "high",
                        "department_id": DEPT_1,
                        "assigned_officer_id": OFF_1,
                        "sla_deadline": "2026-11-28T12:00:00Z",
                        "created_at": "2026-11-25T08:00:00Z",
                        "updated_at": "2026-11-25T10:00:00Z",
                        "image_url": "cit-1/pothole.jpg",
                        "completion_image_url": "resolution/off-1/done.jpg",
                        "departments": {"id": DEPT_1, "name": "Roads"},
                        "complaint_sla_state": {"current_level": 0, "overdue_marked_at": None},
                    }
                ],
                1,
            ),
            ([], 0),
            ([], 0),
        ]

        res = self.client.get(f"/api/officer/complaints/{CID_1}")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["signed_image_url"], "https://signed.example/problem.jpg?token=1")
        self.assertEqual(data["signed_completion_url"], "https://signed.example/completion.jpg?token=2")
        self.assertNotIn("cit-1/pothole.jpg", res.text)
        self.assertNotIn("resolution/off-1/done.jpg", res.text)

        # Another officer's complaint must return 404 and never call _create_signed_complaint_image_url
        mock_sign.reset_mock()
        mock_get.side_effect = [
            (
                [
                    {
                        "id": CID_2,
                        "assigned_officer_id": OFF_2,
                        "image_url": "cit-2/secret.jpg",
                    }
                ],
                1,
            )
        ]
        res_other = self.client.get(f"/api/officer/complaints/{CID_2}")
        self.assertEqual(res_other.status_code, 404)
        mock_sign.assert_not_called()
