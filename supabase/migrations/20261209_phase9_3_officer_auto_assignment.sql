-- =============================================================================
-- Migration: 20261209_phase9_3_officer_auto_assignment.sql
-- Phase 9.3: AI Officer Auto-Assignment (Safety-First, Additive Only)
--
-- Features:
--   1. public.officer_assignment_events (immutable audit log with explicit
--      actor_type ('system_ai' | 'staff'), partial unique index on (complaint_id)
--      WHERE actor_type = 'system_ai', workload_snapshot JSONB, and override tracking).
--   2. public.complaint_officer_triage_queue (additive manual queue entries with
--      explicit fallback reason codes: shadow_mode, no_department, no_officer,
--      no_eligible_ward, all_at_capacity, ambiguous, already_assigned,
--      terminal_status, error).
--   3. Non-invasive AFTER UPDATE OF assigned_officer_id trigger on public.complaints
--      wrapped in EXCEPTION WHEN OTHERS so it can never break assign_complaint_admin.
--   4. RPC: evaluate_and_assign_officer_ai (service_role only, SET search_path = '',
--      ZERO RECORD variables, pg_advisory_xact_lock per department_id, exact ward
--      match or optional NULL-ward fallback only, lowest workload + deterministic
--      tie-break, atomic UPDATE checking ROW_COUNT, outer EXCEPTION handler).
--
-- Note: Never schema-qualify LEAST, GREATEST, or COALESCE (SQL keywords).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Preconditions Check
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
    SELECT 'table public.officers' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'officers'
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
    SELECT 'function public.is_admin()' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin'
    )
  ) checks;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed for Phase 9.3: missing %', v_missing;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Immutable Officer Assignment Events (AI + Staff + Override Tracking)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.officer_assignment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system_ai', 'staff')),
  actor_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  prev_officer_id UUID NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  new_officer_id UUID NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  proposed_officer_id UUID NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  mode TEXT NULL CHECK (mode IS NULL OR mode IN ('off', 'shadow', 'active')),
  workload_snapshot JSONB NULL,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  is_ai_override BOOLEAN NOT NULL DEFAULT FALSE,
  reason_code TEXT NULL CHECK (
    reason_code IS NULL OR pg_catalog.char_length(pg_catalog.btrim(reason_code)) BETWEEN 1 AND 64
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT chk_officer_assign_event_actor CHECK (
    (actor_type = 'system_ai' AND actor_id IS NULL)
    OR (actor_type = 'staff' AND is_ai_override IN (TRUE, FALSE))
  )
);

COMMENT ON TABLE public.officer_assignment_events IS
  'Immutable audit log of automated officer routing evaluations/assignments and staff officer assignments/overrides.';

-- Idempotency: at most one system_ai officer routing event per complaint; staff events unrestricted.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_officer_assign_events_system_ai_complaint
  ON public.officer_assignment_events (complaint_id)
  WHERE actor_type = 'system_ai';

CREATE INDEX IF NOT EXISTS idx_officer_assign_events_complaint
  ON public.officer_assignment_events (complaint_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.guard_immutable_officer_assign_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Officer assignment events are strictly immutable.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_officer_assign_events() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_officer_assign_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_officer_assign_events ON public.officer_assignment_events;
CREATE TRIGGER trg_guard_immutable_officer_assign_events
  BEFORE UPDATE OR DELETE ON public.officer_assignment_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_officer_assign_events();

DROP TRIGGER IF EXISTS trg_guard_immutable_officer_assign_events_truncate ON public.officer_assignment_events;
CREATE TRIGGER trg_guard_immutable_officer_assign_events_truncate
  BEFORE TRUNCATE ON public.officer_assignment_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_officer_assign_events();

ALTER TABLE public.officer_assignment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.officer_assignment_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.officer_assignment_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.officer_assignment_events TO authenticated;

DROP POLICY IF EXISTS "Admins can view officer assignment events" ON public.officer_assignment_events;
CREATE POLICY "Admins can view officer assignment events"
  ON public.officer_assignment_events
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 3. Additive Officer Manual Triage Queue
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_officer_triage_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL UNIQUE REFERENCES public.complaints(id) ON DELETE RESTRICT,
  department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'shadow_mode',
      'no_department',
      'no_officer',
      'no_eligible_ward',
      'all_at_capacity',
      'ambiguous',
      'already_assigned',
      'terminal_status',
      'error'
    )
  ),
  mode TEXT NOT NULL CHECK (mode IN ('off', 'shadow', 'active')),
  proposed_officer_id UUID NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  workload_snapshot JSONB NULL,
  resolved_at TIMESTAMPTZ NULL,
  resolved_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE public.complaint_officer_triage_queue IS
  'Additive manual triage queue records with explicit fallback reason codes for complaints not auto-assigned an officer by Phase 9.3.';

