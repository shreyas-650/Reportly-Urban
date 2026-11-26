-- =============================================================================
-- Migration: 20261203_phase9_1_ai_decisions_shadow_mode.sql
-- Module: Phase 9.1 — AI Category & Priority Suggestions (Shadow Mode)
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   1. Creates a generic, reusable public.ai_decisions table (with feature column
--      for Phases 9.1 through 9.7) storing shadow-mode AI suggestions, confidence,
--      raw status, sanitized error messages, and admin review outcomes.
--   2. Enforces strict shadow mode: AI execution RPCs (service_role only) can
--      claim/complete rows in public.ai_decisions and NEVER mutate public.complaints.
--   3. Only verified municipal administrators (public.is_admin()) can read
--      public.ai_decisions via RLS or commit Accept/Override/Ignore decisions via
--      public.decide_ai_category_priority_suggestion(). Priority changes route
--      through the existing public.assign_complaint_admin() path.
--   4. Zero PII is returned by get_ai_suggestion_inputs(): omits citizen_id,
--      street address/location, coordinates, names, phone numbers, and emails.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT pg_catalog.string_agg(req.label, ', ')
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
    SELECT 'column public.complaints.category' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'category'
    )
    UNION ALL
    SELECT 'column public.complaints.priority' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'priority'
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
    SELECT 'column public.complaints.sla_deadline' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'sla_deadline'
    )
    UNION ALL
    SELECT 'column public.complaints.updated_at' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'updated_at'
    )
    UNION ALL
    SELECT 'table public.profiles' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'profiles'
    )
    UNION ALL
    SELECT 'enum public.complaint_priority' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'complaint_priority'
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
    UNION ALL
    SELECT 'function public.assign_complaint_admin(uuid,uuid,uuid,complaint_priority,timestamptz,timestamptz)' WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'assign_complaint_admin' AND p.pronargs = 6
    )
  ) req;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Missing required prerequisite(s): %', v_missing;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Generic Reusable AI Decisions Table (Phases 9.1 - 9.7)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  feature TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(feature)) BETWEEN 1 AND 64
  ),
  model_name TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(model_name)) BETWEEN 1 AND 100
  ),
  prompt_version TEXT NOT NULL DEFAULT 'v1.0' CHECK (
    pg_catalog.char_length(pg_catalog.btrim(prompt_version)) BETWEEN 1 AND 64
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  suggested_category VARCHAR(50) NULL CHECK (
    suggested_category IS NULL
    OR suggested_category IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure')
  ),
  suggested_priority public.complaint_priority NULL,
  suggestion_payload JSONB NULL,
  confidence DOUBLE PRECISION NULL CHECK (
    confidence IS NULL OR (
      confidence >= 0.0
      AND confidence <= 1.0
      AND confidence <> 'NaN'::double precision
      AND confidence <> 'Infinity'::double precision
      AND confidence <> '-Infinity'::double precision
    )
  ),
  error_message TEXT NULL CHECK (
    error_message IS NULL OR pg_catalog.char_length(error_message) <= 500
  ),
  admin_decision TEXT NOT NULL DEFAULT 'pending' CHECK (
    admin_decision IN ('pending', 'accepted', 'overridden', 'ignored')
  ),
  final_category VARCHAR(50) NULL CHECK (
    final_category IS NULL
    OR final_category IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure')
  ),
  final_priority public.complaint_priority NULL,
  decided_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  completed_at TIMESTAMPTZ NULL,
  CONSTRAINT chk_ai_decisions_state_consistency CHECK (
    (
      status = 'pending'
      AND confidence IS NULL
      AND suggested_category IS NULL
      AND suggested_priority IS NULL
      AND error_message IS NULL
      AND completed_at IS NULL
    ) OR (
      status = 'completed'
      AND confidence IS NOT NULL
      AND confidence >= 0.0
      AND confidence <= 1.0
      AND confidence <> 'NaN'::double precision
      AND confidence <> 'Infinity'::double precision
      AND confidence <> '-Infinity'::double precision
      AND completed_at IS NOT NULL
      AND error_message IS NULL
      AND (
        feature <> 'category_priority_suggestion'
        OR (suggested_category IS NOT NULL AND suggested_priority IS NOT NULL)
      )
    ) OR (
      status = 'failed'
      AND confidence IS NULL
      AND suggested_category IS NULL
      AND suggested_priority IS NULL
      AND error_message IS NOT NULL
      AND pg_catalog.char_length(pg_catalog.btrim(error_message)) >= 1
      AND completed_at IS NOT NULL
    )
  ),
  CONSTRAINT chk_ai_decisions_admin_outcome_consistency CHECK (
    (
      admin_decision = 'pending'
      AND final_category IS NULL
      AND final_priority IS NULL
      AND decided_by IS NULL
      AND decided_at IS NULL
    ) OR (
      admin_decision IN ('accepted', 'overridden')
      AND status = 'completed'
      AND decided_by IS NOT NULL
      AND decided_at IS NOT NULL
    ) OR (
      admin_decision = 'ignored'
      AND status IN ('completed', 'failed')
      AND decided_by IS NOT NULL
      AND decided_at IS NOT NULL
    )
  ),
  CONSTRAINT chk_ai_decisions_completed_after_created CHECK (
    completed_at IS NULL OR completed_at >= created_at
  ),
  CONSTRAINT chk_ai_decisions_decided_after_created CHECK (
    decided_at IS NULL OR decided_at >= created_at
  )
);

