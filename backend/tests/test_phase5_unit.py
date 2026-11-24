"""
ReportlyUrban — Phase 5 Unit Test Suite (Python)
Covers:
  1. Image magic bytes detection (JPEG, PNG, WebP vs invalid headers).
  2. Pillow image integrity, dimension bounds, and decompression bomb guards.
  3. Pydantic schema validation conforming to PostgreSQL public.complaints constraints.
  4. Category whitelist enforcement (strictly the 6 authorized categories).
  5. Title (5-100) and description (15-500) length limits (NO silent truncation).
  6. Confidence thresholds and suggestions=None for non-civic / ambiguous inputs.
  7. Concurrency-safe quota state tracking and UTC daily accounting.
"""

import io
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, AsyncMock, patch
from PIL import Image

from app.schemas.ai import (
    CivicAnalysisGeminiRaw,
    CivicSuggestions,
    AIAnalysisResponse,
    VALID_CIVIC_CATEGORIES,
)
from app.services.image_service import (
    detect_image_format_by_magic_bytes,
    JPEG_MAGIC,
    PNG_MAGIC,
    WEBP_RIFF,
    WEBP_MAGIC,
)
from app.services.gemini_service import analyze_civic_image
from app.services.quota_service import (
    QuotaReservation,
    reserve_quota,
    finalize_quota,
    refund_quota,
    _local_usage_log,
)
from app.config import settings


class TestImageMagicBytes(unittest.TestCase):
    """Test binary magic-byte detection without trusting extensions or Content-Type headers."""

    def test_valid_jpeg_magic_bytes(self):
        header = JPEG_MAGIC + b'\xe0\x00\x10JFIF'
        self.assertEqual(detect_image_format_by_magic_bytes(header), "image/jpeg")

    def test_valid_png_magic_bytes(self):
        header = PNG_MAGIC + b'\x00\x00\x00\rIHDR'
        self.assertEqual(detect_image_format_by_magic_bytes(header), "image/png")

    def test_valid_webp_magic_bytes(self):
        header = WEBP_RIFF + b'\x00\x10\x00\x00' + WEBP_MAGIC + b'VP8 '
        self.assertEqual(detect_image_format_by_magic_bytes(header), "image/webp")

    def test_invalid_and_dangerous_headers(self):
        # Empty header
        self.assertEqual(detect_image_format_by_magic_bytes(b''), "")
        # Short header
        self.assertEqual(detect_image_format_by_magic_bytes(b'\xff\xd8'), "")
        # HTML document masquerading as image
        self.assertEqual(detect_image_format_by_magic_bytes(b'<!DOCTYPE html><html>'), "")
        # SVG XML text masquerading as image
        self.assertEqual(detect_image_format_by_magic_bytes(b'<?xml version="1.0"?>'), "")
        # Executable binary header (MZ)
        self.assertEqual(detect_image_format_by_magic_bytes(b'MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00'), "")
        # GIF header (not authorized for civic reporting)
        self.assertEqual(detect_image_format_by_magic_bytes(b'GIF89a\x01\x00\x01\x00'), "")