CREATE INDEX IF NOT EXISTS idx_officer_triage_queue_open
  ON public.complaint_officer_triage_queue (resolved_at, created_at DESC);

ALTER TABLE public.complaint_officer_triage_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_officer_triage_queue FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_officer_triage_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.complaint_officer_triage_queue TO authenticated;

DROP POLICY IF EXISTS "Admins can view officer triage queue" ON public.complaint_officer_triage_queue;
CREATE POLICY "Admins can view officer triage queue"
  ON public.complaint_officer_triage_queue
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 4. Additive Staff Officer Assignment & Override Trigger on public.complaints
-- Zero RECORD variables. Wrapped in EXCEPTION WHEN OTHERS.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phase9_3_track_staff_officer_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID := NULL;
  v_is_override BOOLEAN := FALSE;
  v_prior_ai_event_found BOOLEAN := FALSE;
  v_prior_ai_event_id UUID := NULL;
BEGIN
  IF pg_catalog.current_setting('reportly.officer_assign_actor', true) = 'system_ai' THEN
    RETURN NEW;
  END IF;

  IF OLD.assigned_officer_id IS NOT DISTINCT FROM NEW.assigned_officer_id THEN
    RETURN NEW;
  END IF;

  v_actor_id := auth.uid();

  BEGIN
    IF OLD.assigned_officer_id IS NOT NULL THEN
      SELECT e.id
      INTO v_prior_ai_event_id
      FROM public.officer_assignment_events e
      WHERE e.complaint_id = NEW.id
        AND e.actor_type = 'system_ai'
        AND e.applied = TRUE
        AND e.new_officer_id = OLD.assigned_officer_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.officer_assignment_events s
          WHERE s.complaint_id = NEW.id
            AND s.actor_type = 'staff'
            AND s.created_at >= e.created_at
        )
      ORDER BY e.created_at DESC
      LIMIT 1;
      v_prior_ai_event_found := FOUND;

      IF v_prior_ai_event_found THEN
        v_is_override := TRUE;
      END IF;
    END IF;

    INSERT INTO public.officer_assignment_events (
      complaint_id,
      actor_type,
      actor_id,
      department_id,
      prev_officer_id,
      new_officer_id,
      applied,
      is_ai_override,
      reason_code,
      created_at
    ) VALUES (
      NEW.id,
      'staff',
      v_actor_id,
      NEW.department_id,
      OLD.assigned_officer_id,
      NEW.assigned_officer_id,
      TRUE,
      v_is_override,
      CASE WHEN v_is_override THEN 'staff_override' ELSE 'staff_manual_assign' END,
      pg_catalog.now()
    );

    IF NEW.assigned_officer_id IS NOT NULL THEN
      UPDATE public.complaint_officer_triage_queue
      SET resolved_at = pg_catalog.now(),
          resolved_by = v_actor_id,
          updated_at = pg_catalog.now()
      WHERE complaint_id = NEW.id
        AND resolved_at IS NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.phase9_3_track_staff_officer_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.phase9_3_track_staff_officer_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_phase9_3_track_staff_officer_change ON public.complaints;
CREATE TRIGGER trg_phase9_3_track_staff_officer_change
  AFTER UPDATE OF assigned_officer_id ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.phase9_3_track_staff_officer_change();

