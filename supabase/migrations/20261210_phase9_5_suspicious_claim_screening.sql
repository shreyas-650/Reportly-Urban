-- =============================================================================
-- Migration: 20261210_phase9_5_suspicious_claim_screening.sql
-- Module: Phase 9.5 — Suspicious / False Claim Screening & Workflow Advancement
-- Target: Supabase PostgreSQL
--
-- Safety, Privacy & Fairness Guarantees:
--   1. ADDITIVE ONLY: Does NOT alter or replace existing tables, columns,
--      public.complaint_status enum, existing triggers, or existing functions
--      (transition_complaint_status, evaluate_and_assign_department_ai,
--      evaluate_and_assign_officer_ai remain untouched).
--   2. NEVER auto-rejects, deletes, hides, or restricts a complaint. The only
--      automatic status transition allowed is submitted -> under_review when
--      ALL gates pass in active mode (risk = low, clean duplicate check,
--      deterministic checks pass, confidence >= threshold, accuracy/sample-size
--      and staleness gates pass, and row is still untouched submitted).
--   3. FAIRNESS: municipal ward, language, citizen name, phone, email, and
--      demographic/socioeconomic proxies are NEVER read or used as risk inputs
--      and NEVER used to segment accuracy metrics.
--   4. CITIZEN PRIVACY: FORCE ROW LEVEL SECURITY strictly restricts all Phase 9.5
--      tables to verified admins (public.is_admin()). Citizens and officers receive
--      0 rows and zero suspicion/flag/AI metadata in any response.
--   5. PL/pgSQL SAFETY: SET search_path = '', zero RECORD variables (strictly
--      scalar variables with defaults and immediate FOUND checks), bare
--      LEAST/GREATEST/COALESCE (never schema-qualified), and EXCEPTION WHEN OTHERS
--      handlers that persist reason 'error' instead of raising unhandled 500s.
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
    SELECT 'table public.complaint_duplicate_links' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_duplicate_links'
    )
    UNION ALL
    SELECT 'table public.complaint_status_history' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
    )
    UNION ALL
    SELECT 'table public.complaint_assignment_audit' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_assignment_audit'
    )
    UNION ALL
    SELECT 'table storage.objects' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'storage' AND table_name = 'objects'
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
-- 2. Phase 9.5 Tables (Admin-Only via FORCE RLS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_screening_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  screening_version TEXT NOT NULL DEFAULT 'v1.0' CHECK (
    pg_catalog.char_length(pg_catalog.btrim(screening_version)) BETWEEN 1 AND 64
  ),
  model_name TEXT NOT NULL DEFAULT 'deterministic_rules' CHECK (
    pg_catalog.char_length(pg_catalog.btrim(model_name)) BETWEEN 1 AND 100
  ),
  prompt_version TEXT NOT NULL DEFAULT 'v1.0' CHECK (
    pg_catalog.char_length(pg_catalog.btrim(prompt_version)) BETWEEN 1 AND 64
  ),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'active')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  confidence DOUBLE PRECISION NOT NULL CHECK (
    confidence >= 0.0
    AND confidence <= 1.0
    AND confidence <> 'NaN'::double precision
    AND confidence <> 'Infinity'::double precision
    AND confidence <> '-Infinity'::double precision
  ),
  reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (
    reason_codes <@ ARRAY[
      'duplicate_spam',
      'no_evidence',
      'gibberish',
      'rate_abuse',
      'needs_clarification'
    ]::TEXT[]
  ),
  operational_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (
    operational_flags <@ ARRAY[
      'duplicate_suspected',
      'duplicate_confirmed',
      'duplicate_missing',
      'outside_service_area',
      'low_confidence',
      'insufficient_metrics',
      'error'
    ]::TEXT[]
  ),
  used_gemini BOOLEAN NOT NULL DEFAULT FALSE,
  ai_decision_id UUID NULL REFERENCES public.ai_decisions(id) ON DELETE RESTRICT,
  would_advance BOOLEAN NOT NULL DEFAULT FALSE,
  applied_advance BOOLEAN NOT NULL DEFAULT FALSE,
  review_status TEXT NOT NULL CHECK (
    review_status IN (
      'clear',
      'needs_review',
      'priority_review',
      'ai_advanced',
      'dismissed',
      'confirmed_suspicious',
      'needs_info_resolved',
      'reverted'
    )
  ),
  admin_decision TEXT NOT NULL DEFAULT 'none' CHECK (
    admin_decision IN ('none', 'confirmed_suspicious', 'false_alarm', 'needs_info_resolved')
  ),
  advancement_outcome TEXT NOT NULL DEFAULT 'none' CHECK (
    advancement_outcome IN ('none', 'pending_review', 'kept', 'reverted')
  ),
  decided_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NULL,
  decision_reason TEXT NULL CHECK (
    decision_reason IS NULL OR pg_catalog.char_length(decision_reason) <= 500
  ),
  signals_snapshot JSONB NULL,
  accuracy_snapshot JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT uidx_screening_complaint_version UNIQUE (complaint_id, screening_version)
);

COMMENT ON TABLE public.complaint_screening_reviews IS
  'Phase 9.5 screening state per (complaint_id, screening_version). Fairness rule: ward, language, name, and demographics are NEVER risk inputs. Admin-only via FORCE RLS.';

CREATE INDEX IF NOT EXISTS idx_screening_reviews_status_risk_created
  ON public.complaint_screening_reviews (review_status, risk_level, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_screening_reviews_complaint_updated
  ON public.complaint_screening_reviews (complaint_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.complaint_screening_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  screening_review_id UUID NULL REFERENCES public.complaint_screening_reviews(id) ON DELETE RESTRICT,
  ai_decision_id UUID NULL REFERENCES public.ai_decisions(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system_ai', 'staff')),
  actor_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'evaluated',
      'flagged_for_review',
      'workflow_advanced',
      'admin_confirmed_suspicious',
      'admin_dismissed_flag',
      'admin_resolved_info',
      'admin_kept_advancement',
      'admin_reverted_advancement',
      'error'
    )
  ),
  mode TEXT NOT NULL CHECK (mode IN ('off', 'shadow', 'active')),
  screening_version TEXT NOT NULL DEFAULT 'v1.0',
  model_name TEXT NULL,
  prompt_version TEXT NULL,
  risk_level TEXT NULL CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
  confidence DOUBLE PRECISION NULL CHECK (
    confidence IS NULL OR (
      confidence >= 0.0
      AND confidence <= 1.0
      AND confidence <> 'NaN'::double precision
      AND confidence <> 'Infinity'::double precision
      AND confidence <> '-Infinity'::double precision
    )
  ),
  reason_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  operational_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  would_advance BOOLEAN NOT NULL DEFAULT FALSE,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  previous_status public.complaint_status NULL,
  resulting_status public.complaint_status NULL,
  signals_snapshot JSONB NULL,
  accuracy_snapshot JSONB NULL,
  notes TEXT NULL CHECK (notes IS NULL OR pg_catalog.char_length(notes) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.complaint_screening_events IS
  'Immutable append-only audit log of Phase 9.5 system_ai evaluations, submitted -> under_review advancements, and staff screening reviews/overrides.';

CREATE INDEX IF NOT EXISTS idx_screening_events_complaint_created
  ON public.complaint_screening_events (complaint_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ai_screening_accuracy_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(model_name)) BETWEEN 1 AND 100
  ),
  prompt_version TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(prompt_version)) BETWEEN 1 AND 64
  ),
  screening_version TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(screening_version)) BETWEEN 1 AND 64
  ),
  sample_size INT NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  agreed_count INT NOT NULL DEFAULT 0 CHECK (agreed_count >= 0),
  disagreed_count INT NOT NULL DEFAULT 0 CHECK (disagreed_count >= 0),
  rejected_count INT NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  rejection_rate DOUBLE PRECISION NULL CHECK (
    rejection_rate IS NULL OR (rejection_rate >= 0.0 AND rejection_rate <= 1.0)
  ),
  accuracy DOUBLE PRECISION NULL CHECK (
    accuracy IS NULL OR (accuracy >= 0.0 AND accuracy <= 1.0)
  ),
  measured_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT uidx_screening_accuracy_version UNIQUE (model_name, prompt_version, screening_version)
);