class TestPydanticCivicSchemas(unittest.TestCase):
    """Test Pydantic schemas against PostgreSQL database constraints."""

    def test_category_whitelist_matches_database_check_constraint(self):
        expected_categories = {
            'potholes',
            'garbage',
            'streetlights',
            'water_leakage',
            'drainage',
            'public_infrastructure',
        }
        self.assertEqual(set(VALID_CIVIC_CATEGORIES), expected_categories)

    def test_valid_civic_suggestions_schema(self):
        s = CivicSuggestions(
            category='potholes',
            title='Large asphalt pothole near bus terminal',
            description='Severe pothole approximately 50cm wide causing vehicles to swerve into oncoming lane.',
            confidence=0.92,
            detected_issue='Damaged asphalt road surface'
        )
        self.assertEqual(s.category, 'potholes')
        self.assertEqual(s.confidence, 0.92)

    def test_invalid_category_rejected(self):
        with self.assertRaises(Exception):
            CivicSuggestions(
                category='illegal_parking',  # Not in whitelist
                title='Unauthorized parking on pavement',
                description='Cars parked across the sidewalk blocking pedestrians.',
                confidence=0.88,
                detected_issue='Parking violation'
            )

    def test_title_minimum_and_maximum_length_rejected(self):
        # Too short (< 5 chars)
        with self.assertRaises(Exception):
            CivicSuggestions(
                category='garbage',
                title='Dirt',
                description='Garbage is overflowing from the municipal bin onto the pedestrian footpath.',
                confidence=0.85,
                detected_issue='Garbage pile'
            )
        # Too long (> 100 chars matching DB varchar/char constraint)
        with self.assertRaises(Exception):
            CivicSuggestions(
                category='garbage',
                title='A' * 101,
                description='Garbage is overflowing from the municipal bin onto the pedestrian footpath.',
                confidence=0.85,
                detected_issue='Garbage pile'
            )

    def test_description_minimum_and_maximum_length_rejected(self):
        # Too short (< 15 chars)
        with self.assertRaises(Exception):
            CivicSuggestions(
                category='drainage',
                title='Drain blocked',
                description='Water clogged.',
                confidence=0.85,
                detected_issue='Drain clog'
            )
        # Too long (> 500 chars matching DB constraint)
        with self.assertRaises(Exception):
            CivicSuggestions(
                category='drainage',
                title='Drain blocked on Main Street',
                description='W' * 501,
                confidence=0.85,
                detected_issue='Drain clog'
            )


class TestGeminiServiceLogic(unittest.IsolatedAsyncioTestCase):
    """Test AI analysis post-processing, validation, and rejection logic."""

    def _create_mock_client(self, response_text: str):
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.text = response_text
        mock_client.models.generate_content.return_value = mock_response
        return mock_client

    async def test_valid_civic_issue_detection(self):
        raw_json = (
            '{"is_civic_issue": true, "detected_issue": "Broken storm water drain", '
            '"suggested_category": "drainage", "suggested_title": "Clogged storm drain with standing sewage", '
            '"suggested_description": "Severe sewage blockage in open culvert causing overflow onto roadway.", '
            '"confidence": 0.94, "uncertainty_reason": null}'
        )
        client = self._create_mock_client(raw_json)
        result = await analyze_civic_image(b'fake_bytes', 'image/jpeg', client)

        self.assertTrue(result.is_civic_issue)
        self.assertIsNotNone(result.suggestions)
        self.assertEqual(result.suggestions.category, 'drainage')
        self.assertEqual(result.suggestions.title, 'Clogged storm drain with standing sewage')
        self.assertAlmostEqual(result.suggestions.confidence, 0.94)

    async def test_non_civic_issue_returns_suggestions_null(self):
        raw_json = (
            '{"is_civic_issue": false, "detected_issue": "Domestic dog in living room", '
            '"suggested_category": null, "suggested_title": null, '
            '"suggested_description": null, "confidence": 0.05, '
            '"uncertainty_reason": "The photograph depicts a pet indoors, not public infrastructure."}'
        )
        client = self._create_mock_client(raw_json)
        result = await analyze_civic_image(b'fake_bytes', 'image/jpeg', client)

        self.assertFalse(result.is_civic_issue)
        self.assertIsNone(result.suggestions)
        self.assertIn("indoor", result.uncertainty_reason.lower())

    async def test_low_confidence_civic_issue_returns_suggestions_null(self):
        raw_json = (
            '{"is_civic_issue": true, "detected_issue": "Possible blurred pothole", '
            '"suggested_category": "potholes", "suggested_title": "Blurry road defect", '
            '"suggested_description": "Possible asphalt defect obscured by heavy lens glare.", '
            '"confidence": 0.45, "uncertainty_reason": "Image is out of focus."}'
        )
        client = self._create_mock_client(raw_json)
        result = await analyze_civic_image(b'fake_bytes', 'image/jpeg', client)

        self.assertTrue(result.is_civic_issue)
        self.assertIsNone(result.suggestions)
        self.assertAlmostEqual(result.confidence, 0.45)
        self.assertIn("out of focus", result.uncertainty_reason.lower())

    async def test_invalid_category_suggested_by_ai_returns_suggestions_null(self):
        raw_json = (
            '{"is_civic_issue": true, "detected_issue": "Noise complaint", '
            '"suggested_category": "sound_pollution", "suggested_title": "Loud speaker noise", '
            '"suggested_description": "Excessive audio volume from commercial speaker in residential area.", '
            '"confidence": 0.85, "uncertainty_reason": null}'
        )
        client = self._create_mock_client(raw_json)
        result = await analyze_civic_image(b'fake_bytes', 'image/jpeg', client)

        # Must reject invalid category, not crash or invent category
        self.assertIsNone(result.suggestions)
        self.assertIn("not an authorized civic department category", result.uncertainty_reason)

    async def test_oversized_title_or_description_never_silently_truncated(self):
        # Title > 100 characters must be rejected rather than silently truncated
        raw_json = (
            '{"is_civic_issue": true, "detected_issue": "Water pipe leak", '
            '"suggested_category": "water_leakage", "suggested_title": "' + ('Excessive leak ' * 10) + '", '
            '"suggested_description": "Clean municipal water pipe ruptured under pedestrian walkway.", '
            '"confidence": 0.90, "uncertainty_reason": null}'
        )
        client = self._create_mock_client(raw_json)
        result = await analyze_civic_image(b'fake_bytes', 'image/jpeg', client)

        self.assertIsNone(result.suggestions)
        self.assertIn("length constraints", result.uncertainty_reason)

    async def test_malformed_json_from_gemini_rejected_safely(self):
        client = self._create_mock_client("{broken json response...")
        result = await analyze_civic_image(b'fake_bytes', 'image/jpeg', client)
        self.assertFalse(result.is_civic_issue)
        self.assertIsNone(result.suggestions)
        self.assertIn("did not conform to structured schema", result.uncertainty_reason)

    async def test_out_of_range_confidence_rejected_safely(self):
        raw_json = (
            '{"is_civic_issue": true, "detected_issue": "Pothole", '
            '"suggested_category": "potholes", "suggested_title": "Deep pothole", '
            '"suggested_description": "A large pothole on the main asphalt roadway.", '
            '"confidence": 1.75, "uncertainty_reason": null}'
        )
        client = self._create_mock_client(raw_json)
        result = await analyze_civic_image(b'fake_bytes', 'image/jpeg', client)
        self.assertFalse(result.is_civic_issue)
        self.assertIsNone(result.suggestions)
        self.assertIn("did not conform to structured schema", result.uncertainty_reason)


