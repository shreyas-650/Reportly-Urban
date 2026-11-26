-- =============================================================================
-- Migration: 20261207_phase9_2_department_auto_assignment.sql
-- Phase 9.2: AI Department Auto-Assignment (Safety-First, Additive Only)
--
-- Features:
--   1. public.category_department_mappings (DB-driven category + optional ward -> dept;
--      seeded with is_active = FALSE so no unreviewed mapping auto-assigns).
--   2. public.ai_category_accuracy_metrics (per-category, per-ward/citywide, per
--      model_name + prompt_version accuracy against human-confirmed department).
--   3. public.department_assignment_events (immutable audit log with explicit
--      actor_type ('system_ai' | 'staff'), partial unique index on (ai_decision_id)
--      WHERE actor_type = 'system_ai', gate_snapshot, and AI override tracking).
--   4. public.complaint_department_triage_queue (additive manual queue entries with
--      explicit fallback reason codes).
--   5. Non-invasive AFTER UPDATE OF department_id trigger on public.complaints
--      wrapped in EXCEPTION WHEN OTHERS so it can never break assign_complaint_admin.
--   6. RPCs: evaluate_and_assign_department_ai, refresh_ai_category_accuracy_metrics,
--      upsert_category_department_mapping, get_admin_department_routing_overview.
--
-- Note: Never schema-qualify LEAST, GREATEST, or COALESCE (SQL keywords).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Preconditions Check (fail fast if prior dependencies missing)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT string_agg(req, ', ')
  INTO v_missing
  FROM (
    SELECT 'table public.complaints' AS req WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'complaints'
    )
    UNION ALL
    SELECT 'table public.departments' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'departments'
    )
    UNION ALL
    SELECT 'table public.complaint_assignment_audit' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'complaint_assignment_audit'
    )
    UNION ALL
    SELECT 'table public.ai_decisions' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_decisions'
    )
    UNION ALL
    SELECT 'function public.is_admin()' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin'
    )
  ) checks;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed for Phase 9.2: missing %', v_missing;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Category -> Department Mappings (Ward-Aware, Admin-Activated)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.category_department_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(50) NOT NULL CHECK (
    category IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure')
  ),
  ward VARCHAR(100) NULL CHECK (
    ward IS NULL OR pg_catalog.char_length(pg_catalog.btrim(ward)) BETWEEN 1 AND 100
  ),
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.category_department_mappings IS
  'Admin-managed category (and optional ward) to department routing mappings. Rows default to is_active = FALSE until verified by an administrator.';

-- Prevent duplicate (category, ward, department_id) rows while allowing detection of
-- multiple distinct active departments mapped to the same (category, ward) -> ambiguous_mapping.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_cat_dept_map_pair
  ON public.category_department_mappings (category, COALESCE(ward, ''), department_id);

CREATE INDEX IF NOT EXISTS idx_cat_dept_map_lookup
  ON public.category_department_mappings (category, is_active, ward);

ALTER TABLE public.category_department_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.category_department_mappings FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.category_department_mappings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.category_department_mappings TO authenticated;

DROP POLICY IF EXISTS "Admins can view category department mappings" ON public.category_department_mappings;
CREATE POLICY "Admins can view category department mappings"
  ON public.category_department_mappings
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Seed conservative inactive placeholders for known seeded department codes.
-- Admins must explicitly verify and activate mappings before active routing can use them.
INSERT INTO public.category_department_mappings (category, ward, department_id, is_active)
SELECT seed.category, NULL, d.id, FALSE
FROM (
  VALUES
    ('potholes', 'roads_infrastructure'),
    ('garbage', 'solid_waste'),
    ('streetlights', 'electrical_lighting'),
    ('water_leakage', 'water_sewerage'),
    ('drainage', 'stormwater_drainage'),
    ('public_infrastructure', 'pwd_infrastructure')
) AS seed(category, dept_code)
JOIN public.departments d ON d.code = seed.dept_code
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Per-Category / Per-Ward Accuracy Metrics (Ground-Truth Evaluated)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_category_accuracy_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(50) NOT NULL CHECK (
    category IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure')
  ),
  ward VARCHAR(100) NULL CHECK (
    ward IS NULL OR pg_catalog.char_length(pg_catalog.btrim(ward)) BETWEEN 1 AND 100
  ),
  model_name TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(model_name)) BETWEEN 1 AND 100
  ),
  prompt_version TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(prompt_version)) BETWEEN 1 AND 64
  ),
  sample_size INT NOT NULL CHECK (sample_size >= 0),
  correct_count INT NOT NULL CHECK (correct_count >= 0 AND correct_count <= sample_size),
  accuracy DOUBLE PRECISION NOT NULL CHECK (
    accuracy >= 0.0
    AND accuracy <= 1.0
    AND accuracy <> 'NaN'::double precision
    AND accuracy <> 'Infinity'::double precision
    AND accuracy <> '-Infinity'::double precision
  ),
  measured_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.ai_category_accuracy_metrics IS
  'Per-category (and per-ward when ward IS NOT NULL) accuracy metrics for Phase 9.1 suggestions evaluated against human-assigned departments.';

CREATE UNIQUE INDEX IF NOT EXISTS uidx_ai_cat_acc_metrics_key
  ON public.ai_category_accuracy_metrics (category, COALESCE(ward, ''), model_name, prompt_version);

CREATE INDEX IF NOT EXISTS idx_ai_cat_acc_metrics_lookup
  ON public.ai_category_accuracy_metrics (category, model_name, prompt_version, measured_at DESC);

ALTER TABLE public.ai_category_accuracy_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_category_accuracy_metrics FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_category_accuracy_metrics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ai_category_accuracy_metrics TO authenticated;

