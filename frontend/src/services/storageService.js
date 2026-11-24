import { supabase } from '../lib/supabase.js';

export const COMPLAINT_STORAGE_BUCKET = 'complaint-images';
export const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB
export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const MIME_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Strict RFC 4122 UUID v4 regex (version 4, variant 1 [89ab])
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Strict storage path regex: <citizen-uuid-v4>/<file-uuid-v4>.<ext>
const STORAGE_PATH_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$/i;

/**
 * Validates file type and size according to civic reporting storage guidelines.
 * @param {File} file
 * @returns {{ valid: boolean, error: string | null }}
 */
export function validateImageFile(file) {
  if (!file) {
    return { valid: false, error: 'No image file provided.' };
  }

  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return {
      valid: false,
      error: `Unsupported file format (${file.type || 'unknown'}). Only JPEG, PNG, and WebP images are allowed.`,
    };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    const sizeInMB = (file.size / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File size (${sizeInMB} MB) exceeds the 8 MB maximum limit.`,
    };
  }

  return { valid: true, error: null };
}

/**
 * Generates an isolated, path-traversal-proof storage path for an authenticated citizen.
 * Strictly requires a valid UUID v4 citizen ID and uses crypto.randomUUID() without insecure fallbacks.
 * Path format: "<userId>/<fileId>.<extension>"
 *
 * @param {string} userId - UUID v4 of the authenticated citizen
 * @param {string} mimeType - MIME type of the verified image
 * @returns {string} Sanitized object path
 */
export function generateStoragePath(userId, mimeType) {
  if (!userId || typeof userId !== 'string' || !UUID_V4_REGEX.test(userId)) {
    throw new Error('A valid citizen UUID v4 is required to generate an isolated storage path.');
  }

  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Cryptographically secure UUID generation (crypto.randomUUID) is unavailable in this environment.');
  }

  const extension = MIME_TO_EXTENSION[mimeType];
  if (!extension) {
    throw new Error(`Unsupported MIME type: '${mimeType}'. Only JPEG, PNG, and WebP images are allowed.`);
  }

  const fileId = crypto.randomUUID();

  return `${userId}/${fileId}.${extension}`;
}

/**
 * Uploads a complaint image to the private Supabase Storage bucket.
 * Does not overwrite existing files (upsert: false).
 * Returns the relative storage path (e.g., "userId/uuid.jpg"), NOT a public URL.
 *
 * @param {Object} params
 * @param {File} params.file - File object to upload
 * @param {string} params.userId - Authenticated citizen's UUID v4
 * @returns {Promise<{ data: { path: string } | null, error: Error | null }>}
 */
export async function uploadComplaintImage({ file, userId }) {
  try {
    const validation = validateImageFile(file);
    if (!validation.valid) {
      return { data: null, error: new Error(validation.error) };
    }

    const objectPath = generateStoragePath(userId, file.type);

    const { data, error } = await supabase.storage
      .from(COMPLAINT_STORAGE_BUCKET)
      .upload(objectPath, file, {
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      return { data: null, error };
    }

    return {
      data: {
        path: data.path,
      },
      error: null,
    };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Generates a temporary signed URL for authorized viewing of a private complaint image.
 * Validates path formatting and enforces valid expiry limits (1 to 86,400 seconds).
 *
 * @param {string} storagePath - Relative path inside the complaint-images bucket (<citizen-uuid>/<file-uuid>.<ext>)
 * @param {number} [expiresIn=3600] - Expiry in seconds (defaults to 1 hour, max 24 hours)
 * @returns {Promise<{ data: { signedUrl: string } | null, error: Error | null }>}
 */
export async function getSignedImageUrl(storagePath, expiresIn = 3600) {
  try {
    if (!storagePath || typeof storagePath !== 'string') {
      return { data: null, error: new Error('A valid storage path is required.') };
    }

    // Strip bucket prefix if inadvertently passed
    const cleanPath = storagePath.startsWith(`${COMPLAINT_STORAGE_BUCKET}/`)
      ? storagePath.replace(`${COMPLAINT_STORAGE_BUCKET}/`, '')
      : storagePath;

    // Validate path against strict storage path specification
    if (!STORAGE_PATH_REGEX.test(cleanPath)) {
      return {
        data: null,
        error: new Error('Malformed storage path. Expected format: <citizen-uuid-v4>/<file-uuid-v4>.<extension>'),
      };
    }

    // Validate expiresIn argument
    if (
      typeof expiresIn !== 'number' ||
      !Number.isInteger(expiresIn) ||
      expiresIn <= 0 ||
      expiresIn > 86400
    ) {
      return {
        data: null,
        error: new Error('Invalid expiry duration. Expiry must be an integer between 1 and 86400 seconds (24 hours).'),
      };
    }

    const { data, error } = await supabase.storage
      .from(COMPLAINT_STORAGE_BUCKET)
      .createSignedUrl(cleanPath, expiresIn);

    if (error) {
      return { data: null, error };
    }

    return {
      data: {
        signedUrl: data.signedUrl,
      },
      error: null,
    };
  } catch (err) {
    return {
      data: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