COMMENT ON TABLE public.ai_screening_accuracy_metrics IS
  'Measured workflow-advancement accuracy per (model_name, prompt_version, screening_version). Intentionally NEVER segmented by ward or demographics.';

-- -----------------------------------------------------------------------------
-- 3. Immutability Guards on complaint_screening_events
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_immutable_screening_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Complaint screening events are append-only and cannot be updated or deleted.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_screening_events() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_screening_events() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_immutable_screening_events ON public.complaint_screening_events;
CREATE TRIGGER trg_guard_immutable_screening_events
  BEFORE UPDATE OR DELETE ON public.complaint_screening_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_screening_events();

CREATE OR REPLACE FUNCTION public.guard_immutable_screening_events_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Truncating complaint screening events is prohibited.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_screening_events_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_screening_events_truncate() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_immutable_screening_events_truncate ON public.complaint_screening_events;
CREATE TRIGGER trg_guard_immutable_screening_events_truncate
  BEFORE TRUNCATE ON public.complaint_screening_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_screening_events_truncate();

-- -----------------------------------------------------------------------------
-- 4. FORCE Row Level Security (Admin SELECT Only; Zero Direct Writes)
-- -----------------------------------------------------------------------------
ALTER TABLE public.complaint_screening_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_screening_reviews FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.complaint_screening_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_screening_reviews TO authenticated;

DROP POLICY IF EXISTS "Admins can read screening reviews" ON public.complaint_screening_reviews;
CREATE POLICY "Admins can read screening reviews"
  ON public.complaint_screening_reviews
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

ALTER TABLE public.complaint_screening_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_screening_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.complaint_screening_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_screening_events TO authenticated;

DROP POLICY IF EXISTS "Admins can read screening events" ON public.complaint_screening_events;
CREATE POLICY "Admins can read screening events"
  ON public.complaint_screening_events
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

ALTER TABLE public.ai_screening_accuracy_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_screening_accuracy_metrics FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_screening_accuracy_metrics FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ai_screening_accuracy_metrics TO authenticated;

DROP POLICY IF EXISTS "Admins can read screening accuracy metrics" ON public.ai_screening_accuracy_metrics;
CREATE POLICY "Admins can read screening accuracy metrics"
  ON public.ai_screening_accuracy_metrics
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 5. Read-Only Helper: public.is_complaint_screening_flagged(UUID)
-- -----------------------------------------------------------------------------
-- Returns TRUE if an unresolved suspicious/borderline/reverted Phase 9.5 state
-- exists for the complaint. Strictly service_role only so citizens cannot probe.
CREATE OR REPLACE FUNCTION public.is_complaint_screening_flagged(
  p_complaint_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_flagged BOOLEAN := FALSE;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN TRUE;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.complaint_screening_reviews r
    WHERE r.complaint_id = p_complaint_id
      AND (
        r.review_status IN ('needs_review', 'priority_review', 'confirmed_suspicious', 'reverted')
        OR r.admin_decision = 'confirmed_suspicious'
        OR r.advancement_outcome = 'reverted'
      )
  ) INTO v_flagged;

  RETURN COALESCE(v_flagged, FALSE);
EXCEPTION WHEN OTHERS THEN
  -- Fail closed on helper error; Python checks handle mode semantics (off/shadow vs active)
  RETURN TRUE;
END;
$$;

