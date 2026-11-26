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
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Strict RFC 4122 generic UUID regex (supports database UUIDs for complaints)
export const UUID_ANY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Strict storage path regex: <citizen-uuid-v4>/<file-uuid-v4>.<ext>
export const INCIDENT_STORAGE_PATH_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$/i;

// Strict resolution storage path regex: resolution/<complaint-uuid>/<file-uuid-v4>.<ext>
export const RESOLUTION_STORAGE_PATH_REGEX = /^resolution\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$/i;

// Backward-compatible alias
export const STORAGE_PATH_REGEX = INCIDENT_STORAGE_PATH_REGEX;

/**
 * Validates whether a storage path strictly matches either incident evidence or resolution proof format.
 * @param {string} path
 * @returns {boolean}
 */
export function isValidStoragePath(path) {
  if (!path || typeof path !== 'string') return false;
  return INCIDENT_STORAGE_PATH_REGEX.test(path) || RESOLUTION_STORAGE_PATH_REGEX.test(path);
}

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
async function stripImageMetadataInBrowser(file) {
  if (
    typeof document === 'undefined' ||
    typeof createImageBitmap !== 'function' ||
    !file ||
    !ALLOWED_MIME_TYPES.includes(file.type)
  ) {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, file.type, file.type === 'image/jpeg' ? 0.92 : undefined)
      );
      if (!blob) return file;
      return new File([blob], file.name || `upload.${MIME_TO_EXTENSION[file.type] || 'jpg'}`, {
        type: file.type,
      });
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close();
    }
  } catch {
    return file;
  }
}

export async function uploadComplaintImage({ file, userId }) {
  try {
    const validation = validateImageFile(file);
    if (!validation.valid) {
      return { data: null, error: new Error(validation.error) };
    }

    const sanitizedFile = await stripImageMetadataInBrowser(file);
    const objectPath = generateStoragePath(userId, file.type);

    const { data, error } = await supabase.storage
      .from(COMPLAINT_STORAGE_BUCKET)
      .upload(objectPath, sanitizedFile, {
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
 * Generates an isolated, path-traversal-proof resolution storage path for a complaint.
 * Path format: "resolution/<complaintId>/<fileId>.<extension>"
 *
 * @param {string} complaintId - UUID of the complaint being resolved
 * @param {string} mimeType - MIME type of the verified image
 * @returns {string} Sanitized object path
 */
export function generateResolutionStoragePath(complaintId, mimeType) {
  if (!complaintId || typeof complaintId !== 'string' || !UUID_ANY_REGEX.test(complaintId)) {
    throw new Error('A valid complaint UUID is required to generate a resolution storage path.');
  }

  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Cryptographically secure UUID generation (crypto.randomUUID) is unavailable in this environment.');
  }

  const extension = MIME_TO_EXTENSION[mimeType];
  if (!extension) {
    throw new Error(`Unsupported MIME type: '${mimeType}'. Only JPEG, PNG, and WebP images are allowed.`);
  }

  const fileId = crypto.randomUUID();

  return `resolution/${complaintId}/${fileId}.${extension}`;
}

/**
 * Uploads a municipal resolution evidence photograph to the private Supabase Storage bucket.
 * Does not overwrite existing files (upsert: false).
 * Returns the relative storage path (e.g., "resolution/complaintId/uuid.jpg").
 *
 * @param {Object} params
 * @param {File} params.file - File object to upload
 * @param {string} params.complaintId - UUID of the complaint being resolved
 * @returns {Promise<{ data: { path: string } | null, error: Error | null }>}
 */
export async function uploadResolutionImage({ file, complaintId }) {
  try {
    const validation = validateImageFile(file);
    if (!validation.valid) {
      return { data: null, error: new Error(validation.error) };
    }

    const objectPath = generateResolutionStoragePath(complaintId, file.type);

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
 * Generates a temporary signed URL for authorized viewing of a private complaint or resolution image.
 * Validates path formatting against strict incident or resolution patterns and enforces valid expiry limits.
 *
 * @param {string} storagePath - Relative path inside the complaint-images bucket
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

    // Validate path against strict storage path specification (incident or resolution)
    if (!isValidStoragePath(cleanPath)) {
      return {
        data: null,
        error: new Error('Malformed storage path. Expected format: <citizen-uuid>/<file-uuid>.<ext> or resolution/<complaint-uuid>/<file-uuid>.<ext>'),
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
