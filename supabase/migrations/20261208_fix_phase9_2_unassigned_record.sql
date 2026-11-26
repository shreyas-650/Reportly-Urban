-- =============================================================================
-- Migration: 20261208_fix_phase9_2_unassigned_record.sql
-- Fix: Eliminate PostgreSQL 55000 ("record is not assigned yet") in
--      public.evaluate_and_assign_department_ai by replacing ALL RECORD
--      variables (v_metric, v_ai, v_comp) with typed scalar variables, fixing
--      FOUND clobbering across INSERT, and wrapping execution in an EXCEPTION
--      handler that writes 'error' to complaint_department_triage_queue.
--
-- Touches ONLY public.evaluate_and_assign_department_ai (same signature,
-- owner, grants, and SET search_path = '').
-- Never schema-qualify LEAST, GREATEST, or COALESCE.
-- =============================================================================

BEGIN;

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

  -- Scalar complaint fields (replaces v_comp RECORD)
  v_comp_ward VARCHAR(100) := NULL;
  v_comp_status public.complaint_status := NULL;
  v_comp_department_id UUID := NULL;

  -- Scalar Phase 9.1 decision fields (replaces v_ai RECORD)
  v_ai_found BOOLEAN := FALSE;
  v_ai_id UUID := NULL;
  v_ai_status TEXT := NULL;
  v_ai_suggested_category VARCHAR(50) := NULL;
  v_ai_confidence DOUBLE PRECISION := NULL;
  v_ai_model_name TEXT := NULL;
  v_ai_prompt_version TEXT := NULL;

  -- Mapping resolution scalars
  v_ward_active_count INT := 0;
  v_global_active_count INT := 0;
  v_mapping_scope TEXT := NULL;
  v_target_dept_id UUID := NULL;
  v_dept_active BOOLEAN := NULL;

  -- Scalar accuracy metric fields (replaces v_metric RECORD)
  v_metric_found BOOLEAN := FALSE;
  v_metric_sample_size INT := 0;
  v_metric_accuracy DOUBLE PRECISION := NULL;
  v_metric_measured_at TIMESTAMPTZ := NULL;

  v_reason_code TEXT := NULL;
  v_all_gates_passed BOOLEAN := FALSE;
  v_rows_updated INT := 0;
  v_gate_snapshot JSONB;
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

  v_min_samples := GREATEST(1, COALESCE(p_min_samples, 50));
  v_min_acc := GREATEST(0.0::double precision, LEAST(1.0::double precision, COALESCE(p_min_accuracy, 0.95::double precision)));
  v_max_age_days := GREATEST(1, COALESCE(p_metrics_max_age_days, 14));
  v_min_conf := GREATEST(0.0::double precision, LEAST(1.0::double precision, COALESCE(p_min_confidence, 0.85::double precision)));

  BEGIN
    -- Lock complaint row (Amendment 7)
    SELECT ward, status, department_id
    INTO v_comp_ward, v_comp_status, v_comp_department_id
    FROM public.complaints
    WHERE id = p_complaint_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('found', false, 'applied', false);
    END IF;

    -- Fetch latest Phase 9.1 decision into scalars
    SELECT id, status, suggested_category, confidence, model_name, prompt_version
    INTO v_ai_id, v_ai_status, v_ai_suggested_category, v_ai_confidence, v_ai_model_name, v_ai_prompt_version
    FROM public.ai_decisions
    WHERE complaint_id = p_complaint_id
      AND feature = 'category_priority_suggestion'
    ORDER BY created_at DESC
    LIMIT 1;
    v_ai_found := FOUND;

    -- Amendment 5: Failed / Absent 9.1 suggestion -> triage queue
    IF NOT v_ai_found OR v_ai_status = 'failed' THEN
      INSERT INTO public.complaint_department_triage_queue (
        complaint_id, ai_decision_id, reason_code, mode, gate_snapshot, created_at, updated_at
      ) VALUES (
        p_complaint_id,
        CASE WHEN v_ai_found THEN v_ai_id ELSE NULL END,
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

      IF v_ai_found AND v_ai_id IS NOT NULL THEN
        INSERT INTO public.department_assignment_events (
          complaint_id, actor_type, ai_decision_id, model_name, prompt_version, mode, gate_snapshot, applied, reason_code, created_at
        ) VALUES (
          p_complaint_id, 'system_ai', v_ai_id, v_ai_model_name, v_ai_prompt_version, v_mode,
          jsonb_build_object('reason', 'no_suggestion'), FALSE, 'no_suggestion', v_now
        )
        ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;
      END IF;

      RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'no_suggestion', 'applied', false);
    END IF;

    IF v_ai_status = 'pending' THEN
      -- Record ai_pending in triage queue WITHOUT consuming the (ai_decision_id) system_ai slot
      INSERT INTO public.complaint_department_triage_queue (
        complaint_id, ai_decision_id, reason_code, mode, gate_snapshot, created_at, updated_at
      ) VALUES (
        p_complaint_id,
        v_ai_id,
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
      WHERE actor_type = 'system_ai' AND ai_decision_id = v_ai_id
    ) THEN
      RETURN jsonb_build_object('mode', v_mode, 'idempotent_hit', true, 'applied', false);
    END IF;

    -- Reject terminal complaint states (Amendment 7)
    IF v_comp_status IN (
      'resolved'::public.complaint_status,
      'rejected'::public.complaint_status,
      'not_confirmed_by_citizen'::public.complaint_status
    ) THEN
      v_gate_snapshot := jsonb_build_object('reason', 'terminal_status', 'status', v_comp_status::text, 'mode', v_mode);
      INSERT INTO public.department_assignment_events (
        complaint_id, actor_type, ai_decision_id, model_name, prompt_version, confidence, mode, gate_snapshot, applied, reason_code, created_at
      ) VALUES (
        p_complaint_id, 'system_ai', v_ai_id, v_ai_model_name, v_ai_prompt_version, v_ai_confidence, v_mode, v_gate_snapshot, FALSE, 'terminal_status', v_now
      )
      ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;
      RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'terminal_status', 'applied', false);
    END IF;

    -- Never re-run on or overwrite an already-assigned complaint
    IF v_comp_department_id IS NOT NULL THEN
      v_gate_snapshot := jsonb_build_object('reason', 'already_assigned', 'department_id', v_comp_department_id, 'mode', v_mode);
      INSERT INTO public.department_assignment_events (
        complaint_id, actor_type, ai_decision_id, prev_department_id, new_department_id, model_name, prompt_version, confidence, mode, gate_snapshot, applied, reason_code, created_at
      ) VALUES (
        p_complaint_id, 'system_ai', v_ai_id, v_comp_department_id, v_comp_department_id, v_ai_model_name, v_ai_prompt_version, v_ai_confidence, v_mode, v_gate_snapshot, FALSE, 'already_assigned', v_now
      )
      ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;
      RETURN jsonb_build_object('mode', v_mode, 'reason_code', 'already_assigned', 'applied', false);
    END IF;

    -- Resolve category -> department mapping (ward-specific first, then citywide)
    SELECT pg_catalog.count(*)::int
    INTO v_ward_active_count
    FROM public.category_department_mappings m
    WHERE m.category = v_ai_suggested_category
      AND m.ward = v_comp_ward
      AND m.is_active = TRUE;

    IF v_ward_active_count > 1 THEN
      v_reason_code := 'ambiguous_mapping';
    ELSIF v_ward_active_count = 1 THEN
      v_mapping_scope := 'ward';
      SELECT m.department_id INTO v_target_dept_id
      FROM public.category_department_mappings m
      WHERE m.category = v_ai_suggested_category
        AND m.ward = v_comp_ward
        AND m.is_active = TRUE
      LIMIT 1;
    ELSE
      SELECT pg_catalog.count(*)::int
      INTO v_global_active_count
      FROM public.category_department_mappings m
      WHERE m.category = v_ai_suggested_category
        AND m.ward IS NULL
        AND m.is_active = TRUE;

      IF v_global_active_count > 1 THEN
        v_reason_code := 'ambiguous_mapping';
      ELSIF v_global_active_count = 1 THEN
        v_mapping_scope := 'citywide';
        SELECT m.department_id INTO v_target_dept_id
        FROM public.category_department_mappings m
        WHERE m.category = v_ai_suggested_category
          AND m.ward IS NULL
          AND m.is_active = TRUE
        LIMIT 1;
      ELSE
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

    -- Evaluate accuracy, sample size, staleness into typed scalars (Amendments 3 & 6)
    IF v_mapping_scope = 'ward' THEN
      SELECT sample_size, accuracy, measured_at
      INTO v_metric_sample_size, v_metric_accuracy, v_metric_measured_at
      FROM public.ai_category_accuracy_metrics
      WHERE category = v_ai_suggested_category
        AND ward = v_comp_ward
        AND model_name = v_ai_model_name
        AND prompt_version = v_ai_prompt_version
      LIMIT 1;
      v_metric_found := FOUND;
    ELSIF v_mapping_scope = 'citywide' THEN
      SELECT sample_size, accuracy, measured_at
      INTO v_metric_sample_size, v_metric_accuracy, v_metric_measured_at
      FROM public.ai_category_accuracy_metrics
      WHERE category = v_ai_suggested_category
        AND ward IS NULL
        AND model_name = v_ai_model_name
        AND prompt_version = v_ai_prompt_version
      LIMIT 1;
      v_metric_found := FOUND;
    END IF;

    IF NOT v_metric_found THEN
      v_metric_sample_size := 0;
      v_metric_accuracy := NULL;
      v_metric_measured_at := NULL;
    END IF;

    IF v_reason_code IS NULL THEN
      IF NOT v_metric_found OR v_metric_sample_size < v_min_samples THEN
        v_reason_code := 'insufficient_samples';
      ELSIF v_metric_measured_at < (v_now - pg_catalog.make_interval(days => v_max_age_days)) THEN
        v_reason_code := 'stale_metrics';
      ELSIF v_metric_accuracy < v_min_acc THEN
        v_reason_code := 'low_accuracy';
      ELSIF v_ai_confidence IS NULL OR v_ai_confidence < v_min_conf THEN
        v_reason_code := 'low_confidence';
      ELSE
        v_all_gates_passed := TRUE;
      END IF;
    END IF;

    v_gate_snapshot := jsonb_build_object(
      'mode', v_mode,
      'category', v_ai_suggested_category,
      'ward', v_comp_ward,
      'mapping_scope', v_mapping_scope,
      'suggested_department_id', v_target_dept_id,
      'model_name', v_ai_model_name,
      'prompt_version', v_ai_prompt_version,
      'confidence', v_ai_confidence,
      'min_confidence', v_min_conf,
      'sample_size', v_metric_sample_size,
      'min_samples', v_min_samples,
      'accuracy', v_metric_accuracy,
      'min_accuracy', v_min_acc,
      'measured_at', v_metric_measured_at,
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
        p_complaint_id, 'system_ai', v_ai_id, v_target_dept_id,
        v_ai_model_name, v_ai_prompt_version, v_ai_confidence, 'shadow', v_gate_snapshot, FALSE, v_reason_code, v_now
      )
      ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;

      INSERT INTO public.complaint_department_triage_queue (
        complaint_id, ai_decision_id, reason_code, mode, suggested_department_id, gate_snapshot, created_at, updated_at
      ) VALUES (
        p_complaint_id, v_ai_id, v_reason_code, 'shadow', v_target_dept_id, v_gate_snapshot, v_now, v_now
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
        INSERT INTO public.department_assignment_events (
          complaint_id, actor_type, ai_decision_id, prev_department_id, new_department_id,
          suggested_department_id, model_name, prompt_version, confidence, mode, gate_snapshot,
          applied, is_ai_override, reason_code, created_at
        ) VALUES (
          p_complaint_id, 'system_ai', v_ai_id, NULL, v_target_dept_id,
          v_target_dept_id, v_ai_model_name, v_ai_prompt_version, v_ai_confidence, 'active', v_gate_snapshot,
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
      p_complaint_id, 'system_ai', v_ai_id, v_target_dept_id,
      v_ai_model_name, v_ai_prompt_version, v_ai_confidence, 'active', v_gate_snapshot, FALSE, v_reason_code, v_now
    )
    ON CONFLICT (ai_decision_id) WHERE actor_type = 'system_ai' AND ai_decision_id IS NOT NULL DO NOTHING;

    INSERT INTO public.complaint_department_triage_queue (
      complaint_id, ai_decision_id, reason_code, mode, suggested_department_id, gate_snapshot, created_at, updated_at
    ) VALUES (
      p_complaint_id, v_ai_id, v_reason_code, 'active', v_target_dept_id, v_gate_snapshot, v_now, v_now
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

  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.complaint_department_triage_queue (
        complaint_id, ai_decision_id, reason_code, mode, gate_snapshot, created_at, updated_at
      ) VALUES (
        p_complaint_id,
        v_ai_id,
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
      'all_gates_passed', false,
      'reason_code', 'error',
      'error_sqlstate', SQLSTATE
    );
  END;
END;
$$;

ALTER FUNCTION public.evaluate_and_assign_department_ai(UUID, TEXT, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.evaluate_and_assign_department_ai(UUID, TEXT, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_and_assign_department_ai(UUID, TEXT, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION) TO service_role;

COMMIT;
