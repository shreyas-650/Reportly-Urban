-- =============================================================================
-- Migration: 20261130_phase8_3_verification_dispute.sql
-- Module: Phase 8.3 — Citizen Verification/Dispute, Reopen & Verification History
--                    + Phase 8.2 Automatic Path & Daily Cap RPC Hardening
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   1. Adds service_role-only SECURITY DEFINER RPCs so automatic background AI
--      checks and fail-closed daily cap counting do not rely on direct table
--      grants to public.complaints or public.complaint_resolution_ai_checks.
--   2. Replaces uidx_ai_res_check_auto_evidence_prompt so failed automatic AI
--      attempts do not block safe retry while pending/completed duplicates stay
--      strictly prevented.
--   3. Creates append-only public.complaint_resolution_verifications with strict
--      immutability triggers, INSERT preconditions, RLS + FORCE RLS, and no
--      client INSERT/UPDATE/DELETE grants.
--   4. Creates submit_resolution_verification() (authenticated citizen only) to
--      verify a resolution or dispute & reopen a resolved complaint using the
--      existing complaint_status enum and complaint_status_history audit log.
--   5. Creates get_admin_complaint_verifications() (authenticated admin only) to
--      read verification history and citizen display names safely.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks (Verify Every Referenced Object, Column, Enum & Func)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT string_agg(req.label, ', ')
  INTO v_missing
  FROM (
    SELECT 'table public.complaints' AS label WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaints'
    )
    UNION ALL
    SELECT 'column public.complaints.id' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'id'
    )
    UNION ALL
    SELECT 'column public.complaints.citizen_id' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'citizen_id'
    )
    UNION ALL
    SELECT 'column public.complaints.status' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'status'
    )
    UNION ALL
    SELECT 'column public.complaints.department_id' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'department_id'
    )
    UNION ALL
    SELECT 'column public.complaints.assigned_officer_id' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'assigned_officer_id'
    )
    UNION ALL
    SELECT 'column public.complaints.image_url' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'image_url'
    )
    UNION ALL
    SELECT 'column public.complaints.completion_image_url' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'completion_image_url'
    )
    UNION ALL
    SELECT 'column public.complaints.updated_at' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'updated_at'
    )
    UNION ALL
    SELECT 'table public.complaint_resolution_evidence' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence'
    )
    UNION ALL
    SELECT 'column public.complaint_resolution_evidence.id' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence' AND column_name = 'id'
    )
    UNION ALL
    SELECT 'column public.complaint_resolution_evidence.complaint_id' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence' AND column_name = 'complaint_id'
    )
    UNION ALL
    SELECT 'column public.complaint_resolution_evidence.storage_path' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence' AND column_name = 'storage_path'
    )
    UNION ALL
    SELECT 'column public.complaint_resolution_evidence.upload_status' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence' AND column_name = 'upload_status'
    )
    UNION ALL
    SELECT 'column public.complaint_resolution_evidence.exif_stripped' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence' AND column_name = 'exif_stripped'
    )
    UNION ALL
    SELECT 'column public.complaint_resolution_evidence.created_at' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence' AND column_name = 'created_at'
    )
    UNION ALL
    SELECT 'table public.complaint_status_history' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
    )
    UNION ALL
    SELECT 'table public.complaint_resolution_ai_checks' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_ai_checks'
    )
    UNION ALL
    SELECT 'table public.profiles' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'profiles'
    )
    UNION ALL
    SELECT 'column public.profiles.full_name' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'full_name'
    )
    UNION ALL
    SELECT 'column public.profiles.role' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'role'
    )
    UNION ALL
    SELECT 'enum complaint_status values' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public' AND t.typname = 'complaint_status' AND e.enumlabel = 'resolved'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public' AND t.typname = 'complaint_status' AND e.enumlabel = 'in_progress'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public' AND t.typname = 'complaint_status' AND e.enumlabel = 'under_review'
    )
    UNION ALL
    SELECT 'enum user_role citizen/admin' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public' AND t.typname = 'user_role' AND e.enumlabel = 'citizen'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public' AND t.typname = 'user_role' AND e.enumlabel = 'admin'
    )
    UNION ALL
    SELECT 'function public.is_admin()' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin'
    )
    UNION ALL
    SELECT 'function public.get_current_officer_id()' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_current_officer_id'
    )
  ) req;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Missing required database object(s): %.', v_missing;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Part 0: Harden Automatic AI Check Retry & Service-Role Read/Count RPCs
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS public.uidx_ai_res_check_auto_evidence_prompt;
CREATE UNIQUE INDEX IF NOT EXISTS uidx_ai_res_check_auto_evidence_prompt
  ON public.complaint_resolution_ai_checks (evidence_id, prompt_version)
  WHERE trigger_source = 'automatic' AND status IN ('pending', 'completed');