DROP POLICY IF EXISTS "Admins can view AI category accuracy metrics" ON public.ai_category_accuracy_metrics;
CREATE POLICY "Admins can view AI category accuracy metrics"
  ON public.ai_category_accuracy_metrics
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 4. Immutable Department Assignment Events (AI + Staff + Override Tracking)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.department_assignment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system_ai', 'staff')),
  actor_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  ai_decision_id UUID NULL REFERENCES public.ai_decisions(id) ON DELETE RESTRICT,
  prev_department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  new_department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  suggested_department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  model_name TEXT NULL,
  prompt_version TEXT NULL,
  confidence DOUBLE PRECISION NULL,
  mode TEXT NULL CHECK (mode IS NULL OR mode IN ('off', 'shadow', 'active')),
  gate_snapshot JSONB NULL,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  is_ai_override BOOLEAN NOT NULL DEFAULT FALSE,
  reason_code TEXT NULL CHECK (
    reason_code IS NULL OR pg_catalog.char_length(pg_catalog.btrim(reason_code)) BETWEEN 1 AND 64
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT chk_dept_assign_event_actor CHECK (
    (actor_type = 'system_ai' AND actor_id IS NULL)
    OR (actor_type = 'staff' AND is_ai_override IN (TRUE, FALSE))
  )
);

COMMENT ON TABLE public.department_assignment_events IS
  'Immutable audit log of AI department routing evaluations/assignments and staff assignments/overrides.';

-- Idempotency: at most one system_ai event per ai_decision_id; staff events unrestricted.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_dept_assign_events_system_ai_decision
  ON public.department_assignment_events (ai_decision_id)
  WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dept_assign_events_complaint
  ON public.department_assignment_events (complaint_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.guard_immutable_dept_assign_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Department assignment events are strictly immutable.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_dept_assign_events() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_dept_assign_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_dept_assign_events ON public.department_assignment_events;
CREATE TRIGGER trg_guard_immutable_dept_assign_events
  BEFORE UPDATE OR DELETE ON public.department_assignment_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_dept_assign_events();

DROP TRIGGER IF EXISTS trg_guard_immutable_dept_assign_events_truncate ON public.department_assignment_events;
CREATE TRIGGER trg_guard_immutable_dept_assign_events_truncate
  BEFORE TRUNCATE ON public.department_assignment_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_dept_assign_events();

ALTER TABLE public.department_assignment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_assignment_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.department_assignment_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.department_assignment_events TO authenticated;

DROP POLICY IF EXISTS "Admins can view department assignment events" ON public.department_assignment_events;
CREATE POLICY "Admins can view department assignment events"
  ON public.department_assignment_events
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 5. Additive Manual Triage Queue (Every Non-Assign Fallback Recorded)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_department_triage_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL UNIQUE REFERENCES public.complaints(id) ON DELETE RESTRICT,
  ai_decision_id UUID NULL REFERENCES public.ai_decisions(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'shadow_mode',
      'ai_pending',
      'no_suggestion',
      'low_confidence',
      'insufficient_samples',
      'low_accuracy',
      'stale_metrics',
      'ambiguous_mapping',
      'unmapped',
      'inactive_department',
      'already_assigned',
      'terminal_status',
      'error'
    )
  ),
  mode TEXT NOT NULL CHECK (mode IN ('off', 'shadow', 'active')),
  suggested_department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  gate_snapshot JSONB NULL,
  resolved_at TIMESTAMPTZ NULL,
  resolved_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.complaint_department_triage_queue IS
  'Additive manual triage queue records with explicit fallback reason codes for complaints not auto-assigned by Phase 9.2.';

CREATE INDEX IF NOT EXISTS idx_dept_triage_queue_open
  ON public.complaint_department_triage_queue (resolved_at, created_at DESC);

ALTER TABLE public.complaint_department_triage_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_department_triage_queue FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_department_triage_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.complaint_department_triage_queue TO authenticated;

DROP POLICY IF EXISTS "Admins can view department triage queue" ON public.complaint_department_triage_queue;
CREATE POLICY "Admins can view department triage queue"
  ON public.complaint_department_triage_queue
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 6. Additive Staff Assignment & AI Override Trigger on public.complaints
-- Wrapped in EXCEPTION WHEN OTHERS so it can NEVER break assign_complaint_admin.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phase9_2_track_staff_department_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_tag TEXT;
  v_actor_id UUID;
  v_is_override BOOLEAN := FALSE;
  v_ai_decision_id UUID := NULL;
BEGIN
  IF pg_catalog.current_setting('reportly.dept_assign_actor', true) = 'system_ai' THEN
    RETURN NEW;
  END IF;

  IF OLD.department_id IS NOT DISTINCT FROM NEW.department_id THEN
    RETURN NEW;
  END IF;

  v_actor_id := auth.uid();

  BEGIN
    -- An assignment is an AI override ONLY if the prior department_id was set by system_ai
    -- with no intervening staff department assignment on this complaint.
    IF OLD.department_id IS NOT NULL THEN
      SELECT e.ai_decision_id
      INTO v_ai_decision_id
      FROM public.department_assignment_events e
      WHERE e.complaint_id = NEW.id
        AND e.actor_type = 'system_ai'
        AND e.applied = TRUE
        AND e.new_department_id = OLD.department_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.department_assignment_events s
          WHERE s.complaint_id = NEW.id
            AND s.actor_type = 'staff'
            AND s.created_at >= e.created_at
        )
      ORDER BY e.created_at DESC
      LIMIT 1;

      IF FOUND THEN
        v_is_override := TRUE;
      END IF;
    END IF;

    INSERT INTO public.department_assignment_events (
      complaint_id,
      actor_type,
      actor_id,
      ai_decision_id,
      prev_department_id,
      new_department_id,
      applied,
      is_ai_override,
      reason_code,
      created_at
    ) VALUES (
      NEW.id,
      'staff',
      v_actor_id,
      v_ai_decision_id,
      OLD.department_id,
      NEW.department_id,
      TRUE,
      v_is_override,
      CASE WHEN v_is_override THEN 'staff_override' ELSE 'staff_manual_assign' END,
      pg_catalog.now()
    );

    -- Close any open manual triage queue row when staff resolves the department assignment
    IF NEW.department_id IS NOT NULL THEN
      UPDATE public.complaint_department_triage_queue
      SET resolved_at = pg_catalog.now(),
          resolved_by = v_actor_id,
          updated_at = pg_catalog.now()
      WHERE complaint_id = NEW.id
        AND resolved_at IS NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Safety guard: never allow telemetry/audit failures to break assign_complaint_admin
    RETURN NEW;
  END;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.phase9_2_track_staff_department_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.phase9_2_track_staff_department_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_phase9_2_track_staff_department_change ON public.complaints;
