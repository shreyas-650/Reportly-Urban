-- =============================================================================
-- Migration: 20261129_phase8_2_ai_resolution_check.sql
-- Module: Phase 8.2 — Advisory AI Before-and-After Photo Comparison
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   1. Creates public.complaint_resolution_ai_checks to store advisory-only
--      before/after Gemini Vision comparison attempts and results.
--   2. Does NOT alter any existing table, RLS policy, or storage policy.
--   3. Enforces verified evidence preconditions, forced initial pending state,
--      and append-only immutability via hardened BEFORE INSERT/UPDATE/DELETE/TRUNCATE
--      triggers.
--   4. Prevents duplicate automatic checks and concurrent pending checks via
--      advisory locks + partial unique indexes.
--   5. Enforces FORCE ROW LEVEL SECURITY with admin-only SELECT and write isolation
--      strictly via service_role SECURITY DEFINER RPCs (SET search_path = '').
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks (Verify Every Referenced Table, Column, Enum, Function)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT pg_catalog.string_agg(item, ', ')
  INTO v_missing
  FROM (
    SELECT 'table public.complaints' AS item WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaints'
    )
    UNION ALL
    SELECT 'column public.complaints.id' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'id'
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
    SELECT 'table public.profiles' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'profiles'
    )
    UNION ALL
    SELECT 'column public.profiles.id' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'id'
    )
    UNION ALL
    SELECT 'column public.profiles.role' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'role'
    )
    UNION ALL
    SELECT 'enum value public.user_role(admin)' WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public' AND t.typname = 'user_role' AND e.enumlabel = 'admin'
    )
    UNION ALL
    SELECT 'function public.is_admin()' WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin' AND p.pronargs = 0
    )
  ) req;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Missing required prerequisite(s): %', v_missing;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Advisory AI Check Results Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_resolution_ai_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  evidence_id UUID NOT NULL REFERENCES public.complaint_resolution_evidence(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  verdict TEXT NULL CHECK (verdict IS NULL OR verdict IN ('appears_fixed', 'appears_not_fixed', 'unclear')),
  confidence DOUBLE PRECISION NULL CHECK (
    confidence IS NULL OR (
      confidence >= 0.0
      AND confidence <= 1.0
      AND confidence <> 'NaN'::double precision
      AND confidence <> 'Infinity'::double precision
      AND confidence <> '-Infinity'::double precision
    )
  ),
  summary TEXT NULL CHECK (summary IS NULL OR pg_catalog.char_length(summary) <= 300),
  failure_category TEXT NULL CHECK (
    failure_category IS NULL
    OR pg_catalog.char_length(pg_catalog.btrim(failure_category)) BETWEEN 1 AND 64
  ),
  model_name TEXT NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(model_name)) BETWEEN 1 AND 100),
  prompt_version TEXT NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(prompt_version)) BETWEEN 1 AND 64),
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('automatic', 'manual')),
  requested_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT chk_ai_check_state_consistency CHECK (
    (
      status = 'completed'
      AND verdict IS NOT NULL
      AND confidence IS NOT NULL
      AND confidence >= 0.0
      AND confidence <= 1.0
      AND confidence <> 'NaN'::double precision
      AND confidence <> 'Infinity'::double precision
      AND confidence <> '-Infinity'::double precision
      AND completed_at IS NOT NULL
      AND failure_category IS NULL
    ) OR (
      status = 'pending'
      AND verdict IS NULL
      AND confidence IS NULL
      AND summary IS NULL
      AND failure_category IS NULL
      AND completed_at IS NULL
    ) OR (
      status = 'failed'
      AND verdict IS NULL
      AND confidence IS NULL
      AND failure_category IS NOT NULL
      AND pg_catalog.char_length(pg_catalog.btrim(failure_category)) BETWEEN 1 AND 64
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT chk_ai_check_completed_after_created CHECK (
    completed_at IS NULL OR completed_at >= created_at
  ),
  CONSTRAINT chk_ai_check_trigger_requested_by CHECK (
    (trigger_source = 'automatic' AND requested_by IS NULL)
    OR (trigger_source = 'manual' AND requested_by IS NOT NULL)
  )
);

COMMENT ON TABLE public.complaint_resolution_ai_checks IS
  'Advisory-only Gemini Vision before-and-after photo comparison attempts. Never controls complaint status, SLA, or rewards; readable strictly by admins.';
COMMENT ON COLUMN public.complaint_resolution_ai_checks.verdict IS
  'Advisory visual suggestion only (appears_fixed | appears_not_fixed | unclear; NULL unless completed). Never proof that physical work is complete.';
COMMENT ON COLUMN public.complaint_resolution_ai_checks.confidence IS
  'Model-estimated visual comparison confidence (0..1; NULL unless completed), never proof that physical work is complete.';
COMMENT ON COLUMN public.complaint_resolution_ai_checks.trigger_source IS
  'Indicates whether this advisory check was triggered automatically after resolution or manually by an admin.';

-- -----------------------------------------------------------------------------
-- 3. Indexes & Concurrency / Duplicate Guarantees
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ai_res_check_complaint
  ON public.complaint_resolution_ai_checks (complaint_id);

CREATE INDEX IF NOT EXISTS idx_ai_res_check_evidence
  ON public.complaint_resolution_ai_checks (evidence_id);

CREATE INDEX IF NOT EXISTS idx_ai_res_check_latest
  ON public.complaint_resolution_ai_checks (complaint_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_ai_res_check_auto_evidence_prompt
  ON public.complaint_resolution_ai_checks (evidence_id, prompt_version)
  WHERE trigger_source = 'automatic';

CREATE UNIQUE INDEX IF NOT EXISTS uidx_ai_res_check_one_pending
  ON public.complaint_resolution_ai_checks (evidence_id)
  WHERE status = 'pending';

COMMENT ON INDEX public.idx_ai_res_check_complaint IS
  'Supports lookup of advisory AI resolution checks by complaint.';
COMMENT ON INDEX public.idx_ai_res_check_evidence IS
  'Supports lookup of advisory AI resolution checks by completion evidence record.';
COMMENT ON INDEX public.idx_ai_res_check_latest IS
  'Supports fetching latest AI resolution check and attempt history per complaint.';
COMMENT ON INDEX public.uidx_ai_res_check_auto_evidence_prompt IS
  'Guarantees at most one automatic AI comparison per (evidence_id, prompt_version).';
COMMENT ON INDEX public.uidx_ai_res_check_one_pending IS
  'Prevents concurrent duplicate pending AI comparisons for the same completion evidence.';

-- -----------------------------------------------------------------------------
-- 4. Triggers: Verified Evidence Precondition & Append-Only Result Immutability
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_ai_resolution_check_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ev RECORD;
  v_role public.user_role;
BEGIN
  IF NEW.trigger_source IS NULL OR NEW.trigger_source NOT IN ('automatic', 'manual') THEN
    RAISE EXCEPTION 'AI Check Rejected: Invalid trigger_source.'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.trigger_source = 'automatic' AND NEW.requested_by IS NOT NULL THEN
    RAISE EXCEPTION 'AI Check Rejected: Automatic AI checks must have NULL requested_by.'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.trigger_source = 'manual' THEN
    IF NEW.requested_by IS NULL THEN
      RAISE EXCEPTION 'AI Check Rejected: Manual re-runs require verified admin requested_by identity.'
        USING ERRCODE = '42501';
    END IF;
    SELECT role INTO v_role FROM public.profiles WHERE id = NEW.requested_by;
    IF v_role IS DISTINCT FROM 'admin'::public.user_role THEN
      RAISE EXCEPTION 'AI Check Rejected: Manual re-runs are restricted to administrators.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT id, complaint_id, upload_status, exif_stripped
  INTO v_ev
  FROM public.complaint_resolution_evidence
  WHERE id = NEW.evidence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AI Check Rejected: Referenced completion evidence record does not exist.'
      USING ERRCODE = '23503';
  END IF;

  IF v_ev.complaint_id <> NEW.complaint_id THEN
    RAISE EXCEPTION 'AI Check Rejected: Completion evidence does not belong to the target complaint.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_ev.upload_status IS DISTINCT FROM 'completed' OR v_ev.exif_stripped IS NOT TRUE THEN
    RAISE EXCEPTION 'AI Check Rejected: Completion evidence must be completed and EXIF-stripped before AI comparison.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Force initial pending state and clear any result fields on INSERT
  NEW.status := 'pending';
  NEW.verdict := NULL;
  NEW.confidence := NULL;
  NEW.summary := NULL;
  NEW.failure_category := NULL;
  NEW.completed_at := NULL;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_ai_resolution_check_evidence() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_ai_resolution_check_evidence() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.guard_ai_resolution_check_evidence() IS
  'Enforces verified evidence preconditions, admin provenance on manual checks, and forced initial pending state before insert.';

DROP TRIGGER IF EXISTS trg_guard_ai_resolution_check_evidence ON public.complaint_resolution_ai_checks;
CREATE TRIGGER trg_guard_ai_resolution_check_evidence
  BEFORE INSERT ON public.complaint_resolution_ai_checks
  FOR EACH ROW EXECUTE FUNCTION public.guard_ai_resolution_check_evidence();

COMMENT ON TRIGGER trg_guard_ai_resolution_check_evidence ON public.complaint_resolution_ai_checks IS
  'Validates completion evidence ownership, upload_status, exif_stripped, and initial pending state before insert.';

CREATE OR REPLACE FUNCTION public.guard_ai_resolution_check_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI resolution check history cannot be deleted.'
      USING ERRCODE = '42501';
  END IF;

  -- Only a pending attempt may transition once to completed or failed; terminal rows and return-to-pending are blocked.
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Completed or failed AI resolution check rows are immutable and cannot be overwritten.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.completed_at IS NULL OR NEW.completed_at < OLD.created_at THEN
    RAISE EXCEPTION 'AI resolution check transition requires completed_at >= created_at.'
      USING ERRCODE = '22023';
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.complaint_id <> OLD.complaint_id
     OR NEW.evidence_id <> OLD.evidence_id
     OR NEW.model_name <> OLD.model_name
     OR NEW.prompt_version <> OLD.prompt_version
     OR NEW.trigger_source <> OLD.trigger_source
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'AI resolution check metadata and provenance fields are immutable.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_ai_resolution_check_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_ai_resolution_check_immutable() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.guard_ai_resolution_check_immutable() IS
  'Prevents deleting any AI check row and prevents modifying historical completed/failed rows or provenance fields.';

DROP TRIGGER IF EXISTS trg_guard_ai_resolution_check_immutable ON public.complaint_resolution_ai_checks;
CREATE TRIGGER trg_guard_ai_resolution_check_immutable
  BEFORE UPDATE OR DELETE ON public.complaint_resolution_ai_checks
  FOR EACH ROW EXECUTE FUNCTION public.guard_ai_resolution_check_immutable();

COMMENT ON TRIGGER trg_guard_ai_resolution_check_immutable ON public.complaint_resolution_ai_checks IS
  'Ensures AI comparison history is append-only once an attempt finishes.';

CREATE OR REPLACE FUNCTION public.guard_ai_resolution_check_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Truncating AI resolution check history is prohibited.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_ai_resolution_check_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_ai_resolution_check_truncate() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.guard_ai_resolution_check_truncate() IS
  'Blocks TRUNCATE on public.complaint_resolution_ai_checks.';

DROP TRIGGER IF EXISTS trg_guard_ai_resolution_check_truncate ON public.complaint_resolution_ai_checks;
CREATE TRIGGER trg_guard_ai_resolution_check_truncate
  BEFORE TRUNCATE ON public.complaint_resolution_ai_checks
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ai_resolution_check_truncate();

COMMENT ON TRIGGER trg_guard_ai_resolution_check_truncate ON public.complaint_resolution_ai_checks IS
  'Statement-level guard preventing TRUNCATE on AI resolution check history.';

-- -----------------------------------------------------------------------------
-- 5. Row Level Security & Privileges (Admin SELECT only; Zero direct writes)
-- -----------------------------------------------------------------------------
ALTER TABLE public.complaint_resolution_ai_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_resolution_ai_checks FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_resolution_ai_checks FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_resolution_ai_checks TO authenticated;

DROP POLICY IF EXISTS "Admins can read AI resolution checks" ON public.complaint_resolution_ai_checks;
CREATE POLICY "Admins can read AI resolution checks"
  ON public.complaint_resolution_ai_checks
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

COMMENT ON POLICY "Admins can read AI resolution checks" ON public.complaint_resolution_ai_checks IS
  'Restricts advisory AI resolution check visibility strictly to administrators; citizens, officers, and anon receive 0 rows.';

-- -----------------------------------------------------------------------------
-- 6. Server-Only Claim & Finalize RPCs (service_role only, SET search_path = '')
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_ai_resolution_check(
  p_complaint_id UUID,
  p_evidence_id UUID,
  p_model_name TEXT,
  p_prompt_version TEXT,
  p_trigger_source TEXT,
  p_requested_by UUID DEFAULT NULL,
  p_stale_pending_minutes INT DEFAULT 5
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_stale_mins INT;
  v_model_clean TEXT;
  v_prompt_clean TEXT;
  v_role public.user_role;
  v_stale_ids UUID[];
  v_check_id UUID;
BEGIN
  IF p_complaint_id IS NULL OR p_evidence_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id and evidence_id are required.'
      USING ERRCODE = '22023';
  END IF;

  IF p_trigger_source IS NULL OR p_trigger_source NOT IN ('automatic', 'manual') THEN
    RAISE EXCEPTION 'Invalid Parameter: trigger_source must be automatic or manual.'
      USING ERRCODE = '22023';
  END IF;

  v_model_clean := pg_catalog.btrim(COALESCE(p_model_name, ''));
  IF pg_catalog.char_length(v_model_clean) < 1 OR pg_catalog.char_length(v_model_clean) > 100 THEN
    RAISE EXCEPTION 'Invalid Parameter: model_name must be 1 to 100 non-blank characters.'
      USING ERRCODE = '22023';
  END IF;

  v_prompt_clean := pg_catalog.btrim(COALESCE(p_prompt_version, ''));
  IF pg_catalog.char_length(v_prompt_clean) < 1 OR pg_catalog.char_length(v_prompt_clean) > 64 THEN
    RAISE EXCEPTION 'Invalid Parameter: prompt_version must be 1 to 64 non-blank characters.'
      USING ERRCODE = '22023';
  END IF;

  v_stale_mins := COALESCE(p_stale_pending_minutes, 5);
  IF v_stale_mins < 1 OR v_stale_mins > 60 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_stale_pending_minutes must be between 1 and 60.'
      USING ERRCODE = '22023';
  END IF;

  IF p_trigger_source = 'automatic' AND p_requested_by IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: automatic checks must not supply requested_by.'
      USING ERRCODE = '22023';
  END IF;

  IF p_trigger_source = 'manual' THEN
    IF p_requested_by IS NULL THEN
      RAISE EXCEPTION 'Unauthorized: manual re-run requires verified admin requested_by.'
        USING ERRCODE = '42501';
    END IF;
    SELECT role INTO v_role FROM public.profiles WHERE id = p_requested_by;
    IF v_role IS DISTINCT FROM 'admin'::public.user_role THEN
      RAISE EXCEPTION 'Unauthorized: manual re-runs are restricted to administrators.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Serialize claim attempts per completion evidence record
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ai_res_check_' || p_evidence_id::text));

  -- 1. Recover stale pending rows (both automatic and manual) without touching terminal rows
  SELECT pg_catalog.array_agg(id)
  INTO v_stale_ids
  FROM (
    SELECT id
    FROM public.complaint_resolution_ai_checks
    WHERE evidence_id = p_evidence_id
      AND status = 'pending'
      AND created_at < (pg_catalog.now() - pg_catalog.make_interval(mins => v_stale_mins))
    FOR UPDATE SKIP LOCKED
  ) stale_rows;

  IF v_stale_ids IS NOT NULL THEN
    UPDATE public.complaint_resolution_ai_checks
    SET status = 'failed',
        failure_category = 'timeout',
        completed_at = pg_catalog.now()
    WHERE id = ANY(v_stale_ids)
      AND status = 'pending';
  END IF;

  -- 2. Attempt atomic pending claim; returns NULL if duplicate automatic or active pending exists
  INSERT INTO public.complaint_resolution_ai_checks (
    complaint_id,
    evidence_id,
    status,
    model_name,
    prompt_version,
    trigger_source,
    requested_by,
    created_at
  ) VALUES (
    p_complaint_id,
    p_evidence_id,
    'pending',
    v_model_clean,
    v_prompt_clean,
    p_trigger_source,
    p_requested_by,
    pg_catalog.now()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_check_id;

  RETURN v_check_id;
END;
$$;

ALTER FUNCTION public.claim_ai_resolution_check(UUID, UUID, TEXT, TEXT, TEXT, UUID, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_ai_resolution_check(UUID, UUID, TEXT, TEXT, TEXT, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_resolution_check(UUID, UUID, TEXT, TEXT, TEXT, UUID, INT) TO service_role;

COMMENT ON FUNCTION public.claim_ai_resolution_check(UUID, UUID, TEXT, TEXT, TEXT, UUID, INT) IS
  'Atomically claims a pending advisory AI comparison row (recovering stale pending rows as timeout) or returns NULL if duplicate/active. Restricted to service_role.';

CREATE OR REPLACE FUNCTION public.complete_ai_resolution_check(
  p_check_id UUID,
  p_status TEXT,
  p_verdict TEXT DEFAULT NULL,
  p_confidence DOUBLE PRECISION DEFAULT NULL,
  p_summary TEXT DEFAULT NULL,
  p_failure_category TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
  v_summary_clean TEXT;
  v_failure_clean TEXT;
BEGIN
  IF p_check_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_check_id is required.'
      USING ERRCODE = '22023';
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Invalid Parameter: status must be completed or failed.'
      USING ERRCODE = '22023';
  END IF;

  v_summary_clean := NULLIF(pg_catalog.btrim(COALESCE(p_summary, '')), '');
  IF v_summary_clean IS NOT NULL AND pg_catalog.char_length(v_summary_clean) > 300 THEN
    RAISE EXCEPTION 'Invalid Parameter: summary must not exceed 300 characters.'
      USING ERRCODE = '22023';
  END IF;

  IF p_status = 'completed' THEN
    IF p_verdict IS NULL OR p_verdict NOT IN ('appears_fixed', 'appears_not_fixed', 'unclear') THEN
      RAISE EXCEPTION 'Invalid Parameter: completed check requires a valid verdict.'
        USING ERRCODE = '22023';
    END IF;
    IF p_confidence IS NULL
       OR p_confidence = 'NaN'::double precision
       OR p_confidence = 'Infinity'::double precision
       OR p_confidence = '-Infinity'::double precision
       OR p_confidence < 0.0
       OR p_confidence > 1.0 THEN
      RAISE EXCEPTION 'Invalid Parameter: completed check requires finite confidence between 0.0 and 1.0.'
        USING ERRCODE = '22023';
    END IF;
    v_failure_clean := NULL;
  ELSE
    v_failure_clean := pg_catalog.btrim(COALESCE(p_failure_category, ''));
    IF pg_catalog.char_length(v_failure_clean) < 1 OR pg_catalog.char_length(v_failure_clean) > 64 THEN
      RAISE EXCEPTION 'Invalid Parameter: failed check requires a non-blank failure_category (max 64 chars).'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT id, status
  INTO v_row
  FROM public.complaint_resolution_ai_checks
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND OR v_row.status <> 'pending' THEN
    RETURN FALSE;
  END IF;

  UPDATE public.complaint_resolution_ai_checks
  SET status = p_status,
      verdict = CASE WHEN p_status = 'completed' THEN p_verdict ELSE NULL END,
      confidence = CASE WHEN p_status = 'completed' THEN p_confidence ELSE NULL END,
      summary = v_summary_clean,
      failure_category = v_failure_clean,
      completed_at = pg_catalog.now()
  WHERE id = p_check_id
    AND status = 'pending';

  RETURN TRUE;
END;
$$;

ALTER FUNCTION public.complete_ai_resolution_check(UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_ai_resolution_check(UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_resolution_check(UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.complete_ai_resolution_check(UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT) IS
  'Finalizes a locked pending AI comparison row as completed or failed without modifying any other table. Restricted to service_role.';

-- -----------------------------------------------------------------------------
-- 7. Final Privilege & RLS Audit Block
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
    AND c.relname = 'complaint_resolution_ai_checks'
    AND c.relrowsecurity = TRUE
    AND c.relforcerowsecurity = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit Failed: RLS and FORCE ROW LEVEL SECURITY must both be enabled on public.complaint_resolution_ai_checks.';
  END IF;

  IF (
    v_relacl IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(v_relacl) a
      WHERE a.grantee = 0
    )
  )
     OR pg_catalog.has_table_privilege('anon', 'public.complaint_resolution_ai_checks', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.complaint_resolution_ai_checks', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_resolution_ai_checks', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_resolution_ai_checks', 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_resolution_ai_checks', 'DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_resolution_ai_checks', 'TRUNCATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_ai_checks', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_ai_checks', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_ai_checks', 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_resolution_ai_checks', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Audit Failed: Unauthorized table privileges detected on public.complaint_resolution_ai_checks.';
  END IF;

  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'guard_ai_resolution_check_evidence',
        'guard_ai_resolution_check_immutable',
        'guard_ai_resolution_check_truncate',
        'claim_ai_resolution_check',
        'complete_ai_resolution_check'
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
END $$;

COMMIT;