COMMENT ON INDEX public.uidx_ai_res_check_auto_evidence_prompt IS
  'Guarantees at most one active pending or completed automatic AI check per (evidence_id, prompt_version), allowing safe retry after failed attempts.';

CREATE OR REPLACE FUNCTION public.get_ai_resolution_check_inputs(
  p_complaint_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comp RECORD;
  v_ev RECORD;
BEGIN
  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id is required.'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, status, image_url, completion_image_url
  INTO v_comp
  FROM public.complaints
  WHERE id = p_complaint_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT id, complaint_id, storage_path, upload_status, exif_stripped, created_at
  INTO v_ev
  FROM public.complaint_resolution_evidence
  WHERE complaint_id = p_complaint_id
    AND upload_status = 'completed'
    AND exif_stripped IS TRUE
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'complaint', pg_catalog.jsonb_build_object(
      'id', v_comp.id,
      'status', v_comp.status::text,
      'image_url', v_comp.image_url,
      'completion_image_url', v_comp.completion_image_url
    ),
    'evidence', CASE
      WHEN v_ev.id IS NULL THEN NULL
      ELSE pg_catalog.jsonb_build_object(
        'id', v_ev.id,
        'complaint_id', v_ev.complaint_id,
        'storage_path', v_ev.storage_path,
        'upload_status', v_ev.upload_status,
        'exif_stripped', v_ev.exif_stripped,
        'created_at', v_ev.created_at
      )
    END
  );
END;
$$;

