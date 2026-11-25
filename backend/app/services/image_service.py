"""
ReportlyUrban — Image Security & Validation Service
Enforces streaming size limits, magic bytes verification, MIME consistency,
Pillow decompression bomb guards, and metadata (EXIF/GPS/XMP) stripping.
"""

from dataclasses import dataclass
import hashlib
import io
import os
from typing import FrozenSet, Tuple
from fastapi import UploadFile, HTTPException, status
from PIL import Image, ImageFile, ImageOps, PngImagePlugin
from app.config import settings

# Enforce strict pixel limit to prevent decompression bomb denial-of-service
Image.MAX_IMAGE_PIXELS = settings.MAX_IMAGE_PIXELS
ImageFile.LOAD_TRUNCATED_IMAGES = False

# Magic byte signatures for authorized civic image formats
JPEG_MAGIC = b'\xff\xd8\xff'
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
WEBP_RIFF = b'RIFF'
WEBP_MAGIC = b'WEBP'

MAX_RESOLUTION_IMAGE_SIZE_BYTES = 8 * 1024 * 1024  # 8 MB (matches complaint-images bucket)
MAX_RESOLUTION_IMAGE_DIMENSION = 8192

MIME_TO_EXTENSIONS: dict[str, FrozenSet[str]] = {
    "image/jpeg": frozenset({".jpg", ".jpeg"}),
    "image/png": frozenset({".png"}),
    "image/webp": frozenset({".webp"}),
}
MIME_TO_EXTENSION_CANONICAL: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}
MIME_TO_PIL_FORMAT: dict[str, str] = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}
_GPS_IFD_TAG = 0x8825


@dataclass(frozen=True)
class StrippedImageResult:
    image_bytes: bytes
    mime_type: str
    extension: str
    width: int
    height: int
    sha256_hash: str
    had_metadata: bool


def detect_image_format_by_magic_bytes(header: bytes) -> str:
    """
    Validates file headers against authoritative binary magic bytes.
    Does not trust client Content-Type headers or file extensions.
    """
    if len(header) < 3:
        return ""
    
    if header.startswith(JPEG_MAGIC):
        return "image/jpeg"
    
    if header.startswith(PNG_MAGIC):
        return "image/png"
    
    if len(header) >= 12 and header.startswith(WEBP_RIFF) and header[8:12] == WEBP_MAGIC:
        return "image/webp"
    
    return ""


async def read_and_validate_image_file(file: UploadFile) -> Tuple[bytes, str]:
    """
    Reads an uploaded image stream with chunked size enforcement,
    verifies magic bytes, and performs deep integrity validation via Pillow.
    
    Returns (image_bytes, mime_type).
    Raises HTTPException(413) if oversized, HTTPException(422) if invalid/corrupt.
    """
    chunks = []
    total_bytes = 0
    header_bytes = bytearray()
    
    # 1. Stream file in 64 KB chunks to prevent unbounded memory allocation
    chunk_size = 64 * 1024
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        
        total_bytes += len(chunk)
        if total_bytes > settings.MAX_IMAGE_SIZE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Uploaded image exceeds maximum allowable limit of {settings.MAX_IMAGE_SIZE_BYTES // (1024 * 1024)} MB."
            )
        
        chunks.append(chunk)
        if len(header_bytes) < 12:
            header_bytes.extend(chunk[:12 - len(header_bytes)])
    
    if total_bytes == 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Uploaded file is empty (0 bytes)."
        )
    
    image_bytes = b"".join(chunks)
    
    # 2. Magic byte verification
    mime_type = detect_image_format_by_magic_bytes(bytes(header_bytes))
    if not mime_type:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Unsupported image format. File must be an authentic JPEG, PNG, or WebP image."
        )
    
    # 3. Pillow Deep Verification & Decompression Bomb Protection
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            # Verify basic structural integrity without loading full pixel array
            img.verify()
            
            # Verify width and height within reasonable bounds
            width, height = img.size
            if width <= 0 or height <= 0:
                raise ValueError("Invalid image dimensions.")
            
            # Check decompression bomb limit
            if width * height > settings.MAX_IMAGE_PIXELS:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail="Image pixel dimensions exceed maximum security threshold."
                )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Image decoding failed: file is corrupted or not a valid image ({str(e)})."
        )
    
    return image_bytes, mime_type


async def _read_bounded_stream(file: UploadFile, max_bytes: int) -> bytes:
    """Streams an UploadFile in 64 KB chunks up to max_bytes."""
    chunks = []
    total_bytes = 0
    chunk_size = 64 * 1024

    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total_bytes += len(chunk)
        if total_bytes > max_bytes:
            limit_mb = max_bytes // (1024 * 1024)
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Uploaded image exceeds maximum allowable limit of {limit_mb} MB.",
            )
        chunks.append(chunk)

    if total_bytes == 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Uploaded file is empty (0 bytes).",
        )

    return b"".join(chunks)