CREATE TRIGGER trg_phase9_2_track_staff_department_change
  AFTER UPDATE OF department_id ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.phase9_2_track_staff_department_change();

-- -----------------------------------------------------------------------------
-- 7. Accuracy Metric Computation RPC (Ground-Truth Department Formula)
--
-- EXACT FORMULA DOCUMENTED:
--   For each complaint c, take AT MOST ONE Phase 9.1 AI suggestion:
--   the latest completed decision (DISTINCT ON complaint_id ordered by
--   COALESCE(completed_at, created_at) DESC, created_at DESC, id DESC) where
--   feature = 'category_priority_suggestion', status = 'completed', and
--   suggested_category IS NOT NULL.
--     1) Human ground truth exists ONLY when:
--        - c.department_id IS NOT NULL, AND
--        - A human staff member recorded a department assignment matching
--          c.department_id via EITHER:
--          (a) public.complaint_assignment_audit (new_department_id = c.department_id), OR
--          (b) public.department_assignment_events (actor_type = 'staff' AND
--              new_department_id = c.department_id), AND
--        - Explicitly EXCLUDE complaints whose current c.department_id was set
--          by actor_type = 'system_ai' (applied = TRUE) with NO subsequent
--          'staff' assignment event or complaint_assignment_audit row at or
--          after that AI assignment.
--        Category review alone (ai_decisions.admin_decision) NEVER counts as
--        department ground truth so the AI never validates its own predictions.
--     2) Predicted department pred_dept_id(d.suggested_category, c.ward) is resolved
--        from active, unambiguous rows in public.category_department_mappings:
--        - If exactly 1 active ward mapping exists for (suggested_category, c.ward),
--          use that department_id (if >1 ward mappings, NULL / incorrect).
--        - Else if exactly 1 active citywide mapping exists for (suggested_category, NULL),
--          use that department_id (if >1 citywide mappings, NULL / incorrect).
--        - Also require target department.is_active = TRUE.
--     3) Sample correctness:
--        is_correct = (pred_dept_id IS NOT NULL AND pred_dept_id = c.department_id)
--     4) Aggregations computed separately per (category, model_name, prompt_version):
--        - Ward-scoped rows (ward = c.ward):
--            sample_size   = COUNT(*) in that ward
--            correct_count = COUNT(*) FILTER (WHERE is_correct) in that ward
--            accuracy      = correct_count::double precision / sample_size::double precision
--        - Citywide rows (ward = NULL):
--            sample_size   = COUNT(*) across all wards
--            correct_count = COUNT(*) FILTER (WHERE is_correct) across all wards
--            accuracy      = correct_count::double precision / sample_size::double precision
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_ai_category_accuracy_metrics()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_rows_upserted INT := 0;
  v_ward_rows INT := 0;
  v_city_rows INT := 0;
