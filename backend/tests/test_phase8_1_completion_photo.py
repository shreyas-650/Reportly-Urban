"""
ReportlyUrban — Phase 8.1 Unit & Mocked Integration Tests
Covers image security, EXIF/GPS stripping with orientation preservation,
registration retry recovery, role/assignment rechecks, concurrency/terminal guards,
401/403 endpoint enforcement, and migration/rollback static integrity.
"""

import asyncio
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from PIL.TiffImagePlugin import IFDRational

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.main import app  # noqa: E402
from app.services.auth_service import AuthenticatedActor, get_authenticated_actor  # noqa: E402
from app.services.image_service import (  # noqa: E402
    MAX_RESOLUTION_IMAGE_SIZE_BYTES,
    validate_and_strip_resolution_bytes,
    verify_already_stripped_resolution_bytes,
)

REPO_ROOT = Path(BACKEND_DIR).parent
COMPLAINT_ID = "11111111-1111-4111-8111-111111111111"
OTHER_COMPLAINT_ID = "22222222-2222-4222-8222-222222222222"
EVIDENCE_PATH = f"resolution/{COMPLAINT_ID}/33333333-3333-4333-8333-333333333333.jpg"
OTHER_EVIDENCE_PATH = f"resolution/{OTHER_COMPLAINT_ID}/44444444-4444-4444-8444-444444444444.jpg"