def _reject_if_text_or_svg(raw_bytes: bytes) -> None:
    """Rejects SVG, HTML, XML, or script payloads even with spoofed image extensions."""
    head = raw_bytes[:512].lstrip().lower()
    if (
        head.startswith(b"<svg")
        or head.startswith(b"<?xml")
        or head.startswith(b"<!doctype")
        or head.startswith(b"<html")
        or b"<svg" in head
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="SVG and markup files are not allowed. Upload a real JPEG, PNG, or WebP photograph.",
        )


def _validate_mime_and_extension(
    filename: str | None,
    client_content_type: str | None,
    detected_mime: str,
) -> None:
    """Rejects mismatches between declared MIME/extension and actual binary magic bytes."""
    if client_content_type:
        declared = client_content_type.split(";")[0].strip().lower()
        if declared and declared != detected_mime:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="File MIME type does not match actual image contents.",
            )

    if filename:
        _, ext = os.path.splitext(filename.strip())
        if ext:
            ext_lower = ext.lower()
            allowed_exts = MIME_TO_EXTENSIONS[detected_mime]
            if ext_lower not in allowed_exts:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="File extension does not match actual image contents.",
                )


def _validate_dimensions(width: int, height: int) -> None:
    """Enforces positive, bounded dimensions and pixel budget."""
    if width <= 0 or height <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid image dimensions.",
        )
    if width > MAX_RESOLUTION_IMAGE_DIMENSION or height > MAX_RESOLUTION_IMAGE_DIMENSION:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Image dimensions exceed maximum allowed {MAX_RESOLUTION_IMAGE_DIMENSION}px per side.",
        )
    if width * height > settings.MAX_IMAGE_PIXELS:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Image pixel dimensions exceed maximum security threshold.",
        )


def _has_sensitive_metadata(img: Image.Image) -> bool:
    """Returns True if Pillow detects any EXIF, GPS, XMP, ICC comment, or text metadata."""
    exif = img.getexif()
    if len(exif) > 0:
        return True
    try:
        if len(exif.get_ifd(_GPS_IFD_TAG)) > 0:
            return True
    except Exception:
        pass

    sensitive_info_keys = (
        "exif",
        "xmp",
        "XML:com.adobe.xmp",
        "comment",
        "photoshop",
        "adobe",
    )
    if any(img.info.get(k) for k in sensitive_info_keys):
        return True

    png_text = getattr(img, "text", None)
    if isinstance(png_text, dict) and len(png_text) > 0:
        return True

    return False


def _encode_clean_image(oriented: Image.Image, detected_mime: str) -> bytes:
    """Copies pixel data into a blank image with zero metadata and re-encodes."""
    target_format = MIME_TO_PIL_FORMAT[detected_mime]
    mode = oriented.mode

    if target_format == "JPEG":
        if mode not in ("RGB", "L"):
            oriented = oriented.convert("RGB")
        clean = Image.frombytes(oriented.mode, oriented.size, oriented.tobytes())
        out = io.BytesIO()
        clean.save(out, format="JPEG", quality=92, optimize=True)
        return out.getvalue()

    if target_format == "PNG":
        if mode == "P":
            oriented = oriented.convert("RGBA" if "transparency" in oriented.info else "RGB")
        elif mode not in ("L", "LA", "RGB", "RGBA"):
            oriented = oriented.convert("RGBA" if oriented.mode.endswith("A") else "RGB")
        clean = Image.frombytes(oriented.mode, oriented.size, oriented.tobytes())
        out = io.BytesIO()
        clean.save(out, format="PNG", optimize=True, pnginfo=PngImagePlugin.PngInfo())
        return out.getvalue()

    # WEBP
    if mode not in ("RGB", "RGBA", "L"):
        has_alpha = mode.endswith("A") or "transparency" in oriented.info
        oriented = oriented.convert("RGBA" if has_alpha else "RGB")
    clean = Image.frombytes(oriented.mode, oriented.size, oriented.tobytes())
    out = io.BytesIO()
    clean.save(out, format="WEBP", quality=90)
    return out.getvalue()