BEGIN
  -- Ward-level metrics (strictly evaluated from validated samples within each ward)
  WITH latest_completed_ai AS (
    SELECT DISTINCT ON (d.complaint_id)
      d.complaint_id,
      d.suggested_category,
      d.model_name,
      d.prompt_version
    FROM public.ai_decisions d
    WHERE d.feature = 'category_priority_suggestion'
      AND d.status = 'completed'
      AND d.suggested_category IS NOT NULL
    ORDER BY
      d.complaint_id,
      COALESCE(d.completed_at, d.created_at) DESC,
      d.created_at DESC,
      d.id DESC
  ),
  validated_samples AS (
    SELECT
      d.suggested_category AS category,
      c.ward AS ward,
      d.model_name,
      d.prompt_version,
      c.department_id AS human_dept_id,
      (
        CASE
          WHEN (
            SELECT pg_catalog.count(*)
            FROM public.category_department_mappings mw
            JOIN public.departments dw ON dw.id = mw.department_id
            WHERE mw.category = d.suggested_category
              AND mw.ward = c.ward
              AND mw.is_active = TRUE
              AND dw.is_active = TRUE
          ) = 1 THEN (
            SELECT mw.department_id
            FROM public.category_department_mappings mw
            JOIN public.departments dw ON dw.id = mw.department_id
            WHERE mw.category = d.suggested_category
              AND mw.ward = c.ward
              AND mw.is_active = TRUE
              AND dw.is_active = TRUE
            LIMIT 1
          )
          WHEN (
            SELECT pg_catalog.count(*)
            FROM public.category_department_mappings mw_any
            WHERE mw_any.category = d.suggested_category
              AND mw_any.ward = c.ward
              AND mw_any.is_active = TRUE
          ) > 1 THEN NULL
          WHEN (
            SELECT pg_catalog.count(*)
            FROM public.category_department_mappings mg
            JOIN public.departments dg ON dg.id = mg.department_id
            WHERE mg.category = d.suggested_category
              AND mg.ward IS NULL
              AND mg.is_active = TRUE
              AND dg.is_active = TRUE
          ) = 1 THEN (
            SELECT mg.department_id
            FROM public.category_department_mappings mg
            JOIN public.departments dg ON dg.id = mg.department_id
            WHERE mg.category = d.suggested_category
              AND mg.ward IS NULL
              AND mg.is_active = TRUE
              AND dg.is_active = TRUE
            LIMIT 1
          )
          ELSE NULL
        END
      ) AS pred_dept_id
    FROM latest_completed_ai d
    JOIN public.complaints c ON c.id = d.complaint_id
    WHERE c.department_id IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.complaint_assignment_audit a
          WHERE a.complaint_id = c.id
            AND a.new_department_id = c.department_id
        )
        OR EXISTS (
          SELECT 1 FROM public.department_assignment_events ev
          WHERE ev.complaint_id = c.id
            AND ev.actor_type = 'staff'
            AND ev.new_department_id = c.department_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.department_assignment_events ai_ev
        WHERE ai_ev.complaint_id = c.id
          AND ai_ev.actor_type = 'system_ai'
          AND ai_ev.applied = TRUE
          AND ai_ev.new_department_id = c.department_id
          AND NOT EXISTS (
            SELECT 1
            FROM public.department_assignment_events st_ev
            WHERE st_ev.complaint_id = c.id
              AND st_ev.actor_type = 'staff'
              AND st_ev.created_at >= ai_ev.created_at
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.complaint_assignment_audit st_aud
            WHERE st_aud.complaint_id = c.id
              AND st_aud.new_department_id = c.department_id
              AND st_aud.created_at >= ai_ev.created_at
          )
      )
  ),
  ward_agg AS (
    SELECT
      category,
      ward,
      model_name,
      prompt_version,
      pg_catalog.count(*)::int AS sample_size,
      pg_catalog.count(*) FILTER (WHERE pred_dept_id IS NOT NULL AND pred_dept_id = human_dept_id)::int AS correct_count
    FROM validated_samples
    WHERE ward IS NOT NULL
    GROUP BY category, ward, model_name, prompt_version
  )
  INSERT INTO public.ai_category_accuracy_metrics (
    category, ward, model_name, prompt_version, sample_size, correct_count, accuracy, measured_at, created_at, updated_at
  )
  SELECT
    category,
    ward,
    model_name,
    prompt_version,
    sample_size,
    correct_count,
    CASE WHEN sample_size > 0 THEN correct_count::double precision / sample_size::double precision ELSE 0.0 END,
    v_now,
    v_now,
    v_now
  FROM ward_agg
  ON CONFLICT (category, COALESCE(ward, ''), model_name, prompt_version)
  DO UPDATE SET
    sample_size = EXCLUDED.sample_size,
    correct_count = EXCLUDED.correct_count,
    accuracy = EXCLUDED.accuracy,
    measured_at = EXCLUDED.measured_at,
    updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_ward_rows = ROW_COUNT;

  -- Citywide metrics (ward IS NULL)
  WITH latest_completed_ai AS (
    SELECT DISTINCT ON (d.complaint_id)
      d.complaint_id,
      d.suggested_category,
      d.model_name,
      d.prompt_version
    FROM public.ai_decisions d
    WHERE d.feature = 'category_priority_suggestion'
      AND d.status = 'completed'
      AND d.suggested_category IS NOT NULL
    ORDER BY
      d.complaint_id,
      COALESCE(d.completed_at, d.created_at) DESC,
      d.created_at DESC,
      d.id DESC
  ),
  validated_samples AS (
    SELECT
      d.suggested_category AS category,
      d.model_name,
      d.prompt_version,
      c.department_id AS human_dept_id,
      (
        CASE
          WHEN (
            SELECT pg_catalog.count(*)
            FROM public.category_department_mappings mw
            JOIN public.departments dw ON dw.id = mw.department_id
            WHERE mw.category = d.suggested_category
              AND mw.ward = c.ward
              AND mw.is_active = TRUE
              AND dw.is_active = TRUE
          ) = 1 THEN (
            SELECT mw.department_id
            FROM public.category_department_mappings mw
            JOIN public.departments dw ON dw.id = mw.department_id
            WHERE mw.category = d.suggested_category
              AND mw.ward = c.ward
              AND mw.is_active = TRUE
              AND dw.is_active = TRUE
            LIMIT 1
          )
          WHEN (
            SELECT pg_catalog.count(*)
            FROM public.category_department_mappings mw_any
            WHERE mw_any.category = d.suggested_category
              AND mw_any.ward = c.ward
              AND mw_any.is_active = TRUE
          ) > 1 THEN NULL
          WHEN (
            SELECT pg_catalog.count(*)
            FROM public.category_department_mappings mg
            JOIN public.departments dg ON dg.id = mg.department_id
            WHERE mg.category = d.suggested_category
              AND mg.ward IS NULL
              AND mg.is_active = TRUE
              AND dg.is_active = TRUE
          ) = 1 THEN (
            SELECT mg.department_id
            FROM public.category_department_mappings mg
            JOIN public.departments dg ON dg.id = mg.department_id
            WHERE mg.category = d.suggested_category
              AND mg.ward IS NULL
              AND mg.is_active = TRUE
              AND dg.is_active = TRUE
            LIMIT 1
          )
          ELSE NULL
        END
      ) AS pred_dept_id
    FROM latest_completed_ai d
    JOIN public.complaints c ON c.id = d.complaint_id
    WHERE c.department_id IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.complaint_assignment_audit a
          WHERE a.complaint_id = c.id
            AND a.new_department_id = c.department_id
        )
        OR EXISTS (
          SELECT 1 FROM public.department_assignment_events ev
          WHERE ev.complaint_id = c.id
            AND ev.actor_type = 'staff'
            AND ev.new_department_id = c.department_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.department_assignment_events ai_ev
        WHERE ai_ev.complaint_id = c.id
          AND ai_ev.actor_type = 'system_ai'
          AND ai_ev.applied = TRUE
          AND ai_ev.new_department_id = c.department_id
          AND NOT EXISTS (
            SELECT 1
            FROM public.department_assignment_events st_ev
            WHERE st_ev.complaint_id = c.id
              AND st_ev.actor_type = 'staff'
              AND st_ev.created_at >= ai_ev.created_at
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.complaint_assignment_audit st_aud
            WHERE st_aud.complaint_id = c.id
              AND st_aud.new_department_id = c.department_id
              AND st_aud.created_at >= ai_ev.created_at
          )
      )
  ),
  city_agg AS (
    SELECT
      category,
      model_name,
      prompt_version,
      pg_catalog.count(*)::int AS sample_size,
      pg_catalog.count(*) FILTER (WHERE pred_dept_id IS NOT NULL AND pred_dept_id = human_dept_id)::int AS correct_count
    FROM validated_samples
    GROUP BY category, model_name, prompt_version
  )
  INSERT INTO public.ai_category_accuracy_metrics (
    category, ward, model_name, prompt_version, sample_size, correct_count, accuracy, measured_at, created_at, updated_at
  )
  SELECT
    category,
    NULL,
    model_name,
    prompt_version,
    sample_size,
    correct_count,
    CASE WHEN sample_size > 0 THEN correct_count::double precision / sample_size::double precision ELSE 0.0 END,
    v_now,
    v_now,
    v_now
  FROM city_agg
  ON CONFLICT (category, COALESCE(ward, ''), model_name, prompt_version)
  DO UPDATE SET
    sample_size = EXCLUDED.sample_size,
    correct_count = EXCLUDED.correct_count,
    accuracy = EXCLUDED.accuracy,
    measured_at = EXCLUDED.measured_at,
    updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_city_rows = ROW_COUNT;
  v_rows_upserted := v_ward_rows + v_city_rows;

  RETURN jsonb_build_object(
    'success', true,
    'ward_metrics_updated', v_ward_rows,
    'citywide_metrics_updated', v_city_rows,
    'total_updated', v_rows_upserted,
    'measured_at', v_now
  );