ALTER FUNCTION public.get_ai_resolution_check_inputs(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_ai_resolution_check_inputs(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_resolution_check_inputs(UUID) TO service_role;

COMMENT ON FUNCTION public.get_ai_resolution_check_inputs(UUID) IS
  'Server-only lookup returning minimal complaint and latest verified evidence paths for AI comparison without exposing direct table grants.';

CREATE OR REPLACE FUNCTION public.count_ai_resolution_checks_since(
  p_since TIMESTAMPTZ,
  p_exclude_check_id UUID DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count INT;
BEGIN
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_since timestamp is required.'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*)::int
  INTO v_count
  FROM public.complaint_resolution_ai_checks
  WHERE created_at >= p_since
    AND status IN ('pending', 'completed')
    AND (p_exclude_check_id IS NULL OR id <> p_exclude_check_id);

  RETURN COALESCE(v_count, 0);
END;
$$;

ALTER FUNCTION public.count_ai_resolution_checks_since(TIMESTAMPTZ, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.count_ai_resolution_checks_since(TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_ai_resolution_checks_since(TIMESTAMPTZ, UUID) TO service_role;

COMMENT ON FUNCTION public.count_ai_resolution_checks_since(TIMESTAMPTZ, UUID) IS
  'Server-only count of active/completed AI comparison checks since p_since for fail-closed daily cap enforcement.';

-- -----------------------------------------------------------------------------
-- 3. Append-Only Citizen Verification History Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_resolution_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  evidence_id UUID NOT NULL REFERENCES public.complaint_resolution_evidence(id) ON DELETE RESTRICT,
  citizen_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('verified', 'disputed')),
  reason TEXT NULL CHECK (reason IS NULL OR pg_catalog.char_length(reason) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT uq_resolution_verification_evidence_citizen UNIQUE (evidence_id, citizen_id),
  CONSTRAINT chk_resolution_verification_reason CHECK (
    (
      decision = 'disputed'
      AND reason IS NOT NULL
      AND pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 1000
    ) OR (
      decision = 'verified'
      AND (reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(reason)) <= 1000)
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_res_verif_complaint_created
  ON public.complaint_resolution_verifications (complaint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_res_verif_evidence
  ON public.complaint_resolution_verifications (evidence_id);

CREATE INDEX IF NOT EXISTS idx_res_verif_citizen
  ON public.complaint_resolution_verifications (citizen_id, created_at DESC);

COMMENT ON TABLE public.complaint_resolution_verifications IS
  'Append-only history of citizen verify/dispute decisions against verified municipal completion evidence.';

-- -----------------------------------------------------------------------------
-- 4. Triggers: Pre-Insert Guards & Strict Append-Only Immutability
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_resolution_verification_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comp RECORD;
  v_ev RECORD;
  v_latest_ev_id UUID;
BEGIN
  SELECT id, citizen_id, status
  INTO v_comp
  FROM public.complaints
  WHERE id = NEW.complaint_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid Reference: Complaint % does not exist.', NEW.complaint_id
      USING ERRCODE = '23503';
  END IF;

  IF v_comp.citizen_id IS DISTINCT FROM NEW.citizen_id THEN
    RAISE EXCEPTION 'Unauthorized: Only the original reporting citizen can verify or dispute this resolution.'
      USING ERRCODE = '42501';
  END IF;

  IF v_comp.status IS DISTINCT FROM 'resolved'::public.complaint_status THEN
    RAISE EXCEPTION 'Invalid State: Resolution verification requires complaint % to be in resolved status.', NEW.complaint_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, complaint_id, upload_status, exif_stripped
  INTO v_ev
  FROM public.complaint_resolution_evidence
  WHERE id = NEW.evidence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid Reference: Completion evidence % does not exist.', NEW.evidence_id
      USING ERRCODE = '23503';
  END IF;

  IF v_ev.complaint_id IS DISTINCT FROM NEW.complaint_id THEN
    RAISE EXCEPTION 'Evidence Mismatch: Completion evidence % does not belong to complaint %.', NEW.evidence_id, NEW.complaint_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_ev.upload_status IS DISTINCT FROM 'completed' OR v_ev.exif_stripped IS NOT TRUE THEN
    RAISE EXCEPTION 'Unverified Evidence: Completion evidence % is not completed and EXIF-stripped.', NEW.evidence_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
  INTO v_latest_ev_id
  FROM public.complaint_resolution_evidence
  WHERE complaint_id = NEW.complaint_id
    AND upload_status = 'completed'
    AND exif_stripped IS TRUE
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_latest_ev_id IS DISTINCT FROM NEW.evidence_id THEN
    RAISE EXCEPTION 'Stale Evidence: Decisions are allowed only on the latest verified completion evidence.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.reason IS NOT NULL THEN
    NEW.reason := NULLIF(pg_catalog.btrim(NEW.reason), '');
  END IF;

  IF NEW.decision = 'disputed' AND (NEW.reason IS NULL OR pg_catalog.char_length(NEW.reason) < 1) THEN
    RAISE EXCEPTION 'Invalid Parameter: A dispute reason is required.'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_resolution_verification_insert() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_resolution_verification_insert() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_resolution_verification_insert ON public.complaint_resolution_verifications;
CREATE TRIGGER trg_guard_resolution_verification_insert
  BEFORE INSERT ON public.complaint_resolution_verifications
  FOR EACH ROW EXECUTE FUNCTION public.guard_resolution_verification_insert();

CREATE OR REPLACE FUNCTION public.guard_resolution_verification_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Verification history records are strictly append-only and cannot be modified, deleted, or truncated.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_resolution_verification_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_resolution_verification_immutable() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_resolution_verification_immutable ON public.complaint_resolution_verifications;
CREATE TRIGGER trg_guard_resolution_verification_immutable
  BEFORE UPDATE OR DELETE ON public.complaint_resolution_verifications
  FOR EACH ROW EXECUTE FUNCTION public.guard_resolution_verification_immutable();

DROP TRIGGER IF EXISTS trg_guard_resolution_verification_truncate ON public.complaint_resolution_verifications;
CREATE TRIGGER trg_guard_resolution_verification_truncate
  BEFORE TRUNCATE ON public.complaint_resolution_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_resolution_verification_immutable();

-- -----------------------------------------------------------------------------
-- 5. RLS & Table Grants (No Direct INSERT/UPDATE/DELETE/TRUNCATE)
-- -----------------------------------------------------------------------------
ALTER TABLE public.complaint_resolution_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_resolution_verifications FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_resolution_verifications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_resolution_verifications TO authenticated;

DROP POLICY IF EXISTS "Reporters can read own resolution verifications" ON public.complaint_resolution_verifications;
CREATE POLICY "Reporters can read own resolution verifications"
  ON public.complaint_resolution_verifications
  FOR SELECT
  TO authenticated
  USING (citizen_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Admins can read all resolution verifications" ON public.complaint_resolution_verifications;
CREATE POLICY "Admins can read all resolution verifications"
  ON public.complaint_resolution_verifications
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Assigned officers can read verifications for assigned complaints" ON public.complaint_resolution_verifications;
CREATE POLICY "Assigned officers can read verifications for assigned complaints"
  ON public.complaint_resolution_verifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_resolution_verifications.complaint_id
        AND c.assigned_officer_id = (SELECT public.get_current_officer_id())
    )
  );

-- -----------------------------------------------------------------------------
-- 6. Authenticated RPCs: submit_resolution_verification & Admin History Read
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_resolution_verification(
  p_complaint_id UUID,
  p_evidence_id UUID,
  p_decision TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID;
  v_role public.user_role;
  v_decision TEXT;
  v_clean_reason TEXT;
  v_complaint RECORD;
  v_latest_ev_id UUID;
  v_verif_id UUID;
  v_created_at TIMESTAMPTZ;
  v_reopen_status public.complaint_status;
  v_final_status TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required: Anonymous callers cannot verify complaint resolutions.'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = v_caller_id;

  IF v_role IS DISTINCT FROM 'citizen'::public.user_role THEN
    RAISE EXCEPTION 'Unauthorized: Only citizen accounts may submit resolution verification decisions.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL OR p_evidence_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id and evidence_id are required.'
      USING ERRCODE = '22023';
  END IF;

  v_decision := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_decision, '')));
  IF v_decision NOT IN ('verified', 'disputed') THEN
    RAISE EXCEPTION 'Invalid Parameter: decision must be verified or disputed.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_reason := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  IF v_decision = 'disputed' THEN
    IF v_clean_reason IS NULL OR pg_catalog.char_length(v_clean_reason) < 1 OR pg_catalog.char_length(v_clean_reason) > 1000 THEN
      RAISE EXCEPTION 'Invalid Parameter: A dispute reason between 1 and 1000 characters is required.'
        USING ERRCODE = '22023';
    END IF;
  ELSIF v_clean_reason IS NOT NULL AND pg_catalog.char_length(v_clean_reason) > 1000 THEN
    RAISE EXCEPTION 'Invalid Parameter: Verification note cannot exceed 1000 characters.'
      USING ERRCODE = '22023';
  END IF;

  -- Acquire row lock on complaint before checking ownership/status and inserting
  SELECT id, citizen_id, status, department_id, assigned_officer_id
  INTO v_complaint
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND OR v_complaint.citizen_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Unauthorized: Complaint not found or you are not the reporting citizen.'
      USING ERRCODE = '42501';
  END IF;

  IF v_complaint.status IS DISTINCT FROM 'resolved'::public.complaint_status THEN
    RAISE EXCEPTION 'Invalid State: Only resolved complaints can be verified or disputed.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id
  INTO v_latest_ev_id
  FROM public.complaint_resolution_evidence
  WHERE complaint_id = p_complaint_id
    AND upload_status = 'completed'
    AND exif_stripped IS TRUE
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_latest_ev_id IS NULL OR v_latest_ev_id IS DISTINCT FROM p_evidence_id THEN
    RAISE EXCEPTION 'Invalid Evidence: No matching latest verified completion photograph exists for this complaint.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.complaint_resolution_verifications (
    complaint_id,
    evidence_id,
    citizen_id,
    decision,
    reason,
    created_at
  ) VALUES (
    p_complaint_id,
    p_evidence_id,
    v_caller_id,
    v_decision,
    v_clean_reason,
    pg_catalog.now()
  )
  RETURNING id, created_at INTO v_verif_id, v_created_at;

  v_final_status := 'resolved';

  IF v_decision = 'disputed' THEN
    -- Reopen strictly to a valid active workflow status preserving Phase 4.3 invariants
    IF v_complaint.department_id IS NOT NULL AND v_complaint.assigned_officer_id IS NOT NULL THEN
      v_reopen_status := 'in_progress'::public.complaint_status;
    ELSE
      v_reopen_status := 'under_review'::public.complaint_status;
    END IF;

    UPDATE public.complaints
    SET status = v_reopen_status,
        updated_at = pg_catalog.now()
    WHERE id = p_complaint_id;

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
      v_reopen_status,
      'resolved'::public.complaint_status,
      'Resolution Disputed — Reopened',
      v_clean_reason,
      NULL,
      v_caller_id,
      pg_catalog.now()
    );

    v_final_status := v_reopen_status::text;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'verification_id', v_verif_id,
    'complaint_id', p_complaint_id,
    'evidence_id', p_evidence_id,
    'decision', v_decision,
    'reason', v_clean_reason,
    'complaint_status', v_final_status,
    'created_at', v_created_at
  );
END;
$$;

ALTER FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT) IS
  'Allows the reporting citizen to record a verified or disputed decision against the latest verified completion photo; disputes reopen the complaint to in_progress/under_review.';

