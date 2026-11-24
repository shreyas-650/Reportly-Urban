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

/**
 * Fetches complaints submitted by the authenticated citizen from Supabase.
 *
 * Requirements (Phase 3.4):
 * - Strict RLS enforcement: Queries only authenticated citizen's complaints.
 * - Generates signed URLs for private images; falls back gracefully if signing fails.
 * - Accurate KPI statistics:
 *   - total: all citizen complaints
 *   - pending: submitted + under_review
 *   - inProgress: in_progress
 *   - resolved: resolved
 *   - rejected: rejected
 *
 * @param {Object} [options]
 * @param {Object} [options.supabaseClient=supabase]
 * @returns {Promise<{
 *   data: Array<Object> | null,
 *   stats: { total: number, pending: number, inProgress: number, resolved: number, rejected: number } | null,
 *   error: Error | null
 * }>}
 */
export async function fetchCitizenComplaints({ supabaseClient = supabase } = {}) {
  try {
    const {
      data: { session },
      error: sessionError,
    } = await supabaseClient.auth.getSession();

    if (sessionError || !session?.user?.id) {
      return {
        data: null,
        stats: null,
        error: new Error('Authentication required. Please sign in to view your complaints.'),
      };
    }

    const citizenId = session.user.id;

    // Execute select strictly scoped to the authenticated citizen
    const { data: rawComplaints, error: queryError } = await supabaseClient
      .from('complaints')
      .select(`
        id,
        complaint_number,
        title,
        category,
        description,
        location,
        ward,
        status,
        priority,
        image_url,
        completion_image_url,
        created_at,
        updated_at,
        department:departments (
          name
        )
      `)
      .eq('citizen_id', citizenId)
      .order('created_at', { ascending: false });

    if (queryError) {
      const err = new Error(`Failed to load complaints: ${queryError.message}`);
      return {
        data: null,
        stats: null,
        error: attachDiagnosticDetails(err, queryError),
      };
    }

    const storageClient =
      supabaseClient?.storage && typeof supabaseClient.storage.from === 'function'
        ? supabaseClient.storage
        : supabase.storage;

    // Resolve time-limited signed URLs for private storage images
    const enrichedComplaints = await Promise.all(
      (rawComplaints || []).map(async (c) => {
        let signedImageUrl = null;
        if (c.image_url) {
          if (c.image_url.startsWith('http://') || c.image_url.startsWith('https://')) {
            signedImageUrl = c.image_url;
          } else {
            try {
              const { data: signedData, error: signErr } = await storageClient
                .from(COMPLAINT_STORAGE_BUCKET)
                .createSignedUrl(c.image_url, 3600);

              if (!signErr && signedData?.signedUrl) {
                signedImageUrl = signedData.signedUrl;
              }
            } catch {
              // On signing failure, leave null so component uses image fallback
              signedImageUrl = null;
            }
          }
        }

        return {
          ...c,
          departmentName: c.department?.name || 'Unassigned',
          imageUrl: signedImageUrl,
        };
      })
    );

    // Compute live KPI stats adhering to strict business logic
    const stats = {
      total: enrichedComplaints.length,
      pending: enrichedComplaints.filter(
        (c) => c.status === 'submitted' || c.status === 'under_review'
      ).length,
      inProgress: enrichedComplaints.filter((c) => c.status === 'in_progress').length,
      resolved: enrichedComplaints.filter((c) => c.status === 'resolved').length,
      rejected: enrichedComplaints.filter((c) => c.status === 'rejected').length,
    };

    return {
      data: enrichedComplaints,
      stats,
      error: null,
    };
  } catch (err) {
    const diagnosticErr = err instanceof Error ? err : new Error(String(err));
    return {
      data: null,
      stats: null,
      error: diagnosticErr,
    };
  }
}

/**
 * Fetches single complaint details and safe audit timeline from Supabase.
 *
 * Requirements (Phase 3.5):
 * - Strictly respects RLS: Citizens can only access their own complaints.
 * - Queries by complaint_number or id (UUID).
 * - Retrieves citizen-safe timeline from public_complaint_history view.
 * - Generates signed URLs for private images; falls back gracefully.
 * - Never exposes actor_id or internal notes.
 *
 * @param {Object} params
 * @param {string} params.identifier - UUID or complaint_number (e.g. RU-2026-0001)
 * @param {Object} [params.supabaseClient=supabase]
 * @returns {Promise<{ data: Object | null, error: Error | null }>}
 */