END;
$$;

ALTER FUNCTION public.refresh_ai_category_accuracy_metrics() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refresh_ai_category_accuracy_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_ai_category_accuracy_metrics() TO service_role;

-- -----------------------------------------------------------------------------
-- 8. Core Phase 9.2 Evaluation & Atomic Department Assignment RPC (service_role)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_and_assign_department_ai(
  p_complaint_id UUID,
  p_mode TEXT DEFAULT 'shadow',
  p_min_samples INT DEFAULT 50,
  p_min_accuracy DOUBLE PRECISION DEFAULT 0.95,
  p_metrics_max_age_days INT DEFAULT 14,
  p_min_confidence DOUBLE PRECISION DEFAULT 0.85
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_mode TEXT;
  v_min_samples INT;
  v_min_acc DOUBLE PRECISION;
  v_max_age_days INT;
  v_min_conf DOUBLE PRECISION;
  v_comp RECORD;
  v_ai RECORD;
  v_ward_active_count INT := 0;
  v_global_active_count INT := 0;
  v_ward_inactive_count INT := 0;
  v_global_inactive_count INT := 0;
  v_mapping_scope TEXT := NULL;
  v_target_dept_id UUID := NULL;
  v_dept_active BOOLEAN := NULL;
  v_metric RECORD;
  v_has_metric BOOLEAN := FALSE;
  v_reason_code TEXT := NULL;
  v_all_gates_passed BOOLEAN := FALSE;
  v_applied BOOLEAN := FALSE;
  v_rows_updated INT := 0;
  v_gate_snapshot JSONB;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_complaint_id');
  END IF;

  v_mode := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_mode, 'shadow')));
  IF v_mode NOT IN ('off', 'shadow', 'active') THEN
    v_mode := 'shadow';
  END IF;

  IF v_mode = 'off' THEN
    RETURN jsonb_build_object('mode', 'off', 'skipped', true, 'applied', false);
  END IF;

  v_min_samples := GREATEST(1, COALESCE(p_min_samples, 50));
  v_min_acc := GREATEST(0.0::double precision, LEAST(1.0::double precision, COALESCE(p_min_accuracy, 0.95::double precision)));
  v_max_age_days := GREATEST(1, COALESCE(p_metrics_max_age_days, 14));
  v_min_conf := GREATEST(0.0::double precision, LEAST(1.0::double precision, COALESCE(p_min_confidence, 0.85::double precision)));

  -- Lock complaint row (Amendment 7)
  SELECT id, category, ward, status, department_id, assigned_officer_id, updated_at
  INTO v_comp
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'applied', false);
  END IF;

  -- Fetch latest Phase 9.1 decision
  SELECT id, status, suggested_category, confidence, model_name, prompt_version, created_at, completed_at
  INTO v_ai
  FROM public.ai_decisions
  WHERE complaint_id = p_complaint_id
    AND feature = 'category_priority_suggestion'
  ORDER BY created_at DESC
  LIMIT 1;

  -- Amendment 5: Pending / Failed / Absent 9.1 suggestion -> triage queue
  IF NOT FOUND OR v_ai.status = 'failed' THEN
    INSERT INTO public.complaint_department_triage_queue (
      complaint_id, ai_decision_id, reason_code, mode, gate_snapshot, created_at, updated_at
    ) VALUES (
      p_complaint_id,
      CASE WHEN FOUND THEN v_ai.id ELSE NULL END,
      'no_suggestion',
      v_mode,
      jsonb_build_object('reason', 'no_suggestion', 'mode', v_mode),
      v_now,
      v_now
    )
    ON CONFLICT (complaint_id) DO UPDATE SET
      ai_decision_id = EXCLUDED.ai_decision_id,
      reason_code = CASE WHEN public.complaint_department_triage_queue.resolved_at IS NULL THEN EXCLUDED.reason_code ELSE public.complaint_department_triage_queue.reason_code END,
      mode = EXCLUDED.mode,
      gate_snapshot = EXCLUDED.gate_snapshot,
      updated_at = v_now;

    IF FOUND AND v_ai.id IS NOT NULL THEN
      INSERT INTO public.department_assignment_events (
        complaint_id, actor_type, ai_decision_id, model_name, prompt_version, mode, gate_snapshot, applied, reason_code, created_at
      ) VALUES (
        p_complaint_id, 'system_ai', v_ai.id, v_ai.model_name, v_ai.prompt_version, v_mode,
        jsonb_build_object('reason', 'no_suggestion'), FALSE, 'no_suggestion', v_now
      )
      ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;
    END IF;

    RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'no_suggestion', 'applied', false);
  END IF;

  IF v_ai.status = 'pending' THEN
    -- Record ai_pending in triage queue WITHOUT consuming the (ai_decision_id) system_ai slot
    INSERT INTO public.complaint_department_triage_queue (
      complaint_id, ai_decision_id, reason_code, mode, gate_snapshot, created_at, updated_at
    ) VALUES (
      p_complaint_id,
      v_ai.id,
      'ai_pending',
      v_mode,
      jsonb_build_object('reason', 'ai_pending', 'mode', v_mode),
      v_now,
      v_now
    )
    ON CONFLICT (complaint_id) DO UPDATE SET
      ai_decision_id = EXCLUDED.ai_decision_id,
      reason_code = CASE WHEN public.complaint_department_triage_queue.resolved_at IS NULL THEN 'ai_pending' ELSE public.complaint_department_triage_queue.reason_code END,
      mode = EXCLUDED.mode,
      gate_snapshot = EXCLUDED.gate_snapshot,
      updated_at = v_now;

    RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'ai_pending', 'applied', false);
  END IF;

  -- Idempotency check for completed ai_decision_id (Amendment 4)
  IF EXISTS (
    SELECT 1 FROM public.department_assignment_events
    WHERE actor_type = 'system_ai' AND ai_decision_id = v_ai.id
  ) THEN
    RETURN jsonb_build_object('mode', v_mode, 'idempotent_hit', true, 'applied', false);
  END IF;

  -- Reject terminal complaint states (Amendment 7)
  IF v_comp.status IN (
    'resolved'::public.complaint_status,
    'rejected'::public.complaint_status,
    'not_confirmed_by_citizen'::public.complaint_status
  ) THEN
    v_gate_snapshot := jsonb_build_object('reason', 'terminal_status', 'status', v_comp.status::text, 'mode', v_mode);
    INSERT INTO public.department_assignment_events (
      complaint_id, actor_type, ai_decision_id, model_name, prompt_version, confidence, mode, gate_snapshot, applied, reason_code, created_at
    ) VALUES (
      p_complaint_id, 'system_ai', v_ai.id, v_ai.model_name, v_ai.prompt_version, v_ai.confidence, v_mode, v_gate_snapshot, FALSE, 'terminal_status', v_now
    )
    ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'terminal_status', 'applied', false);
  END IF;

  -- Never re-run on or overwrite an already-assigned complaint
  IF v_comp.department_id IS NOT NULL THEN
    v_gate_snapshot := jsonb_build_object('reason', 'already_assigned', 'department_id', v_comp.department_id, 'mode', v_mode);
    INSERT INTO public.department_assignment_events (
      complaint_id, actor_type, ai_decision_id, prev_department_id, new_department_id, model_name, prompt_version, confidence, mode, gate_snapshot, applied, reason_code, created_at
    ) VALUES (
      p_complaint_id, 'system_ai', v_ai.id, v_comp.department_id, v_comp.department_id, v_ai.model_name, v_ai.prompt_version, v_ai.confidence, v_mode, v_gate_snapshot, FALSE, 'already_assigned', v_now
    )
    ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'already_assigned', 'applied', false);
  END IF;

  -- Resolve category -> department mapping (ward-specific first, then citywide)
  SELECT pg_catalog.count(*)::int
  INTO v_ward_active_count
  FROM public.category_department_mappings m
  WHERE m.category = v_ai.suggested_category
    AND m.ward = v_comp.ward
    AND m.is_active = TRUE;

  IF v_ward_active_count > 1 THEN
    v_reason_code := 'ambiguous_mapping';
  ELSIF v_ward_active_count = 1 THEN
    v_mapping_scope := 'ward';
    SELECT m.department_id INTO v_target_dept_id
    FROM public.category_department_mappings m
    WHERE m.category = v_ai.suggested_category
      AND m.ward = v_comp.ward
      AND m.is_active = TRUE
    LIMIT 1;
  ELSE
    SELECT pg_catalog.count(*)::int
    INTO v_global_active_count
    FROM public.category_department_mappings m
    WHERE m.category = v_ai.suggested_category
      AND m.ward IS NULL
      AND m.is_active = TRUE;

    IF v_global_active_count > 1 THEN
      v_reason_code := 'ambiguous_mapping';
    ELSIF v_global_active_count = 1 THEN
      v_mapping_scope := 'citywide';
      SELECT m.department_id INTO v_target_dept_id
      FROM public.category_department_mappings m
      WHERE m.category = v_ai.suggested_category
        AND m.ward IS NULL
        AND m.is_active = TRUE
      LIMIT 1;
    ELSE
      SELECT pg_catalog.count(*)::int
      INTO v_ward_inactive_count
      FROM public.category_department_mappings m
      WHERE m.category = v_ai.suggested_category
        AND (m.ward = v_comp.ward OR m.ward IS NULL)
        AND m.is_active = FALSE;

      v_reason_code := 'unmapped';
    END IF;
  END IF;

  -- Check target department active state
  IF v_reason_code IS NULL AND v_target_dept_id IS NOT NULL THEN
    SELECT is_active INTO v_dept_active
    FROM public.departments
    WHERE id = v_target_dept_id;

    IF NOT FOUND OR v_dept_active IS DISTINCT FROM TRUE THEN
      v_reason_code := 'inactive_department';
    END IF;
  END IF;

  -- Evaluate accuracy, sample size, staleness (exact model_name + prompt_version, Amendments 3 & 6)
  IF v_mapping_scope = 'ward' THEN
    SELECT * INTO v_metric
    FROM public.ai_category_accuracy_metrics
    WHERE category = v_ai.suggested_category
      AND ward = v_comp.ward
      AND model_name = v_ai.model_name
      AND prompt_version = v_ai.prompt_version
    LIMIT 1;
    v_has_metric := FOUND;
  ELSIF v_mapping_scope = 'citywide' THEN
    SELECT * INTO v_metric
    FROM public.ai_category_accuracy_metrics
    WHERE category = v_ai.suggested_category
      AND ward IS NULL
      AND model_name = v_ai.model_name
      AND prompt_version = v_ai.prompt_version
    LIMIT 1;
    v_has_metric := FOUND;
  END IF;

  IF v_reason_code IS NULL THEN
    IF NOT v_has_metric OR v_metric.sample_size < v_min_samples THEN
      v_reason_code := 'insufficient_samples';
    ELSIF v_metric.measured_at < (v_now - pg_catalog.make_interval(days => v_max_age_days)) THEN
      v_reason_code := 'stale_metrics';
    ELSIF v_metric.accuracy < v_min_acc THEN
      v_reason_code := 'low_accuracy';
    ELSIF v_ai.confidence IS NULL OR v_ai.confidence < v_min_conf THEN
      v_reason_code := 'low_confidence';
    ELSE
      v_all_gates_passed := TRUE;
    END IF;
  END IF;

  v_gate_snapshot := jsonb_build_object(
    'mode', v_mode,
    'category', v_ai.suggested_category,
    'ward', v_comp.ward,
    'mapping_scope', v_mapping_scope,
    'suggested_department_id', v_target_dept_id,
    'model_name', v_ai.model_name,
    'prompt_version', v_ai.prompt_version,
    'confidence', v_ai.confidence,
    'min_confidence', v_min_conf,
    'sample_size', CASE WHEN v_has_metric THEN v_metric.sample_size ELSE 0 END,
    'min_samples', v_min_samples,
    'accuracy', CASE WHEN v_has_metric THEN v_metric.accuracy ELSE NULL END,
    'min_accuracy', v_min_acc,
    'measured_at', CASE WHEN v_has_metric THEN v_metric.measured_at ELSE NULL END,
    'max_age_days', v_max_age_days,
    'all_gates_passed', v_all_gates_passed,
    'gate_failure_reason', v_reason_code
  );

  -- Amendment 11: In shadow mode, always evaluate gates and store snapshot, never change department_id
  IF v_mode = 'shadow' THEN
    v_reason_code := COALESCE(v_reason_code, 'shadow_mode');

    INSERT INTO public.department_assignment_events (
      complaint_id, actor_type, ai_decision_id, suggested_department_id,
      model_name, prompt_version, confidence, mode, gate_snapshot, applied, reason_code, created_at
    ) VALUES (
      p_complaint_id, 'system_ai', v_ai.id, v_target_dept_id,
      v_ai.model_name, v_ai.prompt_version, v_ai.confidence, 'shadow', v_gate_snapshot, FALSE, v_reason_code, v_now
    )
    ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;

    INSERT INTO public.complaint_department_triage_queue (
      complaint_id, ai_decision_id, reason_code, mode, suggested_department_id, gate_snapshot, created_at, updated_at
    ) VALUES (
      p_complaint_id, v_ai.id, v_reason_code, 'shadow', v_target_dept_id, v_gate_snapshot, v_now, v_now
    )
    ON CONFLICT (complaint_id) DO UPDATE SET
      ai_decision_id = EXCLUDED.ai_decision_id,
      reason_code = CASE WHEN public.complaint_department_triage_queue.resolved_at IS NULL THEN EXCLUDED.reason_code ELSE public.complaint_department_triage_queue.reason_code END,
      mode = EXCLUDED.mode,
      suggested_department_id = EXCLUDED.suggested_department_id,
      gate_snapshot = EXCLUDED.gate_snapshot,
      updated_at = v_now;

    RETURN jsonb_build_object(
      'mode', 'shadow',
      'applied', false,
      'all_gates_passed', v_all_gates_passed,
      'reason_code', v_reason_code,
      'suggested_department_id', v_target_dept_id,
      'gate_snapshot', v_gate_snapshot
    );
  END IF;

  -- Active mode: assign ONLY if all gates passed
  IF v_all_gates_passed AND v_target_dept_id IS NOT NULL THEN
    PERFORM pg_catalog.set_config('reportly.dept_assign_actor', 'system_ai', true);

    UPDATE public.complaints
    SET department_id = v_target_dept_id,
        updated_at = v_now
    WHERE id = p_complaint_id
      AND department_id IS NULL
      AND status NOT IN (
        'resolved'::public.complaint_status,
        'rejected'::public.complaint_status,
        'not_confirmed_by_citizen'::public.complaint_status
      );

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

    IF v_rows_updated = 1 THEN
      v_applied := TRUE;

      INSERT INTO public.department_assignment_events (
        complaint_id, actor_type, ai_decision_id, prev_department_id, new_department_id,
        suggested_department_id, model_name, prompt_version, confidence, mode, gate_snapshot,
        applied, is_ai_override, reason_code, created_at
      ) VALUES (
        p_complaint_id, 'system_ai', v_ai.id, NULL, v_target_dept_id,
        v_target_dept_id, v_ai.model_name, v_ai.prompt_version, v_ai.confidence, 'active', v_gate_snapshot,
        TRUE, FALSE, 'assigned', v_now
      )
      ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;

      -- Close any prior pending triage row (e.g. ai_pending)
      UPDATE public.complaint_department_triage_queue
      SET resolved_at = v_now,
          updated_at = v_now
      WHERE complaint_id = p_complaint_id
        AND resolved_at IS NULL;

      RETURN jsonb_build_object(
        'mode', 'active',
        'applied', true,
        'all_gates_passed', true,
        'department_id', v_target_dept_id,
        'gate_snapshot', v_gate_snapshot
      );
    ELSE
      v_reason_code := 'already_assigned';
    END IF;
  END IF;

  -- Non-assign fallback in active mode -> manual triage queue
  v_reason_code := COALESCE(v_reason_code, 'error');

  INSERT INTO public.department_assignment_events (
    complaint_id, actor_type, ai_decision_id, suggested_department_id,
    model_name, prompt_version, confidence, mode, gate_snapshot, applied, reason_code, created_at
  ) VALUES (
    p_complaint_id, 'system_ai', v_ai.id, v_target_dept_id,
    v_ai.model_name, v_ai.prompt_version, v_ai.confidence, 'active', v_gate_snapshot, FALSE, v_reason_code, v_now
  )
  ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;

  INSERT INTO public.complaint_department_triage_queue (
    complaint_id, ai_decision_id, reason_code, mode, suggested_department_id, gate_snapshot, created_at, updated_at
  ) VALUES (
    p_complaint_id, v_ai.id, v_reason_code, 'active', v_target_dept_id, v_gate_snapshot, v_now, v_now
  )
  ON CONFLICT (complaint_id) DO UPDATE SET
    ai_decision_id = EXCLUDED.ai_decision_id,
    reason_code = CASE WHEN public.complaint_department_triage_queue.resolved_at IS NULL THEN EXCLUDED.reason_code ELSE public.complaint_department_triage_queue.reason_code END,
    mode = EXCLUDED.mode,
    suggested_department_id = EXCLUDED.suggested_department_id,
    gate_snapshot = EXCLUDED.gate_snapshot,
    updated_at = v_now;

  RETURN jsonb_build_object(
    'mode', 'active',
    'applied', false,
    'all_gates_passed', v_all_gates_passed,
    'reason_code', v_reason_code,
    'suggested_department_id', v_target_dept_id,
    'gate_snapshot', v_gate_snapshot
  );
