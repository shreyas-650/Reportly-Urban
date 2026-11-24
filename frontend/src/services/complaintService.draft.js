import { supabase } from '../lib/supabase.js';
import {
  COMPLAINT_STORAGE_BUCKET,
  validateImageFile,
  generateStoragePath,
  uploadComplaintImage,
} from './storageService.js';

export const VALID_CIVIC_CATEGORIES = [
  'potholes',
  'garbage',
  'streetlights',
  'water_leakage',
  'drainage',
  'public_infrastructure',
];

// RFC 4122 UUID v4 regex (version 4, variant 1 [89ab])
export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Strict storage path regex: <citizen-uuid-v4>/<file-uuid-v4>.<ext>
export const STORAGE_PATH_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$/i;

export function validateComplaintInput(data) {
  if (!data) {
    return { valid: false, error: 'Complaint data is required.' };
  }

  const { title, category, ward, location, description, file, uploadedStoragePath } = data;

  if (!title || typeof title !== 'string' || title.trim().length < 5) {
    return { valid: false, error: 'Title must be at least 5 characters long.' };
  }

  if (title.trim().length > 255) {
    return { valid: false, error: 'Title cannot exceed 255 characters.' };
  }

  if (!category || !VALID_CIVIC_CATEGORIES.includes(category)) {
    return {
      valid: false,
      error: `Invalid category. Must be one of: ${VALID_CIVIC_CATEGORIES.join(', ')}.`,
    };
  }

  if (!ward || typeof ward !== 'string' || !ward.trim()) {
    return { valid: false, error: 'Municipal ward is required.' };
  }

  if (!location || typeof location !== 'string' || !location.trim()) {
    return { valid: false, error: 'Specific location or landmark is required.' };
  }

  if (!description || typeof description !== 'string' || description.trim().length < 15) {
    return { valid: false, error: 'Description must be at least 15 characters long.' };
  }

  if (!uploadedStoragePath && !file) {
    return { valid: false, error: 'A clear photograph of the issue is required.' };
  }

  return { valid: true, error: null };
}

export function validateStoragePathOwnership(storagePath, citizenId) {
  if (!storagePath || typeof storagePath !== 'string') {
    return { valid: false, error: 'Storage path is required.' };
  }

  if (!STORAGE_PATH_REGEX.test(storagePath)) {
    return {
      valid: false,
      error: 'Malformed storage path. Expected format: <citizen-uuid-v4>/<file-uuid-v4>.<extension>',
    };
  }

  const [pathFolder] = storagePath.split('/');
  if (pathFolder.toLowerCase() !== citizenId.toLowerCase()) {
    return {
      valid: false,
      error: 'Security violation: Referenced storage path does not belong to your citizen account folder.',
    };
  }

  return { valid: true, error: null };
}

export function isIdempotencyKeyViolation(error) {
  if (error?.code !== '23505') return false;
  const combined = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return combined.includes('uq_complaints_idempotency_key');
}

function attachDiagnosticDetails(error, originalError) {
  if (originalError) {
    if (originalError.code) error.code = originalError.code;
    if (originalError.details) error.details = originalError.details;
    if (originalError.hint) error.hint = originalError.hint;
    error.cause = originalError;
  }
  return error;
}

async function executeImageUpload({ file, citizenId, supabaseClient, customUploadFn }) {
  if (typeof customUploadFn === 'function') {
    return customUploadFn({ file, userId: citizenId, supabaseClient });
  }

  // Consistent dependency injection: If an injected client is provided, require storage support.
  // Never silently fall back to the module singleton when an injected client lacks storage.
  if (supabaseClient && supabaseClient !== supabase) {
    if (!supabaseClient.storage || typeof supabaseClient.storage.from !== 'function') {
      return {
        data: null,
        error: new Error(
          'Injected Supabase client does not support storage operations (.storage.from is missing).'
        ),
      };
    }

    const validation = validateImageFile(file);
    if (!validation.valid) {
      return { data: null, error: new Error(validation.error) };
    }

    const objectPath = generateStoragePath(citizenId, file.type);

    const { data, error } = await supabaseClient.storage
      .from(COMPLAINT_STORAGE_BUCKET)
      .upload(objectPath, file, {
        cacheControl: '3600',
        upsert: false,
      });

    if (error) {
      const err = new Error(error.message || 'Storage upload failed');
      return { data: null, error: attachDiagnosticDetails(err, error) };
    }

    return { data: { path: data.path }, error: null };
  }

  // Default path using default singleton
  return uploadComplaintImage({ file, userId: citizenId });
}