export async function fetchComplaintDetails({ identifier, supabaseClient = supabase } = {}) {
  try {
    if (!identifier || typeof identifier !== 'string') {
      return { data: null, error: new Error('A valid complaint identifier is required.') };
    }

    const {
      data: { session },
      error: sessionError,
    } = await supabaseClient.auth.getSession();

    if (sessionError || !session?.user?.id) {
      return {
        data: null,
        error: new Error('Authentication required. Please sign in to view complaint details.'),
      };
    }

    let query = supabaseClient.from('complaints').select(`
      id,
      complaint_number,
      citizen_id,
      title,
      category,
      description,
      location,
      ward,
      status,
      priority,
      image_url,
      completion_image_url,
      sla_deadline,
      created_at,
      updated_at,
      department:departments (
        name
      )
    `);

    // Prevent PostgREST 22P02 UUID syntax error by checking format
    if (UUID_V4_REGEX.test(identifier.trim())) {
      query = query.eq('id', identifier.trim());
    } else {
      query = query.eq('complaint_number', identifier.trim());
    }

    const { data: complaint, error: queryError } = await query.maybeSingle();

    if (queryError) {
      const err = new Error(`Failed to load complaint details: ${queryError.message}`);
      return { data: null, error: attachDiagnosticDetails(err, queryError) };
    }

    // Complaint not found OR blocked by RLS
    if (!complaint) {
      return { data: null, error: null };
    }

    const storageClient =
      supabaseClient?.storage && typeof supabaseClient.storage.from === 'function'
        ? supabaseClient.storage
        : supabase.storage;

    // Resolve time-limited signed URL for primary incident image
    let signedImageUrl = null;
    if (complaint.image_url) {
      if (complaint.image_url.startsWith('http://') || complaint.image_url.startsWith('https://')) {
        signedImageUrl = complaint.image_url;
      } else {
        try {
          const { data: signedData, error: signErr } = await storageClient
            .from(COMPLAINT_STORAGE_BUCKET)
            .createSignedUrl(complaint.image_url, 3600);

          if (!signErr && signedData?.signedUrl) {
            signedImageUrl = signedData.signedUrl;
          }
        } catch {
          signedImageUrl = null;
        }
      }
    }

    // Resolve time-limited signed URL for municipal completion proof image
    let signedCompletionUrl = null;
    if (complaint.completion_image_url) {
      if (
        complaint.completion_image_url.startsWith('http://') ||
        complaint.completion_image_url.startsWith('https://')
      ) {
        signedCompletionUrl = complaint.completion_image_url;
      } else {
        try {
          const { data: signedData, error: signErr } = await storageClient
            .from(COMPLAINT_STORAGE_BUCKET)
            .createSignedUrl(complaint.completion_image_url, 3600);

          if (!signErr && signedData?.signedUrl) {
            signedCompletionUrl = signedData.signedUrl;
          }
        } catch {
          signedCompletionUrl = null;
        }
      }
    }

    // Fetch safe audit history from security-barrier view public_complaint_history
    // Strictly contains: id, complaint_id, status, stage_title, created_at, public_description. Never exposes actor_id or internal_note.
    const { data: historyData, error: historyError } = await supabaseClient
      .from('public_complaint_history')
      .select('id, complaint_id, status, stage_title, created_at, public_description')
      .eq('complaint_id', complaint.id)
      .order('created_at', { ascending: true });

    if (historyError) {
      console.warn('[complaintService] Timeline history fetch warning:', historyError.message);
    }

    const timeline = (historyData || []).map((step, idx) => ({
      id: step.id,
      status: step.status,
      title: step.stage_title,
      public_description: step.public_description || null,
      created_at: step.created_at,
      date: step.created_at,
      completed: complaint.status === 'resolved' || idx < (historyData?.length ?? 0) - 1,
    }));

    return {
      data: {
        ...complaint,
        departmentName: complaint.department?.name || 'Unassigned',
        resolution_description: complaint.resolution_description || null,
        imageUrl: signedImageUrl,
        completionImageUrl: signedCompletionUrl,
        timeline,
      },
      error: null,
    };
  } catch (err) {
    const diagnosticErr = err instanceof Error ? err : new Error(String(err));
    return { data: null, error: diagnosticErr };
  }
}