def validate_and_strip_resolution_bytes(
    raw_bytes: bytes,
    *,
    client_content_type: str | None = None,
    filename: str | None = None,
) -> StrippedImageResult:
    """
    Validates raw bytes by magic signature, MIME/extension consistency, dimension limits,
    and full Pillow decode; applies EXIF orientation transform; strips EXIF/GPS/XMP/text
    metadata; and re-verifies that the clean output decodes with preserved orientation.
    """
    if not raw_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Uploaded file is empty (0 bytes).",
        )
    if len(raw_bytes) > MAX_RESOLUTION_IMAGE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Uploaded image exceeds maximum allowable limit of 8 MB.",
        )

    _reject_if_text_or_svg(raw_bytes)
    detected_mime = detect_image_format_by_magic_bytes(raw_bytes[:12])
    if not detected_mime:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Unsupported image format. File must be an authentic JPEG, PNG, or WebP image.",
        )

    _validate_mime_and_extension(filename, client_content_type, detected_mime)
    expected_pil_format = MIME_TO_PIL_FORMAT[detected_mime]

    try:
        # Step 1: Header & structural check
        with Image.open(io.BytesIO(raw_bytes)) as probe:
            if probe.format != expected_pil_format:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Image container format does not match detected image signature.",
                )
            _validate_dimensions(*probe.size)
            probe.verify()

        # Step 2: Full decode, orientation baking, and clean re-encode without metadata
        with Image.open(io.BytesIO(raw_bytes)) as img:
            _validate_dimensions(*img.size)
            had_metadata = _has_sensitive_metadata(img)
            img.load()
            oriented = ImageOps.exif_transpose(img)
            expected_size = oriented.size
            _validate_dimensions(*expected_size)
            stripped_bytes = _encode_clean_image(oriented, detected_mime)

        if not stripped_bytes or len(stripped_bytes) > MAX_RESOLUTION_IMAGE_SIZE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Processed completion photo exceeds maximum allowable limit of 8 MB.",
            )

        # Step 3: Post-strip verification (still decodes, zero EXIF/GPS/XMP, orientation preserved)
        with Image.open(io.BytesIO(stripped_bytes)) as verify_probe:
            verify_probe.verify()
        with Image.open(io.BytesIO(stripped_bytes)) as verify_img:
            verify_img.load()
            if verify_img.format != expected_pil_format:
                raise ValueError("Stripped output format mismatch.")
            if verify_img.size != expected_size:
                raise ValueError("Image orientation dimensions were not preserved after stripping.")
            if _has_sensitive_metadata(verify_img):
                raise ValueError("Sensitive image metadata remained after stripping.")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Image decoding failed: file is corrupted, malformed, or cannot be sanitized.",
        )

    return StrippedImageResult(
        image_bytes=stripped_bytes,
        mime_type=detected_mime,
        extension=MIME_TO_EXTENSION_CANONICAL[detected_mime],
        width=expected_size[0],
        height=expected_size[1],
        sha256_hash=hashlib.sha256(stripped_bytes).hexdigest(),
        had_metadata=had_metadata,
    )


async def read_validate_and_strip_resolution_image(file: UploadFile) -> StrippedImageResult:
    """Reads bounded upload stream and runs full resolution image security + metadata stripping."""
    raw_bytes = await _read_bounded_stream(file, MAX_RESOLUTION_IMAGE_SIZE_BYTES)
    return validate_and_strip_resolution_bytes(
        raw_bytes,
        client_content_type=file.content_type,
        filename=file.filename,
    )


def verify_already_stripped_resolution_bytes(raw_bytes: bytes) -> StrippedImageResult:
    """
    Verifies bytes already stored in Storage during a registration retry:
    rejects non-conforming files AND rejects any file that still contains EXIF/GPS/XMP.
    """
    if not raw_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Stored completion photo is empty.",
        )
    if len(raw_bytes) > MAX_RESOLUTION_IMAGE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Stored completion photo exceeds 8 MB limit.",
        )

    _reject_if_text_or_svg(raw_bytes)
    detected_mime = detect_image_format_by_magic_bytes(raw_bytes[:12])
    if not detected_mime:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Stored file is not an authentic JPEG, PNG, or WebP image.",
        )

    expected_pil_format = MIME_TO_PIL_FORMAT[detected_mime]
    try:
        with Image.open(io.BytesIO(raw_bytes)) as probe:
            if probe.format != expected_pil_format:
                raise ValueError("Format mismatch.")
            _validate_dimensions(*probe.size)
            probe.verify()

        with Image.open(io.BytesIO(raw_bytes)) as img:
            _validate_dimensions(*img.size)
            if _has_sensitive_metadata(img):
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Stored image contains unstripped metadata and must be re-uploaded through the server.",
                )
            img.load()
            width, height = img.size
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Stored completion photo failed integrity verification.",
        )

    return StrippedImageResult(
        image_bytes=raw_bytes,
        mime_type=detected_mime,
        extension=MIME_TO_EXTENSION_CANONICAL[detected_mime],
        width=width,
        height=height,
        sha256_hash=hashlib.sha256(raw_bytes).hexdigest(),
        had_metadata=False,
    )