CREATE OR REPLACE FUNCTION public.get_admin_complaint_verifications(
  p_complaint_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comp RECORD;
  v_latest_ev_id UUID;
  v_latest_decision TEXT;
  v_history JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id is required.'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, status
  INTO v_comp
  FROM public.complaints
  WHERE id = p_complaint_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT id
  INTO v_latest_ev_id
  FROM public.complaint_resolution_evidence
  WHERE complaint_id = p_complaint_id
    AND upload_status = 'completed'
    AND exif_stripped IS TRUE
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  SELECT v.decision
  INTO v_latest_decision
  FROM public.complaint_resolution_verifications v
  WHERE v.complaint_id = p_complaint_id
  ORDER BY v.created_at DESC, v.id DESC
  LIMIT 1;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', row_data.id,
        'evidence_id', row_data.evidence_id,
        'decision', row_data.decision,
        'reason', row_data.reason,
        'citizen_display_name', row_data.citizen_display_name,
        'created_at', row_data.created_at
      )
      ORDER BY row_data.created_at DESC, row_data.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_history
  FROM (
    SELECT
      v.id,
      v.evidence_id,
      v.decision,
      v.reason,
      COALESCE(NULLIF(pg_catalog.btrim(p.full_name), ''), 'Reporting Citizen') AS citizen_display_name,
      v.created_at
    FROM public.complaint_resolution_verifications v
    LEFT JOIN public.profiles p ON p.id = v.citizen_id
    WHERE v.complaint_id = p_complaint_id
    ORDER BY v.created_at DESC, v.id DESC
  ) row_data;

  RETURN pg_catalog.jsonb_build_object(
    'complaint_id', v_comp.id,
    'complaint_status', v_comp.status::text,
    'latest_evidence_id', v_latest_ev_id,
    'latest_decision', v_latest_decision,
    'history', v_history
  );