COMMENT ON TABLE public.ai_decisions IS
  'Shadow-mode and advisory AI decision log shared across Phase 9 features. Readable strictly by municipal administrators via RLS.';

-- -----------------------------------------------------------------------------
-- 3. Indexes
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ai_decisions_complaint_feature_created
  ON public.ai_decisions (complaint_id, feature, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_decisions_created
  ON public.ai_decisions (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_ai_decisions_one_pending
  ON public.ai_decisions (complaint_id, feature)
  WHERE status = 'pending';

-- -----------------------------------------------------------------------------
-- 4. Immutability & Lifecycle Triggers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_ai_decisions_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.complaints WHERE id = NEW.complaint_id) THEN
    RAISE EXCEPTION 'AI Decision Rejected: Referenced complaint does not exist.'
      USING ERRCODE = '23503';
  END IF;

  -- Force initial pending shadow state on INSERT
  NEW.status := 'pending';
  NEW.suggested_category := NULL;
  NEW.suggested_priority := NULL;
  NEW.suggestion_payload := NULL;
  NEW.confidence := NULL;
  NEW.error_message := NULL;
  NEW.completed_at := NULL;
  NEW.admin_decision := 'pending';
  NEW.final_category := NULL;
  NEW.final_priority := NULL;
  NEW.decided_by := NULL;
  NEW.decided_at := NULL;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_ai_decisions_insert() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_ai_decisions_insert() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_ai_decisions_insert ON public.ai_decisions;
CREATE TRIGGER trg_guard_ai_decisions_insert
  BEFORE INSERT ON public.ai_decisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_ai_decisions_insert();

CREATE OR REPLACE FUNCTION public.guard_ai_decisions_update_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role public.user_role;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AI decision audit records cannot be deleted.'
      USING ERRCODE = '42501';
  END IF;

  -- Provenance metadata is strictly immutable
  IF NEW.id <> OLD.id
     OR NEW.complaint_id <> OLD.complaint_id
     OR NEW.feature <> OLD.feature
     OR NEW.model_name <> OLD.model_name
     OR NEW.prompt_version <> OLD.prompt_version
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'AI decision metadata and provenance fields are immutable.'
      USING ERRCODE = '42501';
  END IF;

  -- Case A: Execution transition (pending -> completed | failed) while admin_decision stays pending
  IF OLD.status = 'pending' AND NEW.status IN ('completed', 'failed') THEN
    IF NEW.admin_decision IS DISTINCT FROM 'pending'
       OR NEW.decided_by IS NOT NULL
       OR NEW.decided_at IS NOT NULL
       OR NEW.final_category IS NOT NULL
       OR NEW.final_priority IS NOT NULL THEN
      RAISE EXCEPTION 'AI execution completion cannot set admin decision fields simultaneously.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Case B: Admin review outcome transition (admin_decision: pending -> accepted | overridden | ignored)
  IF OLD.status IN ('completed', 'failed')
     AND OLD.admin_decision = 'pending'
     AND NEW.admin_decision IN ('accepted', 'overridden', 'ignored') THEN

    -- Original AI output columns must remain untouched
    IF NEW.status <> OLD.status
       OR NEW.suggested_category IS DISTINCT FROM OLD.suggested_category
       OR NEW.suggested_priority IS DISTINCT FROM OLD.suggested_priority
       OR NEW.suggestion_payload IS DISTINCT FROM OLD.suggestion_payload
       OR NEW.confidence IS DISTINCT FROM OLD.confidence
       OR NEW.error_message IS DISTINCT FROM OLD.error_message
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'Original AI suggestion output is immutable once recorded.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.decided_by IS NULL OR NEW.decided_at IS NULL THEN
      RAISE EXCEPTION 'Admin decision requires decided_by and decided_at.'
        USING ERRCODE = '22023';
    END IF;

    SELECT role INTO v_role FROM public.profiles WHERE id = NEW.decided_by;
    IF v_role IS DISTINCT FROM 'admin'::public.user_role THEN
      RAISE EXCEPTION 'Only verified administrators can record AI suggestion decisions.'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Completed or decided AI decision rows are immutable and cannot be modified.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_ai_decisions_update_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_ai_decisions_update_delete() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_ai_decisions_update_delete ON public.ai_decisions;
CREATE TRIGGER trg_guard_ai_decisions_update_delete
  BEFORE UPDATE OR DELETE ON public.ai_decisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_ai_decisions_update_delete();

CREATE OR REPLACE FUNCTION public.guard_ai_decisions_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Truncating AI decision audit history is prohibited.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_ai_decisions_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_ai_decisions_truncate() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_ai_decisions_truncate ON public.ai_decisions;
CREATE TRIGGER trg_guard_ai_decisions_truncate
  BEFORE TRUNCATE ON public.ai_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ai_decisions_truncate();

-- -----------------------------------------------------------------------------
-- 5. Row Level Security & Privileges (Admin SELECT only; Zero direct writes)
-- -----------------------------------------------------------------------------
ALTER TABLE public.ai_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_decisions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_decisions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ai_decisions TO authenticated;

DROP POLICY IF EXISTS "Admins can read AI decisions" ON public.ai_decisions;
CREATE POLICY "Admins can read AI decisions"
  ON public.ai_decisions
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

COMMENT ON POLICY "Admins can read AI decisions" ON public.ai_decisions IS
  'Restricts AI suggestion and decision visibility strictly to administrators; citizens, officers, and anon receive 0 rows.';

-- -----------------------------------------------------------------------------
-- 6. Server-Only Background Input Lookup, Quota Count, Claim, Complete RPCs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_ai_suggestion_inputs(
  p_complaint_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comp RECORD;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Strictly omit citizen_id, street location, coordinates, name, phone, and email.
  SELECT id, title, description, ward, category, priority::text AS priority, status::text AS status
  INTO v_comp
  FROM public.complaints
  WHERE id = p_complaint_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', v_comp.id,
    'title', v_comp.title,
    'description', v_comp.description,
    'ward', v_comp.ward,
    'category', v_comp.category,
    'priority', v_comp.priority,
    'status', v_comp.status
  );
END;
$$;

ALTER FUNCTION public.get_ai_suggestion_inputs(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_ai_suggestion_inputs(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_suggestion_inputs(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.count_ai_decisions_since(
  p_since TIMESTAMPTZ,
  p_exclude_id UUID DEFAULT NULL
)
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT pg_catalog.count(*)::int
  FROM public.ai_decisions
  WHERE created_at >= p_since
    AND status IN ('pending', 'completed')
    AND (p_exclude_id IS NULL OR id <> p_exclude_id);
$$;

ALTER FUNCTION public.count_ai_decisions_since(TIMESTAMPTZ, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.count_ai_decisions_since(TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_ai_decisions_since(TIMESTAMPTZ, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_ai_decision(
  p_complaint_id UUID,
  p_feature TEXT,
  p_model_name TEXT,
  p_prompt_version TEXT DEFAULT 'v1.0',
  p_stale_pending_minutes INT DEFAULT 5
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_feature_clean TEXT;
  v_model_clean TEXT;
  v_prompt_clean TEXT;
  v_stale_mins INT;
  v_stale_ids UUID[];
  v_decision_id UUID;
BEGIN
  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_complaint_id is required.' USING ERRCODE = '22023';
  END IF;

  v_feature_clean := pg_catalog.btrim(COALESCE(p_feature, ''));
  IF pg_catalog.char_length(v_feature_clean) < 1 OR pg_catalog.char_length(v_feature_clean) > 64 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_feature must be 1 to 64 characters.' USING ERRCODE = '22023';
  END IF;

  v_model_clean := pg_catalog.btrim(COALESCE(p_model_name, ''));
  IF pg_catalog.char_length(v_model_clean) < 1 OR pg_catalog.char_length(v_model_clean) > 100 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_model_name must be 1 to 100 characters.' USING ERRCODE = '22023';
  END IF;

  v_prompt_clean := pg_catalog.btrim(COALESCE(p_prompt_version, ''));
  IF pg_catalog.char_length(v_prompt_clean) < 1 OR pg_catalog.char_length(v_prompt_clean) > 64 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_prompt_version must be 1 to 64 characters.' USING ERRCODE = '22023';
  END IF;

  v_stale_mins := COALESCE(p_stale_pending_minutes, 5);
  IF v_stale_mins < 1 OR v_stale_mins > 60 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_stale_pending_minutes must be between 1 and 60.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('ai_decision_' || p_complaint_id::text || '_' || v_feature_clean)
  );

  -- Recover stale pending rows for this (complaint_id, feature)
  SELECT pg_catalog.array_agg(id)
  INTO v_stale_ids
  FROM (
    SELECT id
    FROM public.ai_decisions
    WHERE complaint_id = p_complaint_id
      AND feature = v_feature_clean
      AND status = 'pending'
      AND created_at < (pg_catalog.now() - pg_catalog.make_interval(mins => v_stale_mins))
    FOR UPDATE SKIP LOCKED
  ) stale_rows;

  IF v_stale_ids IS NOT NULL THEN
    UPDATE public.ai_decisions
    SET status = 'failed',
        error_message = 'timeout: stale pending AI task expired.',
        completed_at = pg_catalog.now()
    WHERE id = ANY(v_stale_ids)
      AND status = 'pending';
  END IF;

  -- Skip silently if a pending or completed decision already exists for this complaint & feature
  IF EXISTS (
    SELECT 1 FROM public.ai_decisions
    WHERE complaint_id = p_complaint_id
      AND feature = v_feature_clean
      AND status IN ('pending', 'completed')
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.ai_decisions (
    complaint_id,
    feature,
    model_name,
    prompt_version,
    status,
    created_at
  ) VALUES (
    p_complaint_id,
    v_feature_clean,
    v_model_clean,
    v_prompt_clean,
    'pending',
    pg_catalog.now()
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_decision_id;

  RETURN v_decision_id;
END;
$$;

ALTER FUNCTION public.claim_ai_decision(UUID, TEXT, TEXT, TEXT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_ai_decision(UUID, TEXT, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_decision(UUID, TEXT, TEXT, TEXT, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_ai_decision(
  p_decision_id UUID,
  p_status TEXT,
  p_suggested_category TEXT DEFAULT NULL,
  p_suggested_priority public.complaint_priority DEFAULT NULL,
  p_confidence DOUBLE PRECISION DEFAULT NULL,
  p_suggestion_payload JSONB DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
  v_err_clean TEXT;
BEGIN
  IF p_decision_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_decision_id is required.' USING ERRCODE = '22023';
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Invalid Parameter: p_status must be completed or failed.' USING ERRCODE = '22023';
  END IF;

  SELECT id, feature, status
  INTO v_row
  FROM public.ai_decisions
  WHERE id = p_decision_id
  FOR UPDATE;

  IF NOT FOUND OR v_row.status <> 'pending' THEN
    RETURN FALSE;
  END IF;

  IF p_status = 'completed' THEN
    IF p_confidence IS NULL
       OR p_confidence = 'NaN'::double precision
       OR p_confidence = 'Infinity'::double precision
       OR p_confidence = '-Infinity'::double precision
       OR p_confidence < 0.0
       OR p_confidence > 1.0 THEN
      RAISE EXCEPTION 'Invalid Parameter: completed decision requires finite confidence in [0, 1].' USING ERRCODE = '22023';
    END IF;

    IF v_row.feature = 'category_priority_suggestion' THEN
      IF p_suggested_category IS NULL
         OR p_suggested_category NOT IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure') THEN
        RAISE EXCEPTION 'Invalid Parameter: suggested_category is not an allowed civic category.' USING ERRCODE = '22023';
      END IF;
      IF p_suggested_priority IS NULL THEN
        RAISE EXCEPTION 'Invalid Parameter: suggested_priority is required.' USING ERRCODE = '22023';
      END IF;
    END IF;

    UPDATE public.ai_decisions
    SET status = 'completed',
        suggested_category = p_suggested_category,
        suggested_priority = p_suggested_priority,
        suggestion_payload = p_suggestion_payload,
        confidence = p_confidence,
        error_message = NULL,
        completed_at = pg_catalog.now()
    WHERE id = p_decision_id
      AND status = 'pending';

    RETURN TRUE;
  ELSE
    v_err_clean := pg_catalog.left(pg_catalog.btrim(COALESCE(p_error_message, '')), 500);
    IF pg_catalog.char_length(v_err_clean) < 1 THEN
      v_err_clean := 'AI suggestion attempt failed.';
    END IF;

    UPDATE public.ai_decisions
    SET status = 'failed',
        suggested_category = NULL,
        suggested_priority = NULL,
        suggestion_payload = NULL,
        confidence = NULL,
        error_message = v_err_clean,
        completed_at = pg_catalog.now()
    WHERE id = p_decision_id
      AND status = 'pending';

    RETURN TRUE;
  END IF;
END;
$$;

ALTER FUNCTION public.complete_ai_decision(UUID, TEXT, TEXT, public.complaint_priority, DOUBLE PRECISION, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_ai_decision(UUID, TEXT, TEXT, public.complaint_priority, DOUBLE PRECISION, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_decision(UUID, TEXT, TEXT, public.complaint_priority, DOUBLE PRECISION, JSONB, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 7. Admin Decision RPC (Accept / Override / Ignore) — Authenticated Admin Only
-- Routes priority updates strictly through public.assign_complaint_admin().
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_ai_category_priority_suggestion(
  p_complaint_id UUID,
  p_decision TEXT,
  p_final_category TEXT DEFAULT NULL,
  p_final_priority public.complaint_priority DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID;
  v_comp RECORD;
  v_ai RECORD;
  v_target_category VARCHAR(50);
  v_target_priority public.complaint_priority;
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_new_updated_at TIMESTAMPTZ;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Only municipal administrators can decide AI suggestions.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Security Violation: Missing authenticated actor.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_complaint_id is required.' USING ERRCODE = '22023';
  END IF;

  IF p_decision IS NULL OR p_decision NOT IN ('accepted', 'overridden', 'ignored') THEN
    RAISE EXCEPTION 'Invalid Parameter: p_decision must be accepted, overridden, or ignored.'
      USING ERRCODE = '22023';
  END IF;

  -- Lock complaint row
  SELECT id, category, priority, department_id, assigned_officer_id, sla_deadline, status, updated_at
  INTO v_comp
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Complaint % not found.', p_complaint_id USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_updated_at IS NOT NULL THEN
    IF date_trunc('milliseconds', v_comp.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
      RAISE EXCEPTION 'Concurrency Conflict: Complaint was modified elsewhere. Please refresh and try again.'
        USING ERRCODE = 'P0004';
    END IF;
  END IF;

  -- Lock latest non-pending (completed/failed) suggestion for this complaint
  SELECT *
  INTO v_ai
  FROM public.ai_decisions
  WHERE complaint_id = p_complaint_id
    AND feature = 'category_priority_suggestion'
    AND status IN ('completed', 'failed')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No AI category/priority suggestion exists for complaint %.', p_complaint_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_ai.admin_decision <> 'pending' THEN
    RAISE EXCEPTION 'This AI suggestion already has a recorded admin decision (%).', v_ai.admin_decision
      USING ERRCODE = 'P0001';
  END IF;

  IF p_decision IN ('accepted', 'overridden') THEN
    IF v_ai.status <> 'completed' THEN
      RAISE EXCEPTION 'Cannot accept or override a failed AI suggestion.'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_comp.status IN (
      'resolved'::public.complaint_status,
      'rejected'::public.complaint_status,
      'not_confirmed_by_citizen'::public.complaint_status
    ) THEN
      RAISE EXCEPTION 'Terminal State Violation: Cannot update category or priority on a % complaint.', v_comp.status
        USING ERRCODE = 'P0001';
    END IF;

    IF p_decision = 'accepted' THEN
      v_target_category := v_ai.suggested_category;
      v_target_priority := v_ai.suggested_priority;
    ELSE
      v_target_category := NULLIF(pg_catalog.btrim(COALESCE(p_final_category, '')), '');
      IF v_target_category IS NULL
         OR v_target_category NOT IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure') THEN
        RAISE EXCEPTION 'Invalid Parameter: final_category is not an authorized civic category.'
          USING ERRCODE = '22023';
      END IF;
      IF p_final_priority IS NULL THEN
        RAISE EXCEPTION 'Invalid Parameter: final_priority is required when overriding.'
          USING ERRCODE = '22023';
      END IF;
      v_target_priority := p_final_priority;
    END IF;

    v_new_updated_at := v_comp.updated_at;

    -- Route priority updates strictly through existing admin update path (assign_complaint_admin)
    IF v_target_priority IS DISTINCT FROM v_comp.priority THEN
      PERFORM public.assign_complaint_admin(
        p_complaint_id,
        v_comp.department_id,
        v_comp.assigned_officer_id,
        v_target_priority,
        v_comp.sla_deadline,
        v_comp.updated_at
      );
      SELECT updated_at INTO v_new_updated_at FROM public.complaints WHERE id = p_complaint_id;
    END IF;

    -- Update category on complaints when changed
    IF v_target_category IS DISTINCT FROM v_comp.category THEN
      UPDATE public.complaints
      SET category = v_target_category,
          updated_at = v_now
      WHERE id = p_complaint_id
      RETURNING updated_at INTO v_new_updated_at;
    END IF;

    UPDATE public.ai_decisions
    SET admin_decision = p_decision,
        final_category = v_target_category,
        final_priority = v_target_priority,
        decided_by = v_actor_id,
        decided_at = v_now
    WHERE id = v_ai.id;
  ELSE
    -- Ignored: complaint remains untouched
    v_target_category := NULL;
    v_target_priority := NULL;
    v_new_updated_at := v_comp.updated_at;

    UPDATE public.ai_decisions
    SET admin_decision = 'ignored',
        final_category = NULL,
        final_priority = NULL,
        decided_by = v_actor_id,
        decided_at = v_now
    WHERE id = v_ai.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'complaint_id', p_complaint_id,
    'decision_id', v_ai.id,
    'admin_decision', p_decision,
    'final_category', v_target_category,
    'final_priority', CASE WHEN v_target_priority IS NOT NULL THEN v_target_priority::text ELSE NULL END,
    'complaint_updated_at', v_new_updated_at,
    'decided_at', v_now
  );
END;
$$;

ALTER FUNCTION public.decide_ai_category_priority_suggestion(UUID, TEXT, TEXT, public.complaint_priority, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.decide_ai_category_priority_suggestion(UUID, TEXT, TEXT, public.complaint_priority, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_ai_category_priority_suggestion(UUID, TEXT, TEXT, public.complaint_priority, TIMESTAMPTZ) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Final Privilege & RLS Audit Block
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
    AND c.relname = 'ai_decisions'
    AND c.relrowsecurity = TRUE
    AND c.relforcerowsecurity = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit Failed: RLS and FORCE ROW LEVEL SECURITY must be enabled on public.ai_decisions.';
  END IF;

  IF (
    v_relacl IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(v_relacl) a
      WHERE a.grantee = 0
    )
  )
     OR pg_catalog.has_table_privilege('anon', 'public.ai_decisions', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.ai_decisions', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.ai_decisions', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.ai_decisions', 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.ai_decisions', 'DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.ai_decisions', 'TRUNCATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.ai_decisions', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.ai_decisions', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.ai_decisions', 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', 'public.ai_decisions', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Audit Failed: Unauthorized table privileges detected on public.ai_decisions.';
  END IF;

  -- Verify service_role-only RPCs do not grant EXECUTE to PUBLIC, anon, or authenticated
  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'guard_ai_decisions_insert',
        'guard_ai_decisions_update_delete',
        'guard_ai_decisions_truncate',
        'get_ai_suggestion_inputs',
        'count_ai_decisions_since',
        'claim_ai_decision',
        'complete_ai_decision'
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
      RAISE EXCEPTION 'Audit Failed: Function public.%() exposes EXECUTE to PUBLIC, anon, or authenticated.', v_fn.proname;
    END IF;
  END LOOP;

  -- Verify admin decision RPC grants EXECUTE only to authenticated (never PUBLIC/anon)
  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'decide_ai_category_priority_suggestion'
  ) LOOP
    IF v_fn.proacl IS NULL
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(v_fn.proacl) a
         WHERE a.grantee = 0
           AND a.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Function public.%() exposes EXECUTE to PUBLIC or anon.', v_fn.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