def _make_actor(role: str, *, officer_id: str | None = None, user_id: str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") -> AuthenticatedActor:
    return AuthenticatedActor(
        user_id=user_id,
        role=role,
        token=f"mock-{role}-jwt",
        officer_id=officer_id,
        department_id="dddddddd-dddd-4ddd-8ddd-dddddddddddd" if role == "officer" else None,
    )


def _create_jpeg_bytes(width: int = 80, height: int = 60, *, with_exif_gps: bool = False) -> bytes:
    img = Image.new("RGB", (width, height), color=(30, 120, 210))
    if with_exif_gps:
        for x in range(min(20, width)):
            for y in range(min(15, height)):
                img.putpixel((x, y), (255, 0, 0))
        exif = img.getexif()
        exif[271] = "CivicCam"
        exif[272] = "GPS-900"
        exif[274] = 6  # Rotate 90 CW -> expected display size (height, width)
        exif[306] = "2026:11:25 14:22:10"
        exif[0x8825] = {
            1: "N",
            2: (IFDRational(19, 1), IFDRational(4, 1), IFDRational(3360, 100)),
            3: "E",
            4: (IFDRational(72, 1), IFDRational(52, 1), IFDRational(3864, 100)),
        }
        buf = io.BytesIO()
        img.save(buf, format="JPEG", exif=exif.tobytes(), quality=92)
        return buf.getvalue()

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _create_png_with_text_and_exif() -> bytes:
    img = Image.new("RGBA", (64, 48), color=(10, 180, 90, 255))
    pnginfo = PngImagePlugin.PngInfo()
    pnginfo.add_text("Comment", "Secret GPS location text")
    exif = img.getexif()
    exif[271] = "PhoneMaker"
    buf = io.BytesIO()
    img.save(buf, format="PNG", pnginfo=pnginfo, exif=exif.tobytes())
    return buf.getvalue()


def _create_webp_with_exif() -> bytes:
    img = Image.new("RGB", (60, 40), color=(90, 60, 200))
    exif = img.getexif()
    exif[271] = "WebpCam"
    exif[0x8825] = {1: "S", 2: (IFDRational(33, 1), IFDRational(51, 1), IFDRational(0, 1))}
    buf = io.BytesIO()
    img.save(buf, format="WEBP", exif=exif.tobytes(), quality=88)
    return buf.getvalue()


def _mock_response(status_code: int, json_body=None, content: bytes = b"") -> MagicMock:
    res = MagicMock(spec=httpx.Response)
    res.status_code = status_code
    res.content = content
    res.json.return_value = json_body
    return res


class Phase81ImageSecurityAndStrippingTests(unittest.TestCase):
    """Tests signature validation, MIME/extension checks, bomb guards, and EXIF/GPS stripping."""

    def test_strips_exif_and_gps_from_temp_sample_while_preserving_orientation(self):
        raw_bytes = _create_jpeg_bytes(120, 80, with_exif_gps=True)
        with tempfile.TemporaryDirectory() as tmpdir:
            sample_path = os.path.join(tmpdir, "sample_exif_gps.jpg")
            with open(sample_path, "wb") as fh:
                fh.write(raw_bytes)
            with open(sample_path, "rb") as fh:
                loaded_bytes = fh.read()

        result = validate_and_strip_resolution_bytes(
            loaded_bytes, client_content_type="image/jpeg", filename="completion.jpg"
        )
        self.assertTrue(result.had_metadata)
        self.assertEqual(result.mime_type, "image/jpeg")
        # Original 120x80 with EXIF Orientation=6 must become 80x120
        self.assertEqual((result.width, result.height), (80, 120))

        with Image.open(io.BytesIO(result.image_bytes)) as clean:
            clean.load()
            self.assertEqual(clean.size, (80, 120))
            exif = clean.getexif()
            self.assertEqual(len(exif), 0)
            self.assertEqual(len(exif.get_ifd(0x8825)), 0)
            # Original top-left red block rotates to top-right
            self.assertGreater(clean.getpixel((70, 10))[0], 200)

        verified = verify_already_stripped_resolution_bytes(result.image_bytes)
        self.assertEqual((verified.width, verified.height), (80, 120))

    def test_strips_png_text_exif_and_webp_exif_gps(self):
        png_res = validate_and_strip_resolution_bytes(
            _create_png_with_text_and_exif(), client_content_type="image/png", filename="proof.png"
        )
        with Image.open(io.BytesIO(png_res.image_bytes)) as clean_png:
            clean_png.load()
            self.assertEqual(len(clean_png.getexif()), 0)
            self.assertEqual(clean_png.text, {})

        webp_res = validate_and_strip_resolution_bytes(
            _create_webp_with_exif(), client_content_type="image/webp", filename="proof.webp"
        )
        with Image.open(io.BytesIO(webp_res.image_bytes)) as clean_webp:
            clean_webp.load()
            self.assertEqual(len(clean_webp.getexif()), 0)
            self.assertEqual(len(clean_webp.getexif().get_ifd(0x8825)), 0)

    def test_rejects_mime_spoofing_svg_corrupt_wrong_type_and_excessive_dimensions(self):
        jpeg = _create_jpeg_bytes()

        # MIME mismatch: JPEG bytes declared as image/png
        with self.assertRaises(Exception) as cm_mime:
            validate_and_strip_resolution_bytes(jpeg, client_content_type="image/png", filename="fake.jpg")
        self.assertEqual(cm_mime.exception.status_code, 422)

        # Extension mismatch: JPEG bytes with .png extension
        with self.assertRaises(Exception) as cm_ext:
            validate_and_strip_resolution_bytes(jpeg, client_content_type="image/jpeg", filename="fake.png")
        self.assertEqual(cm_ext.exception.status_code, 422)

        # SVG disguised as .jpg
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        with self.assertRaises(Exception) as cm_svg:
            validate_and_strip_resolution_bytes(svg, client_content_type="image/jpeg", filename="xss.jpg")
        self.assertEqual(cm_svg.exception.status_code, 422)

        # Wrong type (GIF)
        gif = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
        with self.assertRaises(Exception) as cm_gif:
            validate_and_strip_resolution_bytes(gif, client_content_type="image/gif", filename="anim.gif")
        self.assertEqual(cm_gif.exception.status_code, 422)

        # Corrupt / truncated JPEG
        corrupt = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00BROKEN_BODY"
        with self.assertRaises(Exception) as cm_corrupt:
            validate_and_strip_resolution_bytes(corrupt, client_content_type="image/jpeg", filename="bad.jpg")
        self.assertEqual(cm_corrupt.exception.status_code, 422)

        # Excessive dimensions (exceeds MAX_RESOLUTION_IMAGE_DIMENSION = 8192)
        wide = _create_jpeg_bytes(8200, 10)
        with self.assertRaises(Exception) as cm_wide:
            validate_and_strip_resolution_bytes(wide, client_content_type="image/jpeg", filename="wide.jpg")
        self.assertEqual(cm_wide.exception.status_code, 422)

        # Oversized file (> 8 MB)
        oversized = b"\xff\xd8\xff\xe0" + (b"\x00" * (MAX_RESOLUTION_IMAGE_SIZE_BYTES + 10))
        with self.assertRaises(Exception) as cm_size:
            validate_and_strip_resolution_bytes(oversized, client_content_type="image/jpeg", filename="big.jpg")
        self.assertEqual(cm_size.exception.status_code, 413)

        # Unstripped image rejected if submitted straight to register verification
        unstripped = _create_jpeg_bytes(40, 30, with_exif_gps=True)
        with self.assertRaises(Exception) as cm_unstripped:
            verify_already_stripped_resolution_bytes(unstripped)
        self.assertEqual(cm_unstripped.exception.status_code, 422)


class Phase81EndpointsAndAuthorizationTests(unittest.TestCase):
    """Tests 401/403 guards, upload/registration/resolve workflow, assignment revocation, and error safety."""

    def setUp(self):
        self.client = TestClient(app)
        app.dependency_overrides.clear()

    def tearDown(self):
        app.dependency_overrides.clear()

    def test_unauthenticated_returns_401_on_all_phase8_1_endpoints(self):
        jpeg = _create_jpeg_bytes()
        endpoints = [
            ("POST", f"/api/officer/complaints/{COMPLAINT_ID}/resolution-photo", {"files": {"file": ("p.jpg", jpeg, "image/jpeg")}}),
            ("POST", f"/api/officer/complaints/{COMPLAINT_ID}/resolution-photo/register", {"json": {"storage_path": EVIDENCE_PATH}}),
            ("POST", f"/api/officer/complaints/{COMPLAINT_ID}/resolve", {"json": {"expected_updated_at": "2026-11-25T10:00:00Z", "public_description": "Repaired surface cleanly.", "resolution_image_path": EVIDENCE_PATH}}),
            ("POST", f"/api/admin/complaints/{COMPLAINT_ID}/resolution-photo", {"files": {"file": ("p.jpg", jpeg, "image/jpeg")}}),
            ("POST", f"/api/admin/complaints/{COMPLAINT_ID}/resolution-photo/register", {"json": {"storage_path": EVIDENCE_PATH}}),
            ("POST", f"/api/admin/complaints/{COMPLAINT_ID}/resolve", {"json": {"expected_updated_at": "2026-11-25T10:00:00Z", "public_description": "Repaired surface cleanly.", "resolution_image_path": EVIDENCE_PATH}}),
        ]
        for method, path, kwargs in endpoints:
            res = self.client.request(method, path, **kwargs)
            self.assertEqual(res.status_code, 401, f"Expected 401 on {path}")

    def test_role_enforcement_returns_403_on_all_phase8_1_endpoints(self):
        jpeg = _create_jpeg_bytes()
        citizen = _make_actor("citizen")
        inactive_officer = _make_actor("officer", officer_id=None)
        active_officer = _make_actor("officer", officer_id="off-1")
        admin = _make_actor("admin")

        try:
            # Citizen & inactive officer & admin denied on officer routes
            for actor in (citizen, inactive_officer, admin):
                app.dependency_overrides[get_authenticated_actor] = lambda a=actor: a
                r1 = self.client.post(f"/api/officer/complaints/{COMPLAINT_ID}/resolution-photo", files={"file": ("p.jpg", jpeg, "image/jpeg")})
                r2 = self.client.post(f"/api/officer/complaints/{COMPLAINT_ID}/resolution-photo/register", json={"storage_path": EVIDENCE_PATH})
                r3 = self.client.post(f"/api/officer/complaints/{COMPLAINT_ID}/resolve", json={"expected_updated_at": "2026-11-25T10:00:00Z", "public_description": "Completed repair work.", "resolution_image_path": EVIDENCE_PATH})
                self.assertEqual(r1.status_code, 403)
                self.assertEqual(r2.status_code, 403)
                self.assertEqual(r3.status_code, 403)

            # Citizen & officer denied on admin routes
            for actor in (citizen, active_officer):
                app.dependency_overrides[get_authenticated_actor] = lambda a=actor: a
                r1 = self.client.post(f"/api/admin/complaints/{COMPLAINT_ID}/resolution-photo", files={"file": ("p.jpg", jpeg, "image/jpeg")})
                r2 = self.client.post(f"/api/admin/complaints/{COMPLAINT_ID}/resolution-photo/register", json={"storage_path": EVIDENCE_PATH})
                r3 = self.client.post(f"/api/admin/complaints/{COMPLAINT_ID}/resolve", json={"expected_updated_at": "2026-11-25T10:00:00Z", "public_description": "Completed repair work.", "resolution_image_path": EVIDENCE_PATH})
                self.assertEqual(r1.status_code, 403)
                self.assertEqual(r2.status_code, 403)
                self.assertEqual(r3.status_code, 403)
        finally:
            app.dependency_overrides.clear()

    def test_upload_strips_metadata_before_storage_and_registers_completed_record(self):
        officer = _make_actor("officer", officer_id="off-1")
        app.dependency_overrides[get_authenticated_actor] = lambda: officer
        captured_storage_bytes = {}

        async def fake_post(client_self, url, **kwargs):
            if "/storage/v1/object/" in url:
                captured_storage_bytes["bytes"] = kwargs.get("content", b"")
                return _mock_response(200, {"Key": EVIDENCE_PATH})
            if "/rpc/register_resolution_evidence" in url:
                payload = kwargs["json"]
                self.assertTrue(payload["p_exif_stripped"])
                self.assertEqual(payload["p_mime_type"], "image/jpeg")
                return _mock_response(200, "evid-uuid-1")
            return _mock_response(404)

        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("app.services.resolution_service.settings.SUPABASE_SERVICE_ROLE_KEY", "service-key"), \
             patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=_mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T10:00:00Z"}])), \
             patch("httpx.AsyncClient.post", new=fake_post):
            raw_with_gps = _create_jpeg_bytes(100, 70, with_exif_gps=True)
            res = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolution-photo",
                files={"file": ("proof.jpg", raw_with_gps, "image/jpeg")},
            )

        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["upload_status"], "completed")
        self.assertTrue(body["exif_stripped"])
        self.assertEqual((body["width"], body["height"]), (70, 100))

        # Verify bytes uploaded to storage already have EXIF & GPS stripped
        with Image.open(io.BytesIO(captured_storage_bytes["bytes"])) as stored_img:
            self.assertEqual(len(stored_img.getexif()), 0)
            self.assertEqual(len(stored_img.getexif().get_ifd(0x8825)), 0)

    def test_upload_succeeds_but_registration_fails_allows_clean_retry_and_blocks_resolve(self):
        officer = _make_actor("officer", officer_id="off-1")
        app.dependency_overrides[get_authenticated_actor] = lambda: officer
        stored_blobs = {}

        async def fake_post_upload_then_fail_reg(client_self, url, **kwargs):
            if "/storage/v1/object/" in url:
                path_part = url.split("/complaint-images/")[-1]
                stored_blobs[path_part] = kwargs["content"]
                return _mock_response(200, {"Key": path_part})
            if "/rpc/register_resolution_evidence" in url:
                # Simulate raw SQL error from DB (must never leak!)
                return _mock_response(500, {"code": "XX000", "message": "SELECT * FROM pg_catalog internal error"})
            return _mock_response(404)

        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("app.services.resolution_service.settings.SUPABASE_SERVICE_ROLE_KEY", "service-key"), \
             patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=_mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T10:00:00Z"}])), \
             patch("httpx.AsyncClient.post", new=fake_post_upload_then_fail_reg):
            res = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolution-photo",
                files={"file": ("proof.jpg", _create_jpeg_bytes(), "image/jpeg")},
            )

        self.assertEqual(res.status_code, 502)
        err_body = res.json()
        self.assertTrue(err_body["registration_pending"])
        saved_path = err_body["storage_path"]
        self.assertNotIn("pg_catalog", err_body["detail"])
        self.assertNotIn("SELECT", err_body["detail"])

        # Resolve stays blocked while evidence is unregistered
        async def fake_get_no_evidence(client_self, url, **kwargs):
            if "/rest/v1/complaints" in url:
                return _mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T10:00:00Z"}])
            if "/rest/v1/complaint_resolution_evidence" in url:
                return _mock_response(200, [])
            return _mock_response(404)

        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new=fake_get_no_evidence):
            res_blocked = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolve",
                json={
                    "expected_updated_at": "2026-11-25T10:00:00Z",
                    "public_description": "Attempt resolve before registration saved.",
                    "resolution_image_path": saved_path,
                },
            )
        self.assertEqual(res_blocked.status_code, 422)

        # Retry registration cleanly succeeds without re-uploading bytes
        async def fake_get_for_retry(client_self, url, **kwargs):
            if "/rest/v1/complaints" in url:
                return _mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T10:00:00Z"}])
            if "/storage/v1/object/authenticated/" in url:
                return _mock_response(200, content=stored_blobs[saved_path])
            return _mock_response(404)

        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("app.services.resolution_service.settings.SUPABASE_SERVICE_ROLE_KEY", "service-key"), \
             patch("httpx.AsyncClient.get", new=fake_get_for_retry), \
             patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=_mock_response(200, "evid-uuid-retry")):
            retry_res = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolution-photo/register",
                json={"storage_path": saved_path},
            )
        self.assertEqual(retry_res.status_code, 200)
        self.assertEqual(retry_res.json()["upload_status"], "completed")

    def test_resolve_blocks_missing_object_pending_upload_wrong_complaint_and_revoked_officer(self):
        officer = _make_actor("officer", officer_id="off-1")
        app.dependency_overrides[get_authenticated_actor] = lambda: officer

        # 1. Photo belonging to another complaint rejected
        res_other = self.client.post(
            f"/api/officer/complaints/{COMPLAINT_ID}/resolve",
            json={
                "expected_updated_at": "2026-11-25T10:00:00Z",
                "public_description": "Trying to reuse another complaint photo.",
                "resolution_image_path": OTHER_EVIDENCE_PATH,
            },
        )
        self.assertEqual(res_other.status_code, 422)

        # 2. Officer assignment revoked between upload and resolve (or non-assigned officer)
        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=_mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-2", "updated_at": "2026-11-25T10:00:00Z"}])):
            res_revoked = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolve",
                json={
                    "expected_updated_at": "2026-11-25T10:00:00Z",
                    "public_description": "Officer assignment was reassigned.",
                    "resolution_image_path": EVIDENCE_PATH,
                },
            )
        self.assertEqual(res_revoked.status_code, 403)

        # 3. Incomplete (pending) upload blocked
        async def fake_get_pending(client_self, url, **kwargs):
            if "/rest/v1/complaints" in url:
                return _mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T10:00:00Z"}])
            return _mock_response(200, [{"id": "e1", "complaint_id": COMPLAINT_ID, "storage_path": EVIDENCE_PATH, "upload_status": "pending", "exif_stripped": True}])

        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new=fake_get_pending):
            res_pending = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolve",
                json={
                    "expected_updated_at": "2026-11-25T10:00:00Z",
                    "public_description": "Pending upload resolve attempt.",
                    "resolution_image_path": EVIDENCE_PATH,
                },
            )
        self.assertEqual(res_pending.status_code, 422)

        # 4. Missing stored object in bucket blocked
        async def fake_get_missing_obj(client_self, url, **kwargs):
            if "/rest/v1/complaints" in url:
                return _mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T10:00:00Z"}])
            return _mock_response(200, [{"id": "e1", "complaint_id": COMPLAINT_ID, "storage_path": EVIDENCE_PATH, "upload_status": "completed", "exif_stripped": True}])

        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new=fake_get_missing_obj), \
             patch("httpx.AsyncClient.head", new_callable=AsyncMock, return_value=_mock_response(404)):
            res_missing_obj = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolve",
                json={
                    "expected_updated_at": "2026-11-25T10:00:00Z",
                    "public_description": "Stored object disappeared.",
                    "resolution_image_path": EVIDENCE_PATH,
                },
            )
        self.assertEqual(res_missing_obj.status_code, 422)

    def test_resolve_succeeds_for_assigned_officer_and_admin_handles_concurrency_and_existing_resolved(self):
        officer = _make_actor("officer", officer_id="off-1")
        app.dependency_overrides[get_authenticated_actor] = lambda: officer

        async def fake_get_valid(client_self, url, **kwargs):
            if "/rest/v1/complaints" in url:
                return _mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T10:00:00Z"}])
            return _mock_response(200, [{"id": "e1", "complaint_id": COMPLAINT_ID, "storage_path": EVIDENCE_PATH, "upload_status": "completed", "exif_stripped": True}])

        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new=fake_get_valid), \
             patch("httpx.AsyncClient.head", new_callable=AsyncMock, return_value=_mock_response(200)), \
             patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=_mock_response(204)):
            ok_res = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolve",
                json={
                    "expected_updated_at": "2026-11-25T10:00:00Z",
                    "public_description": "Asphalt patched and compacted cleanly.",
                    "resolution_image_path": EVIDENCE_PATH,
                    "internal_note": "Must be stripped for officer",
                },
            )
        self.assertEqual(ok_res.status_code, 200)
        self.assertEqual(ok_res.json()["status"], "resolved")

        # Simulated concurrent resolve request returning SQLSTATE 40001 maps safely to 409
        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new=fake_get_valid), \
             patch("httpx.AsyncClient.head", new_callable=AsyncMock, return_value=_mock_response(200)), \
             patch("httpx.AsyncClient.post", new_callable=AsyncMock, return_value=_mock_response(409, {"code": "40001", "message": "Concurrency Conflict"})):
            conflict_res = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolve",
                json={
                    "expected_updated_at": "2026-11-25T10:00:00Z",
                    "public_description": "Concurrent resolve attempt.",
                    "resolution_image_path": EVIDENCE_PATH,
                },
            )
        self.assertEqual(conflict_res.status_code, 409)

        # Already resolved complaints are untouched & rejected with 409
        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new_callable=AsyncMock, return_value=_mock_response(200, [{"id": COMPLAINT_ID, "status": "resolved", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T11:00:00Z"}])):
            resolved_res = self.client.post(
                f"/api/officer/complaints/{COMPLAINT_ID}/resolve",
                json={
                    "expected_updated_at": "2026-11-25T11:00:00Z",
                    "public_description": "Existing resolved complaint must not change.",
                    "resolution_image_path": EVIDENCE_PATH,
                },
            )
        self.assertEqual(resolved_res.status_code, 409)

    def test_admin_resolve_workflow_and_concurrent_asyncio_resolve_requests(self):
        from app.schemas.resolution import ResolveComplaintRequest
        from app.services.resolution_service import resolve_complaint_with_verified_photo

        admin = _make_actor("admin")
        app.dependency_overrides[get_authenticated_actor] = lambda: admin

        async def fake_get_valid(client_self, url, **kwargs):
            if "/rest/v1/complaints" in url:
                return _mock_response(200, [{"id": COMPLAINT_ID, "status": "in_progress", "assigned_officer_id": "off-1", "updated_at": "2026-11-25T10:00:00Z"}])
            return _mock_response(200, [{"id": "e1", "complaint_id": COMPLAINT_ID, "storage_path": EVIDENCE_PATH, "upload_status": "completed", "exif_stripped": True}])

        captured_payload = {}

        async def fake_post_admin(client_self, url, **kwargs):
            if "/rpc/transition_complaint_status" in url:
                captured_payload["json"] = kwargs.get("json")
            return _mock_response(204)

        with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
             patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
             patch("httpx.AsyncClient.get", new=fake_get_valid), \
             patch("httpx.AsyncClient.head", new_callable=AsyncMock, return_value=_mock_response(200)), \
             patch("httpx.AsyncClient.post", new=fake_post_admin):
            admin_res = self.client.post(
                f"/api/admin/complaints/{COMPLAINT_ID}/resolve",
                json={
                    "expected_updated_at": "2026-11-25T10:00:00Z",
                    "public_description": "Admin verified completion and closed ticket.",
                    "resolution_image_path": EVIDENCE_PATH,
                    "internal_note": "Verified on field inspection.",
                },
            )
        self.assertEqual(admin_res.status_code, 200)
        self.assertEqual(captured_payload["json"]["p_internal_note"], "Verified on field inspection.")

        # Two concurrent resolve attempts: first succeeds, second sees SQLSTATE 40001 from row lock
        rpc_calls = {"count": 0}

        async def fake_post_race(client_self, url, **kwargs):
            rpc_calls["count"] += 1
            if rpc_calls["count"] == 1:
                return _mock_response(204)
            return _mock_response(409, {"code": "40001", "message": "Concurrency Conflict"})

        req = ResolveComplaintRequest(
            expected_updated_at="2026-11-25T10:00:00Z",
            public_description="Concurrent race condition test statement.",
            resolution_image_path=EVIDENCE_PATH,
        )

        async def run_race():
            with patch("app.services.resolution_service.settings.SUPABASE_URL", "https://example.supabase.co"), \
                 patch("app.services.resolution_service.settings.SUPABASE_ANON_KEY", "anon-key"), \
                 patch("httpx.AsyncClient.get", new=fake_get_valid), \
                 patch("httpx.AsyncClient.head", new_callable=AsyncMock, return_value=_mock_response(200)), \
                 patch("httpx.AsyncClient.post", new=fake_post_race):
                return await asyncio.gather(
                    resolve_complaint_with_verified_photo(admin, COMPLAINT_ID, req),
                    resolve_complaint_with_verified_photo(admin, COMPLAINT_ID, req),
                    return_exceptions=True,
                )

        race_results = asyncio.run(run_race())
        successes = [r for r in race_results if isinstance(r, dict) and r.get("status") == "resolved"]
        conflicts = [r for r in race_results if hasattr(r, "status_code") and r.status_code == 409]
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(conflicts), 1)


class Phase81MigrationStaticIntegrityTests(unittest.TestCase):
    """Static verification of the Phase 8.1 migration & rollback SQL without executing SQL."""

    def test_migration_and_rollback_preserve_signature_locks_and_evidence_immutability(self):
        mig = (REPO_ROOT / "supabase/migrations/20261128_phase8_1_completion_photo_required.sql").read_text(encoding="utf-8")
        undo = (REPO_ROOT / "supabase/rollbacks/20261128_phase8_1_completion_photo_required_UNDO.sql").read_text(encoding="utf-8")

        self.assertIn("CREATE OR REPLACE FUNCTION public.transition_complaint_status(", mig)
        self.assertIn("SECURITY DEFINER", mig)
        self.assertIn("SET search_path = public, pg_temp", mig)
        self.assertIn("FOR UPDATE;", mig)
        self.assertIn("v_evidence.upload_status IS DISTINCT FROM 'completed'", mig)
        self.assertIn("v_evidence.exif_stripped IS NOT TRUE", mig)
        self.assertIn("FROM storage.objects", mig)
        self.assertIn("AS RESTRICTIVE", mig)
        self.assertIn("FOR UPDATE", mig)
        self.assertIn("FOR DELETE", mig)
        self.assertIn("trg_guard_resolution_evidence_insert_state", mig)
        self.assertIn("GRANT EXECUTE ON FUNCTION public.register_resolution_evidence(", mig)
        self.assertIn("TO service_role;", mig)

        # Rollback restores Phase 4.3 transition_complaint_status and drops Phase 8.1 objects
        self.assertIn("CREATE OR REPLACE FUNCTION public.transition_complaint_status(", undo)
        self.assertIn("DROP FUNCTION IF EXISTS public.register_resolution_evidence(", undo)
        self.assertIn('DROP POLICY IF EXISTS "Block deletes of resolution evidence objects" ON storage.objects;', undo)
        self.assertIn("DROP TRIGGER IF EXISTS trg_guard_resolution_evidence_insert_state", undo)


if __name__ == "__main__":
    unittest.main()