async function recoverySelectByIdempotencyKey(supabaseClient, idempotencyKey) {
  try {
    const result = await supabaseClient
      .from('complaints')
      .select('id, complaint_number, status, title, category, ward, location, description, image_url, created_at')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    return { data: result.data || null, error: result.error || null };
  } catch (err) {
    return { data: null, error: err };
  }
}

export async function createComplaint({
  title,
  category,
  ward,
  location,
  description,
  file = null,
  uploadedStoragePath = null,
  latitude = null,
  longitude = null,
  idempotencyKey,
  onStorageUploaded = null,
  supabaseClient = supabase,
  uploadImageFn = null,
}) {
  let activeStoragePath = uploadedStoragePath || null;

  try {
    // 1. Strict Idempotency Key Validation
    if (
      !idempotencyKey ||
      typeof idempotencyKey !== 'string' ||
      !UUID_V4_REGEX.test(idempotencyKey)
    ) {
      return {
        data: null,
        error: new Error(
          'A valid RFC 4122 UUID v4 idempotency key is required for safe submission.'
        ),
        orphanedStoragePath: activeStoragePath,
        isUnresolved: false,
      };
    }

    // 2. Client-side input validation
    const validation = validateComplaintInput({
      title,
      category,
      ward,
      location,
      description,
      file,
      uploadedStoragePath: activeStoragePath,
    });

    if (!validation.valid) {
      return {
        data: null,
        error: new Error(validation.error),
        orphanedStoragePath: activeStoragePath,
        isUnresolved: false,
      };
    }

    // 3. Authoritative session verification
    const {
      data: { session },
      error: sessionError,
    } = await supabaseClient.auth.getSession();

    if (sessionError || !session?.user?.id) {
      const err = new Error(
        'Authentication required. Please sign in as a citizen to file a complaint.'
      );
      return {
        data: null,
        error: attachDiagnosticDetails(err, sessionError),
        orphanedStoragePath: activeStoragePath,
        isUnresolved: false,
      };
    }

    const citizenId = session.user.id;

    // 4. Validate storage path ownership if path was pre-provided
    if (activeStoragePath) {
      const ownership = validateStoragePathOwnership(activeStoragePath, citizenId);
      if (!ownership.valid) {
        return {
          data: null,
          error: new Error(ownership.error),
          orphanedStoragePath: null,
          isUnresolved: false,
        };
      }
    }

    // 5. Upload photograph (uses consistent injected client, no silent fallback)
    if (!activeStoragePath && file) {
      const uploadResult = await executeImageUpload({
        file,
        citizenId,
        supabaseClient,
        customUploadFn: uploadImageFn,
      });

      if (uploadResult.error || !uploadResult.data?.path) {
        const err = uploadResult.error || new Error('Failed to upload photographic evidence.');
        return {
          data: null,
          error: attachDiagnosticDetails(err, uploadResult.error),
          orphanedStoragePath: null,
          isUnresolved: false,
        };
      }

      activeStoragePath = uploadResult.data.path;

      const newPathOwnership = validateStoragePathOwnership(activeStoragePath, citizenId);
      if (!newPathOwnership.valid) {
        return {
          data: null,
          error: new Error(newPathOwnership.error),
          orphanedStoragePath: null,
          isUnresolved: false,
        };
      }
    }

    if (!activeStoragePath) {
      return {
        data: null,
        error: new Error('Image storage path is missing after upload processing.'),
        orphanedStoragePath: null,
        isUnresolved: false,
      };
    }

    // 6. Pre-INSERT Persistence Barrier
    if (typeof onStorageUploaded === 'function') {
      try {
        const persistOk = await onStorageUploaded(activeStoragePath);
        if (persistOk === false || (persistOk && persistOk.success === false)) {
          return {
            data: null,
            error: new Error(
              'Failed to persist uploaded storage path to local recovery storage before database submission. Aborting submission to prevent orphaned state.'
            ),
            orphanedStoragePath: activeStoragePath,
            isUnresolved: false,
          };
        }
      } catch (persistErr) {
        const err = new Error(
          `Pending-state persistence error: ${persistErr.message || String(persistErr)}. Submission aborted before database registration.`
        );
        return {
          data: null,
          error: attachDiagnosticDetails(err, persistErr),
          orphanedStoragePath: activeStoragePath,
          isUnresolved: false,
        };
      }
    }

    // 7. Prepare 10-column payload
    const payload = {
      citizen_id: citizenId,
      title: title.trim(),
      category,
      ward: ward.trim(),
      location: location.trim(),
      description: description.trim(),
      image_url: activeStoragePath,
      idempotency_key: idempotencyKey,
      ...(latitude != null && { latitude }),
      ...(longitude != null && { longitude }),
    };

    // 8. Execute INSERT query
    const { data, error } = await supabaseClient
      .from('complaints')
      .insert(payload)
      .select(
        'id, complaint_number, status, title, category, ward, location, description, image_url, created_at'
      )
      .single();

    // 9. Confirmed Success
    if (!error && data) {
      return {
        data,
        error: null,
        orphanedStoragePath: null,
        isUnresolved: false,
      };
    }

    // 10. Handle errors
    if (error) {
      if (error.code === '23505') {
        if (isIdempotencyKeyViolation(error)) {
          const recovery = await recoverySelectByIdempotencyKey(supabaseClient, idempotencyKey);

          if (recovery.data) {
            return {
              data: recovery.data,
              error: null,
              orphanedStoragePath: null,
              isUnresolved: false,
            };
          }

          const err = new Error(
            recovery.error
              ? `Submission recorded but verification query failed: ${recovery.error.message || 'Recovery error'}. Do not retry with different data.`
              : 'Submission was recorded but could not be verified. Do not change your submission data — retry will check again.'
          );
          return {
            data: null,
            error: attachDiagnosticDetails(err, recovery.error || error),
            orphanedStoragePath: activeStoragePath,
            isUnresolved: true,
          };
        }

        const err = new Error(`Database constraint violation: ${error.message}`);
        return {
          data: null,
          error: attachDiagnosticDetails(err, error),
          orphanedStoragePath: activeStoragePath,
          isUnresolved: false,
        };
      }

      const isNetworkOrTimeout =
        error.message?.includes('fetch') ||
        error.message?.includes('timeout') ||
        error.message?.includes('network') ||
        error.code === '57014' ||
        !error.code;

      if (isNetworkOrTimeout) {
        const recovery = await recoverySelectByIdempotencyKey(supabaseClient, idempotencyKey);

        if (recovery.data) {
          return {
            data: recovery.data,
            error: null,
            orphanedStoragePath: null,
            isUnresolved: false,
          };
        }

        const err = new Error(
          recovery.error
            ? `Submission outcome uncertain due to network interruption. Verification also failed: ${recovery.error.message || 'Recovery error'}. Please check your connection and retry.`
            : 'Submission outcome uncertain — your complaint may have been registered. Please check your connection and retry to verify. Do not change your submission data.'
        );
        return {
          data: null,
          error: attachDiagnosticDetails(err, recovery.error || error),
          orphanedStoragePath: activeStoragePath,
          isUnresolved: true,
        };
      }

      const err = new Error(`Database registration failed: ${error.message}`);
      return {
        data: null,
        error: attachDiagnosticDetails(err, error),
        orphanedStoragePath: activeStoragePath,
        isUnresolved: false,
      };
    }

    return {
      data: null,
      error: new Error('Unexpected response: no data returned from database.'),
      orphanedStoragePath: activeStoragePath,
      isUnresolved: true,
    };
  } catch (err) {
    const diagnosticErr = err instanceof Error ? err : new Error(String(err));
    return {
      data: null,
      error: diagnosticErr,
      orphanedStoragePath: activeStoragePath,
      isUnresolved: true,
    };
  }
}