-- -----------------------------------------------------------------------------
-- 5. Core Phase 9.3 Officer Auto-Assignment RPC (service_role only)
-- Zero RECORD variables. Advisory lock per department_id. Outer EXCEPTION handler.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_and_assign_officer_ai(
  p_complaint_id UUID,
  p_mode TEXT DEFAULT 'shadow',
  p_max_open_complaints INT DEFAULT 10,
  p_allow_ward_fallback BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_mode TEXT;
  v_max_open INT;
  v_allow_null_ward BOOLEAN;

  -- Scalar complaint fields (zero RECORD variables)
  v_comp_found BOOLEAN := FALSE;
  v_comp_ward VARCHAR(100) := NULL;
  v_comp_status public.complaint_status := NULL;
  v_comp_department_id UUID := NULL;
  v_comp_officer_id UUID := NULL;

  -- Eligibility counts
  v_dept_active_officers INT := 0;
  v_ward_eligible_officers INT := 0;
  v_under_capacity_officers INT := 0;

  -- Selected officer scalars
  v_selected_found BOOLEAN := FALSE;
  v_selected_officer_id UUID := NULL;
  v_selected_ward VARCHAR(100) := NULL;
  v_selected_open_count INT := 0;
  v_selected_tier INT := NULL;
  v_selected_last_assigned TIMESTAMPTZ := NULL;

  v_reason_code TEXT := NULL;
  v_rows_updated INT := 0;
  v_workload_snapshot JSONB := NULL;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_complaint_id', 'applied', false);
  END IF;

  v_mode := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_mode, 'shadow')));
  IF v_mode NOT IN ('off', 'shadow', 'active') THEN
    v_mode := 'shadow';
  END IF;

  IF v_mode = 'off' THEN
    RETURN jsonb_build_object('mode', 'off', 'skipped', true, 'applied', false);
  END IF;

  v_max_open := GREATEST(1, COALESCE(p_max_open_complaints, 10));
  v_allow_null_ward := COALESCE(p_allow_ward_fallback, TRUE);

  BEGIN
    -- Lock complaint row first
    SELECT ward, status, department_id, assigned_officer_id
    INTO v_comp_ward, v_comp_status, v_comp_department_id, v_comp_officer_id
    FROM public.complaints
    WHERE id = p_complaint_id
    FOR UPDATE;
    v_comp_found := FOUND;

    IF NOT v_comp_found THEN
      RETURN jsonb_build_object('found', false, 'applied', false);
    END IF;

    -- Idempotency check: at most one system_ai officer routing evaluation per complaint
    IF EXISTS (
      SELECT 1 FROM public.officer_assignment_events
      WHERE complaint_id = p_complaint_id AND actor_type = 'system_ai'
    ) THEN
      RETURN jsonb_build_object('mode', v_mode, 'idempotent_hit', true, 'applied', false);
    END IF;

    -- Terminal status check
    IF v_comp_status IN (
      'resolved'::public.complaint_status,
      'rejected'::public.complaint_status,
      'not_confirmed_by_citizen'::public.complaint_status
    ) THEN
      v_workload_snapshot := jsonb_build_object('reason', 'terminal_status', 'status', v_comp_status::text, 'mode', v_mode);
      INSERT INTO public.officer_assignment_events (
        complaint_id, actor_type, department_id, mode, workload_snapshot, applied, reason_code, created_at
      ) VALUES (
        p_complaint_id, 'system_ai', v_comp_department_id, v_mode, v_workload_snapshot, FALSE, 'terminal_status', v_now
      )
      ON CONFLICT (complaint_id) WHERE actor_type = 'system_ai' DO NOTHING;

      RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'terminal_status', 'applied', false);
    END IF;

    -- Never overwrite or re-run on an already officer-assigned complaint
    IF v_comp_officer_id IS NOT NULL THEN
      v_workload_snapshot := jsonb_build_object('reason', 'already_assigned', 'assigned_officer_id', v_comp_officer_id, 'mode', v_mode);
      INSERT INTO public.officer_assignment_events (
        complaint_id, actor_type, department_id, prev_officer_id, new_officer_id, mode, workload_snapshot, applied, reason_code, created_at
      ) VALUES (
        p_complaint_id, 'system_ai', v_comp_department_id, v_comp_officer_id, v_comp_officer_id, v_mode, v_workload_snapshot, FALSE, 'already_assigned', v_now
      )
      ON CONFLICT (complaint_id) WHERE actor_type = 'system_ai' DO NOTHING;

      RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'already_assigned', 'applied', false);
    END IF;

    -- Require a department first (never assign officer to complaint without department)
    IF v_comp_department_id IS NULL THEN
      v_workload_snapshot := jsonb_build_object('reason', 'no_department', 'mode', v_mode);
      INSERT INTO public.complaint_officer_triage_queue (
        complaint_id, department_id, reason_code, mode, workload_snapshot, created_at, updated_at
      ) VALUES (
        p_complaint_id, NULL, 'no_department', v_mode, v_workload_snapshot, v_now, v_now
      )
      ON CONFLICT (complaint_id) DO UPDATE SET
        department_id = NULL,
        reason_code = CASE WHEN public.complaint_officer_triage_queue.resolved_at IS NULL THEN 'no_department' ELSE public.complaint_officer_triage_queue.reason_code END,
        mode = EXCLUDED.mode,
        workload_snapshot = EXCLUDED.workload_snapshot,
        updated_at = v_now;

      RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'no_department', 'applied', false);
    END IF;

    -- Serialize concurrent officer selection within the same department
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('phase9_3_dept_' || v_comp_department_id::text)
    );

    -- Count active officers in department
    SELECT pg_catalog.count(*)::int
    INTO v_dept_active_officers
    FROM public.officers o
    WHERE o.department_id = v_comp_department_id
      AND o.is_active = TRUE;

    IF v_dept_active_officers = 0 THEN
      v_reason_code := 'no_officer';
    ELSE
      -- Count ward-eligible officers (exact ward match OR NULL-ward fallback only if enabled)
      SELECT pg_catalog.count(*)::int
      INTO v_ward_eligible_officers
      FROM public.officers o
      WHERE o.department_id = v_comp_department_id
        AND o.is_active = TRUE
        AND (
          (o.assigned_ward IS NOT NULL AND o.assigned_ward = v_comp_ward)
          OR (v_allow_null_ward AND o.assigned_ward IS NULL)
        );

      IF v_ward_eligible_officers = 0 THEN
        v_reason_code := 'no_eligible_ward';
      END IF;
    END IF;

    -- Select lowest-workload eligible officer (exact ward tier=0 before NULL-ward tier=1)
    IF v_reason_code IS NULL THEN
      WITH officer_pool AS (
        SELECT
          o.id AS officer_id,
          o.assigned_ward,
          o.created_at AS officer_created_at,
          CASE WHEN o.assigned_ward IS NOT NULL AND o.assigned_ward = v_comp_ward THEN 0 ELSE 1 END AS ward_tier,
          (
            SELECT pg_catalog.count(*)::int
            FROM public.complaints oc
            WHERE oc.assigned_officer_id = o.id
              AND oc.status NOT IN (
                'resolved'::public.complaint_status,
                'rejected'::public.complaint_status,
                'not_confirmed_by_citizen'::public.complaint_status
              )
          ) AS open_count,
          (
            SELECT pg_catalog.max(caa.created_at)
            FROM public.complaint_assignment_audit caa
            WHERE caa.new_officer_id = o.id
          ) AS last_assigned_at
        FROM public.officers o
        WHERE o.department_id = v_comp_department_id
          AND o.is_active = TRUE
          AND (
            (o.assigned_ward IS NOT NULL AND o.assigned_ward = v_comp_ward)
            OR (v_allow_null_ward AND o.assigned_ward IS NULL)
          )
      ),
      under_cap AS (
        SELECT *
        FROM officer_pool
        WHERE open_count < v_max_open
      )
      SELECT
        (SELECT pg_catalog.count(*)::int FROM under_cap),
        uc.officer_id,
        uc.assigned_ward,
        uc.open_count,
        uc.ward_tier,
        uc.last_assigned_at
      INTO
        v_under_capacity_officers,
        v_selected_officer_id,
        v_selected_ward,
        v_selected_open_count,
        v_selected_tier,
        v_selected_last_assigned
      FROM under_cap uc
      ORDER BY
        uc.ward_tier ASC,
        uc.open_count ASC,
        uc.last_assigned_at ASC NULLS FIRST,
        uc.officer_created_at ASC,
        uc.officer_id ASC
      LIMIT 1;
      v_selected_found := FOUND;

      IF NOT v_selected_found THEN
        v_selected_officer_id := NULL;
        v_under_capacity_officers := 0;
        v_reason_code := 'all_at_capacity';
      END IF;
    END IF;

    v_workload_snapshot := jsonb_build_object(
      'mode', v_mode,
      'department_id', v_comp_department_id,
      'complaint_ward', v_comp_ward,
      'allow_null_ward_fallback', v_allow_null_ward,
      'max_open_complaints', v_max_open,
      'dept_active_officers', v_dept_active_officers,
      'ward_eligible_officers', v_ward_eligible_officers,
      'under_capacity_officers', v_under_capacity_officers,
      'proposed_officer_id', v_selected_officer_id,
      'proposed_officer_ward', v_selected_ward,
      'proposed_officer_tier', v_selected_tier,
      'proposed_officer_open_count', CASE WHEN v_selected_found THEN v_selected_open_count ELSE NULL END,
      'proposed_officer_last_assigned_at', v_selected_last_assigned,
      'fallback_reason', v_reason_code
    );

    -- Shadow mode: record proposed officer + workload snapshot, never mutate complaints
    IF v_mode = 'shadow' THEN
      v_reason_code := COALESCE(v_reason_code, 'shadow_mode');

      INSERT INTO public.officer_assignment_events (
        complaint_id, actor_type, department_id, proposed_officer_id,
        mode, workload_snapshot, applied, reason_code, created_at
      ) VALUES (
        p_complaint_id, 'system_ai', v_comp_department_id, v_selected_officer_id,
        'shadow', v_workload_snapshot, FALSE, v_reason_code, v_now
      )
      ON CONFLICT (complaint_id) WHERE actor_type = 'system_ai' DO NOTHING;

      INSERT INTO public.complaint_officer_triage_queue (
        complaint_id, department_id, reason_code, mode, proposed_officer_id, workload_snapshot, created_at, updated_at
      ) VALUES (
        p_complaint_id, v_comp_department_id, v_reason_code, 'shadow', v_selected_officer_id, v_workload_snapshot, v_now, v_now
      )
      ON CONFLICT (complaint_id) DO UPDATE SET
        department_id = EXCLUDED.department_id,
        reason_code = CASE WHEN public.complaint_officer_triage_queue.resolved_at IS NULL THEN EXCLUDED.reason_code ELSE public.complaint_officer_triage_queue.reason_code END,
        mode = EXCLUDED.mode,
        proposed_officer_id = EXCLUDED.proposed_officer_id,
        workload_snapshot = EXCLUDED.workload_snapshot,
        updated_at = v_now;

      RETURN jsonb_build_object(
        'mode', 'shadow',
        'applied', false,
        'reason_code', v_reason_code,
        'proposed_officer_id', v_selected_officer_id,
        'workload_snapshot', v_workload_snapshot
      );
    END IF;

    -- Active mode: atomic conditional UPDATE re-verifying officer & complaint state
    IF v_reason_code IS NULL AND v_selected_officer_id IS NOT NULL THEN
      PERFORM pg_catalog.set_config('reportly.officer_assign_actor', 'system_ai', true);

      UPDATE public.complaints c
      SET assigned_officer_id = v_selected_officer_id,
          updated_at = v_now
      WHERE c.id = p_complaint_id
        AND c.department_id = v_comp_department_id
        AND c.assigned_officer_id IS NULL
        AND c.status NOT IN (
          'resolved'::public.complaint_status,
          'rejected'::public.complaint_status,
          'not_confirmed_by_citizen'::public.complaint_status
        )
        AND EXISTS (
          SELECT 1
          FROM public.officers o
          WHERE o.id = v_selected_officer_id
            AND o.is_active = TRUE
            AND o.department_id = c.department_id
        );

      GET DIAGNOSTICS v_rows_updated = ROW_COUNT;

      IF v_rows_updated = 1 THEN
        INSERT INTO public.officer_assignment_events (
          complaint_id, actor_type, department_id, prev_officer_id, new_officer_id,
          proposed_officer_id, mode, workload_snapshot, applied, is_ai_override, reason_code, created_at
        ) VALUES (
          p_complaint_id, 'system_ai', v_comp_department_id, NULL, v_selected_officer_id,
          v_selected_officer_id, 'active', v_workload_snapshot, TRUE, FALSE, 'assigned', v_now
        )
        ON CONFLICT (complaint_id) WHERE actor_type = 'system_ai' DO NOTHING;

        UPDATE public.complaint_officer_triage_queue
        SET resolved_at = v_now,
            updated_at = v_now
        WHERE complaint_id = p_complaint_id
          AND resolved_at IS NULL;

        RETURN jsonb_build_object(
          'mode', 'active',
          'applied', true,
          'assigned_officer_id', v_selected_officer_id,
          'workload_snapshot', v_workload_snapshot
        );
      ELSE
        v_reason_code := 'already_assigned';
      END IF;
    END IF;

    -- Active mode fallback -> manual officer triage queue
    v_reason_code := COALESCE(v_reason_code, 'error');

    INSERT INTO public.officer_assignment_events (
      complaint_id, actor_type, department_id, proposed_officer_id,
      mode, workload_snapshot, applied, reason_code, created_at
    ) VALUES (
      p_complaint_id, 'system_ai', v_comp_department_id, v_selected_officer_id,
      'active', v_workload_snapshot, FALSE, v_reason_code, v_now
    )
    ON CONFLICT (complaint_id) WHERE actor_type = 'system_ai' DO NOTHING;

    INSERT INTO public.complaint_officer_triage_queue (
      complaint_id, department_id, reason_code, mode, proposed_officer_id, workload_snapshot, created_at, updated_at
    ) VALUES (
      p_complaint_id, v_comp_department_id, v_reason_code, 'active', v_selected_officer_id, v_workload_snapshot, v_now, v_now
    )
    ON CONFLICT (complaint_id) DO UPDATE SET
      department_id = EXCLUDED.department_id,
      reason_code = CASE WHEN public.complaint_officer_triage_queue.resolved_at IS NULL THEN EXCLUDED.reason_code ELSE public.complaint_officer_triage_queue.reason_code END,
      mode = EXCLUDED.mode,
      proposed_officer_id = EXCLUDED.proposed_officer_id,
      workload_snapshot = EXCLUDED.workload_snapshot,
      updated_at = v_now;

    RETURN jsonb_build_object(
      'mode', 'active',
      'applied', false,
      'reason_code', v_reason_code,
      'proposed_officer_id', v_selected_officer_id,
      'workload_snapshot', v_workload_snapshot
    );

  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.complaint_officer_triage_queue (
        complaint_id, department_id, reason_code, mode, workload_snapshot, created_at, updated_at
      ) VALUES (
        p_complaint_id,
        v_comp_department_id,
        'error',
        v_mode,
        jsonb_build_object('reason', 'error', 'sqlstate', SQLSTATE, 'mode', v_mode),
        v_now,
        v_now
      )
      ON CONFLICT (complaint_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;

    RETURN jsonb_build_object(
      'mode', v_mode,
      'applied', false,
      'reason_code', 'error',
      'error_sqlstate', SQLSTATE
    );
  END;
END;
$$;

ALTER FUNCTION public.evaluate_and_assign_officer_ai(UUID, TEXT, INT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.evaluate_and_assign_officer_ai(UUID, TEXT, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_and_assign_officer_ai(UUID, TEXT, INT, BOOLEAN) TO service_role;

-- -----------------------------------------------------------------------------
-- 6. Final Privilege & RLS Audit Block
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl TEXT;
  v_relacl aclitem[];
  v_fn RECORD;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY[
    'officer_assignment_events',
    'complaint_officer_triage_queue'
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
    SELECT p.oid, p.proname
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'evaluate_and_assign_officer_ai'
  ) LOOP
    IF pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Function public.%() must allow EXECUTE strictly for service_role.', v_fn.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