END;
$$;

ALTER FUNCTION public.get_admin_complaint_verifications(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_complaint_verifications(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_complaint_verifications(UUID) TO authenticated;

COMMENT ON FUNCTION public.get_admin_complaint_verifications(UUID) IS
  'Admin-only lookup returning complaint verification history with privacy-safe citizen display names (no phone, email, or citizen_id).';

-- -----------------------------------------------------------------------------
-- 7. Final Privilege & RLS Audit Block (aclexplode grantee = 0 for PUBLIC)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_relacl aclitem[];
  v_fn RECORD;
BEGIN
  SELECT c.relacl
  INTO v_relacl
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'complaint_resolution_verifications'
    AND c.relrowsecurity = TRUE
    AND c.relforcerowsecurity = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit Failed: RLS and FORCE ROW LEVEL SECURITY must both be enabled on public.complaint_resolution_verifications.';
  END IF;

  IF (
    v_relacl IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(v_relacl) a
      WHERE a.grantee = 0
    )
  )
     OR pg_catalog.has_table_privilege('anon', 'public.complaint_resolution_verifications', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.complaint_resolution_verifications', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_resolution_verifications', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_resolution_verifications', 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_resolution_verifications', 'DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_resolution_verifications', 'TRUNCATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_verifications', 'SELECT')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_verifications', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_verifications', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_verifications', 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_verifications', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Audit Failed: Unauthorized table privileges detected on public.complaint_resolution_verifications.';
  END IF;

  -- Trigger functions + service_role RPCs must NOT grant EXECUTE to PUBLIC, anon, or authenticated
  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'guard_resolution_verification_insert',
        'guard_resolution_verification_immutable',
        'get_ai_resolution_check_inputs',
        'count_ai_resolution_checks_since'
      )
  ) LOOP
    IF v_fn.proacl IS NULL
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(v_fn.proacl) a
         WHERE a.grantee = 0
           AND a.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Function public.%() grants EXECUTE to PUBLIC, anon, or authenticated.', v_fn.proname;
    END IF;
  END LOOP;

  -- Authenticated RPCs must grant EXECUTE to authenticated ONLY (never PUBLIC, anon, or service_role)
  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'submit_resolution_verification',
        'get_admin_complaint_verifications'
      )
  ) LOOP
    IF v_fn.proacl IS NULL
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(v_fn.proacl) a
         WHERE a.grantee = 0
           AND a.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_fn.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Authenticated RPC public.%() has unexpected EXECUTE grants.', v_fn.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