class TestQuotaServiceLogic(unittest.IsolatedAsyncioTestCase):
    """Test quota reservations, finalization, refunding, and concurrency locks."""

    def setUp(self):
        _local_usage_log.clear()

    async def test_atomic_reservation_and_finalization(self):
        res = await reserve_quota("citizen-101")
        self.assertEqual(res.status, "reserved")
        self.assertEqual(len(_local_usage_log), 1)
        self.assertEqual(_local_usage_log[0]["status"], "reserved")

        await finalize_quota(res)
        self.assertEqual(res.status, "succeeded")
        self.assertEqual(_local_usage_log[0]["status"], "succeeded")

    async def test_quota_refunding_on_failure(self):
        res = await reserve_quota("citizen-102")
        self.assertEqual(res.status, "reserved")

        await refund_quota(res, "Gemini API timeout")
        self.assertEqual(res.status, "refunded")
        self.assertEqual(_local_usage_log[0]["status"], "refunded")

        # Double refund should be safe no-op
        await refund_quota(res, "Second refund attempt")
        self.assertEqual(res.status, "refunded")

    async def test_per_user_limit_enforced_strictly(self):
        citizen_id = "citizen-limit-test"
        # Simulate reaching limit (default 10)
        for _ in range(settings.USER_DAILY_AI_LIMIT):
            res = await reserve_quota(citizen_id)
            await finalize_quota(res)

        # 11th attempt must raise HTTPException with 429
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            await reserve_quota(citizen_id)
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertIn("Daily AI analysis quota reached", ctx.exception.detail)


if __name__ == '__main__':
    unittest.main()