END;
$$;

ALTER FUNCTION public.evaluate_and_assign_department_ai(UUID, TEXT, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.evaluate_and_assign_department_ai(UUID, TEXT, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_and_assign_department_ai(UUID, TEXT, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION) TO service_role;

-- -----------------------------------------------------------------------------
-- 9. Admin Mapping Activation / Edit RPC & Read RPC (authenticated + is_admin())
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_category_department_mapping(
  p_category TEXT,
  p_department_id UUID,
  p_ward TEXT DEFAULT NULL,
  p_is_active BOOLEAN DEFAULT FALSE,
  p_mapping_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID;
  v_clean_cat TEXT;
  v_clean_ward TEXT;
  v_dept_exists BOOLEAN;
  v_row public.category_department_mappings%ROWTYPE;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Only municipal administrators can manage category-department mappings.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Security Violation: Missing authenticated actor.' USING ERRCODE = '42501';
  END IF;

  v_clean_cat := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_category, '')));
  IF v_clean_cat NOT IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure') THEN
    RAISE EXCEPTION 'Invalid Parameter: category is not an allowed civic category.' USING ERRCODE = '22023';
  END IF;

  v_clean_ward := NULLIF(pg_catalog.btrim(COALESCE(p_ward, '')), '');

  IF p_department_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: department_id is required.' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.departments WHERE id = p_department_id) INTO v_dept_exists;
  IF NOT v_dept_exists THEN
    RAISE EXCEPTION 'Department % not found.', p_department_id USING ERRCODE = 'P0002';
  END IF;

  IF p_mapping_id IS NOT NULL THEN
    UPDATE public.category_department_mappings
    SET category = v_clean_cat,
        ward = v_clean_ward,
        department_id = p_department_id,
        is_active = COALESCE(p_is_active, FALSE),
        updated_by = v_actor_id,
        updated_at = pg_catalog.now()
    WHERE id = p_mapping_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Mapping % not found.', p_mapping_id USING ERRCODE = 'P0002';
    END IF;
  ELSE
    INSERT INTO public.category_department_mappings (
      category, ward, department_id, is_active, updated_by, created_at, updated_at
    ) VALUES (
      v_clean_cat, v_clean_ward, p_department_id, COALESCE(p_is_active, FALSE), v_actor_id, pg_catalog.now(), pg_catalog.now()
    )
    ON CONFLICT (category, COALESCE(ward, ''), department_id)
    DO UPDATE SET
      is_active = EXCLUDED.is_active,
      updated_by = EXCLUDED.updated_by,
      updated_at = pg_catalog.now()
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'category', v_row.category,
    'ward', v_row.ward,
    'department_id', v_row.department_id,
    'is_active', v_row.is_active,
    'updated_at', v_row.updated_at
  );
