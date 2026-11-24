"""
ReportlyUrban — Phase 5 Mocked Integration Test Suite (Python)
Covers FastAPI HTTP endpoints, authentication guards, role validation, file handling, and Gemini mocking:
  1. /health endpoint behavior (zero secrets exposed).
  2. Missing, malformed, or invalid Bearer tokens (HTTP 401).
  3. Role-based access control: 'officer' and 'admin' rejected (HTTP 403).
  4. Role-based access control: 'citizen' authorized.
  5. File size limits: files > 5MB rejected (HTTP 413).
  6. File format validation: invalid magic bytes or corrupt images rejected (HTTP 422).
  7. Gemini Vision analysis: valid civic issue returned with structured schema (HTTP 200).
  8. Gemini Vision analysis: non-civic / low confidence returns suggestions=null (HTTP 200).
  9. Gemini timeout handling: returns HTTP 504 and refunds quota.
  10. Gemini service error handling: returns HTTP 502 and refunds quota.
  11. Daily quota exhaustion: returns HTTP 429.
"""

import io
import unittest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock, AsyncMock
from PIL import Image
from fastapi.testclient import TestClient

from app.main import app
from app.services.auth_service import get_citizen_user, verify_supabase_jwt
from app.services.quota_service import _local_usage_log
from app.config import settings


def create_synthetic_jpeg_bytes(width=100, height=100, color="gray") -> bytes:
    """Creates a minimal in-memory valid JPEG image for testing."""
    buf = io.BytesIO()
    img = Image.new("RGB", (width, height), color=color)
    img.save(buf, format="JPEG")
    return buf.getvalue()


