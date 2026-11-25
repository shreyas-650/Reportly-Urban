-- =============================================================================
-- Migration: 20261128_phase8_1_completion_photo_required.sql
-- Module: Phase 8.1 — Require Verified, Metadata-Stripped Completion Photo
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   1. Extends public.complaint_resolution_evidence with upload_status ('pending' |
--      'completed'), exif_stripped verification, dimensions, and SHA-256 metadata.
--      Existing historical rows default safely to upload_status = 'completed'.
--   2. Adds a BEFORE INSERT trigger blocking resolution evidence attachment on
--      non-in-progress complaints or mismatched storage paths.
--   3. Adds RESTRICTIVE UPDATE and DELETE storage policies on storage.objects for
--      complaint-images/resolution/* to reinforce immutability of completion evidence.
--   4. Creates public.register_resolution_evidence() (service_role only) called by
--      the trusted backend after magic-byte validation, dimension checks, EXIF/GPS
--      removal, and Storage upload.
--   5. Replaces public.transition_complaint_status() (identical 6-arg signature,
--      SECURITY DEFINER, owner, grants, search_path, row lock, and concurrency)
--      so future transitions to 'resolved' require an existing 'completed' and
--      exif_stripped = TRUE evidence record for that exact complaint plus live
--      storage.objects presence, while re-verifying current role & assignment.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaints'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaints does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaint_resolution_evidence does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'transition_complaint_status'
      AND n.nspname = 'public'
      AND p.pronargs = 6
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: 6-parameter public.transition_complaint_status is missing.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Extend public.complaint_resolution_evidence for Upload & Verification State
-- -----------------------------------------------------------------------------
ALTER TABLE public.complaint_resolution_evidence
  ADD COLUMN IF NOT EXISTS upload_status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS exif_stripped BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS image_width INT NULL,
  ADD COLUMN IF NOT EXISTS image_height INT NULL,
  ADD COLUMN IF NOT EXISTS sha256_hash TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_resolution_evidence_upload_status'
      AND conrelid = 'public.complaint_resolution_evidence'::regclass
  ) THEN
    ALTER TABLE public.complaint_resolution_evidence
      ADD CONSTRAINT chk_resolution_evidence_upload_status
      CHECK (upload_status IN ('pending', 'completed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_resolution_evidence_dimensions'
      AND conrelid = 'public.complaint_resolution_evidence'::regclass
  ) THEN
    ALTER TABLE public.complaint_resolution_evidence
      ADD CONSTRAINT chk_resolution_evidence_dimensions
      CHECK (
        (image_width IS NULL OR image_width > 0) AND
        (image_height IS NULL OR image_height > 0)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.complaint_resolution_evidence.upload_status IS
  'Tracks whether completion photo upload and verification finished (pending | completed).';
COMMENT ON COLUMN public.complaint_resolution_evidence.exif_stripped IS
  'TRUE only when the trusted backend stripped EXIF/GPS metadata and re-verified decoding before storage.';
COMMENT ON COLUMN public.complaint_resolution_evidence.sha256_hash IS
  'SHA-256 digest of the metadata-stripped image stored in complaint-images.';

-- -----------------------------------------------------------------------------
-- 3. Guard Trigger: Prevent Attaching Evidence to Resolved/Rejected Complaints
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_resolution_evidence_insert_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status public.complaint_status;
BEGIN
  IF NEW.storage_path IS NULL OR NOT (NEW.storage_path LIKE ('resolution/' || NEW.complaint_id::text || '/%')) THEN
    RAISE EXCEPTION 'Invalid Evidence Path: Resolution evidence path must belong strictly to complaint %.', NEW.complaint_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT status INTO v_status
  FROM public.complaints
  WHERE id = NEW.complaint_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Complaint not found for resolution evidence registration.'
      USING ERRCODE = '23503';
  END IF;

  IF v_status <> 'in_progress'::public.complaint_status THEN
    RAISE EXCEPTION 'Evidence Insert Rejected: Resolution evidence can only be registered while complaint is in_progress (current: %).', v_status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_resolution_evidence_insert_state() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_resolution_evidence_insert_state() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_resolution_evidence_insert_state() IS
  'Prevents attaching or replacing completion evidence rows after a complaint leaves in_progress or across complaints.';

DROP TRIGGER IF EXISTS trg_guard_resolution_evidence_insert_state ON public.complaint_resolution_evidence;
CREATE TRIGGER trg_guard_resolution_evidence_insert_state
  BEFORE INSERT ON public.complaint_resolution_evidence
  FOR EACH ROW EXECUTE FUNCTION public.guard_resolution_evidence_insert_state();

-- -----------------------------------------------------------------------------
-- 4. Tighten storage.objects Policies (Explicitly Restrict UPDATE & DELETE on resolution/*)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Block updates to resolution evidence objects" ON storage.objects;
CREATE POLICY "Block updates to resolution evidence objects"
  ON storage.objects
  AS RESTRICTIVE
  FOR UPDATE
  TO anon, authenticated
  USING (NOT (bucket_id = 'complaint-images' AND (storage.foldername(name))[1] = 'resolution'))
  WITH CHECK (NOT (bucket_id = 'complaint-images' AND (storage.foldername(name))[1] = 'resolution'));

DROP POLICY IF EXISTS "Block deletes of resolution evidence objects" ON storage.objects;
CREATE POLICY "Block deletes of resolution evidence objects"
  ON storage.objects
  AS RESTRICTIVE
  FOR DELETE
  TO anon, authenticated
  USING (NOT (bucket_id = 'complaint-images' AND (storage.foldername(name))[1] = 'resolution'));

-- -----------------------------------------------------------------------------
-- 5. Trusted Backend RPC: public.register_resolution_evidence
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_resolution_evidence(
  p_complaint_id UUID,
  p_storage_path TEXT,
  p_uploaded_by UUID,
  p_file_size_bytes BIGINT,
  p_mime_type TEXT,
  p_exif_stripped BOOLEAN DEFAULT TRUE,
  p_image_width INT DEFAULT NULL,
  p_image_height INT DEFAULT NULL,
  p_sha256_hash TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_complaint RECORD;
  v_role public.user_role;
  v_officer_id UUID;
  v_storage_obj RECORD;
  v_existing RECORD;
  v_evidence_id UUID;
BEGIN
  IF p_complaint_id IS NULL OR p_uploaded_by IS NULL THEN
    RAISE EXCEPTION 'Invalid Evidence Arguments: complaint_id and uploaded_by are required.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_storage_path IS NULL OR TRIM(p_storage_path) = '' THEN
    RAISE EXCEPTION 'Invalid Evidence Path: storage_path is required.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT (p_storage_path LIKE ('resolution/' || p_complaint_id::text || '/%')) THEN
    RAISE EXCEPTION 'Invalid Evidence Path: Resolution image path must reside under resolution/%/.', p_complaint_id
      USING ERRCODE = 'P0001';
  END IF;

  IF p_exif_stripped IS NOT TRUE THEN
    RAISE EXCEPTION 'Unverified Evidence: Completion photos must pass server-side EXIF/GPS stripping before registration.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_mime_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'Invalid Evidence MIME: Only JPEG, PNG, and WebP completion photos are allowed.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_file_size_bytes IS NULL OR p_file_size_bytes <= 0 OR p_file_size_bytes > 8388608 THEN
    RAISE EXCEPTION 'Invalid Evidence Size: File size must be between 1 byte and 8 MB.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock target complaint row and verify role + current assignment
  SELECT id, status, assigned_officer_id
  INTO v_complaint
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Complaint not found or access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = p_uploaded_by;

  IF v_role IS NULL OR v_role NOT IN ('admin'::public.user_role, 'officer'::public.user_role) THEN
    RAISE EXCEPTION 'Complaint not found or access denied.'
      USING ERRCODE = '42501';
  END IF;

  IF v_role = 'officer'::public.user_role THEN
    SELECT id INTO v_officer_id
    FROM public.officers
    WHERE profile_id = p_uploaded_by
      AND is_active = TRUE
    LIMIT 1;

    IF v_officer_id IS NULL OR v_complaint.assigned_officer_id IS NULL OR v_officer_id <> v_complaint.assigned_officer_id THEN
      RAISE EXCEPTION 'Complaint not found or access denied.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_complaint.status <> 'in_progress'::public.complaint_status THEN
    RAISE EXCEPTION 'Invalid Complaint State: Completion photos can only be attached while complaint is in_progress.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Verify stored object actually exists in private complaint-images bucket
  SELECT
    id,
    name,
    COALESCE(metadata->>'mimetype', '') AS mimetype,
    COALESCE((metadata->>'size')::bigint, -1) AS size
  INTO v_storage_obj
  FROM storage.objects
  WHERE bucket_id = 'complaint-images'
    AND name = p_storage_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resolution Evidence Not Found: Storage object "%" does not exist in bucket "complaint-images".',
      p_storage_path
      USING ERRCODE = '23503';
  END IF;

  IF v_storage_obj.mimetype <> p_mime_type THEN
    RAISE EXCEPTION 'Evidence MIME Mismatch: Stored object MIME does not match verified image type.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_storage_obj.size <> p_file_size_bytes OR v_storage_obj.size <= 0 OR v_storage_obj.size > 8388608 THEN
    RAISE EXCEPTION 'Evidence Size Mismatch: Stored object size does not match verified upload.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent retry support when storage upload succeeded earlier and registration is retried
  SELECT id, complaint_id, uploaded_by, upload_status, exif_stripped
  INTO v_existing
  FROM public.complaint_resolution_evidence
  WHERE storage_path = p_storage_path;

  IF FOUND THEN
    IF v_existing.complaint_id <> p_complaint_id OR v_existing.uploaded_by <> p_uploaded_by THEN
      RAISE EXCEPTION 'Evidence Conflict: Storage path is already registered to another record.'
        USING ERRCODE = '42501';
    END IF;

    IF v_existing.upload_status = 'completed' AND v_existing.exif_stripped IS TRUE THEN
      RETURN v_existing.id;
    END IF;

    RAISE EXCEPTION 'Evidence Conflict: Existing record is incomplete and cannot be marked resolved.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.complaint_resolution_evidence (
    complaint_id,
    storage_path,
    file_size_bytes,
    mime_type,
    uploaded_by,
    upload_status,
    exif_stripped,
    image_width,
    image_height,
    sha256_hash,
    created_at
  ) VALUES (
    p_complaint_id,
    p_storage_path,
    p_file_size_bytes,
    p_mime_type,
    p_uploaded_by,
    'completed',
    TRUE,
    p_image_width,
    p_image_height,
    p_sha256_hash,
    pg_catalog.now()
  )
  RETURNING id INTO v_evidence_id;

  RETURN v_evidence_id;
END;
$$;

ALTER FUNCTION public.register_resolution_evidence(
  UUID, TEXT, UUID, BIGINT, TEXT, BOOLEAN, INT, INT, TEXT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.register_resolution_evidence(
  UUID, TEXT, UUID, BIGINT, TEXT, BOOLEAN, INT, INT, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_resolution_evidence(
  UUID, TEXT, UUID, BIGINT, TEXT, BOOLEAN, INT, INT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.register_resolution_evidence(
  UUID, TEXT, UUID, BIGINT, TEXT, BOOLEAN, INT, INT, TEXT
) IS
  'Trusted backend-only RPC to register validated, EXIF-stripped completion photo metadata for in_progress complaints.';

-- -----------------------------------------------------------------------------
-- 6. Harden public.transition_complaint_status (Phase 8.1 Enforcement)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_complaint_status(
  p_complaint_id UUID,
  p_new_status public.complaint_status,
  p_expected_updated_at TIMESTAMPTZ,
  p_public_description TEXT DEFAULT NULL,
  p_internal_note TEXT DEFAULT NULL,
  p_resolution_image_path TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID;
  v_is_admin BOOLEAN;
  v_officer_id UUID;
  v_complaint RECORD;
  v_stage_title TEXT;
  v_trimmed_public TEXT;
  v_trimmed_internal TEXT;
  v_storage_obj RECORD;
  v_evidence RECORD;
BEGIN
  -- 6.1 Caller Authentication (derived from verified JWT auth.uid())
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required: Anonymous callers cannot transition complaint status.'
      USING ERRCODE = '42501';
  END IF;

  -- Recheck authoritative caller role & active officer record at resolution time
  v_is_admin := public.is_admin();
  v_officer_id := public.get_current_officer_id();

  -- 6.2 Acquire Row-Level Exclusive Lock on Complaint before checking assignment/status
  SELECT id, status, department_id, assigned_officer_id, updated_at
  INTO v_complaint
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  -- 6.3 Authorization Check (rechecks CURRENT assignment; non-authorized get generic 42501)
  IF NOT FOUND OR (NOT v_is_admin AND (v_officer_id IS NULL OR v_complaint.assigned_officer_id IS NULL OR v_officer_id <> v_complaint.assigned_officer_id)) THEN
    RAISE EXCEPTION 'Complaint not found or you lack permission to transition its status.'
      USING ERRCODE = '42501';
  END IF;

  -- 6.4 Mandatory Concurrency Argument Check
  IF p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'Concurrency Control Violation: p_expected_updated_at timestamp is required.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 6.5 Optimistic Concurrency Verification (SQLSTATE 40001, without leaking found timestamp)
  IF date_trunc('milliseconds', v_complaint.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
    RAISE EXCEPTION 'Concurrency Conflict: Complaint has been modified by another administrative session. Please refresh and review current state before retrying.'
      USING ERRCODE = '40001';
  END IF;

  -- 6.6 Terminal State Invariance Check (existing resolved/rejected complaints cannot transition)
  IF v_complaint.status IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status) THEN
    RAISE EXCEPTION 'Terminal State Violation: Complaint % is in terminal state "%" and cannot undergo further status transitions.',
      p_complaint_id, v_complaint.status
      USING ERRCODE = 'P0001';
  END IF;

  -- 6.7 Administrative Rejection Governance
  IF p_new_status = 'rejected'::public.complaint_status THEN
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'Unauthorized: Complaint rejection is strictly an administrative privilege. Department officers cannot reject citizen complaints.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 6.8 State Machine Transition Matrix
  IF v_complaint.status = 'submitted'::public.complaint_status THEN
    IF p_new_status NOT IN ('under_review'::public.complaint_status, 'rejected'::public.complaint_status) THEN
      RAISE EXCEPTION 'Illegal status transition: "submitted" -> "%".', p_new_status
        USING ERRCODE = 'P0001';
    END IF;
    IF p_new_status = 'under_review'::public.complaint_status AND NOT v_is_admin THEN
      RAISE EXCEPTION 'Unauthorized: Administrative review is required to transition submitted complaints to under_review.'
        USING ERRCODE = '42501';
    END IF;

  ELSIF v_complaint.status = 'under_review'::public.complaint_status THEN
    IF p_new_status NOT IN ('in_progress'::public.complaint_status, 'rejected'::public.complaint_status) THEN
      RAISE EXCEPTION 'Illegal status transition: "under_review" -> "%".', p_new_status
        USING ERRCODE = 'P0001';
    END IF;

  ELSIF v_complaint.status = 'in_progress'::public.complaint_status THEN
    IF p_new_status NOT IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status) THEN
      RAISE EXCEPTION 'Illegal status transition: "in_progress" -> "%".', p_new_status
        USING ERRCODE = 'P0001';
    END IF;

  ELSE
    RAISE EXCEPTION 'Illegal status transition from current status "%".', v_complaint.status
      USING ERRCODE = 'P0001';
  END IF;

  -- 6.9 Precondition: in_progress requires department AND assigned officer
  IF p_new_status = 'in_progress'::public.complaint_status THEN
    IF v_complaint.department_id IS NULL THEN
      RAISE EXCEPTION 'Precondition Failed: Cannot move complaint to in_progress without an assigned department.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_complaint.assigned_officer_id IS NULL THEN
      RAISE EXCEPTION 'Precondition Failed: Cannot move complaint to in_progress without an assigned officer.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_trimmed_public := NULLIF(TRIM(p_public_description), '');
  v_trimmed_internal := NULLIF(TRIM(p_internal_note), '');

  -- 6.10 Precondition: Rejection requires mandatory public reason
  IF p_new_status = 'rejected'::public.complaint_status THEN
    IF v_trimmed_public IS NULL OR length(v_trimmed_public) < 5 THEN
      RAISE EXCEPTION 'Rejection Reason Required: A clear public explanation (minimum 5 characters) must be provided to the citizen.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 6.11 Precondition: Resolution requires statement + completed, verified evidence record + live storage object
  IF p_new_status = 'resolved'::public.complaint_status THEN
    IF v_trimmed_public IS NULL OR length(v_trimmed_public) < 10 THEN
      RAISE EXCEPTION 'Resolution Statement Required: A clear public resolution statement (minimum 10 characters) must be provided to the citizen.'
        USING ERRCODE = 'P0001';
    END IF;

    IF p_resolution_image_path IS NULL OR TRIM(p_resolution_image_path) = '' THEN
      RAISE EXCEPTION 'Resolution Evidence Required: A verified completion photograph must be uploaded before marking a complaint resolved.'
        USING ERRCODE = 'P0001';
    END IF;

    IF NOT (p_resolution_image_path LIKE ('resolution/' || p_complaint_id::text || '/%')) THEN
      RAISE EXCEPTION 'Invalid Evidence Path: Resolution image path must reside strictly under resolution/%/.', p_complaint_id
        USING ERRCODE = 'P0001';
    END IF;

    -- Verify a registered completion photo record exists belonging to THIS exact complaint
    SELECT
      id,
      complaint_id,
      storage_path,
      file_size_bytes,
      mime_type,
      upload_status,
      exif_stripped
    INTO v_evidence
    FROM public.complaint_resolution_evidence
    WHERE complaint_id = p_complaint_id
      AND storage_path = p_resolution_image_path
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Resolution Evidence Required: No completed completion photograph record is registered for this complaint.'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_evidence.upload_status IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'Resolution Upload Incomplete: Completion photograph upload is still pending and cannot resolve this complaint.'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_evidence.exif_stripped IS NOT TRUE THEN
      RAISE EXCEPTION 'Unverified Resolution Evidence: Completion photograph has not completed server-side validation and metadata removal.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Re-verify stored object exists in storage.objects and matches registered metadata
    SELECT
      id,
      name,
      COALESCE(metadata->>'mimetype', '') AS mimetype,
      COALESCE((metadata->>'size')::bigint, -1) AS size
    INTO v_storage_obj
    FROM storage.objects
    WHERE bucket_id = 'complaint-images'
      AND name = p_resolution_image_path;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Resolution Evidence Not Found: Storage object "%" does not exist in bucket "complaint-images".',
        p_resolution_image_path
        USING ERRCODE = '23503';
    END IF;

    IF v_storage_obj.mimetype NOT IN ('image/jpeg', 'image/png', 'image/webp')
       OR v_storage_obj.mimetype <> v_evidence.mime_type THEN
      RAISE EXCEPTION 'Invalid Evidence MIME: Resolution evidence MIME mismatch or unsupported format.'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_storage_obj.size <= 0
       OR v_storage_obj.size > 8388608
       OR v_storage_obj.size <> v_evidence.file_size_bytes THEN
      RAISE EXCEPTION 'Evidence Size Mismatch: Stored completion photograph size is missing, over 8 MB, or inconsistent.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 6.12 Derive Canonical Stage Title
  v_stage_title := CASE p_new_status
    WHEN 'under_review'::public.complaint_status THEN 'Under Municipal Review'
    WHEN 'in_progress'::public.complaint_status THEN 'Remediation In Progress'
    WHEN 'resolved'::public.complaint_status THEN 'Issue Resolved'
    WHEN 'rejected'::public.complaint_status THEN 'Report Rejected'
    ELSE 'Status Updated'
  END;

  -- 6.13 Update Complaint Record Atomically
  UPDATE public.complaints
  SET status = p_new_status,
      resolution_description = CASE
        WHEN p_new_status = 'resolved'::public.complaint_status THEN v_trimmed_public
        ELSE resolution_description
      END,
      completion_image_url = CASE
        WHEN p_new_status = 'resolved'::public.complaint_status THEN p_resolution_image_path
        ELSE completion_image_url
      END,
      updated_at = pg_catalog.now()
  WHERE id = p_complaint_id;

  -- 6.14 Append to Immutable Complaint Status History
  INSERT INTO public.complaint_status_history (
    complaint_id,
    status,
    previous_status,
    title,
    public_description,
    internal_note,
    actor_id,
    created_at
  ) VALUES (
    p_complaint_id,
    p_new_status,
    v_complaint.status,
    v_stage_title,
    v_trimmed_public,
    v_trimmed_internal,
    v_caller_id,
    pg_catalog.now()
  );
END;
$$;

ALTER FUNCTION public.transition_complaint_status(
  UUID, public.complaint_status, TIMESTAMPTZ, TEXT, TEXT, TEXT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.transition_complaint_status(
  UUID, public.complaint_status, TIMESTAMPTZ, TEXT, TEXT, TEXT
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.transition_complaint_status(
  UUID, public.complaint_status, TIMESTAMPTZ, TEXT, TEXT, TEXT
) TO authenticated;

COMMENT ON FUNCTION public.transition_complaint_status(
  UUID, public.complaint_status, TIMESTAMPTZ, TEXT, TEXT, TEXT
) IS
  'Atomic civic complaint state machine. Enforces role checks, current assignment, optimistic concurrency (40001), and Phase 8.1 verified completion evidence.';

COMMIT;