END;
$$;

ALTER FUNCTION public.upsert_category_department_mapping(TEXT, UUID, TEXT, BOOLEAN, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_category_department_mapping(TEXT, UUID, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_category_department_mapping(TEXT, UUID, TEXT, BOOLEAN, UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 10. Final Privilege & RLS Audit Block
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl TEXT;
  v_relacl aclitem[];
  v_fn RECORD;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'category_department_mappings',
    'ai_category_accuracy_metrics',
    'department_assignment_events',
    'complaint_department_triage_queue'
  ] LOOP
    SELECT c.relacl
    INTO v_relacl
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_tbl
      AND c.relrowsecurity = TRUE
      AND c.relforcerowsecurity = TRUE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Audit Failed: RLS and FORCE ROW LEVEL SECURITY must be enabled on public.%', v_tbl;
    END IF;

    IF pg_catalog.has_table_privilege('anon', 'public.' || v_tbl, 'SELECT')
       OR pg_catalog.has_table_privilege('anon', 'public.' || v_tbl, 'INSERT')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'INSERT')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'UPDATE')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'DELETE') THEN
      RAISE EXCEPTION 'Audit Failed: Excessive table privilege detected on public.%', v_tbl;
    END IF;
  END LOOP;

  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'evaluate_and_assign_department_ai',
        'refresh_ai_category_accuracy_metrics'
      )
  ) LOOP
    IF pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Function public.%() must allow EXECUTE strictly for service_role.', v_fn.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