class TestPhase5MockedEndpoints(unittest.TestCase):
    """Test suite testing FastAPI endpoints with mocked dependencies."""

    def setUp(self):
        self.client = TestClient(app)
        _local_usage_log.clear()

    def test_health_endpoint_exposes_no_secrets(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["service"], "reportly-ai-backend")
        self.assertIn("version", data)
        # Ensure zero credentials or keys are leaked in health payload
        self.assertNotIn("key", str(data).lower())
        self.assertNotIn("secret", str(data).lower())
        self.assertNotIn("token", str(data).lower())

    def test_unauthenticated_request_returns_401(self):
        jpeg_bytes = create_synthetic_jpeg_bytes()
        files = {"file": ("test.jpg", jpeg_bytes, "image/jpeg")}
        # Missing Authorization header
        res = self.client.post("/api/ai/analyze-issue", files=files)
        self.assertEqual(res.status_code, 401)
        self.assertIn("Authorization header is required", res.json()["detail"])

    def test_invalid_bearer_token_returns_401(self):
        jpeg_bytes = create_synthetic_jpeg_bytes()
        files = {"file": ("test.jpg", jpeg_bytes, "image/jpeg")}
        headers = {"Authorization": "Bearer invalid_gibberish_token_string"}
        res = self.client.post("/api/ai/analyze-issue", files=files, headers=headers)
        self.assertEqual(res.status_code, 401)

    @patch("app.services.auth_service.verify_supabase_jwt")
    @patch("httpx.AsyncClient.get")
    def test_officer_role_returns_403(self, mock_http_get, mock_verify_jwt):
        mock_verify_jwt.return_value = {"sub": "officer-uuid-1"}
        mock_res = MagicMock()
        mock_res.status_code = 200
        mock_res.json.return_value = [{"id": "officer-uuid-1", "role": "officer"}]
        mock_http_get.return_value = mock_res

        jpeg_bytes = create_synthetic_jpeg_bytes()
        files = {"file": ("test.jpg", jpeg_bytes, "image/jpeg")}
        headers = {"Authorization": "Bearer valid_officer_token"}
        res = self.client.post("/api/ai/analyze-issue", files=files, headers=headers)
        self.assertEqual(res.status_code, 403)
        self.assertIn("Role 'officer' cannot utilize citizen AI issue detection", res.json()["detail"])

    @patch("app.services.auth_service.verify_supabase_jwt")
    @patch("httpx.AsyncClient.get")
    def test_admin_role_returns_403(self, mock_http_get, mock_verify_jwt):
        mock_verify_jwt.return_value = {"sub": "admin-uuid-1"}
        mock_res = MagicMock()
        mock_res.status_code = 200
        mock_res.json.return_value = [{"id": "admin-uuid-1", "role": "admin"}]
        mock_http_get.return_value = mock_res

        jpeg_bytes = create_synthetic_jpeg_bytes()
        files = {"file": ("test.jpg", jpeg_bytes, "image/jpeg")}
        headers = {"Authorization": "Bearer valid_admin_token"}
        res = self.client.post("/api/ai/analyze-issue", files=files, headers=headers)
        self.assertEqual(res.status_code, 403)
        self.assertIn("Role 'admin' cannot utilize citizen AI issue detection", res.json()["detail"])

    def test_oversized_file_rejected_with_413(self):
        # Override dependency to mock authenticated citizen
        app.dependency_overrides[get_citizen_user] = lambda: "citizen-uuid-mock"

        try:
            # Create synthetic payload exceeding 5 MB
            oversized_bytes = b'\xff\xd8\xff\xe0' + (b'0' * (5 * 1024 * 1024 + 100))
            files = {"file": ("large.jpg", oversized_bytes, "image/jpeg")}
            res = self.client.post("/api/ai/analyze-issue", files=files)
            self.assertEqual(res.status_code, 413)
            self.assertIn("exceeds maximum allowable limit", res.json()["detail"])
        finally:
            app.dependency_overrides.pop(get_citizen_user, None)

    def test_invalid_magic_bytes_rejected_with_422(self):
        app.dependency_overrides[get_citizen_user] = lambda: "citizen-uuid-mock"

        try:
            # File labeled as image/jpeg but actually plain text
            corrupt_bytes = b"This is not a real photograph header at all."
            files = {"file": ("fake.jpg", corrupt_bytes, "image/jpeg")}
            res = self.client.post("/api/ai/analyze-issue", files=files)
            self.assertEqual(res.status_code, 422)
            self.assertIn("Unsupported image format", res.json()["detail"])
        finally:
            app.dependency_overrides.pop(get_citizen_user, None)

    @patch("app.routers.ai.analyze_civic_image")
    def test_successful_civic_analysis_flow(self, mock_analyze):
        app.dependency_overrides[get_citizen_user] = lambda: "citizen-uuid-mock"

        from app.schemas.ai import AIAnalysisResponse, CivicSuggestions
        mock_analyze.return_value = AIAnalysisResponse(
            is_civic_issue=True,
            confidence=0.91,
            suggestions=CivicSuggestions(
                category="potholes",
                title="Deep asphalt pothole near bus terminal",
                description="Severe road crater approximately 40cm wide causing vehicles to swerve abruptly.",
                confidence=0.91,
                detected_issue="Damaged road pavement"
            ),
            uncertainty_reason=None
        )

        try:
            jpeg_bytes = create_synthetic_jpeg_bytes()
            files = {"file": ("pothole.jpg", jpeg_bytes, "image/jpeg")}
            res = self.client.post("/api/ai/analyze-issue", files=files)
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data["is_civic_issue"])
            self.assertIsNotNone(data["suggestions"])
            self.assertEqual(data["suggestions"]["category"], "potholes")
            self.assertEqual(data["suggestions"]["title"], "Deep asphalt pothole near bus terminal")
            self.assertAlmostEqual(data["confidence"], 0.91)
            self.assertIsNotNone(data["quota_remaining"])
            # Ensure reservation finalized to 'succeeded'
            self.assertEqual(_local_usage_log[0]["status"], "succeeded")
        finally:
            app.dependency_overrides.pop(get_citizen_user, None)

    @patch("app.routers.ai.analyze_civic_image")
    def test_non_civic_image_returns_suggestions_null(self, mock_analyze):
        app.dependency_overrides[get_citizen_user] = lambda: "citizen-uuid-mock"

        from app.schemas.ai import AIAnalysisResponse
        mock_analyze.return_value = AIAnalysisResponse(
            is_civic_issue=False,
            confidence=0.08,
            suggestions=None,
            uncertainty_reason="The photograph depicts an indoor domestic pet, not public municipal infrastructure."
        )

        try:
            jpeg_bytes = create_synthetic_jpeg_bytes()
            files = {"file": ("pet.jpg", jpeg_bytes, "image/jpeg")}
            res = self.client.post("/api/ai/analyze-issue", files=files)
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertFalse(data["is_civic_issue"])
            self.assertIsNone(data["suggestions"])
            self.assertIn("indoor", data["uncertainty_reason"].lower())
            # Even non-civic successful calls consume 1 quota analysis
            self.assertEqual(_local_usage_log[0]["status"], "succeeded")
        finally:
            app.dependency_overrides.pop(get_citizen_user, None)

    @patch("app.routers.ai.analyze_civic_image")
    def test_gemini_timeout_returns_504_and_refunds_quota(self, mock_analyze):
        app.dependency_overrides[get_citizen_user] = lambda: "citizen-uuid-mock"

        import asyncio
        async def mock_timeout(*args, **kwargs):
            raise asyncio.TimeoutError()

        mock_analyze.side_effect = mock_timeout

        try:
            jpeg_bytes = create_synthetic_jpeg_bytes()
            files = {"file": ("timeout.jpg", jpeg_bytes, "image/jpeg")}
            res = self.client.post("/api/ai/analyze-issue", files=files)
            self.assertEqual(res.status_code, 504)
            self.assertIn("timed out", res.json()["detail"])
            # Quota must be safely refunded!
            self.assertEqual(_local_usage_log[0]["status"], "refunded")
        finally:
            app.dependency_overrides.pop(get_citizen_user, None)

    @patch("app.routers.ai.analyze_civic_image")
    def test_gemini_api_error_returns_502_and_refunds_quota(self, mock_analyze):
        app.dependency_overrides[get_citizen_user] = lambda: "citizen-uuid-mock"

        mock_analyze.side_effect = RuntimeError("Google Gemini 503 Overloaded")

        try:
            jpeg_bytes = create_synthetic_jpeg_bytes()
            files = {"file": ("error.jpg", jpeg_bytes, "image/jpeg")}
            res = self.client.post("/api/ai/analyze-issue", files=files)
            self.assertEqual(res.status_code, 502)
            self.assertIn("AI vision service encountered a processing error", res.json()["detail"])
            # Quota must be safely refunded!
            self.assertEqual(_local_usage_log[0]["status"], "refunded")
        finally:
            app.dependency_overrides.pop(get_citizen_user, None)

    def test_quota_exhaustion_returns_429(self):
        citizen_id = "quota-exhausted-user"
        app.dependency_overrides[get_citizen_user] = lambda: citizen_id

        # Pre-fill usage log to reach maximum
        for i in range(settings.USER_DAILY_AI_LIMIT):
            _local_usage_log.append({
                "id": f"res-{i}",
                "citizen_id": citizen_id,
                "status": "succeeded",
                "timestamp": datetime.now(timezone.utc)
            })

        try:
            jpeg_bytes = create_synthetic_jpeg_bytes()
            files = {"file": ("quota_test.jpg", jpeg_bytes, "image/jpeg")}
            res = self.client.post("/api/ai/analyze-issue", files=files)
            self.assertEqual(res.status_code, 429)
            self.assertIn("Daily AI analysis quota reached", res.json()["detail"])
        finally:
            app.dependency_overrides.pop(get_citizen_user, None)


if __name__ == "__main__":
    unittest.main()
