-- =============================================================================
-- Migration: 20261124_phase4_3_complaint_status_workflow.sql
-- Module: Phase 4.3 — Complaint Status Management & Resolution Workflow (Hardened)
-- Target: Supabase PostgreSQL
--
-- Safety Guarantees:
--   - Idempotent and transaction-safe (BEGIN ... COMMIT).
--   - Explicitly drops old 4-parameter overload of public.transition_complaint_status()
--     identifying it via p.pronargs = 4 to avoid pattern mismatch.
--   - Adds 'resolution_description' to public.complaints (written only by RPC).
--   - Revokes direct UPDATE on status, completion_image_url, and resolution_description from authenticated & anon.
--   - Adds 'previous_status', 'public_description', and 'internal_note' to
--     public.complaint_status_history (leaves legacy rows NULL; never backfilled).
--   - Existing immutability triggers on complaint_status_history remain intact.
--   - Creates immutable public.complaint_resolution_evidence table with UPDATE,
--     DELETE, and TRUNCATE guards.
--   - Configures storage RLS on storage.objects for resolution photos:
--       * Staff can upload only for complaints in 'in_progress' status to
--         resolution/<complaint_id>/* with safe UUID regex parsing.
--       * Citizens can view resolution photos only for their own complaints
--         that are in 'resolved' status.
--       * No UPDATE or DELETE policies granted on storage.objects.
--   - Dynamically drops all existing SELECT and ALL policies on complaint_status_history
--     and establishes a single SELECT policy strictly for administrators and the assigned officer.
--   - Revokes INSERT, UPDATE, DELETE, TRUNCATE on complaint_status_history from client roles.
--     (Background: Both handle_new_complaint_post_insert and transition_complaint_status
--      are SECURITY DEFINER owned by postgres, so citizen submission and transitions succeed).
--   - Updates security-barrier view public.public_complaint_history with an explicit
--     ownership filter (WHERE EXISTS on own complaint, assigned officer, or admin)
--     and appends public_description while strictly omitting internal_note, notes, and actor_id.
--   - Implements atomic public.transition_complaint_status():
--       * Authorization check executed BEFORE concurrency check. Non-authorized callers
--         receive a generic 42501 error revealing neither existence nor updated_at.
--       * Stale concurrency check uses distinct SQLSTATE 40001 and removes found timestamp.
--       * Enforces admin-only rejection and assigned officer requirement for in_progress.
--       * In the resolved branch, COALESCEs storage metadata mimetype and size and raises
--         explicit errors if metadata is missing.
--   - Complete verification block validating policy counts, lack of ALL policies,
--     and column-level UPDATE privileges.
--   - Complete rollback section restoring exact Phase 2/3 definitions.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- 1.1 Verify required tables exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaints'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaints does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaint_status_history does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'departments'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.departments does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'officers'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.officers does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.profiles does not exist.';
  END IF;

  -- 1.2 Verify status enum values exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'complaint_status' AND e.enumlabel = 'submitted'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'complaint_status' AND e.enumlabel = 'under_review'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'complaint_status' AND e.enumlabel = 'in_progress'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'complaint_status' AND e.enumlabel = 'resolved'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'complaint_status' AND e.enumlabel = 'rejected'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Enum public.complaint_status is missing expected states.';
  END IF;

  -- 1.3 Verify helper functions exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'is_admin' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Helper function public.is_admin() does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_current_officer_id' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Helper function public.get_current_officer_id() does not exist.';
  END IF;

  -- 1.4 Precondition check for legacy 4-param overload using pronargs = 4
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'transition_complaint_status' AND n.nspname = 'public'
      AND p.pronargs = 4
  ) THEN
    RAISE NOTICE 'Notice: Legacy 4-parameter transition_complaint_status identified for replacement.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Drop Legacy Function Overload
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.transition_complaint_status(
  UUID,
  public.complaint_status,
  TEXT,
  TEXT
);

-- -----------------------------------------------------------------------------
-- 3. Schema Enhancements & Column Lockdown
-- -----------------------------------------------------------------------------

-- 3.1 Add resolution_description to public.complaints
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS resolution_description TEXT NULL;

-- 3.2 Revoke direct UPDATE on status, completion_image_url, and resolution_description
REVOKE UPDATE (status, completion_image_url, resolution_description)
  ON TABLE public.complaints FROM PUBLIC, anon, authenticated;

-- Ensure operational update permissions remain strictly on citizen editable fields
GRANT UPDATE (title, description, location, ward, latitude, longitude)
  ON TABLE public.complaints TO authenticated;

-- 3.3 Add audit columns to public.complaint_status_history
-- Non-destructive: leaves all legacy rows NULL; legacy notes column remains unexposed.
ALTER TABLE public.complaint_status_history
  ADD COLUMN IF NOT EXISTS previous_status public.complaint_status NULL,
  ADD COLUMN IF NOT EXISTS public_description TEXT NULL,
  ADD COLUMN IF NOT EXISTS internal_note TEXT NULL;

-- 3.4 Create public.complaint_resolution_evidence table
CREATE TABLE IF NOT EXISTS public.complaint_resolution_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  storage_path TEXT NOT NULL UNIQUE,
  file_size_bytes BIGINT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Index for rapid complaint evidence resolution
CREATE INDEX IF NOT EXISTS idx_resolution_evidence_complaint
  ON public.complaint_resolution_evidence(complaint_id);

CREATE INDEX IF NOT EXISTS idx_complaint_history_complaint_status
  ON public.complaint_status_history(complaint_id, status);

-- 3.5 Immutability Triggers on complaint_resolution_evidence (Update, Delete, Truncate)
CREATE OR REPLACE FUNCTION public.guard_resolution_evidence_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Civic resolution evidence is strictly immutable and cannot be updated or deleted.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_resolution_evidence_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_resolution_evidence_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_resolution_evidence_immutable ON public.complaint_resolution_evidence;
CREATE TRIGGER trg_guard_resolution_evidence_immutable
  BEFORE UPDATE OR DELETE ON public.complaint_resolution_evidence
  FOR EACH ROW EXECUTE FUNCTION public.guard_resolution_evidence_immutable();

-- Truncate guard for complaint_resolution_evidence
CREATE OR REPLACE FUNCTION public.guard_resolution_evidence_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Civic resolution evidence is strictly immutable and truncating is prohibited.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_resolution_evidence_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_resolution_evidence_truncate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_resolution_evidence_truncate ON public.complaint_resolution_evidence;
CREATE TRIGGER trg_guard_resolution_evidence_truncate
  BEFORE TRUNCATE ON public.complaint_resolution_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_resolution_evidence_truncate();

-- 3.6 Enable RLS & Table Grants on complaint_resolution_evidence
ALTER TABLE public.complaint_resolution_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_resolution_evidence FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.complaint_resolution_evidence FROM authenticated;
GRANT SELECT ON TABLE public.complaint_resolution_evidence TO authenticated;

-- Resolution evidence SELECT policy:
DROP POLICY IF EXISTS "Resolution evidence readable by owner, assigned officer, or admin"
  ON public.complaint_resolution_evidence;

CREATE POLICY "Resolution evidence readable by owner, assigned officer, or admin"
  ON public.complaint_resolution_evidence
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_resolution_evidence.complaint_id
      AND (
        (c.citizen_id = (SELECT auth.uid()) AND c.status = 'resolved'::public.complaint_status) OR
        c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
        (SELECT public.is_admin())
      )
    )
  );

COMMENT ON TABLE public.complaint_resolution_evidence IS
  'Immutable civic resolution evidence metadata linking storage objects to verified complaints.';

-- -----------------------------------------------------------------------------
-- 4. Storage Security Policies on storage.objects
-- -----------------------------------------------------------------------------

-- 4.1 Staff Resolution Image Upload Policy (INSERT)
DROP POLICY IF EXISTS "Staff can upload resolution images for in-progress complaints" ON storage.objects;

CREATE POLICY "Staff can upload resolution images for in-progress complaints"
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'complaint-images'
    AND (storage.foldername(name))[1] = 'resolution'
    AND (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = (
        CASE
          WHEN (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN ((storage.foldername(name))[2])::uuid
          ELSE NULL
        END
      )
        AND c.status = 'in_progress'::public.complaint_status
        AND (
          (SELECT public.is_admin()) OR
          c.assigned_officer_id = (SELECT public.get_current_officer_id())
        )
    )
  );

-- 4.2 Citizen Resolution Image Read Policy (SELECT)
DROP POLICY IF EXISTS "Citizens can view resolution evidence of own resolved complaints" ON storage.objects;

CREATE POLICY "Citizens can view resolution evidence of own resolved complaints"
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'complaint-images'
    AND (storage.foldername(name))[1] = 'resolution'
    AND EXISTS (
      SELECT 1 FROM public.complaint_resolution_evidence e
      JOIN public.complaints c ON c.id = e.complaint_id
      WHERE e.storage_path = storage.objects.name
        AND c.citizen_id = (SELECT auth.uid())
        AND c.status = 'resolved'::public.complaint_status
    )
  );

-- 4.3 Staff Resolution Image Read Policy (SELECT)
DROP POLICY IF EXISTS "Staff can view resolution evidence of assigned complaints or all" ON storage.objects;

CREATE POLICY "Staff can view resolution evidence of assigned complaints or all"
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'complaint-images'
    AND (storage.foldername(name))[1] = 'resolution'
    AND (
      (SELECT public.is_admin()) OR
      (
        (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND EXISTS (
          SELECT 1 FROM public.complaints c
          WHERE c.id = (
            CASE
              WHEN (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN ((storage.foldername(name))[2])::uuid
              ELSE NULL
            END
          )
            AND c.assigned_officer_id = (SELECT public.get_current_officer_id())
        )
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 5. Restrict Complaint Status History Policies & Table Privileges
-- -----------------------------------------------------------------------------
-- 5.1 Revoke all mutation privileges on complaint_status_history from client roles
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.complaint_status_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.complaint_status_history TO authenticated;

-- 5.2 Dynamically drop all existing read-granting (SELECT or ALL) policies on complaint_status_history
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'complaint_status_history'
      AND cmd IN ('SELECT', 'ALL')
  ) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.complaint_status_history;', r.policyname);
  END LOOP;
END $$;

-- 5.3 Establish single authoritative SELECT policy for assigned officer or administrator
CREATE POLICY "History readable by assigned officer or admin"
  ON public.complaint_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_status_history.complaint_id
      AND (
        c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
        (SELECT public.is_admin())
      )
    )
  );

COMMENT ON POLICY "History readable by assigned officer or admin" ON public.complaint_status_history IS
  'Protects operational notes: status history is viewable only by the assigned officer and administrators.';

-- -----------------------------------------------------------------------------
-- 6. Update Security-Barrier View public.public_complaint_history
-- -----------------------------------------------------------------------------
-- Adds an explicit ownership filter so citizens can see history ONLY for their own complaints.
-- Other citizens, unassigned officers, and anon get 0 rows.
-- Appends public_description at the end. internal_note, notes, and actor_id remain strictly excluded.
CREATE OR REPLACE VIEW public.public_complaint_history
WITH (security_barrier = TRUE) AS
  SELECT
    h.id,
    h.complaint_id,
    h.status,
    CASE h.status
      WHEN 'submitted'::public.complaint_status THEN 'Report Registered'
      WHEN 'under_review'::public.complaint_status THEN 'Under Municipal Review'
      WHEN 'in_progress'::public.complaint_status THEN 'Remediation In Progress'
      WHEN 'resolved'::public.complaint_status THEN 'Issue Resolved'
      WHEN 'rejected'::public.complaint_status THEN 'Report Rejected'
      ELSE 'Status Updated'
    END AS stage_title,
    h.created_at,
    h.public_description
  FROM public.complaint_status_history h
  WHERE EXISTS (
    SELECT 1 FROM public.complaints c
    WHERE c.id = h.complaint_id
      AND (
        c.citizen_id = (SELECT auth.uid()) OR
        c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
        (SELECT public.is_admin())
      )
  );

ALTER VIEW public.public_complaint_history OWNER TO postgres;
REVOKE ALL ON public.public_complaint_history FROM PUBLIC, anon;
GRANT SELECT ON public.public_complaint_history TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. Atomic Status Transition Procedure
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

-- Function Ownership and Grants
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

-- -----------------------------------------------------------------------------
-- 8. Post-Migration Verification Queries
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- 8.1 Verify resolution_description column on complaints
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaints'
      AND column_name = 'resolution_description'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Column resolution_description missing from public.complaints.';
  END IF;

  -- 8.2 Verify history audit columns
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
      AND column_name = 'previous_status'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
      AND column_name = 'public_description'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
      AND column_name = 'internal_note'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Status history audit columns missing.';
  END IF;

  -- 8.3 Verify complaint_resolution_evidence table and index
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Table public.complaint_resolution_evidence missing.';
  END IF;

  -- 8.4 Verify view public_complaint_history has public_description
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'public_complaint_history'
      AND column_name = 'public_description'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: View public.public_complaint_history does not expose public_description.';
  END IF;

  -- 8.5 Verify legacy 4-param overload was dropped (checked by pronargs = 4)
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'transition_complaint_status' AND n.nspname = 'public'
      AND p.pronargs = 4
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Legacy 4-param overload of transition_complaint_status still exists.';
  END IF;

  -- 8.6 Verify new 6-param transition function exists with exact parameter count
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'transition_complaint_status' AND n.nspname = 'public'
      AND p.pronargs = 6
  ) THEN
    RAISE EXCEPTION 'Verification Failed: New 6-param transition_complaint_status function missing.';
  END IF;

  -- 8.7 Verify EXACTLY ONE read-granting policy exists on complaint_status_history,
  -- and that NO 'ALL' policy exists.
  IF (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'complaint_status_history'
      AND cmd IN ('SELECT', 'ALL')
  ) <> 1 THEN
    RAISE EXCEPTION 'Verification Failed: Expected exactly 1 read-granting (SELECT or ALL) policy on complaint_status_history.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'complaint_status_history'
      AND cmd = 'SELECT'
      AND policyname = 'History readable by assigned officer or admin'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Policy "History readable by assigned officer or admin" is missing.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'complaint_status_history'
      AND cmd = 'ALL'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: No ALL policy is permitted on complaint_status_history.';
  END IF;

  -- 8.8 Verify authenticated and anon DO NOT have INSERT, UPDATE, DELETE, or TRUNCATE on complaint_status_history
  IF has_table_privilege('authenticated', 'public.complaint_status_history', 'INSERT') OR
     has_table_privilege('authenticated', 'public.complaint_status_history', 'UPDATE') OR
     has_table_privilege('authenticated', 'public.complaint_status_history', 'DELETE') OR
     has_table_privilege('authenticated', 'public.complaint_status_history', 'TRUNCATE') OR
     has_table_privilege('anon', 'public.complaint_status_history', 'INSERT') OR
     has_table_privilege('anon', 'public.complaint_status_history', 'UPDATE') OR
     has_table_privilege('anon', 'public.complaint_status_history', 'DELETE') OR
     has_table_privilege('anon', 'public.complaint_status_history', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Verification Failed: authenticated or anon holds unauthorized mutation privileges on complaint_status_history.';
  END IF;

  -- 8.9 Verify authenticated and anon have NO UPDATE privileges on complaints.status, completion_image_url, or resolution_description
  IF has_column_privilege('authenticated', 'public.complaints', 'status', 'UPDATE') OR
     has_column_privilege('authenticated', 'public.complaints', 'completion_image_url', 'UPDATE') OR
     has_column_privilege('authenticated', 'public.complaints', 'resolution_description', 'UPDATE') OR
     has_column_privilege('anon', 'public.complaints', 'status', 'UPDATE') OR
     has_column_privilege('anon', 'public.complaints', 'completion_image_url', 'UPDATE') OR
     has_column_privilege('anon', 'public.complaints', 'resolution_description', 'UPDATE') THEN
    RAISE EXCEPTION 'Verification Failed: authenticated or anon possesses unauthorized UPDATE privilege on complaints.status, completion_image_url, or resolution_description.';
  END IF;

  -- 8.10 Verify authenticated and anon DO NOT have INSERT, UPDATE, DELETE, or TRUNCATE on complaint_resolution_evidence
  IF has_table_privilege('authenticated', 'public.complaint_resolution_evidence', 'INSERT') OR
     has_table_privilege('authenticated', 'public.complaint_resolution_evidence', 'UPDATE') OR
     has_table_privilege('authenticated', 'public.complaint_resolution_evidence', 'DELETE') OR
     has_table_privilege('authenticated', 'public.complaint_resolution_evidence', 'TRUNCATE') OR
     has_table_privilege('anon', 'public.complaint_resolution_evidence', 'INSERT') OR
     has_table_privilege('anon', 'public.complaint_resolution_evidence', 'UPDATE') OR
     has_table_privilege('anon', 'public.complaint_resolution_evidence', 'DELETE') OR
     has_table_privilege('anon', 'public.complaint_resolution_evidence', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Verification Failed: authenticated or anon holds unauthorized mutation privileges on complaint_resolution_evidence.';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK SECTION (FOR OPERATOR USE IF RESTORATION IS REQUIRED)
-- =============================================================================
-- Irreversible Artifacts Notice:
--   - Any new status transitions, history records, or resolution evidence rows
--     inserted while this migration was active cannot be automatically un-transitioned
--     without corrupting civic audit chronology.
--   - Legacy rows in complaint_status_history were never modified and remain untouched.
--
-- Rollback Steps:
--
-- 1. Drop the new transition function:
--    DROP FUNCTION IF EXISTS public.transition_complaint_status(UUID, public.complaint_status, TIMESTAMPTZ, TEXT, TEXT, TEXT);
--
-- 2. Restore the original Phase 2 transition function:
--    CREATE OR REPLACE FUNCTION public.transition_complaint_status(
--      p_complaint_id UUID,
--      p_new_status public.complaint_status,
--      p_notes TEXT DEFAULT NULL,
--      p_completion_image_url TEXT DEFAULT NULL
--    )
--    RETURNS VOID
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path = ''
--    AS $rb$
--    DECLARE
--      v_caller_id UUID;
--      v_officer_id UUID;
--      v_is_admin BOOLEAN;
--      v_current_status public.complaint_status;
--      v_assigned_officer_id UUID;
--      v_is_valid_transition BOOLEAN := FALSE;
--      v_stage_title TEXT;
--    BEGIN
--      v_caller_id := auth.uid();
--      IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501'; END IF;
--      v_is_admin := public.is_admin();
--      v_officer_id := public.get_current_officer_id();
--      SELECT status, assigned_officer_id INTO v_current_status, v_assigned_officer_id FROM public.complaints WHERE id = p_complaint_id FOR UPDATE;
--      IF NOT FOUND THEN RAISE EXCEPTION 'Complaint with ID % not found.', p_complaint_id; END IF;
--      IF NOT v_is_admin THEN
--        IF v_officer_id IS NULL OR v_assigned_officer_id IS NULL OR v_officer_id <> v_assigned_officer_id THEN
--          RAISE EXCEPTION 'Unauthorized: Caller is not the officer assigned to this complaint.' USING ERRCODE = '42501';
--        END IF;
--      END IF;
--      IF (v_current_status = 'submitted'::public.complaint_status AND p_new_status IN ('under_review'::public.complaint_status, 'rejected'::public.complaint_status)) THEN v_is_valid_transition := TRUE;
--      ELSIF (v_current_status = 'under_review'::public.complaint_status AND p_new_status IN ('in_progress'::public.complaint_status, 'rejected'::public.complaint_status)) THEN v_is_valid_transition := TRUE;
--      ELSIF (v_current_status = 'in_progress'::public.complaint_status AND p_new_status IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status)) THEN v_is_valid_transition := TRUE;
--      END IF;
--      IF NOT v_is_valid_transition THEN RAISE EXCEPTION 'Illegal status transition from % to %.', v_current_status, p_new_status; END IF;
--      v_stage_title := CASE p_new_status
--        WHEN 'under_review'::public.complaint_status THEN 'Under Municipal Review'
--        WHEN 'in_progress'::public.complaint_status THEN 'Remediation In Progress'
--        WHEN 'resolved'::public.complaint_status THEN 'Issue Resolved'
--        WHEN 'rejected'::public.complaint_status THEN 'Report Rejected'
--        ELSE 'Status Updated'
--      END;
--      UPDATE public.complaints SET status = p_new_status, completion_image_url = CASE WHEN p_new_status = 'resolved'::public.complaint_status AND p_completion_image_url IS NOT NULL THEN p_completion_image_url ELSE completion_image_url END, updated_at = pg_catalog.now() WHERE id = p_complaint_id;
--      INSERT INTO public.complaint_status_history (complaint_id, status, title, notes, actor_id, created_at) VALUES (p_complaint_id, p_new_status, v_stage_title, p_notes, v_caller_id, pg_catalog.now());
--    END;
--    $rb$;
--    GRANT EXECUTE ON FUNCTION public.transition_complaint_status(UUID, public.complaint_status, TEXT, TEXT) TO authenticated;
--
-- 3. Restore Phase 4.1 complaint_status_history SELECT policy:
--    DROP POLICY IF EXISTS "History readable by assigned officer or admin" ON public.complaint_status_history;
--    CREATE POLICY "History readable by complaint owner, department officer, or admin" ON public.complaint_status_history
--      FOR SELECT TO authenticated
--      USING (
--        EXISTS (
--          SELECT 1 FROM public.complaints c
--          WHERE c.id = complaint_status_history.complaint_id
--          AND (
--            c.citizen_id = (SELECT auth.uid()) OR
--            (c.department_id IS NOT NULL AND c.department_id = (SELECT public.get_current_officer_department_id())) OR
--            c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
--            (SELECT public.is_admin())
--          )
--        )
--      );
--
-- 4. Restore exact original Phase 2/3 public.public_complaint_history view:
--    CREATE OR REPLACE VIEW public.public_complaint_history WITH (security_barrier = TRUE) AS
--      SELECT h.id, h.complaint_id, h.status,
--        CASE h.status
--          WHEN 'submitted'::public.complaint_status THEN 'Report Registered'
--          WHEN 'under_review'::public.complaint_status THEN 'Under Municipal Review'
--          WHEN 'in_progress'::public.complaint_status THEN 'Remediation In Progress'
--          WHEN 'resolved'::public.complaint_status THEN 'Issue Resolved'
--          WHEN 'rejected'::public.complaint_status THEN 'Report Rejected'
--          ELSE 'Status Updated'
--        END AS stage_title,
--        h.created_at
--      FROM public.complaint_status_history h;
--    ALTER VIEW public.public_complaint_history OWNER TO postgres;
--    GRANT SELECT ON public.public_complaint_history TO anon, authenticated;
--
-- 5. Drop storage resolution policies:
--    DROP POLICY IF EXISTS "Staff can upload resolution images for in-progress complaints" ON storage.objects;
--    DROP POLICY IF EXISTS "Citizens can view resolution evidence of own resolved complaints" ON storage.objects;
--    DROP POLICY IF EXISTS "Staff can view resolution evidence of assigned complaints or all" ON storage.objects;
--
-- 6. Drop complaint_resolution_evidence:
--    DROP TABLE IF EXISTS public.complaint_resolution_evidence CASCADE;
--    DROP FUNCTION IF EXISTS public.guard_resolution_evidence_immutable();
--    DROP FUNCTION IF EXISTS public.guard_resolution_evidence_truncate();
--
-- 7. Restore completion_image_url UPDATE grant from Phase 4.2:
--    GRANT UPDATE (title, description, location, ward, latitude, longitude, completion_image_url) ON TABLE public.complaints TO authenticated;
-- =============================================================================
