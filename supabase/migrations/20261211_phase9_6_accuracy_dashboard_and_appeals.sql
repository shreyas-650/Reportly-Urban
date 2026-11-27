-- =============================================================================
-- Migration: 20261211_phase9_6_accuracy_dashboard_and_appeals.sql
-- Module: Phase 9.6 — AI Accuracy Dashboard, Ward Fairness Monitoring & Neutral Review Appeals
-- Target: Supabase PostgreSQL
--
-- Design, Privacy & Safety Guarantees:
--   1. ADDITIVE ONLY: Zero changes to applied migrations, complaint_status enum,
--      or existing Phase 9.1 - 9.5 functions.
--   2. SEPARATE FEATURE ACCURACY (no blended score): computes independent verified
--      metrics for 9.1, 9.2, 9.3, 9.4, 9.5A (advancement), and 9.5B (flag + appeal).
--      Never invents/backfills history; excludes unverified rows and exposes
--      excluded counts and minimum sample gates ("Not enough data" below floor).
--   3. WARD FAIRNESS ISOLATION: ward breakdown normalizes submitted complaints.ward
--      (trim, collapse spaces, case-fold) for grouping only over ONE fixed window,
--      merges wards below minimum into 'Other' (omitting 'Other' if also below min,
--      and reporting displayed_sample_total so hidden groups cannot be recovered
--      by subtraction). Informational only; NEVER read by any 9.1-9.5 AI gate.
--   4. NEUTRAL CITIZEN APPEAL: guarded inside SQL by public.phase9_feature_settings
--      ('screening_appeal', default FALSE / OFF). Available identically to ANY
--      complaint in status='submitted' aged >= p_min_age_days (UTC), regardless of
--      9.5 flags. Enforces 1 open appeal (idempotent retry without consuming caps),
--      lifetime max 3 appeals per complaint, 72h cooldown, rolling 24h cap 3, and
--      length 10..500 chars. Never changes complaints.status or triggers routing.
--   5. IMMUTABLE DECISIONS & FAIL-LOUD WRITES: complaint_review_appeal_decisions
--      is append-only (UPDATE/DELETE/TRUNCATE blocked). Write RPCs fail loudly
--      and roll back on error with verified ROW_COUNT checks.
--   6. PL/pgSQL RULES: SET search_path = '', zero RECORD variables, scalar defaults
--      + FOUND checks, bare LEAST/GREATEST/COALESCE.
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
    SELECT 'table public.profiles' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'profiles'
    )
    UNION ALL
    SELECT 'table public.ai_decisions' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'ai_decisions'
    )
    UNION ALL
    SELECT 'table public.department_assignment_events' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'department_assignment_events'
    )
    UNION ALL
    SELECT 'table public.officer_assignment_events' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'officer_assignment_events'
    )
    UNION ALL
    SELECT 'table public.complaint_duplicate_links' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_duplicate_links'
    )
    UNION ALL
    SELECT 'table public.complaint_screening_reviews' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_screening_reviews'
    )
    UNION ALL
    SELECT 'table public.complaint_screening_events' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_screening_events'
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
-- 2. Additive DB Feature Toggle Table (Default OFF for screening_appeal)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phase9_feature_settings (
  feature_key TEXT PRIMARY KEY CHECK (
    pg_catalog.char_length(pg_catalog.btrim(feature_key)) BETWEEN 1 AND 64
  ),
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

INSERT INTO public.phase9_feature_settings (feature_key, is_enabled)
VALUES ('screening_appeal', FALSE)
ON CONFLICT (feature_key) DO NOTHING;

ALTER TABLE public.phase9_feature_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase9_feature_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.phase9_feature_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.phase9_feature_settings TO authenticated;

DROP POLICY IF EXISTS "Admins can read phase9 feature settings" ON public.phase9_feature_settings;
CREATE POLICY "Admins can read phase9 feature settings"
  ON public.phase9_feature_settings
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 3. Citizen Review Appeals & Immutable Admin Appeal Decisions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_review_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  citizen_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  appeal_text TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(appeal_text)) BETWEEN 10 AND 500
  ),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'needs_more_info', 'released', 'upheld', 'reviewed')
  ),
  had_active_flag BOOLEAN NOT NULL DEFAULT FALSE,
  screening_review_id UUID NULL REFERENCES public.complaint_screening_reviews(id) ON DELETE RESTRICT,
  screening_version TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.complaint_review_appeals IS
  'Neutral citizen review appeals for aged submitted complaints. Strict lifetime cap (3) and max 1 open per complaint enforced in DB. Admin-only readable via FORCE RLS.';

