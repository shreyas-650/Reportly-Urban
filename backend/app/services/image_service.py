"""
ReportlyUrban — Image Security & Validation Service
Enforces streaming size limits, magic bytes verification, and Pillow decompression bomb guards.
"""

import io
from typing import Tuple
from fastapi import UploadFile, HTTPException, status
from PIL import Image, ImageFile, ImageOps
from app.config import settings

# Enforce strict pixel limit to prevent decompression bomb denial-of-service
Image.MAX_IMAGE_PIXELS = settings.MAX_IMAGE_PIXELS
ImageFile.LOAD_TRUNCATED_IMAGES = False

# Magic byte signatures for authorized civic image formats
JPEG_MAGIC = b'\xff\xd8\xff'
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
WEBP_RIFF = b'RIFF'
WEBP_MAGIC = b'WEBP'


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