ALTER FUNCTION public.is_complaint_screening_flagged(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_complaint_screening_flagged(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_complaint_screening_flagged(UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- 6. Read-Only Gate State Helper for 9.2 / 9.3 Ordering & Active Mode Guard
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_complaint_screening_gate_state(
  p_complaint_id UUID,
  p_screening_version TEXT DEFAULT 'v1.0'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_version TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_screening_version), ''), 'v1.0');
  v_found BOOLEAN := FALSE;
  v_mode TEXT := NULL;
  v_risk_level TEXT := NULL;
  v_review_status TEXT := NULL;
  v_admin_decision TEXT := NULL;
  v_adv_outcome TEXT := NULL;
  v_flagged BOOLEAN := FALSE;
  v_completed BOOLEAN := FALSE;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'completed', false, 'flagged', true);
  END IF;

  SELECT
    r.mode,
    r.risk_level,
    r.review_status,
    r.admin_decision,
    r.advancement_outcome
  INTO
    v_mode,
    v_risk_level,
    v_review_status,
    v_admin_decision,
    v_adv_outcome
  FROM public.complaint_screening_reviews r
  WHERE r.complaint_id = p_complaint_id
    AND r.screening_version = v_version
  LIMIT 1;
  v_found := FOUND;

  IF v_found THEN
    v_completed := NOT ('error' = ANY (
      COALESCE(
        (SELECT sr.operational_flags FROM public.complaint_screening_reviews sr
         WHERE sr.complaint_id = p_complaint_id AND sr.screening_version = v_version LIMIT 1),
        ARRAY[]::TEXT[]
      )
    ));
    v_flagged := (
      v_review_status IN ('needs_review', 'priority_review', 'confirmed_suspicious', 'reverted')
      OR v_admin_decision = 'confirmed_suspicious'
      OR v_adv_outcome = 'reverted'
    );
  END IF;

  RETURN jsonb_build_object(
    'found', v_found,
    'completed', v_completed,
    'flagged', v_flagged,
    'mode', v_mode,
    'risk_level', v_risk_level,
    'review_status', v_review_status,
    'admin_decision', v_admin_decision,
    'advancement_outcome', v_adv_outcome
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('found', false, 'completed', false, 'flagged', true, 'error', SQLSTATE);
END;
$$;

ALTER FUNCTION public.get_complaint_screening_gate_state(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_complaint_screening_gate_state(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_complaint_screening_gate_state(UUID, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 7. Per-Citizen AI Quota Count Helper (service_role only, omits citizen_id)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.count_screening_ai_decisions_for_citizen_since(
  p_complaint_id UUID,
  p_since TIMESTAMPTZ,
  p_exclude_id UUID DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_citizen_id UUID := NULL;
  v_count INT := 0;
BEGIN
  IF p_complaint_id IS NULL OR p_since IS NULL THEN
    RETURN 0;
  END IF;

  SELECT citizen_id INTO v_citizen_id
  FROM public.complaints
  WHERE id = p_complaint_id;

  IF NOT FOUND OR v_citizen_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT pg_catalog.count(*)::int
  INTO v_count
  FROM public.ai_decisions d
  JOIN public.complaints c ON c.id = d.complaint_id
  WHERE c.citizen_id = v_citizen_id
    AND d.feature = 'suspicious_claim_screening'
    AND d.created_at >= p_since
    AND d.status IN ('pending', 'completed')
    AND (p_exclude_id IS NULL OR d.id <> p_exclude_id);

  RETURN COALESCE(v_count, 0);
END;
$$;

ALTER FUNCTION public.count_screening_ai_decisions_for_citizen_since(UUID, TIMESTAMPTZ, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.count_screening_ai_decisions_for_citizen_since(UUID, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_screening_ai_decisions_for_citizen_since(UUID, TIMESTAMPTZ, UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- 8. Read-Only Deterministic Signal & Duplicate Check RPC (service_role only)
-- -----------------------------------------------------------------------------
-- Gathers strictly non-demographic operational & abuse signals + runs the
-- read-only Phase 9.4 duplicate candidate search and existing link inspection.
-- Ward, language, name, phone, email are intentionally omitted from risk signals.
CREATE OR REPLACE FUNCTION public.get_screening_deterministic_signals(
  p_complaint_id UUID,
  p_screening_version TEXT DEFAULT 'v1.0',
  p_text_window_hours INT DEFAULT 24,
  p_dup_radius_meters DOUBLE PRECISION DEFAULT 250.0,
  p_dup_window_days INT DEFAULT 14
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_version TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_screening_version), ''), 'v1.0');
  v_text_hours INT := GREATEST(1, LEAST(COALESCE(p_text_window_hours, 24), 168));
  v_radius DOUBLE PRECISION := GREATEST(1.0, LEAST(COALESCE(p_dup_radius_meters, 250.0), 50000.0));
  v_dup_days INT := GREATEST(1, LEAST(COALESCE(p_dup_window_days, 14), 365));

  -- Target complaint scalars (NO RECORD variables)
  v_comp_found BOOLEAN := FALSE;
  v_comp_citizen_id UUID := NULL;
  v_comp_title VARCHAR(255) := NULL;
  v_comp_category VARCHAR(50) := NULL;
  v_comp_description TEXT := NULL;
  v_comp_priority TEXT := NULL;
  v_comp_status TEXT := NULL;
  v_comp_image_url TEXT := NULL;
  v_comp_latitude DOUBLE PRECISION := NULL;
  v_comp_longitude DOUBLE PRECISION := NULL;
  v_comp_created_at TIMESTAMPTZ := NULL;

  -- Prior admin decision / review state
  v_review_found BOOLEAN := FALSE;
  v_existing_admin_decision TEXT := 'none';
  v_existing_adv_outcome TEXT := 'none';
  v_admin_touched BOOLEAN := FALSE;

  -- Evidence check scalars
  v_storage_found BOOLEAN := FALSE;
  v_storage_mime TEXT := NULL;
  v_storage_size BIGINT := -1;
  v_storage_etag TEXT := NULL;
  v_reused_photo_count INT := 0;

  -- Rate & repeated-text scalars
  v_rate_1h INT := 0;
  v_rate_24h INT := 0;
  v_recent_texts JSONB := '[]'::jsonb;

  -- Duplicate check scalars
  v_dup_suspected_count INT := 0;
  v_dup_confirmed_count INT := 0;
  v_dup_candidate_count INT := 0;
  v_dup_check_ok BOOLEAN := TRUE;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    c.citizen_id,
    c.title,
    c.category,
    c.description,
    c.priority::text,
    c.status::text,
    c.image_url,
    c.latitude,
    c.longitude,
    c.created_at
  INTO
    v_comp_citizen_id,
    v_comp_title,
    v_comp_category,
    v_comp_description,
    v_comp_priority,
    v_comp_status,
    v_comp_image_url,
    v_comp_latitude,
    v_comp_longitude,
    v_comp_created_at
  FROM public.complaints c
  WHERE c.id = p_complaint_id;
  v_comp_found := FOUND;

  IF NOT v_comp_found THEN
    RETURN NULL;
  END IF;

  -- Check existing screening decision (protect dismissed/decided flags from re-flagging)
  SELECT r.admin_decision, r.advancement_outcome
  INTO v_existing_admin_decision, v_existing_adv_outcome
  FROM public.complaint_screening_reviews r
  WHERE r.complaint_id = p_complaint_id
    AND r.screening_version = v_version
  LIMIT 1;
  v_review_found := FOUND;

  -- Check if staff already acted on status or assignment
  SELECT (
    EXISTS (
      SELECT 1 FROM public.complaint_status_history h
      WHERE h.complaint_id = p_complaint_id
        AND (h.status <> 'submitted'::public.complaint_status OR h.actor_id IS DISTINCT FROM v_comp_citizen_id)
    )
    OR EXISTS (
      SELECT 1 FROM public.complaint_assignment_audit caa
      WHERE caa.complaint_id = p_complaint_id
    )
  ) INTO v_admin_touched;

  -- Citizen submission rates (including target complaint)
  SELECT pg_catalog.count(*)::int
  INTO v_rate_1h
  FROM public.complaints c
  WHERE c.citizen_id = v_comp_citizen_id
    AND c.created_at >= (v_comp_created_at - INTERVAL '1 hour')
    AND c.created_at <= (v_comp_created_at + INTERVAL '5 minutes');

  SELECT pg_catalog.count(*)::int
  INTO v_rate_24h
  FROM public.complaints c
  WHERE c.citizen_id = v_comp_citizen_id
    AND c.created_at >= (v_comp_created_at - INTERVAL '24 hours')
    AND c.created_at <= (v_comp_created_at + INTERVAL '5 minutes');

  -- Recent complaints by the same citizen for deterministic near-identical text check
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', prev.id,
        'title', prev.title,
        'description', prev.description
      )
      ORDER BY prev.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_recent_texts
  FROM (
    SELECT c.id, c.title, c.description, c.created_at
    FROM public.complaints c
    WHERE c.citizen_id = v_comp_citizen_id
      AND c.id <> p_complaint_id
      AND c.created_at >= (v_comp_created_at - pg_catalog.make_interval(hours => v_text_hours))
      AND c.created_at <= (v_comp_created_at + INTERVAL '5 minutes')
    ORDER BY c.created_at DESC
    LIMIT 20
  ) prev;

  -- Storage object & photo reuse checks (no demographic or citizen PII returned)
  IF v_comp_image_url IS NOT NULL AND pg_catalog.btrim(v_comp_image_url) <> '' THEN
    SELECT
      COALESCE(so.metadata->>'mimetype', ''),
      COALESCE((so.metadata->>'size')::bigint, -1),
      NULLIF(pg_catalog.btrim(COALESCE(so.metadata->>'eTag', '')), '')
    INTO v_storage_mime, v_storage_size, v_storage_etag
    FROM storage.objects so
    WHERE so.bucket_id = 'complaint-images'
      AND so.name = v_comp_image_url
    LIMIT 1;
    v_storage_found := FOUND;

    SELECT pg_catalog.count(*)::int
    INTO v_reused_photo_count
    FROM public.complaints c
    LEFT JOIN storage.objects so
      ON so.bucket_id = 'complaint-images' AND so.name = c.image_url
    WHERE c.citizen_id = v_comp_citizen_id
      AND c.id <> p_complaint_id
      AND c.created_at >= (v_comp_created_at - INTERVAL '30 days')
      AND (
        c.image_url = v_comp_image_url
        OR (
          v_storage_etag IS NOT NULL
          AND v_storage_size > 0
          AND NULLIF(pg_catalog.btrim(COALESCE(so.metadata->>'eTag', '')), '') = v_storage_etag
          AND COALESCE((so.metadata->>'size')::bigint, -1) = v_storage_size
        )
      );
  END IF;

  -- Existing 9.4 duplicate links check (suspected / confirmed block; not_duplicate does not)
  BEGIN
    SELECT
      pg_catalog.count(*) FILTER (WHERE dl.status = 'suspected')::int,
      pg_catalog.count(*) FILTER (WHERE dl.status = 'confirmed_duplicate')::int
    INTO v_dup_suspected_count, v_dup_confirmed_count
    FROM public.complaint_duplicate_links dl
    WHERE dl.complaint_id = p_complaint_id
       OR dl.candidate_complaint_id = p_complaint_id;

    -- Read-only geospatial candidate check matching Phase 9.4 rules (fails closed on error)
    IF v_comp_latitude IS NOT NULL AND v_comp_longitude IS NOT NULL THEN
      SELECT pg_catalog.count(*)::int
      INTO v_dup_candidate_count
      FROM public.complaints c
      WHERE c.id <> p_complaint_id
        AND c.category = v_comp_category
        AND c.status IN (
          'submitted'::public.complaint_status,
          'under_review'::public.complaint_status,
          'in_progress'::public.complaint_status
        )
        AND c.latitude IS NOT NULL
        AND c.longitude IS NOT NULL
        AND c.created_at >= (v_comp_created_at - pg_catalog.make_interval(days => v_dup_days))
        AND c.created_at <= (v_comp_created_at + INTERVAL '5 minutes')
        AND (
          2.0 * 6371000.0 * pg_catalog.asin(
            pg_catalog.sqrt(
              LEAST(
                1.0::double precision,
                pg_catalog.power(pg_catalog.sin(pg_catalog.radians(c.latitude - v_comp_latitude) / 2.0), 2)
                + pg_catalog.cos(pg_catalog.radians(v_comp_latitude))
                * pg_catalog.cos(pg_catalog.radians(c.latitude))
                * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(c.longitude - v_comp_longitude) / 2.0), 2)
              )
            )
          )
        ) <= v_radius
        AND NOT EXISTS (
          SELECT 1
          FROM public.complaint_duplicate_links dl
          WHERE LEAST(dl.complaint_id, dl.candidate_complaint_id) = LEAST(p_complaint_id, c.id)
            AND GREATEST(dl.complaint_id, dl.candidate_complaint_id) = GREATEST(p_complaint_id, c.id)
            AND dl.status = 'not_duplicate'
        );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_dup_check_ok := FALSE;
  END;

  -- Note: strictly omit citizen_id, ward, full_name, phone, email, and street location
  RETURN jsonb_build_object(
    'id', p_complaint_id,
    'title', v_comp_title,
    'category', v_comp_category,
    'description', v_comp_description,
    'priority', v_comp_priority,
    'status', v_comp_status,
    'has_coordinates', (v_comp_latitude IS NOT NULL AND v_comp_longitude IS NOT NULL),
    'latitude', v_comp_latitude,
    'longitude', v_comp_longitude,
    'image_url_present', (v_comp_image_url IS NOT NULL AND pg_catalog.btrim(v_comp_image_url) <> ''),
    'storage_object_found', v_storage_found,
    'storage_mime', v_storage_mime,
    'storage_size', v_storage_size,
    'reused_photo_count', v_reused_photo_count,
    'rate_1h', v_rate_1h,
    'rate_24h', v_rate_24h,
    'recent_texts', v_recent_texts,
    'dup_check_ok', v_dup_check_ok,
    'dup_suspected_count', v_dup_suspected_count,
    'dup_confirmed_count', v_dup_confirmed_count,
    'dup_candidate_count', v_dup_candidate_count,
    'review_found', v_review_found,
    'existing_admin_decision', COALESCE(v_existing_admin_decision, 'none'),
    'existing_advancement_outcome', COALESCE(v_existing_adv_outcome, 'none'),
    'admin_touched', COALESCE(v_admin_touched, FALSE)
  );
END;
$$;

ALTER FUNCTION public.get_screening_deterministic_signals(UUID, TEXT, INT, DOUBLE PRECISION, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_screening_deterministic_signals(UUID, TEXT, INT, DOUBLE PRECISION, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_screening_deterministic_signals(UUID, TEXT, INT, DOUBLE PRECISION, INT) TO service_role;

-- -----------------------------------------------------------------------------
-- 9. Refresh Workflow-Advancement Accuracy Metrics (Amendment C & Decision 6)
-- -----------------------------------------------------------------------------
-- Exact formula:
--   Includes reviewed predictions where would_advance = TRUE, grouped strictly
--   by (model_name, prompt_version, screening_version) -- NEVER by ward.
--   - Disagree: admin rejected at ANY stage (current status = 'rejected' OR
--               rejected history entry), OR admin_decision = 'confirmed_suspicious',
--               OR advancement_outcome = 'reverted'.
--   - Agree: NOT disagreed AND (admin moved complaint to under_review with
--            actor_id IS NOT NULL, OR advancement_outcome = 'kept').
--   - Excluded: untouched complaints without admin outcome / review.
--   Stores sample_size, agreed_count, disagreed_count, rejected_count,
--   rejection_rate = rejected_count / sample_size, and accuracy = agreed / sample_size.
CREATE OR REPLACE FUNCTION public.refresh_ai_screening_accuracy_metrics(
  p_model_name TEXT DEFAULT NULL,
  p_prompt_version TEXT DEFAULT NULL,
  p_screening_version TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_upserted INT := 0;
BEGIN
  WITH labeled_samples AS (
    SELECT
      r.model_name,
      r.prompt_version,
      r.screening_version,
      (
        c.status = 'rejected'::public.complaint_status
        OR EXISTS (
          SELECT 1
          FROM public.complaint_status_history hr
          WHERE hr.complaint_id = r.complaint_id
            AND hr.status = 'rejected'::public.complaint_status
        )
      ) AS is_rejected,
      (
        c.status = 'rejected'::public.complaint_status
        OR EXISTS (
          SELECT 1
          FROM public.complaint_status_history hr
          WHERE hr.complaint_id = r.complaint_id
            AND hr.status = 'rejected'::public.complaint_status
        )
        OR r.admin_decision = 'confirmed_suspicious'
        OR r.advancement_outcome = 'reverted'
      ) AS is_disagree,
      (
        EXISTS (
          SELECT 1
          FROM public.complaint_status_history hu
          WHERE hu.complaint_id = r.complaint_id
            AND hu.status = 'under_review'::public.complaint_status
            AND hu.actor_id IS NOT NULL
        )
        OR r.advancement_outcome = 'kept'
      ) AS is_admin_moved_under_review
    FROM public.complaint_screening_reviews r
    JOIN public.complaints c ON c.id = r.complaint_id
    WHERE r.would_advance = TRUE
      AND (p_model_name IS NULL OR r.model_name = pg_catalog.btrim(p_model_name))
      AND (p_prompt_version IS NULL OR r.prompt_version = pg_catalog.btrim(p_prompt_version))
      AND (p_screening_version IS NULL OR r.screening_version = pg_catalog.btrim(p_screening_version))
  ),
  evaluated_samples AS (
    SELECT
      model_name,
      prompt_version,
      screening_version,
      is_rejected,
      is_disagree,
      (NOT is_disagree AND is_admin_moved_under_review) AS is_agree
    FROM labeled_samples
    WHERE is_disagree OR is_admin_moved_under_review
  ),
  aggregated AS (
    SELECT
      model_name,
      prompt_version,
      screening_version,
      pg_catalog.count(*)::int AS sample_size,
      pg_catalog.count(*) FILTER (WHERE is_agree)::int AS agreed_count,
      pg_catalog.count(*) FILTER (WHERE is_disagree)::int AS disagreed_count,
      pg_catalog.count(*) FILTER (WHERE is_rejected)::int AS rejected_count
    FROM evaluated_samples
    GROUP BY model_name, prompt_version, screening_version
  )
  INSERT INTO public.ai_screening_accuracy_metrics (
    model_name,
    prompt_version,
    screening_version,
    sample_size,
    agreed_count,
    disagreed_count,
    rejected_count,
    rejection_rate,
    accuracy,
    measured_at
  )
  SELECT
    a.model_name,
    a.prompt_version,
    a.screening_version,
    a.sample_size,
    a.agreed_count,
    a.disagreed_count,
    a.rejected_count,
    CASE WHEN a.sample_size > 0 THEN (a.rejected_count::double precision / a.sample_size::double precision) ELSE NULL END,
    CASE WHEN a.sample_size > 0 THEN (a.agreed_count::double precision / a.sample_size::double precision) ELSE NULL END,
    v_now
  FROM aggregated a
  ON CONFLICT (model_name, prompt_version, screening_version) DO UPDATE SET
    sample_size = EXCLUDED.sample_size,
    agreed_count = EXCLUDED.agreed_count,
    disagreed_count = EXCLUDED.disagreed_count,
    rejected_count = EXCLUDED.rejected_count,
    rejection_rate = EXCLUDED.rejection_rate,
    accuracy = EXCLUDED.accuracy,
    measured_at = EXCLUDED.measured_at;

  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  RETURN jsonb_build_object('upserted_groups', v_upserted, 'measured_at', v_now);
END;
$$;

ALTER FUNCTION public.refresh_ai_screening_accuracy_metrics(TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refresh_ai_screening_accuracy_metrics(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_ai_screening_accuracy_metrics(TEXT, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 10. Core Atomic Screening Record & Gated Advancement RPC (service_role only)
-- -----------------------------------------------------------------------------
-- Zero RECORD variables; scalar defaults + FOUND checks; no updated_at equality check.
-- Decision (1): When advancing submitted -> under_review, updates complaints.status
-- + complaints.updated_at and inserts into complaint_status_history copying the
-- exact manual under_review structure (title = 'Under Municipal Review',
-- public_description = NULL, internal_note = NULL, actor_id = NULL).
CREATE OR REPLACE FUNCTION public.record_and_evaluate_complaint_screening(
  p_complaint_id UUID,
  p_screening_version TEXT DEFAULT 'v1.0',
  p_mode TEXT DEFAULT 'shadow',
  p_risk_level TEXT DEFAULT 'low',
  p_confidence DOUBLE PRECISION DEFAULT 0.0,
  p_reason_codes TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_operational_flags TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_used_gemini BOOLEAN DEFAULT FALSE,
  p_ai_decision_id UUID DEFAULT NULL,
  p_model_name TEXT DEFAULT 'deterministic_rules',
  p_prompt_version TEXT DEFAULT 'v1.0',
  p_would_advance BOOLEAN DEFAULT FALSE,
  p_signals_snapshot JSONB DEFAULT NULL,
  p_min_samples INT DEFAULT 50,
  p_min_accuracy DOUBLE PRECISION DEFAULT 0.95,
  p_metrics_max_age_days INT DEFAULT 14,
  p_min_advance_confidence DOUBLE PRECISION DEFAULT 0.90
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_version TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_screening_version), ''), 'v1.0');
  v_mode TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_mode, 'shadow')));
  v_risk TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_risk_level, 'medium')));
  v_conf DOUBLE PRECISION := GREATEST(0.0::double precision, LEAST(1.0::double precision, COALESCE(p_confidence, 0.0::double precision)));
  v_model TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_model_name), ''), 'deterministic_rules');
  v_prompt_ver TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_prompt_version), ''), 'v1.0');
  v_reasons TEXT[] := COALESCE(p_reason_codes, ARRAY[]::TEXT[]);
  v_op_flags TEXT[] := COALESCE(p_operational_flags, ARRAY[]::TEXT[]);
  v_would_advance BOOLEAN := COALESCE(p_would_advance, FALSE);
  v_min_samples INT := GREATEST(1, COALESCE(p_min_samples, 50));
  v_min_acc DOUBLE PRECISION := GREATEST(0.0::double precision, LEAST(1.0::double precision, COALESCE(p_min_accuracy, 0.95::double precision)));
  v_max_age_days INT := GREATEST(1, COALESCE(p_metrics_max_age_days, 14));
  v_min_adv_conf DOUBLE PRECISION := GREATEST(0.0::double precision, LEAST(1.0::double precision, COALESCE(p_min_advance_confidence, 0.90::double precision)));

  -- Complaint lock scalars (NO RECORD vars)
  v_comp_found BOOLEAN := FALSE;
  v_comp_citizen_id UUID := NULL;
  v_comp_status public.complaint_status := NULL;

  -- Existing review scalars
  v_existing_found BOOLEAN := FALSE;
  v_existing_id UUID := NULL;
  v_existing_admin_decision TEXT := 'none';
  v_existing_adv_outcome TEXT := 'none';
  v_existing_review_status TEXT := NULL;
  v_existing_op_flags TEXT[] := ARRAY[]::TEXT[];

  -- Metric gate scalars
  v_metric_found BOOLEAN := FALSE;
  v_metric_samples INT := 0;
  v_metric_acc DOUBLE PRECISION := NULL;
  v_metric_rej_rate DOUBLE PRECISION := NULL;
  v_metric_measured_at TIMESTAMPTZ := NULL;
  v_acc_gate_ok BOOLEAN := FALSE;
  v_acc_gate_reason TEXT := NULL;

  -- State transition & persistence scalars
  v_admin_touched BOOLEAN := FALSE;
  v_target_review_status TEXT := 'clear';
  v_applied_advance BOOLEAN := FALSE;
  v_adv_outcome TEXT := 'none';
  v_rows_updated INT := 0;
  v_review_id UUID := NULL;
  v_accuracy_snapshot JSONB := NULL;
  v_event_type TEXT := 'evaluated';
  v_prev_status public.complaint_status := NULL;
  v_res_status public.complaint_status := NULL;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN jsonb_build_object('applied_advance', false, 'reason', 'invalid_complaint_id');
  END IF;

  IF v_mode NOT IN ('off', 'shadow', 'active') THEN
    v_mode := 'shadow';
  END IF;
  IF v_mode = 'off' THEN
    RETURN jsonb_build_object('mode', 'off', 'skipped', true, 'applied_advance', false);
  END IF;

  IF v_risk NOT IN ('low', 'medium', 'high') THEN
    v_risk := 'medium';
  END IF;

  BEGIN
    -- Lock complaint row atomically (Amendment E)
    SELECT c.citizen_id, c.status
    INTO v_comp_citizen_id, v_comp_status
    FROM public.complaints c
    WHERE c.id = p_complaint_id
    FOR UPDATE;
    v_comp_found := FOUND;

    IF NOT v_comp_found THEN
      RETURN jsonb_build_object('found', false, 'applied_advance', false);
    END IF;

    -- Idempotency & dismissed-flag protection
    SELECT
      r.id,
      r.admin_decision,
      r.advancement_outcome,
      r.review_status,
      r.operational_flags
    INTO
      v_existing_id,
      v_existing_admin_decision,
      v_existing_adv_outcome,
      v_existing_review_status,
      v_existing_op_flags
    FROM public.complaint_screening_reviews r
    WHERE r.complaint_id = p_complaint_id
      AND r.screening_version = v_version
    FOR UPDATE;
    v_existing_found := FOUND;

    IF v_existing_found THEN
      -- Dismissed or already decided flag MUST NEVER be overwritten / re-flagged for same version
      IF v_existing_admin_decision <> 'none'
         OR v_existing_adv_outcome <> 'none'
         OR NOT ('error' = ANY (COALESCE(v_existing_op_flags, ARRAY[]::TEXT[]))) THEN
        RETURN jsonb_build_object(
          'idempotent_hit', true,
          'review_id', v_existing_id,
          'review_status', v_existing_review_status,
          'admin_decision', v_existing_admin_decision,
          'applied_advance', false
        );
      END IF;
    END IF;

    -- Compute accuracy gate snapshot (always measured even in shadow for observability)
    SELECT m.sample_size, m.accuracy, m.rejection_rate, m.measured_at
    INTO v_metric_samples, v_metric_acc, v_metric_rej_rate, v_metric_measured_at
    FROM public.ai_screening_accuracy_metrics m
    WHERE m.model_name = v_model
      AND m.prompt_version = v_prompt_ver
      AND m.screening_version = v_version
    LIMIT 1;
    v_metric_found := FOUND;

    IF NOT v_metric_found THEN
      v_metric_samples := 0;
      v_metric_acc := NULL;
      v_metric_rej_rate := NULL;
      v_metric_measured_at := NULL;
      v_acc_gate_reason := 'no_metrics';
    ELSIF v_metric_samples < v_min_samples THEN
      v_acc_gate_reason := 'insufficient_samples';
    ELSIF v_metric_measured_at IS NULL OR v_metric_measured_at < (v_now - pg_catalog.make_interval(days => v_max_age_days)) THEN
      v_acc_gate_reason := 'stale_metrics';
    ELSIF v_metric_acc IS NULL OR v_metric_acc < v_min_acc THEN
      v_acc_gate_reason := 'low_accuracy';
    ELSIF v_conf < v_min_adv_conf THEN
      v_acc_gate_reason := 'low_confidence';
    ELSE
      v_acc_gate_ok := TRUE;
      v_acc_gate_reason := 'passed';
    END IF;

    v_accuracy_snapshot := jsonb_build_object(
      'model_name', v_model,
      'prompt_version', v_prompt_ver,
      'screening_version', v_version,
      'sample_size', v_metric_samples,
      'min_samples', v_min_samples,
      'accuracy', v_metric_acc,
      'min_accuracy', v_min_acc,
      'rejection_rate', v_metric_rej_rate,
      'measured_at', v_metric_measured_at,
      'max_age_days', v_max_age_days,
      'confidence', v_conf,
      'min_advance_confidence', v_min_adv_conf,
      'passed', v_acc_gate_ok,
      'gate_reason', v_acc_gate_reason
    );

    -- Determine target review_status & whether active advancement executes
    IF v_risk = 'high' THEN
      v_target_review_status := 'priority_review';
      v_event_type := 'flagged_for_review';
    ELSIF v_risk = 'medium' OR COALESCE(pg_catalog.array_length(v_reasons, 1), 0) > 0 THEN
      v_target_review_status := 'needs_review';
      v_event_type := 'flagged_for_review';
    ELSE
      v_target_review_status := 'clear';
      v_event_type := 'evaluated';
    END IF;

    IF v_mode = 'active'
       AND v_risk = 'low'
       AND v_would_advance
       AND COALESCE(pg_catalog.array_length(v_reasons, 1), 0) = 0
       AND COALESCE(pg_catalog.array_length(v_op_flags, 1), 0) = 0
       AND v_acc_gate_ok
       AND v_comp_status = 'submitted'::public.complaint_status THEN

      -- Amendment E: verify untouched by admin in history or assignment audit (no updated_at equality check)
      SELECT (
        EXISTS (
          SELECT 1 FROM public.complaint_status_history h
          WHERE h.complaint_id = p_complaint_id
            AND (h.status <> 'submitted'::public.complaint_status OR h.actor_id IS DISTINCT FROM v_comp_citizen_id)
        )
        OR EXISTS (
          SELECT 1 FROM public.complaint_assignment_audit caa
          WHERE caa.complaint_id = p_complaint_id
        )
      ) INTO v_admin_touched;

      IF NOT COALESCE(v_admin_touched, FALSE) THEN
        -- Exact copy of manual submitted -> under_review columns + history insert
        UPDATE public.complaints
        SET status = 'under_review'::public.complaint_status,
            updated_at = v_now
        WHERE id = p_complaint_id
          AND status = 'submitted'::public.complaint_status;

        GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

        IF v_rows_updated = 1 THEN
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
            'under_review'::public.complaint_status,
            'submitted'::public.complaint_status,
            'Under Municipal Review',
            NULL,
            NULL,
            NULL,
            v_now
          );

          v_applied_advance := TRUE;
          v_target_review_status := 'ai_advanced';
          v_adv_outcome := 'pending_review';
          v_event_type := 'workflow_advanced';
          v_prev_status := 'submitted'::public.complaint_status;
          v_res_status := 'under_review'::public.complaint_status;
        END IF;
      END IF;
    ELSIF v_mode = 'active' AND NOT v_acc_gate_ok AND v_risk = 'low' AND v_would_advance THEN
      IF NOT ('insufficient_metrics' = ANY (v_op_flags)) THEN
        v_op_flags := pg_catalog.array_append(v_op_flags, 'insufficient_metrics');
      END IF;
    END IF;

    INSERT INTO public.complaint_screening_reviews (
      complaint_id,
      screening_version,
      model_name,
      prompt_version,
      mode,
      risk_level,
      confidence,
      reason_codes,
      operational_flags,
      used_gemini,
      ai_decision_id,
      would_advance,
      applied_advance,
      review_status,
      advancement_outcome,
      signals_snapshot,
      accuracy_snapshot,
      created_at,
      updated_at
    ) VALUES (
      p_complaint_id,
      v_version,
      v_model,
      v_prompt_ver,
      v_mode,
      v_risk,
      v_conf,
      v_reasons,
      v_op_flags,
      COALESCE(p_used_gemini, FALSE),
      p_ai_decision_id,
      v_would_advance,
      v_applied_advance,
      v_target_review_status,
      v_adv_outcome,
      p_signals_snapshot,
      v_accuracy_snapshot,
      v_now,
      v_now
    )
    ON CONFLICT (complaint_id, screening_version) DO UPDATE SET
      model_name = EXCLUDED.model_name,
      prompt_version = EXCLUDED.prompt_version,
      mode = EXCLUDED.mode,
      risk_level = EXCLUDED.risk_level,
      confidence = EXCLUDED.confidence,
      reason_codes = EXCLUDED.reason_codes,
      operational_flags = EXCLUDED.operational_flags,
      used_gemini = EXCLUDED.used_gemini,
      ai_decision_id = EXCLUDED.ai_decision_id,
      would_advance = EXCLUDED.would_advance,
      applied_advance = EXCLUDED.applied_advance,
      review_status = EXCLUDED.review_status,
      advancement_outcome = EXCLUDED.advancement_outcome,
      signals_snapshot = EXCLUDED.signals_snapshot,
      accuracy_snapshot = EXCLUDED.accuracy_snapshot,
      updated_at = v_now
    RETURNING id INTO v_review_id;

    INSERT INTO public.complaint_screening_events (
      complaint_id,
      screening_review_id,
      ai_decision_id,
      actor_type,
      event_type,
      mode,
      screening_version,
      model_name,
      prompt_version,
      risk_level,
      confidence,
      reason_codes,
      operational_flags,
      would_advance,
      applied,
      previous_status,
      resulting_status,
      signals_snapshot,
      accuracy_snapshot,
      created_at
    ) VALUES (
      p_complaint_id,
      v_review_id,
      p_ai_decision_id,
      'system_ai',
      v_event_type,
      v_mode,
      v_version,
      v_model,
      v_prompt_ver,
      v_risk,
      v_conf,
      v_reasons,
      v_op_flags,
      v_would_advance,
      v_applied_advance,
      v_prev_status,
      v_res_status,
      p_signals_snapshot,
      v_accuracy_snapshot,
      v_now
    );

    RETURN jsonb_build_object(
      'review_id', v_review_id,
      'mode', v_mode,
      'risk_level', v_risk,
      'review_status', v_target_review_status,
      'would_advance', v_would_advance,
      'applied_advance', v_applied_advance,
      'accuracy_gate_passed', v_acc_gate_ok,
      'accuracy_gate_reason', v_acc_gate_reason
    );

  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.complaint_screening_reviews (
        complaint_id,
        screening_version,
        model_name,
        prompt_version,
        mode,
        risk_level,
        confidence,
        reason_codes,
        operational_flags,
        used_gemini,
        would_advance,
        applied_advance,
        review_status,
        signals_snapshot,
        created_at,
        updated_at
      ) VALUES (
        p_complaint_id,
        v_version,
        v_model,
        v_prompt_ver,
        v_mode,
        'low',
        0.0,
        ARRAY[]::TEXT[],
        ARRAY['error']::TEXT[],
        FALSE,
        FALSE,
        FALSE,
        'needs_review',
        jsonb_build_object('reason', 'error', 'sqlstate', SQLSTATE, 'mode', v_mode),
        v_now,
        v_now
      )
      ON CONFLICT (complaint_id, screening_version) DO NOTHING;

      INSERT INTO public.complaint_screening_events (
        complaint_id,
        actor_type,
        event_type,
        mode,
        screening_version,
        operational_flags,
        applied,
        notes,
        created_at
      ) VALUES (
        p_complaint_id,
        'system_ai',
        'error',
        v_mode,
        v_version,
        ARRAY['error']::TEXT[],
        FALSE,
        'sqlstate:' || SQLSTATE,
        v_now
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RETURN jsonb_build_object(
      'mode', v_mode,
      'applied_advance', false,
      'review_status', 'needs_review',
      'error_sqlstate', SQLSTATE
    );
  END;
END;
$$;

ALTER FUNCTION public.record_and_evaluate_complaint_screening(
  UUID, TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT[], TEXT[], BOOLEAN, UUID, TEXT, TEXT, BOOLEAN, JSONB, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_and_evaluate_complaint_screening(
  UUID, TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT[], TEXT[], BOOLEAN, UUID, TEXT, TEXT, BOOLEAN, JSONB, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_and_evaluate_complaint_screening(
  UUID, TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT[], TEXT[], BOOLEAN, UUID, TEXT, TEXT, BOOLEAN, JSONB, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION
) TO service_role;

-- -----------------------------------------------------------------------------
-- 11. Admin Screening Review & Revert RPCs (authenticated + is_admin() ONLY)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_decide_complaint_screening(
  p_complaint_id UUID,
  p_decision TEXT,
  p_reason TEXT DEFAULT NULL,
  p_screening_version TEXT DEFAULT 'v1.0'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_version TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_screening_version), ''), 'v1.0');
  v_dec TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_decision, '')));
  v_clean_reason TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');

  v_comp_found BOOLEAN := FALSE;
  v_comp_status public.complaint_status := NULL;

  v_rev_found BOOLEAN := FALSE;
  v_rev_id UUID := NULL;
  v_rev_mode TEXT := NULL;
  v_rev_risk TEXT := NULL;
  v_rev_conf DOUBLE PRECISION := NULL;
  v_rev_applied BOOLEAN := FALSE;
  v_rev_admin_decision TEXT := 'none';
  v_rev_adv_outcome TEXT := 'none';
  v_rev_status TEXT := NULL;

  v_new_review_status TEXT := NULL;
  v_new_admin_decision TEXT := NULL;
  v_new_adv_outcome TEXT := NULL;
  v_event_type TEXT := NULL;
