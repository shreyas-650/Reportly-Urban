-- =============================================================================
-- Rollback: 20261128_phase8_1_completion_photo_required_UNDO.sql
-- Reverts: 20261128_phase8_1_completion_photo_required.sql
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   Restores public.transition_complaint_status() to its exact preceding
--   Phase 4.3 definition (from 20261124_phase4_3_complaint_status_workflow.sql)
--   with identical signature, defaults, owner, grants, SECURITY DEFINER, and
--   fixed search_path, and removes the Phase 8.1 additions.
-- =============================================================================

BEGIN;

-- 1. Restore exact Phase 4.3 definition of public.transition_complaint_status
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
BEGIN
  -- 7.1 Caller Authentication
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required: Anonymous callers cannot transition complaint status.'
      USING ERRCODE = '42501';
  END IF;

  v_is_admin := public.is_admin();
  v_officer_id := public.get_current_officer_id();

  -- 7.2 Acquire Row-Level Exclusive Lock on Complaint
  SELECT id, status, department_id, assigned_officer_id, updated_at
  INTO v_complaint
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  -- 7.3 Authorization Check executed BEFORE Concurrency Verification
  -- Non-authorized callers receive a generic error revealing neither existence nor updated_at
  IF NOT FOUND OR (NOT v_is_admin AND (v_officer_id IS NULL OR v_complaint.assigned_officer_id IS NULL OR v_officer_id <> v_complaint.assigned_officer_id)) THEN
    RAISE EXCEPTION 'Complaint not found or you lack permission to transition its status.'
      USING ERRCODE = '42501';
  END IF;

  -- 7.4 Mandatory Concurrency Argument Check
  IF p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'Concurrency Control Violation: p_expected_updated_at timestamp is required.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 7.5 Optimistic Concurrency Verification (SQLSTATE 40001, without leaking found timestamp)
  IF date_trunc('milliseconds', v_complaint.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
    RAISE EXCEPTION 'Concurrency Conflict: Complaint has been modified by another administrative session. Please refresh and review current state before retrying.'
      USING ERRCODE = '40001';
  END IF;

  -- 7.6 Terminal State Invariance Check
  IF v_complaint.status IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status) THEN
    RAISE EXCEPTION 'Terminal State Violation: Complaint % is in terminal state "%" and cannot undergo further status transitions.',
      p_complaint_id, v_complaint.status
      USING ERRCODE = 'P0001';
  END IF;

  -- 7.7 Administrative Rejection Governance
  -- Department officers CANNOT reject complaints. Rejection is strictly reserved for administrators.
  IF p_new_status = 'rejected'::public.complaint_status THEN
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'Unauthorized: Complaint rejection is strictly an administrative privilege. Department officers cannot reject citizen complaints.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 7.8 State Machine Transition Matrix
  IF v_complaint.status = 'submitted'::public.complaint_status THEN
    IF p_new_status NOT IN ('under_review'::public.complaint_status, 'rejected'::public.complaint_status) THEN
      RAISE EXCEPTION 'Illegal status transition: "submitted" -> "%".', p_new_status
        USING ERRCODE = 'P0001';
    END IF;
    -- Triage from submitted to under_review requires administrative review
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

  -- 7.9 Precondition: in_progress requires department AND assigned officer
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

  -- 7.10 Precondition: Rejection requires mandatory public reason
  IF p_new_status = 'rejected'::public.complaint_status THEN
    IF v_trimmed_public IS NULL OR length(v_trimmed_public) < 5 THEN
      RAISE EXCEPTION 'Rejection Reason Required: A clear public explanation (minimum 5 characters) must be provided to the citizen.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 7.11 Precondition: Resolution requires mandatory public description AND verified resolution photograph
  IF p_new_status = 'resolved'::public.complaint_status THEN
    IF v_trimmed_public IS NULL OR length(v_trimmed_public) < 10 THEN
      RAISE EXCEPTION 'Resolution Statement Required: A clear public resolution statement (minimum 10 characters) must be provided to the citizen.'
        USING ERRCODE = 'P0001';
    END IF;

    IF p_resolution_image_path IS NULL OR TRIM(p_resolution_image_path) = '' THEN
      RAISE EXCEPTION 'Resolution Evidence Required: A verified completion photograph must be uploaded before marking a complaint resolved.'
        USING ERRCODE = 'P0001';
    END IF;

    -- Verify path format strictly begins with resolution/<complaint_id>/
    IF NOT (p_resolution_image_path LIKE ('resolution/' || p_complaint_id::text || '/%')) THEN
      RAISE EXCEPTION 'Invalid Evidence Path: Resolution image path must reside strictly under resolution/%/', p_complaint_id
        USING ERRCODE = 'P0001';
    END IF;

    -- Verify object exists in storage.objects, with COALESCE checks for metadata
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
      RAISE EXCEPTION 'Resolution Evidence Not Found: Storage object "%" does not exist in bucket "complaint-images".'
        , p_resolution_image_path
        USING ERRCODE = '23503';
    END IF;

    IF v_storage_obj.mimetype = '' THEN
      RAISE EXCEPTION 'Invalid Evidence Metadata: Storage object "%" is missing a MIME type in its metadata.'
        , p_resolution_image_path
        USING ERRCODE = 'P0001';
    END IF;

    IF v_storage_obj.size < 0 THEN
      RAISE EXCEPTION 'Invalid Evidence Metadata: Storage object "%" is missing file size metadata.'
        , p_resolution_image_path
        USING ERRCODE = 'P0001';
    END IF;

    IF v_storage_obj.mimetype NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
      RAISE EXCEPTION 'Invalid Evidence MIME: Resolution evidence must be JPEG, PNG, or WebP. Found: %', v_storage_obj.mimetype
        USING ERRCODE = 'P0001';
    END IF;

    IF v_storage_obj.size > 8388608 THEN
      RAISE EXCEPTION 'Evidence Size Exceeded: Resolution evidence exceeds 8 MB limit (% bytes).', v_storage_obj.size
        USING ERRCODE = 'P0001';
    END IF;

    -- Insert verified evidence record into complaint_resolution_evidence
    INSERT INTO public.complaint_resolution_evidence (
      complaint_id,
      storage_path,
      file_size_bytes,
      mime_type,
      uploaded_by,
      created_at
    ) VALUES (
      p_complaint_id,
      p_resolution_image_path,
      v_storage_obj.size,
      v_storage_obj.mimetype,
      v_caller_id,
      pg_catalog.now()
    );
  END IF;

  -- 7.12 Derive Canonical Stage Title
  v_stage_title := CASE p_new_status
    WHEN 'under_review'::public.complaint_status THEN 'Under Municipal Review'
    WHEN 'in_progress'::public.complaint_status THEN 'Remediation In Progress'
    WHEN 'resolved'::public.complaint_status THEN 'Issue Resolved'
    WHEN 'rejected'::public.complaint_status THEN 'Report Rejected'
    ELSE 'Status Updated'
  END;

  -- 7.13 Update Complaint Record Atomically
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

  -- 7.14 Append to Immutable Complaint Status History
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
  'Atomic civic complaint state machine. Enforces role checks, transition matrix, optimistic concurrency (40001), and evidence verification.';

-- 2. Drop Phase 8.1 RPC, triggers, storage policies, and added columns
DROP FUNCTION IF EXISTS public.register_resolution_evidence(
  UUID, TEXT, UUID, BIGINT, TEXT, BOOLEAN, INT, INT, TEXT
);

DROP POLICY IF EXISTS "Block updates to resolution evidence objects" ON storage.objects;
DROP POLICY IF EXISTS "Block deletes of resolution evidence objects" ON storage.objects;

DROP TRIGGER IF EXISTS trg_guard_resolution_evidence_insert_state ON public.complaint_resolution_evidence;
DROP FUNCTION IF EXISTS public.guard_resolution_evidence_insert_state();

ALTER TABLE public.complaint_resolution_evidence
  DROP CONSTRAINT IF EXISTS chk_resolution_evidence_upload_status,
  DROP CONSTRAINT IF EXISTS chk_resolution_evidence_dimensions,
  DROP COLUMN IF EXISTS upload_status,
  DROP COLUMN IF EXISTS exif_stripped,
  DROP COLUMN IF EXISTS image_width,
  DROP COLUMN IF EXISTS image_height,
  DROP COLUMN IF EXISTS sha256_hash;

COMMIT;