-- At most one OPEN appeal per complaint at any time (idempotent duplicate key)
CREATE UNIQUE INDEX IF NOT EXISTS uidx_open_appeal_per_complaint
  ON public.complaint_review_appeals (complaint_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_review_appeals_complaint_created
  ON public.complaint_review_appeals (complaint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_appeals_citizen_created
  ON public.complaint_review_appeals (citizen_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_appeals_status_created
  ON public.complaint_review_appeals (status, created_at DESC);

ALTER TABLE public.complaint_review_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_review_appeals FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.complaint_review_appeals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_review_appeals TO authenticated;

DROP POLICY IF EXISTS "Admins can read complaint review appeals" ON public.complaint_review_appeals;
CREATE POLICY "Admins can read complaint review appeals"
  ON public.complaint_review_appeals
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

CREATE TABLE IF NOT EXISTS public.complaint_review_appeal_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appeal_id UUID NOT NULL REFERENCES public.complaint_review_appeals(id) ON DELETE RESTRICT,
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  screening_review_id UUID NULL REFERENCES public.complaint_screening_reviews(id) ON DELETE RESTRICT,
  screening_version TEXT NULL,
  previous_decision_id UUID NULL REFERENCES public.complaint_review_appeal_decisions(id) ON DELETE RESTRICT,
  is_correction BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('upheld', 'released', 'needs_more_info', 'reviewed')
  ),
  is_ai_held BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT NULL CHECK (
    reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 3 AND 500
  ),
  decided_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT chk_appeal_decision_flagged_semantics CHECK (
    (is_ai_held = TRUE AND outcome IN ('upheld', 'released', 'needs_more_info'))
    OR (is_ai_held = FALSE AND outcome IN ('reviewed', 'needs_more_info'))
  )
);

COMMENT ON TABLE public.complaint_review_appeal_decisions IS
  'Strictly immutable append-only admin decisions on review appeals. Original decisions can never be edited or deleted; corrections append a new row referencing previous_decision_id.';

CREATE INDEX IF NOT EXISTS idx_appeal_decisions_appeal_decided
  ON public.complaint_review_appeal_decisions (appeal_id, decided_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_appeal_decisions_complaint_decided
  ON public.complaint_review_appeal_decisions (complaint_id, decided_at DESC, id DESC);

ALTER TABLE public.complaint_review_appeal_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_review_appeal_decisions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.complaint_review_appeal_decisions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_review_appeal_decisions TO authenticated;

DROP POLICY IF EXISTS "Admins can read appeal decisions" ON public.complaint_review_appeal_decisions;
CREATE POLICY "Admins can read appeal decisions"
  ON public.complaint_review_appeal_decisions
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 4. Immutability Triggers on Decisions & Lifetime / Open-Appeal Enforcement
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_immutable_appeal_decisions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Appeal decisions are strictly immutable and cannot be updated, deleted, or truncated.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_appeal_decisions() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_appeal_decisions() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_immutable_appeal_decisions ON public.complaint_review_appeal_decisions;
CREATE TRIGGER trg_guard_immutable_appeal_decisions
  BEFORE UPDATE OR DELETE ON public.complaint_review_appeal_decisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_appeal_decisions();

DROP TRIGGER IF EXISTS trg_guard_immutable_appeal_decisions_truncate ON public.complaint_review_appeal_decisions;
CREATE TRIGGER trg_guard_immutable_appeal_decisions_truncate
  BEFORE TRUNCATE ON public.complaint_review_appeal_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_appeal_decisions();

CREATE OR REPLACE FUNCTION public.guard_complaint_review_appeals_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Appeal audit records cannot be deleted or truncated.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_complaint_review_appeals_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_complaint_review_appeals_delete() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_review_appeals_delete ON public.complaint_review_appeals;
CREATE TRIGGER trg_guard_review_appeals_delete
  BEFORE DELETE ON public.complaint_review_appeals
  FOR EACH ROW EXECUTE FUNCTION public.guard_complaint_review_appeals_delete();

DROP TRIGGER IF EXISTS trg_guard_review_appeals_truncate ON public.complaint_review_appeals;
CREATE TRIGGER trg_guard_review_appeals_truncate
  BEFORE TRUNCATE ON public.complaint_review_appeals
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_complaint_review_appeals_delete();

-- -----------------------------------------------------------------------------
-- 5. Admin RPC: Toggle Appeal Feature Flag (DB-level enforcement)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_appeal_feature_enabled(
  p_enabled BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_enabled BOOLEAN := COALESCE(p_enabled, FALSE);
  v_rows INT := 0;
BEGIN
  IF v_actor_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.phase9_feature_settings (feature_key, is_enabled, updated_by, updated_at)
  VALUES ('screening_appeal', v_enabled, v_actor_id, v_now)
  ON CONFLICT (feature_key) DO UPDATE SET
    is_enabled = EXCLUDED.is_enabled,
    updated_by = EXCLUDED.updated_by,
    updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to update screening_appeal feature setting.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'feature_key', 'screening_appeal',
    'is_enabled', v_enabled,
    'updated_at', v_now
  );
END;
$$;

ALTER FUNCTION public.admin_set_appeal_feature_enabled(BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_set_appeal_feature_enabled(BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_appeal_feature_enabled(BOOLEAN) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Citizen RPCs: Neutral Eligibility Check & Review Appeal Submission
--    ZERO AI/flag data returned. Non-owner gets 42501 (mapped to 404 by backend).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_citizen_review_appeal_status(
  p_complaint_id UUID,
  p_min_age_days INT DEFAULT 3,
  p_cooldown_hours INT DEFAULT 72,
  p_lifetime_cap INT DEFAULT 3
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_min_days INT := GREATEST(1, COALESCE(p_min_age_days, 3));
  v_cooldown_hrs INT := GREATEST(1, COALESCE(p_cooldown_hours, 72));
  v_life_cap INT := GREATEST(1, COALESCE(p_lifetime_cap, 3));

  v_feature_on BOOLEAN := FALSE;
  v_comp_found BOOLEAN := FALSE;
  v_comp_citizen_id UUID := NULL;
  v_comp_status public.complaint_status := NULL;
  v_comp_created_at TIMESTAMPTZ := NULL;

  v_open_status TEXT := NULL;
  v_latest_status TEXT := NULL;
  v_total_appeals INT := 0;
  v_last_decided_at TIMESTAMPTZ := NULL;
  v_has_open BOOLEAN := FALSE;
  v_eligible BOOLEAN := FALSE;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;
  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id is required.' USING ERRCODE = '22023';
  END IF;

  SELECT s.is_enabled INTO v_feature_on
  FROM public.phase9_feature_settings s
  WHERE s.feature_key = 'screening_appeal';

  SELECT c.citizen_id, c.status, c.created_at
  INTO v_comp_citizen_id, v_comp_status, v_comp_created_at
  FROM public.complaints c
  WHERE c.id = p_complaint_id;
  v_comp_found := FOUND;

  IF NOT v_comp_found OR v_comp_citizen_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Complaint not found or access denied.' USING ERRCODE = '42501';
  END IF;

  SELECT a.status
  INTO v_open_status
  FROM public.complaint_review_appeals a
  WHERE a.complaint_id = p_complaint_id
    AND a.status = 'open'
  LIMIT 1;
  v_has_open := FOUND;

  SELECT a.status
  INTO v_latest_status
  FROM public.complaint_review_appeals a
  WHERE a.complaint_id = p_complaint_id
  ORDER BY a.created_at DESC, a.id DESC
  LIMIT 1;

  SELECT pg_catalog.count(*)::int
  INTO v_total_appeals
  FROM public.complaint_review_appeals a
  WHERE a.complaint_id = p_complaint_id;

  SELECT d.decided_at
  INTO v_last_decided_at
  FROM public.complaint_review_appeal_decisions d
  WHERE d.complaint_id = p_complaint_id
  ORDER BY d.decided_at DESC, d.id DESC
  LIMIT 1;

  v_eligible := (
    COALESCE(v_feature_on, FALSE) = TRUE
    AND v_comp_status = 'submitted'::public.complaint_status
    AND (v_now - v_comp_created_at) >= pg_catalog.make_interval(days => v_min_days)
    AND NOT v_has_open
    AND COALESCE(v_total_appeals, 0) < v_life_cap
    AND (
      v_last_decided_at IS NULL
      OR (v_now - v_last_decided_at) >= pg_catalog.make_interval(hours => v_cooldown_hrs)
    )
  );

  -- Strictly neutral payload: zero flag/risk/AI fields
  RETURN jsonb_build_object(
    'eligible', COALESCE(v_eligible, FALSE),
    'has_open_appeal', COALESCE(v_has_open, FALSE),
    'appeal_status', CASE
      WHEN v_has_open THEN 'open'
      WHEN v_latest_status IS NOT NULL THEN 'reviewed'
      ELSE 'none'
    END
  );
END;
$$;

ALTER FUNCTION public.get_citizen_review_appeal_status(UUID, INT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_citizen_review_appeal_status(UUID, INT, INT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_citizen_review_appeal_status(UUID, INT, INT, INT) TO authenticated;

-- Fail-loud transactional submission RPC
CREATE OR REPLACE FUNCTION public.submit_complaint_review_appeal(
  p_complaint_id UUID,
  p_appeal_text TEXT,
  p_min_age_days INT DEFAULT 3,
  p_daily_cap INT DEFAULT 3,
  p_cooldown_hours INT DEFAULT 72,
  p_lifetime_cap INT DEFAULT 3
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_clean_text TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_appeal_text, '')), '');
  v_min_days INT := GREATEST(1, COALESCE(p_min_age_days, 3));
  v_daily_cap INT := GREATEST(1, COALESCE(p_daily_cap, 3));
  v_cooldown_hrs INT := GREATEST(1, COALESCE(p_cooldown_hours, 72));
  v_life_cap INT := GREATEST(1, COALESCE(p_lifetime_cap, 3));

  v_feature_on BOOLEAN := FALSE;
  v_comp_found BOOLEAN := FALSE;
  v_comp_citizen_id UUID := NULL;
  v_comp_status public.complaint_status := NULL;
  v_comp_created_at TIMESTAMPTZ := NULL;

  v_open_found BOOLEAN := FALSE;
  v_open_id UUID := NULL;
  v_lifetime_count INT := 0;
  v_daily_count INT := 0;
  v_last_decided_at TIMESTAMPTZ := NULL;

  v_flag_found BOOLEAN := FALSE;
  v_flag_review_id UUID := NULL;
  v_flag_version TEXT := NULL;
  v_flag_status TEXT := NULL;
  v_had_active_flag BOOLEAN := FALSE;

  v_inserted_id UUID := NULL;
  v_rows INT := 0;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id is required.' USING ERRCODE = '22023';
  END IF;

  IF v_clean_text IS NULL
     OR pg_catalog.char_length(v_clean_text) < 10
     OR pg_catalog.char_length(v_clean_text) > 500 THEN
    RAISE EXCEPTION 'Invalid Parameter: Review request note must be between 10 and 500 characters.'
      USING ERRCODE = '22023';
  END IF;

  -- Enforce DB feature toggle
  SELECT s.is_enabled INTO v_feature_on
  FROM public.phase9_feature_settings s
  WHERE s.feature_key = 'screening_appeal';

  IF COALESCE(v_feature_on, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'Feature Disabled: Review appeal requests are currently disabled.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Serialize per complaint
  SELECT c.citizen_id, c.status, c.created_at
  INTO v_comp_citizen_id, v_comp_status, v_comp_created_at
  FROM public.complaints c
  WHERE c.id = p_complaint_id
  FOR UPDATE;
  v_comp_found := FOUND;

  IF NOT v_comp_found OR v_comp_citizen_id IS DISTINCT FROM v_caller_id THEN
    RAISE EXCEPTION 'Complaint not found or access denied.' USING ERRCODE = '42501';
  END IF;

  -- Eligibility re-check inside DB (UTC timestamp comparison)
  IF v_comp_status IS DISTINCT FROM 'submitted'::public.complaint_status THEN
    RAISE EXCEPTION 'Ineligible: Review requests apply only to complaints currently in submitted status.'
      USING ERRCODE = 'P0001';
  END IF;

  IF (v_now - v_comp_created_at) < pg_catalog.make_interval(days => v_min_days) THEN
    RAISE EXCEPTION 'Ineligible: Complaint must remain submitted for at least % day(s) before requesting review.', v_min_days
      USING ERRCODE = 'P0001';
  END IF;

  -- Clarification 2: Idempotent retry when an open appeal already exists
  -- (does NOT insert a row, and does NOT consume daily, lifetime, or cooldown limits)
  SELECT a.id INTO v_open_id
  FROM public.complaint_review_appeals a
  WHERE a.complaint_id = p_complaint_id
    AND a.status = 'open'
  LIMIT 1;
  v_open_found := FOUND;

  IF v_open_found THEN
    RETURN jsonb_build_object(
      'submitted', TRUE,
      'status', 'open'
    );
  END IF;

  -- Lifetime cap across all historical appeals on this complaint (Amendment A)
  SELECT pg_catalog.count(*)::int
  INTO v_lifetime_count
  FROM public.complaint_review_appeals a
  WHERE a.complaint_id = p_complaint_id;

  IF COALESCE(v_lifetime_count, 0) >= v_life_cap THEN
    RAISE EXCEPTION 'Limit Exceeded: Maximum lifetime review requests (%) reached for this complaint.', v_life_cap
      USING ERRCODE = 'P0001';
  END IF;

  -- Cooldown since last decision on this complaint
  SELECT d.decided_at
  INTO v_last_decided_at
  FROM public.complaint_review_appeal_decisions d
  WHERE d.complaint_id = p_complaint_id
  ORDER BY d.decided_at DESC, d.id DESC
  LIMIT 1;

  IF v_last_decided_at IS NOT NULL
     AND (v_now - v_last_decided_at) < pg_catalog.make_interval(hours => v_cooldown_hrs) THEN
    RAISE EXCEPTION 'Cooldown Active: Please wait before submitting another review request for this complaint.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Per-citizen rolling 24h cap (counts newly created rows)
  SELECT pg_catalog.count(*)::int
  INTO v_daily_count
  FROM public.complaint_review_appeals a
  WHERE a.citizen_id = v_caller_id
    AND a.created_at >= (v_now - INTERVAL '24 hours');

  IF COALESCE(v_daily_count, 0) >= v_daily_cap THEN
    RAISE EXCEPTION 'Daily Limit Exceeded: You have reached the daily limit of review requests.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Internal snapshot of whether Phase 9.5 flagged/held this complaint (NEVER returned to citizen)
  SELECT sr.id, sr.screening_version, sr.review_status
  INTO v_flag_review_id, v_flag_version, v_flag_status
  FROM public.complaint_screening_reviews sr
  WHERE sr.complaint_id = p_complaint_id
    AND (
      sr.review_status IN ('needs_review', 'priority_review', 'confirmed_suspicious')
      OR sr.admin_decision = 'confirmed_suspicious'
    )
  ORDER BY sr.updated_at DESC
  LIMIT 1;
  v_flag_found := FOUND;

  v_had_active_flag := v_flag_found;

  INSERT INTO public.complaint_review_appeals (
    complaint_id,
    citizen_id,
    appeal_text,
    status,
    had_active_flag,
    screening_review_id,
    screening_version,
    created_at
  ) VALUES (
    p_complaint_id,
    v_caller_id,
    v_clean_text,
    'open',
    v_had_active_flag,
    v_flag_review_id,
    v_flag_version,
    v_now
  )
  RETURNING id INTO v_inserted_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 OR v_inserted_id IS NULL THEN
    RAISE EXCEPTION 'Appeal persistence failed.' USING ERRCODE = 'P0001';
  END IF;

  -- Strictly neutral acknowledgement (no flag/screening/ID metadata needed)
  RETURN jsonb_build_object(
    'submitted', TRUE,
    'status', 'open'
  );
END;
$$;

ALTER FUNCTION public.submit_complaint_review_appeal(UUID, TEXT, INT, INT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_complaint_review_appeal(UUID, TEXT, INT, INT, INT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.submit_complaint_review_appeal(UUID, TEXT, INT, INT, INT, INT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. Admin Appeals Queue & Immutable Decision / Correction RPCs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_admin_review_appeals(
  p_status TEXT DEFAULT 'open',
  p_page INT DEFAULT 1,
  p_page_size INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_filter TEXT := COALESCE(NULLIF(pg_catalog.lower(pg_catalog.btrim(p_status)), ''), 'open');
  v_page INT := GREATEST(1, COALESCE(p_page, 1));
  v_size INT := LEAST(100, GREATEST(1, COALESCE(p_page_size, 20)));
  v_offset INT;
  v_total INT := 0;
  v_feature_on BOOLEAN := FALSE;
  v_items JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  IF v_filter NOT IN ('open', 'needs_more_info', 'released', 'upheld', 'reviewed', 'all') THEN
    RAISE EXCEPTION 'Invalid Parameter: unsupported appeal status filter.' USING ERRCODE = '22023';
  END IF;

  SELECT s.is_enabled INTO v_feature_on
  FROM public.phase9_feature_settings s
  WHERE s.feature_key = 'screening_appeal';

  v_offset := (v_page - 1) * v_size;

  SELECT pg_catalog.count(*)::int
  INTO v_total
  FROM public.complaint_review_appeals a
  WHERE v_filter = 'all' OR a.status = v_filter;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT
      a.id AS appeal_id,
      a.complaint_id,
      c.complaint_number,
      c.title AS complaint_title,
      c.category AS complaint_category,
      c.ward AS complaint_ward,
      c.status::text AS complaint_status,
      a.appeal_text,
      a.status AS appeal_status,
      a.had_active_flag,
      a.screening_review_id,
      a.screening_version,
      sr.risk_level,
      sr.reason_codes,
      sr.review_status,
      ld.id AS latest_decision_id,
      ld.outcome AS latest_outcome,
      ld.reason AS latest_reason,
      ld.is_correction AS latest_is_correction,
      ld.decided_at AS latest_decided_at,
      a.created_at
    FROM public.complaint_review_appeals a
    JOIN public.complaints c ON c.id = a.complaint_id
    LEFT JOIN public.complaint_screening_reviews sr ON sr.id = a.screening_review_id
    LEFT JOIN LATERAL (
      SELECT d.id, d.outcome, d.reason, d.is_correction, d.decided_at
      FROM public.complaint_review_appeal_decisions d
      WHERE d.appeal_id = a.id
      ORDER BY d.decided_at DESC, d.id DESC
      LIMIT 1
    ) ld ON TRUE
    WHERE v_filter = 'all' OR a.status = v_filter
    ORDER BY a.had_active_flag DESC, a.created_at DESC
    OFFSET v_offset
    LIMIT v_size
  ) row_data;

  RETURN jsonb_build_object(
    'appeal_feature_enabled', COALESCE(v_feature_on, FALSE),
    'items', v_items,
    'total', v_total,
    'page', v_page,
    'page_size', v_size,
    'total_pages', GREATEST(1, pg_catalog.ceil(v_total::numeric / v_size)::int)
  );
END;
$$;

ALTER FUNCTION public.list_admin_review_appeals(TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_review_appeals(TEXT, INT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_review_appeals(TEXT, INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_decide_complaint_review_appeal(
  p_appeal_id UUID,
  p_outcome TEXT,
  p_reason TEXT DEFAULT NULL,
  p_is_correction BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_outcome TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_outcome, '')));
  v_clean_reason TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  v_is_correction BOOLEAN := COALESCE(p_is_correction, FALSE);

  v_app_found BOOLEAN := FALSE;
  v_app_complaint_id UUID := NULL;
  v_app_status TEXT := NULL;
  v_app_had_flag BOOLEAN := FALSE;
  v_app_rev_id UUID := NULL;
  v_app_ver TEXT := NULL;

  v_comp_status public.complaint_status := NULL;
  v_prev_dec_id UUID := NULL;
  v_new_dec_id UUID := NULL;
  v_rows INT := 0;
  v_new_rev_status TEXT := NULL;
  v_new_admin_dec TEXT := NULL;
  v_event_type TEXT := NULL;
BEGIN
  IF v_actor_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;
  IF p_appeal_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: appeal_id is required.' USING ERRCODE = '22023';
  END IF;
  IF v_outcome NOT IN ('upheld', 'released', 'needs_more_info', 'reviewed') THEN
    RAISE EXCEPTION 'Invalid Parameter: unsupported appeal decision "%".', v_outcome USING ERRCODE = '22023';
  END IF;
  IF v_clean_reason IS NOT NULL AND pg_catalog.char_length(v_clean_reason) < 3 THEN
    RAISE EXCEPTION 'Invalid Parameter: reason must be at least 3 characters when provided.' USING ERRCODE = '22023';
  END IF;

  -- Lock appeal row atomically (race safety for concurrent admins)
  SELECT
    a.complaint_id, a.status, a.had_active_flag, a.screening_review_id, a.screening_version
  INTO
    v_app_complaint_id, v_app_status, v_app_had_flag, v_app_rev_id, v_app_ver
  FROM public.complaint_review_appeals a
  WHERE a.id = p_appeal_id
  FOR UPDATE;
  v_app_found := FOUND;

  IF NOT v_app_found THEN
    RAISE EXCEPTION 'Not Found: Review appeal does not exist.' USING ERRCODE = 'P0002';
  END IF;

  SELECT c.status INTO v_comp_status
  FROM public.complaints c
  WHERE c.id = v_app_complaint_id;

  IF v_app_had_flag AND v_outcome NOT IN ('upheld', 'released', 'needs_more_info') THEN
    RAISE EXCEPTION 'Invalid Parameter: flagged appeal outcome must be upheld, released, or needs_more_info.'
      USING ERRCODE = '22023';
  ELSIF NOT v_app_had_flag AND v_outcome NOT IN ('reviewed', 'needs_more_info') THEN
    RAISE EXCEPTION 'Invalid Parameter: unflagged appeal outcome must be reviewed or needs_more_info.'
      USING ERRCODE = '22023';
  END IF;

  IF NOT v_is_correction THEN
    IF v_app_status NOT IN ('open', 'needs_more_info')
       OR (v_app_status = 'needs_more_info' AND v_outcome = 'needs_more_info') THEN
      RAISE EXCEPTION 'Conflict: This review appeal has already been decided.' USING ERRCODE = 'P0001';
    END IF;
    -- Find previous non-final decision (if transitioning out of needs_more_info)
    SELECT d.id INTO v_prev_dec_id
    FROM public.complaint_review_appeal_decisions d
    WHERE d.appeal_id = p_appeal_id
    ORDER BY d.decided_at DESC, d.id DESC
    LIMIT 1;
  ELSE
    -- Explicit correction of an already-decided appeal creates a NEW immutable row
    IF v_app_status NOT IN ('upheld', 'released', 'reviewed') THEN
      RAISE EXCEPTION 'Conflict: Corrections apply only to already decided appeals.' USING ERRCODE = 'P0001';
    END IF;
    IF v_clean_reason IS NULL OR pg_catalog.char_length(v_clean_reason) < 5 THEN
      RAISE EXCEPTION 'Invalid Parameter: Correction requires a reason (minimum 5 characters).' USING ERRCODE = '22023';
    END IF;
    SELECT d.id INTO v_prev_dec_id
    FROM public.complaint_review_appeal_decisions d
    WHERE d.appeal_id = p_appeal_id
    ORDER BY d.decided_at DESC, d.id DESC
    LIMIT 1;
  END IF;

  -- Insert strictly immutable decision row
  INSERT INTO public.complaint_review_appeal_decisions (
    appeal_id,
    complaint_id,
    screening_review_id,
    screening_version,
    previous_decision_id,
    is_correction,
    outcome,
    is_ai_held,
    reason,
    decided_by,
    decided_at
  ) VALUES (
    p_appeal_id,
    v_app_complaint_id,
    v_app_rev_id,
    v_app_ver,
    v_prev_dec_id,
    v_is_correction,
    v_outcome,
    v_app_had_flag,
    v_clean_reason,
    v_actor_id,
    v_now
  )
  RETURNING id INTO v_new_dec_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 OR v_new_dec_id IS NULL THEN
    RAISE EXCEPTION 'Failed to persist appeal decision.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.complaint_review_appeals
  SET status = v_outcome
  WHERE id = p_appeal_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Failed to update appeal state.' USING ERRCODE = 'P0001';
  END IF;

  -- Sync flag status when flagged & final decision made (without modifying complaint_status or old events)
  IF v_app_had_flag AND v_app_rev_id IS NOT NULL AND v_outcome IN ('released', 'upheld') THEN
    IF v_outcome = 'released' THEN
      v_new_rev_status := 'dismissed';
      v_new_admin_dec := 'false_alarm';
      v_event_type := 'admin_dismissed_flag';
    ELSE
      v_new_rev_status := 'confirmed_suspicious';
      v_new_admin_dec := 'confirmed_suspicious';
      v_event_type := 'admin_confirmed_suspicious';
    END IF;

    UPDATE public.complaint_screening_reviews
    SET review_status = v_new_rev_status,
        admin_decision = v_new_admin_dec,
        updated_at = v_now
    WHERE id = v_app_rev_id;

    INSERT INTO public.complaint_screening_events (
      complaint_id,
      screening_review_id,
      actor_type,
      actor_id,
      event_type,
      mode,
      screening_version,
      applied,
      previous_status,
      resulting_status,
      notes,
      created_at
    )
    SELECT
      v_app_complaint_id,
      v_app_rev_id,
      'staff',
      v_actor_id,
      v_event_type,
      sr.mode,
      sr.screening_version,
      FALSE,
      v_comp_status,
      v_comp_status,
      COALESCE(v_clean_reason, 'appeal_outcome:' || v_outcome),
      v_now
    FROM public.complaint_screening_reviews sr
    WHERE sr.id = v_app_rev_id;
  END IF;

  -- Note: never modifies public.complaints.status
  RETURN jsonb_build_object(
    'success', TRUE,
    'appeal_id', p_appeal_id,
    'decision_id', v_new_dec_id,
    'complaint_id', v_app_complaint_id,
    'outcome', v_outcome,
    'is_ai_held', v_app_had_flag,
    'is_correction', v_is_correction,
    'complaint_status', v_comp_status::text,
    'decided_at', v_now
  );
END;
$$;

ALTER FUNCTION public.admin_decide_complaint_review_appeal(UUID, TEXT, TEXT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_decide_complaint_review_appeal(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_complaint_review_appeal(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Read-Only Admin Accuracy Dashboard RPC (authenticated + is_admin() ONLY)
--    Computes 6 independent feature cards (no combined score, no backfilled history).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_accuracy_dashboard(
  p_window TEXT DEFAULT '30d',
  p_min_samples INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_window TEXT := COALESCE(NULLIF(pg_catalog.lower(pg_catalog.btrim(p_window)), ''), '30d');
  v_min_samples INT := GREATEST(5, COALESCE(p_min_samples, 20));
  v_from TIMESTAMPTZ := NULL;

  -- Card 1: 9.1 Category & Priority
  c91_agree INT := 0; c91_disagree INT := 0; c91_excl INT := 0; c91_sample INT := 0;
  -- Card 2: 9.2 Department Routing
  c92_agree INT := 0; c92_disagree INT := 0; c92_excl INT := 0; c92_sample INT := 0;
  -- Card 3: 9.3 Officer Routing (Clarification 5 & Amendment F)
  c93_agree INT := 0; c93_disagree INT := 0; c93_excl INT := 0; c93_sample INT := 0;
  -- Card 4: 9.4 Duplicate Detection
  c94_agree INT := 0; c94_disagree INT := 0; c94_excl INT := 0; c94_sample INT := 0;
  -- Card 5: 9.5A Workflow Advancement
  c95a_agree INT := 0; c95a_disagree INT := 0; c95a_rej INT := 0; c95a_excl INT := 0; c95a_sample INT := 0;
  -- Card 6: 9.5B Flag + Appeal Accuracy (Clarification 1 & 4)
  c95b_agree INT := 0; c95b_disagree INT := 0; c95b_excl INT := 0; c95b_sample INT := 0; c95b_corrected INT := 0;
  c96_plain_appeals INT := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  IF v_window NOT IN ('7d', '30d', '90d', 'all') THEN
    RAISE EXCEPTION 'Invalid Parameter: window must be 7d, 30d, 90d, or all.' USING ERRCODE = '22023';
  END IF;

  v_from := CASE v_window
    WHEN '7d' THEN v_now - INTERVAL '7 days'
    WHEN '30d' THEN v_now - INTERVAL '30 days'
    WHEN '90d' THEN v_now - INTERVAL '90 days'
    ELSE TIMESTAMPTZ '1970-01-01 00:00:00+00'
  END;

  -- 1) 9.1 Category & Priority
  SELECT
    pg_catalog.count(*) FILTER (WHERE d.admin_decision = 'accepted')::int,
    pg_catalog.count(*) FILTER (WHERE d.admin_decision = 'overridden')::int,
    pg_catalog.count(*) FILTER (WHERE d.admin_decision IN ('pending', 'ignored') OR d.status <> 'completed')::int
  INTO c91_agree, c91_disagree, c91_excl
  FROM public.ai_decisions d
  WHERE d.feature = 'category_priority_suggestion'
    AND d.created_at >= v_from;
  c91_sample := COALESCE(c91_agree, 0) + COALESCE(c91_disagree, 0);

  -- 2) 9.2 Department Routing (human ground truth vs AI suggestion)
  WITH latest_91 AS (
    SELECT DISTINCT ON (d.complaint_id)
      d.complaint_id,
      d.suggested_category,
      d.created_at
    FROM public.ai_decisions d
    WHERE d.feature = 'category_priority_suggestion'
      AND d.status = 'completed'
      AND d.suggested_category IS NOT NULL
      AND d.created_at >= v_from
    ORDER BY d.complaint_id, COALESCE(d.completed_at, d.created_at) DESC, d.id DESC
  ),
  eval_92 AS (
    SELECT
      c.department_id AS human_dept_id,
      (
        c.department_id IS NOT NULL
        AND (
          EXISTS (SELECT 1 FROM public.complaint_assignment_audit a WHERE a.complaint_id = c.id AND a.new_department_id = c.department_id)
          OR EXISTS (SELECT 1 FROM public.department_assignment_events ev WHERE ev.complaint_id = c.id AND ev.actor_type = 'staff' AND ev.new_department_id = c.department_id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.department_assignment_events ai_ev
          WHERE ai_ev.complaint_id = c.id AND ai_ev.actor_type = 'system_ai' AND ai_ev.applied = TRUE AND ai_ev.new_department_id = c.department_id
            AND NOT EXISTS (SELECT 1 FROM public.department_assignment_events st WHERE st.complaint_id = c.id AND st.actor_type = 'staff' AND st.created_at >= ai_ev.created_at)
            AND NOT EXISTS (SELECT 1 FROM public.complaint_assignment_audit au WHERE au.complaint_id = c.id AND au.new_department_id = c.department_id AND au.created_at >= ai_ev.created_at)
        )
      ) AS has_human_truth,
      COALESCE(
        (SELECT ev.suggested_department_id FROM public.department_assignment_events ev
         WHERE ev.complaint_id = c.id AND ev.actor_type = 'system_ai' AND ev.suggested_department_id IS NOT NULL
         ORDER BY ev.created_at DESC LIMIT 1),
        (SELECT mg.department_id FROM public.category_department_mappings mg
         JOIN public.departments dg ON dg.id = mg.department_id
         WHERE mg.category = l.suggested_category AND mg.ward IS NULL AND mg.is_active = TRUE AND dg.is_active = TRUE
         LIMIT 1)
      ) AS pred_dept_id
    FROM latest_91 l
    JOIN public.complaints c ON c.id = l.complaint_id
  )
  SELECT
    pg_catalog.count(*) FILTER (WHERE has_human_truth AND pred_dept_id IS NOT NULL AND pred_dept_id = human_dept_id)::int,
    pg_catalog.count(*) FILTER (WHERE has_human_truth AND (pred_dept_id IS NULL OR pred_dept_id <> human_dept_id))::int,
    pg_catalog.count(*) FILTER (WHERE NOT has_human_truth)::int
  INTO c92_agree, c92_disagree, c92_excl
  FROM eval_92;
  c92_sample := COALESCE(c92_agree, 0) + COALESCE(c92_disagree, 0);

  -- 3) 9.3 Officer Routing (Amendment F + Clarification 5)
  WITH eval_93 AS (
    SELECT
      e.complaint_id,
      e.new_officer_id,
      e.created_at AS ai_at,
      c.assigned_officer_id AS current_officer_id,
      EXISTS (
        SELECT 1 FROM public.officer_assignment_events s
        WHERE s.complaint_id = e.complaint_id
          AND s.actor_type = 'staff'
          AND s.created_at >= e.created_at
          AND (s.is_ai_override = TRUE OR s.new_officer_id IS DISTINCT FROM e.new_officer_id)
      ) AS has_staff_override,
      (
        SELECT pg_catalog.min(h.created_at)
        FROM public.complaint_status_history h
        WHERE h.complaint_id = e.complaint_id
          AND h.status IN ('in_progress'::public.complaint_status, 'resolved'::public.complaint_status)
          AND h.created_at >= e.created_at
      ) AS acted_at
    FROM public.officer_assignment_events e
    JOIN public.complaints c ON c.id = e.complaint_id
    WHERE e.actor_type = 'system_ai'
      AND e.applied = TRUE
      AND e.new_officer_id IS NOT NULL
      AND e.created_at >= v_from
  )
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE NOT has_staff_override
        AND acted_at IS NOT NULL
        AND current_officer_id = new_officer_id
        AND NOT EXISTS (
          SELECT 1 FROM public.officer_assignment_events sb
          WHERE sb.complaint_id = eval_93.complaint_id
            AND sb.actor_type = 'staff'
            AND sb.created_at >= ai_at
            AND sb.created_at <= acted_at
        )
    )::int,
    pg_catalog.count(*) FILTER (WHERE has_staff_override)::int,
    pg_catalog.count(*) FILTER (
      WHERE NOT has_staff_override
        AND (acted_at IS NULL OR current_officer_id IS DISTINCT FROM new_officer_id)
    )::int
  INTO c93_agree, c93_disagree, c93_excl
  FROM eval_93;
  c93_sample := COALESCE(c93_agree, 0) + COALESCE(c93_disagree, 0);

  -- 4) 9.4 Duplicate Detection
  SELECT
    pg_catalog.count(*) FILTER (WHERE dl.status = 'confirmed_duplicate')::int,
    pg_catalog.count(*) FILTER (WHERE dl.status = 'not_duplicate')::int,
    pg_catalog.count(*) FILTER (WHERE dl.status = 'suspected')::int
  INTO c94_agree, c94_disagree, c94_excl
  FROM public.complaint_duplicate_links dl
  WHERE dl.created_at >= v_from;
  c94_sample := COALESCE(c94_agree, 0) + COALESCE(c94_disagree, 0);

  -- 5) 9.5A Workflow Advancement Accuracy
  WITH eval_95a AS (
    SELECT
      (
        c.status = 'rejected'::public.complaint_status
        OR EXISTS (SELECT 1 FROM public.complaint_status_history hr WHERE hr.complaint_id = r.complaint_id AND hr.status = 'rejected'::public.complaint_status)
      ) AS is_rejected,
      (
        c.status = 'rejected'::public.complaint_status
        OR EXISTS (SELECT 1 FROM public.complaint_status_history hr WHERE hr.complaint_id = r.complaint_id AND hr.status = 'rejected'::public.complaint_status)
        OR r.admin_decision = 'confirmed_suspicious'
        OR r.advancement_outcome = 'reverted'
      ) AS is_disagree,
      (
        EXISTS (SELECT 1 FROM public.complaint_status_history hu WHERE hu.complaint_id = r.complaint_id AND hu.status = 'under_review'::public.complaint_status AND hu.actor_id IS NOT NULL)
        OR r.advancement_outcome = 'kept'
      ) AS is_agree_path
    FROM public.complaint_screening_reviews r
    JOIN public.complaints c ON c.id = r.complaint_id
    WHERE r.would_advance = TRUE
      AND r.created_at >= v_from
  )
  SELECT
    pg_catalog.count(*) FILTER (WHERE NOT is_disagree AND is_agree_path)::int,
    pg_catalog.count(*) FILTER (WHERE is_disagree)::int,
    pg_catalog.count(*) FILTER (WHERE is_rejected)::int,
    pg_catalog.count(*) FILTER (WHERE NOT is_disagree AND NOT is_agree_path)::int
  INTO c95a_agree, c95a_disagree, c95a_rej, c95a_excl
  FROM eval_95a;
  c95a_sample := COALESCE(c95a_agree, 0) + COALESCE(c95a_disagree, 0);

  -- 6) 9.5B Flag + Appeal Accuracy (Clarifications 1 & 4: latest decided_at DESC, id DESC)
  WITH flagged_cases AS (
    SELECT
      r.id AS review_id,
      r.complaint_id,
      r.screening_version
    FROM public.complaint_screening_reviews r
    WHERE r.created_at >= v_from
      AND (
        r.risk_level IN ('medium', 'high')
        OR COALESCE(pg_catalog.array_length(r.reason_codes, 1), 0) > 0
        OR r.review_status IN ('needs_review', 'priority_review', 'confirmed_suspicious', 'dismissed', 'reverted')
      )
  ),
  final_verdict_per_case AS (
    SELECT
      fc.complaint_id,
      fc.screening_version,
      fv.verdict
    FROM flagged_cases fc
    LEFT JOIN LATERAL (
      SELECT cand.verdict
      FROM (
        -- Direct screening review events
        SELECT
          CASE e.event_type
            WHEN 'admin_confirmed_suspicious' THEN 'agree'
            ELSE 'disagree'
          END AS verdict,
          e.created_at AS decided_at,
          e.id AS row_id
        FROM public.complaint_screening_events e
        WHERE e.complaint_id = fc.complaint_id
          AND e.screening_version = fc.screening_version
          AND e.event_type IN ('admin_confirmed_suspicious', 'admin_dismissed_flag')
        UNION ALL
        -- Appeal final decisions (needs_more_info excluded!)
        SELECT
          CASE d.outcome
            WHEN 'upheld' THEN 'agree'
            ELSE 'disagree'
          END AS verdict,
          d.decided_at,
          d.id AS row_id
        FROM public.complaint_review_appeal_decisions d
        WHERE d.complaint_id = fc.complaint_id
          AND (d.screening_version IS NULL OR d.screening_version = fc.screening_version)
          AND d.is_ai_held = TRUE
          AND d.outcome IN ('upheld', 'released')
      ) cand
      ORDER BY cand.decided_at DESC, cand.row_id DESC
      LIMIT 1
    ) fv ON TRUE
  )
  SELECT
    pg_catalog.count(*) FILTER (WHERE verdict = 'agree')::int,
    pg_catalog.count(*) FILTER (WHERE verdict = 'disagree')::int,
    pg_catalog.count(*) FILTER (WHERE verdict IS NULL)::int
  INTO c95b_agree, c95b_disagree, c95b_excl
  FROM final_verdict_per_case;
  c95b_sample := COALESCE(c95b_agree, 0) + COALESCE(c95b_disagree, 0);

  SELECT pg_catalog.count(*)::int
  INTO c95b_corrected
  FROM public.complaint_review_appeal_decisions d
  WHERE d.is_correction = TRUE
    AND d.is_ai_held = TRUE
    AND d.decided_at >= v_from;

  SELECT pg_catalog.count(*)::int
  INTO c96_plain_appeals
  FROM public.complaint_review_appeals a
  WHERE a.had_active_flag = FALSE
    AND a.created_at >= v_from;

  RETURN jsonb_build_object(
    'window', v_window,
    'date_from', v_from,
    'date_to', v_now,
    'min_samples', v_min_samples,
    'plain_review_appeals_count', COALESCE(c96_plain_appeals, 0),
    'cards', pg_catalog.jsonb_build_array(
      jsonb_build_object(
        'feature', 'category_priority',
        'label', '9.1 Category & Priority',
        'sample_size', c91_sample,
        'agreed_count', c91_agree,
        'disagreed_count', c91_disagree,
        'excluded_count', c91_excl,
        'enough_data', (c91_sample >= v_min_samples),
        'agreement_rate', CASE WHEN c91_sample >= v_min_samples THEN (c91_agree::double precision / c91_sample) ELSE NULL END,
        'override_rate', CASE WHEN c91_sample >= v_min_samples THEN (c91_disagree::double precision / c91_sample) ELSE NULL END
      ),
      jsonb_build_object(
        'feature', 'department_routing',
        'label', '9.2 Department Routing',
        'sample_size', c92_sample,
        'agreed_count', c92_agree,
        'disagreed_count', c92_disagree,
        'excluded_count', c92_excl,
        'enough_data', (c92_sample >= v_min_samples),
        'agreement_rate', CASE WHEN c92_sample >= v_min_samples THEN (c92_agree::double precision / c92_sample) ELSE NULL END,
        'disagreement_rate', CASE WHEN c92_sample >= v_min_samples THEN (c92_disagree::double precision / c92_sample) ELSE NULL END
      ),
      jsonb_build_object(
        'feature', 'officer_routing',
        'label', '9.3 Officer Routing',
        'sample_size', c93_sample,
        'agreed_count', c93_agree,
        'disagreed_count', c93_disagree,
        'excluded_count', c93_excl,
        'enough_data', (c93_sample >= v_min_samples),
        'agreement_rate', CASE WHEN c93_sample >= v_min_samples THEN (c93_agree::double precision / c93_sample) ELSE NULL END,
        'override_rate', CASE WHEN c93_sample >= v_min_samples THEN (c93_disagree::double precision / c93_sample) ELSE NULL END
      ),
      jsonb_build_object(
        'feature', 'duplicate_detection',
        'label', '9.4 Duplicate Detection',
        'sample_size', c94_sample,
        'agreed_count', c94_agree,
        'disagreed_count', c94_disagree,
        'excluded_count', c94_excl,
        'enough_data', (c94_sample >= v_min_samples),
        'agreement_rate', CASE WHEN c94_sample >= v_min_samples THEN (c94_agree::double precision / c94_sample) ELSE NULL END,
        'false_positive_rate', CASE WHEN c94_sample >= v_min_samples THEN (c94_disagree::double precision / c94_sample) ELSE NULL END
      ),
      jsonb_build_object(
        'feature', 'screening_advancement',
        'label', '9.5A Workflow Advancement',
        'sample_size', c95a_sample,
        'agreed_count', c95a_agree,
        'disagreed_count', c95a_disagree,
        'rejected_count', c95a_rej,
        'excluded_count', c95a_excl,
        'enough_data', (c95a_sample >= v_min_samples),
        'agreement_rate', CASE WHEN c95a_sample >= v_min_samples THEN (c95a_agree::double precision / c95a_sample) ELSE NULL END,
        'disagreement_rate', CASE WHEN c95a_sample >= v_min_samples THEN (c95a_disagree::double precision / c95a_sample) ELSE NULL END,
        'rejection_rate', CASE WHEN c95a_sample >= v_min_samples THEN (c95a_rej::double precision / c95a_sample) ELSE NULL END
      ),
      jsonb_build_object(
        'feature', 'screening_flag_and_appeal',
        'label', '9.5B Screening Flags & Appeals',
        'sample_size', c95b_sample,
        'agreed_count', c95b_agree,
        'disagreed_count', c95b_disagree,
        'excluded_count', c95b_excl,
        'corrected_decisions_count', c95b_corrected,
        'enough_data', (c95b_sample >= v_min_samples),
        'agreement_rate', CASE WHEN c95b_sample >= v_min_samples THEN (c95b_agree::double precision / c95b_sample) ELSE NULL END,
        'false_positive_rate', CASE WHEN c95b_sample >= v_min_samples THEN (c95b_disagree::double precision / c95b_sample) ELSE NULL END
      )
    )
  );
END;
$$;

ALTER FUNCTION public.get_admin_accuracy_dashboard(TEXT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_accuracy_dashboard(TEXT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_accuracy_dashboard(TEXT, INT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 9. Read-Only Ward Fairness Monitoring RPC (ONE fixed window, anti-subtraction)
--    Informational only. Never read by any 9.1 - 9.5 AI decision function.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_ward_accuracy_fairness(
  p_ward_min_samples INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_min INT := GREATEST(5, COALESCE(p_ward_min_samples, 20));
  v_overall_agree INT := 0;
  v_overall_total INT := 0;
  v_overall_rate DOUBLE PRECISION := NULL;
  v_wards JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  -- Evaluates verified 9.1 category/priority decisions grouped by submitted complaints.ward
  -- over ONE fixed all-time window (never filtered dynamically, preventing subtraction attacks).
  WITH base AS (
    SELECT
      COALESCE(
        NULLIF(pg_catalog.lower(pg_catalog.regexp_replace(pg_catalog.btrim(c.ward), '\s+', ' ', 'g')), ''),
        'unspecified'
      ) AS ward_key,
      (d.admin_decision = 'accepted') AS is_agree
    FROM public.ai_decisions d
    JOIN public.complaints c ON c.id = d.complaint_id
    WHERE d.feature = 'category_priority_suggestion'
      AND d.admin_decision IN ('accepted', 'overridden')
  ),
  per_ward AS (
    SELECT
      ward_key,
      pg_catalog.count(*)::int AS sample_size,
      pg_catalog.count(*) FILTER (WHERE is_agree)::int AS agreed_count
    FROM base
    GROUP BY ward_key
  ),
  major_wards AS (
    SELECT
      ward_key AS ward,
      sample_size,
      agreed_count,
      FALSE AS is_other
    FROM per_ward
    WHERE sample_size >= v_min
  ),
  other_bucket AS (
    SELECT
      'Other'::text AS ward,
      pg_catalog.sum(sample_size)::int AS sample_size,
      pg_catalog.sum(agreed_count)::int AS agreed_count,
      TRUE AS is_other
    FROM per_ward
    WHERE sample_size < v_min
    HAVING pg_catalog.sum(sample_size) >= v_min
  ),
  displayed AS (
    SELECT * FROM major_wards
    UNION ALL
    SELECT * FROM other_bucket
  )
  SELECT
    COALESCE(pg_catalog.sum(sample_size), 0)::int,
    COALESCE(pg_catalog.sum(agreed_count), 0)::int,
    COALESCE(
      pg_catalog.jsonb_agg(
        jsonb_build_object(
          'ward', ward,
          'is_other', is_other,
          'sample_size', sample_size,
          'agreed_count', agreed_count,
          'agreement_rate', (agreed_count::double precision / sample_size::double precision)
        )
        ORDER BY is_other ASC, sample_size DESC, ward ASC
      ),
      '[]'::jsonb
    )
  INTO v_overall_total, v_overall_agree, v_wards
  FROM displayed;

  IF COALESCE(v_overall_total, 0) >= v_min THEN
    v_overall_rate := v_overall_agree::double precision / v_overall_total::double precision;
  END IF;

  -- Attach disparity vs displayed overall baseline (informational only)
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      (elem || jsonb_build_object(
        'disparity_vs_overall',
        CASE
          WHEN v_overall_rate IS NOT NULL THEN ((elem->>'agreement_rate')::double precision - v_overall_rate)
          ELSE NULL
        END
      ))
    ),
    '[]'::jsonb
  )
  INTO v_wards
  FROM pg_catalog.jsonb_array_elements(v_wards) elem;

  RETURN jsonb_build_object(
    'scope', 'category_priority',
    'fixed_window', 'all_time',
    'ward_min_samples', v_min,
    'fairness_notice', 'Fairness monitoring, informational only. Ward data never feeds any AI decision, threshold, or gate.',
    'displayed_sample_total', COALESCE(v_overall_total, 0),
    'displayed_overall_rate', v_overall_rate,
    'enough_data', (COALESCE(v_overall_total, 0) >= v_min),
    'wards', v_wards
  );
END;
$$;

ALTER FUNCTION public.get_admin_ward_accuracy_fairness(INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_ward_accuracy_fairness(INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_ward_accuracy_fairness(INT) TO authenticated;

COMMIT;