BEGIN
  IF v_actor_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id is required.'
      USING ERRCODE = '22023';
  END IF;

  IF v_dec NOT IN (
    'confirmed_suspicious',
    'dismiss',
    'needs_info_resolved',
    'keep_advancement',
    'revert_advancement'
  ) THEN
    RAISE EXCEPTION 'Invalid Parameter: unsupported screening decision "%".', v_dec
      USING ERRCODE = '22023';
  END IF;

  SELECT c.status INTO v_comp_status
  FROM public.complaints c
  WHERE c.id = p_complaint_id
  FOR UPDATE;
  v_comp_found := FOUND;

  IF NOT v_comp_found THEN
    RAISE EXCEPTION 'Not Found: Complaint does not exist.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT
    r.id, r.mode, r.risk_level, r.confidence, r.applied_advance,
    r.admin_decision, r.advancement_outcome, r.review_status
  INTO
    v_rev_id, v_rev_mode, v_rev_risk, v_rev_conf, v_rev_applied,
    v_rev_admin_decision, v_rev_adv_outcome, v_rev_status
  FROM public.complaint_screening_reviews r
  WHERE r.complaint_id = p_complaint_id
    AND r.screening_version = v_version
  FOR UPDATE;
  v_rev_found := FOUND;

  IF NOT v_rev_found THEN
    RAISE EXCEPTION 'Not Found: No screening review record exists for this complaint.'
      USING ERRCODE = 'P0002';
  END IF;

  v_new_review_status := v_rev_status;
  v_new_admin_decision := v_rev_admin_decision;
  v_new_adv_outcome := v_rev_adv_outcome;

  IF v_dec = 'dismiss' THEN
    v_new_admin_decision := 'false_alarm';
    v_new_review_status := 'dismissed';
    v_event_type := 'admin_dismissed_flag';
  ELSIF v_dec = 'confirmed_suspicious' THEN
    v_new_admin_decision := 'confirmed_suspicious';
    v_new_review_status := 'confirmed_suspicious';
    IF v_rev_applied AND v_rev_adv_outcome <> 'reverted' THEN
      v_new_adv_outcome := 'reverted';
    END IF;
    v_event_type := 'admin_confirmed_suspicious';
  ELSIF v_dec = 'needs_info_resolved' THEN
    v_new_admin_decision := 'needs_info_resolved';
    v_new_review_status := 'needs_info_resolved';
    v_event_type := 'admin_resolved_info';
  ELSIF v_dec = 'keep_advancement' THEN
    IF NOT v_rev_applied THEN
      RAISE EXCEPTION 'Conflict: This complaint was not auto-advanced by AI.'
        USING ERRCODE = 'P0001';
    END IF;
    v_new_adv_outcome := 'kept';
    v_event_type := 'admin_kept_advancement';
  ELSIF v_dec = 'revert_advancement' THEN
    IF NOT v_rev_applied THEN
      RAISE EXCEPTION 'Conflict: This complaint was not auto-advanced by AI.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_clean_reason IS NULL OR pg_catalog.char_length(v_clean_reason) < 5 THEN
      RAISE EXCEPTION 'Invalid Parameter: A revert reason (minimum 5 characters) is required.'
        USING ERRCODE = '22023';
    END IF;
    v_new_adv_outcome := 'reverted';
    v_new_review_status := 'reverted';
    v_event_type := 'admin_reverted_advancement';
  END IF;

  -- Note: Revert NEVER rolls status backward from under_review -> submitted (preserves state machine & history).
  UPDATE public.complaint_screening_reviews
  SET admin_decision = v_new_admin_decision,
      advancement_outcome = v_new_adv_outcome,
      review_status = v_new_review_status,
      decided_by = v_actor_id,
      decided_at = v_now,
      decision_reason = COALESCE(v_clean_reason, decision_reason),
      updated_at = v_now
  WHERE id = v_rev_id;

  INSERT INTO public.complaint_screening_events (
    complaint_id,
    screening_review_id,
    actor_type,
    actor_id,
    event_type,
    mode,
    screening_version,
    risk_level,
    confidence,
    applied,
    previous_status,
    resulting_status,
    notes,
    created_at
  ) VALUES (
    p_complaint_id,
    v_rev_id,
    'staff',
    v_actor_id,
    v_event_type,
    v_rev_mode,
    v_version,
    v_rev_risk,
    v_rev_conf,
    FALSE,
    v_comp_status,
    v_comp_status,
    v_clean_reason,
    v_now
  );

  RETURN jsonb_build_object(
    'success', true,
    'complaint_id', p_complaint_id,
    'review_id', v_rev_id,
    'review_status', v_new_review_status,
    'admin_decision', v_new_admin_decision,
    'advancement_outcome', v_new_adv_outcome,
    'complaint_status', v_comp_status::text,
    'decided_at', v_now
  );
