-- =============================================================================
-- UNDO: 20261208_fix_phase9_2_unassigned_record_UNDO.sql
-- Restores public.evaluate_and_assign_department_ai to its 20261207 definition.
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

  SELECT id, category, ward, status, department_id, assigned_officer_id, updated_at
  INTO v_comp
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'applied', false);
  END IF;

  SELECT id, status, suggested_category, confidence, model_name, prompt_version, created_at, completed_at
  INTO v_ai
  FROM public.ai_decisions
  WHERE complaint_id = p_complaint_id
    AND feature = 'category_priority_suggestion'
  ORDER BY created_at DESC
  LIMIT 1;

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

  IF EXISTS (
    SELECT 1 FROM public.department_assignment_events
    WHERE actor_type = 'system_ai' AND ai_decision_id = v_ai.id
  ) THEN
    RETURN jsonb_build_object('mode', v_mode, 'idempotent_hit', true, 'applied', false);
  END IF;

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

  IF v_reason_code IS NULL AND v_target_dept_id IS NOT NULL THEN
    SELECT is_active INTO v_dept_active
    FROM public.departments
    WHERE id = v_target_dept_id;

    IF NOT FOUND OR v_dept_active IS DISTINCT FROM TRUE THEN
      v_reason_code := 'inactive_department';
    END IF;
  END IF;

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

COMMIT;