END;
$$;

ALTER FUNCTION public.admin_decide_complaint_screening(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_decide_complaint_screening(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_complaint_screening(UUID, TEXT, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_admin_screening_queue(
  p_filter TEXT DEFAULT 'needs_review',
  p_page INT DEFAULT 1,
  p_page_size INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_filter TEXT := COALESCE(NULLIF(pg_catalog.lower(pg_catalog.btrim(p_filter)), ''), 'needs_review');
  v_page INT := GREATEST(1, COALESCE(p_page, 1));
  v_size INT := LEAST(100, GREATEST(1, COALESCE(p_page_size, 20)));
  v_offset INT;
  v_total INT := 0;
  v_items JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF v_filter NOT IN (
    'needs_review',
    'priority_review',
    'ai_advanced',
    'dismissed',
    'confirmed_suspicious',
    'reverted',
    'all'
  ) THEN
    RAISE EXCEPTION 'Invalid Parameter: unsupported screening filter.'
      USING ERRCODE = '22023';
  END IF;

  v_offset := (v_page - 1) * v_size;

  SELECT pg_catalog.count(*)::int
  INTO v_total
  FROM public.complaint_screening_reviews r
  WHERE (
    v_filter = 'all'
    OR (v_filter = 'needs_review' AND r.review_status IN ('needs_review', 'priority_review'))
    OR r.review_status = v_filter
  );

  SELECT COALESCE(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(q)),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT
      r.id AS review_id,
      r.complaint_id,
      c.complaint_number,
      c.title AS complaint_title,
      c.category AS complaint_category,
      c.status::text AS complaint_status,
      c.created_at AS complaint_created_at,
      r.screening_version,
      r.model_name,
      r.prompt_version,
      r.mode,
      r.risk_level,
      r.confidence,
      r.reason_codes,
      r.operational_flags,
      r.used_gemini,
      r.would_advance,
      r.applied_advance,
      r.review_status,
      r.admin_decision,
      r.advancement_outcome,
      r.decision_reason,
      r.decided_at,
      r.created_at,
      r.updated_at
    FROM public.complaint_screening_reviews r
    JOIN public.complaints c ON c.id = r.complaint_id
    WHERE (
      v_filter = 'all'
      OR (v_filter = 'needs_review' AND r.review_status IN ('needs_review', 'priority_review'))
      OR r.review_status = v_filter
    )
    ORDER BY
      CASE WHEN r.risk_level = 'high' THEN 0 WHEN r.risk_level = 'medium' THEN 1 ELSE 2 END ASC,
      r.created_at DESC
    OFFSET v_offset
    LIMIT v_size
  ) q;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'page', v_page,
    'page_size', v_size,
    'total_pages', GREATEST(1, pg_catalog.ceil(v_total::numeric / v_size)::int)
  );
END;
$$;

ALTER FUNCTION public.list_admin_screening_queue(TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_screening_queue(TEXT, INT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_screening_queue(TEXT, INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_complaint_screening(
  p_complaint_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_comp_found BOOLEAN := FALSE;
  v_comp_status TEXT := NULL;
  v_rev_found BOOLEAN := FALSE;
  v_review JSONB := NULL;
  v_events JSONB := '[]'::jsonb;
  v_metrics JSONB := NULL;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id is required.' USING ERRCODE = '22023';
  END IF;

  SELECT c.status::text INTO v_comp_status
  FROM public.complaints c
  WHERE c.id = p_complaint_id;
  v_comp_found := FOUND;

  IF NOT v_comp_found THEN
    RAISE EXCEPTION 'Not Found: Complaint does not exist.' USING ERRCODE = 'P0002';
  END IF;

  SELECT pg_catalog.to_jsonb(r)
  INTO v_review
  FROM (
    SELECT
      sr.id AS review_id,
      sr.complaint_id,
      sr.screening_version,
      sr.model_name,
      sr.prompt_version,
      sr.mode,
      sr.risk_level,
      sr.confidence,
      sr.reason_codes,
      sr.operational_flags,
      sr.used_gemini,
      sr.ai_decision_id,
      sr.would_advance,
      sr.applied_advance,
      sr.review_status,
      sr.admin_decision,
      sr.advancement_outcome,
      sr.decided_by,
      sr.decided_at,
      sr.decision_reason,
      sr.signals_snapshot,
      sr.accuracy_snapshot,
      sr.created_at,
      sr.updated_at
    FROM public.complaint_screening_reviews sr
    WHERE sr.complaint_id = p_complaint_id
    ORDER BY sr.updated_at DESC
    LIMIT 1
  ) r;
  v_rev_found := FOUND;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ev) ORDER BY ev.created_at DESC),
    '[]'::jsonb
  )
  INTO v_events
  FROM (
    SELECT
      e.id,
      e.actor_type,
      e.event_type,
      e.mode,
      e.screening_version,
      e.model_name,
      e.prompt_version,
      e.risk_level,
      e.confidence,
      e.reason_codes,
      e.operational_flags,
      e.would_advance,
      e.applied,
      e.previous_status::text AS previous_status,
      e.resulting_status::text AS resulting_status,
      e.notes,
      e.created_at
    FROM public.complaint_screening_events e
    WHERE e.complaint_id = p_complaint_id
    ORDER BY e.created_at DESC
    LIMIT 25
  ) ev;

  SELECT pg_catalog.to_jsonb(m)
  INTO v_metrics
  FROM (
    SELECT
      am.model_name,
      am.prompt_version,
      am.screening_version,
      am.sample_size,
      am.agreed_count,
      am.disagreed_count,
      am.rejected_count,
      am.rejection_rate,
      am.accuracy,
      am.measured_at
    FROM public.ai_screening_accuracy_metrics am
    ORDER BY am.measured_at DESC
    LIMIT 1
  ) m;

  RETURN jsonb_build_object(
    'complaint_id', p_complaint_id,
    'complaint_status', v_comp_status,
    'review', v_review,
    'events', v_events,
    'latest_metrics', v_metrics
  );
END;
$$;

ALTER FUNCTION public.get_admin_complaint_screening(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_complaint_screening(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_complaint_screening(UUID) TO authenticated;

COMMIT;
