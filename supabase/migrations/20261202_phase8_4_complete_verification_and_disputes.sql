-- =============================================================================
-- Migration 2 (Run AFTER 20261201): 20261202_phase8_4_complete_verification_and_disputes.sql
-- Module: Phase 8.3/8.4 Completion — Dispute Reopen/SLA/Escalation/Notify,
--         Configurable Reopen Limit + Admin Escalation Queue,
--         Non-Response Auto-Close ('not_confirmed_by_citizen'),
--         Unified Verification History, and Admin Disputed Complaints List
-- Target: Supabase PostgreSQL
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks
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
    SELECT 'table public.complaint_resolution_evidence' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_evidence'
    )
    UNION ALL
    SELECT 'table public.complaint_resolution_verifications' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_verifications'
    )
    UNION ALL
    SELECT 'table public.complaint_resolution_ai_checks' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_resolution_ai_checks'
    )
    UNION ALL
    SELECT 'table public.complaint_sla_state' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_sla_state'
    )
    UNION ALL
    SELECT 'table public.complaint_escalations' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_escalations'
    )
    UNION ALL
    SELECT 'table public.category_sla_rules' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'category_sla_rules'
    )
    UNION ALL
    SELECT 'table public.notifications' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'notifications'
    )
    UNION ALL
    SELECT 'enum complaint_status.not_confirmed_by_citizen' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public'
        AND t.typname = 'complaint_status'
        AND e.enumlabel = 'not_confirmed_by_citizen'
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
    UNION ALL
    SELECT 'function public.get_active_department_head(uuid)' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_active_department_head'
    )
  ) req;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Missing required database object(s): %.', v_missing;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Update Security-Barrier View public_complaint_history for New Status
-- -----------------------------------------------------------------------------
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
      WHEN 'not_confirmed_by_citizen'::public.complaint_status THEN 'Closed (Not Confirmed by Citizen)'
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
-- 3. Dispute State Tracking & Unified Verification History Tables
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_dispute_cases (
  complaint_id UUID PRIMARY KEY REFERENCES public.complaints(id) ON DELETE RESTRICT,
  dispute_state TEXT NOT NULL CHECK (
    dispute_state IN ('open_dispute', 'reopened', 'escalated_to_admin', 'admin_resolved', 'closed_unconfirmed')
  ),
  reopen_count INT NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  latest_verification_id UUID NULL REFERENCES public.complaint_resolution_verifications(id) ON DELETE RESTRICT,
  latest_evidence_id UUID NULL REFERENCES public.complaint_resolution_evidence(id) ON DELETE RESTRICT,
  latest_reason TEXT NULL CHECK (latest_reason IS NULL OR pg_catalog.char_length(latest_reason) <= 1000),
  admin_resolution_note TEXT NULL CHECK (admin_resolution_note IS NULL OR pg_catalog.char_length(admin_resolution_note) <= 1000),
  admin_decided_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  admin_decided_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_dispute_cases_state_updated
  ON public.complaint_dispute_cases (dispute_state, updated_at DESC);

ALTER TABLE public.complaint_dispute_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_dispute_cases FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_dispute_cases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_dispute_cases TO authenticated;

DROP POLICY IF EXISTS "Admins can read dispute cases" ON public.complaint_dispute_cases;
CREATE POLICY "Admins can read dispute cases"
  ON public.complaint_dispute_cases
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

CREATE TABLE IF NOT EXISTS public.complaint_verification_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  evidence_id UUID NULL REFERENCES public.complaint_resolution_evidence(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('ai_suggestion', 'citizen_verified', 'citizen_disputed', 'auto_closed_unconfirmed', 'admin_decision')
  ),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('ai', 'citizen', 'system', 'admin')),
  actor_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  result TEXT NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(result)) BETWEEN 1 AND 128),
  details TEXT NULL CHECK (details IS NULL OR pg_catalog.char_length(details) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_verif_history_complaint_created
  ON public.complaint_verification_history (complaint_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.guard_verification_history_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Unified verification history records are strictly append-only.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_verification_history_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_verification_history_immutable() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_verification_history_immutable ON public.complaint_verification_history;
CREATE TRIGGER trg_guard_verification_history_immutable
  BEFORE UPDATE OR DELETE ON public.complaint_verification_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_verification_history_immutable();

DROP TRIGGER IF EXISTS trg_guard_verification_history_truncate ON public.complaint_verification_history;
CREATE TRIGGER trg_guard_verification_history_truncate
  BEFORE TRUNCATE ON public.complaint_verification_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_verification_history_immutable();

ALTER TABLE public.complaint_verification_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_verification_history FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_verification_history FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_verification_history TO authenticated;

-- Admin sees all events (including ai_suggestion); citizen & assigned officer never see ai_suggestion
DROP POLICY IF EXISTS "Admins read full verification history" ON public.complaint_verification_history;
CREATE POLICY "Admins read full verification history"
  ON public.complaint_verification_history
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

DROP POLICY IF EXISTS "Reporters and officers read non-AI verification history" ON public.complaint_verification_history;
CREATE POLICY "Reporters and officers read non-AI verification history"
  ON public.complaint_verification_history
  FOR SELECT
  TO authenticated
  USING (
    event_type <> 'ai_suggestion'
    AND EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_verification_history.complaint_id
        AND (
          c.citizen_id = (SELECT auth.uid())
          OR c.assigned_officer_id = (SELECT public.get_current_officer_id())
        )
    )
  );

-- -----------------------------------------------------------------------------
-- 4. Log AI Suggestions Automatically into Unified Verification History
-- -----------------------------------------------------------------------------
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
  v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
  IF p_check_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_check_id is required.'
      USING ERRCODE = '22023';
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Invalid Parameter: final status must be completed or failed.'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, complaint_id, evidence_id, status
  INTO v_row
  FROM public.complaint_resolution_ai_checks
  WHERE id = p_check_id
  FOR UPDATE;

  IF NOT FOUND OR v_row.status <> 'pending' THEN
    RETURN FALSE;
  END IF;

  IF p_status = 'completed' THEN
    IF p_verdict IS NULL OR p_verdict NOT IN ('appears_fixed', 'appears_not_fixed', 'unclear') THEN
      RAISE EXCEPTION 'Invalid Parameter: completed check requires valid verdict.'
        USING ERRCODE = '22023';
    END IF;
    IF p_confidence IS NULL OR p_confidence < 0.0 OR p_confidence > 1.0
       OR p_confidence = 'NaN'::double precision
       OR p_confidence = 'Infinity'::double precision
       OR p_confidence = '-Infinity'::double precision THEN
      RAISE EXCEPTION 'Invalid Parameter: completed check requires finite confidence between 0 and 1.'
        USING ERRCODE = '22023';
    END IF;
    v_summary_clean := NULLIF(pg_catalog.btrim(COALESCE(p_summary, '')), '');
    IF v_summary_clean IS NOT NULL AND pg_catalog.char_length(v_summary_clean) > 300 THEN
      RAISE EXCEPTION 'Invalid Parameter: summary cannot exceed 300 characters.'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.complaint_resolution_ai_checks
    SET status = 'completed',
        verdict = p_verdict,
        confidence = p_confidence,
        summary = v_summary_clean,
        failure_category = NULL,
        completed_at = v_now
    WHERE id = p_check_id
      AND status = 'pending';

    INSERT INTO public.complaint_verification_history (
      complaint_id, evidence_id, event_type, actor_type, actor_id, result, details, created_at
    ) VALUES (
      v_row.complaint_id,
      v_row.evidence_id,
      'ai_suggestion',
      'ai',
      NULL,
      p_verdict || ' (' || pg_catalog.round((p_confidence * 100)::numeric, 0)::text || '%)',
      v_summary_clean,
      v_now
    );
  ELSE
    v_failure_clean := pg_catalog.btrim(COALESCE(p_failure_category, ''));
    IF pg_catalog.char_length(v_failure_clean) < 1 OR pg_catalog.char_length(v_failure_clean) > 64 THEN
      RAISE EXCEPTION 'Invalid Parameter: failed check requires failure_category (1..64 chars).'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.complaint_resolution_ai_checks
    SET status = 'failed',
        verdict = NULL,
        confidence = NULL,
        summary = NULL,
        failure_category = v_failure_clean,
        completed_at = v_now
    WHERE id = p_check_id
      AND status = 'pending';

    INSERT INTO public.complaint_verification_history (
      complaint_id, evidence_id, event_type, actor_type, actor_id, result, details, created_at
    ) VALUES (
      v_row.complaint_id,
      v_row.evidence_id,
      'ai_suggestion',
      'ai',
      NULL,
      'failed:' || v_failure_clean,
      NULL,
      v_now
    );
  END IF;

  RETURN TRUE;
END;
$$;

ALTER FUNCTION public.complete_ai_resolution_check(UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_ai_resolution_check(UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_ai_resolution_check(UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. Complete submit_resolution_verification (Reopen Limit, SLA Restart,
--    Escalation, Officer Notification, Admin Queue, Unified History)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_resolution_verification(UUID, UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.submit_resolution_verification(
  p_complaint_id UUID,
  p_evidence_id UUID,
  p_decision TEXT,
  p_reason TEXT DEFAULT NULL,
  p_max_reopens INT DEFAULT 2
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
  v_max_reopens INT;
  v_complaint RECORD;
  v_latest_ev_id UUID;
  v_verif_id UUID;
  v_created_at TIMESTAMPTZ;
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_reopen_count INT := 0;
  v_reopen_status public.complaint_status;
  v_final_status TEXT;
  v_sla_hours INT := 48;
  v_new_sla_deadline TIMESTAMPTZ := NULL;
  v_curr_level INT := 0;
  v_next_level INT := 1;
  v_esc_id UUID;
  v_off_profile UUID;
  v_head RECORD;
  v_admin RECORD;
  v_action TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required: Anonymous callers cannot verify complaint resolutions.'
      USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = v_caller_id;
  IF v_role IS DISTINCT FROM 'citizen'::public.user_role THEN
    RAISE EXCEPTION 'Unauthorized: Only citizen accounts may submit resolution verification decisions.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL OR p_evidence_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id and evidence_id are required.'
      USING ERRCODE = '22023';
  END IF;

  v_max_reopens := COALESCE(p_max_reopens, 2);
  IF v_max_reopens < 0 OR v_max_reopens > 20 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_max_reopens must be between 0 and 20.'
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

  SELECT id, complaint_number, citizen_id, category, status, department_id, assigned_officer_id, sla_deadline
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
    complaint_id, evidence_id, citizen_id, decision, reason, created_at
  ) VALUES (
    p_complaint_id, p_evidence_id, v_caller_id, v_decision, v_clean_reason, v_now
  )
  RETURNING id, created_at INTO v_verif_id, v_created_at;

  v_final_status := 'resolved';

  IF v_decision = 'verified' THEN
    v_action := 'verified';

    INSERT INTO public.complaint_verification_history (
      complaint_id, evidence_id, event_type, actor_type, actor_id, result, details, created_at
    ) VALUES (
      p_complaint_id, p_evidence_id, 'citizen_verified', 'citizen', v_caller_id, 'verified', v_clean_reason, v_now
    );

    UPDATE public.complaint_dispute_cases
    SET dispute_state = 'admin_resolved',
        latest_verification_id = v_verif_id,
        latest_evidence_id = p_evidence_id,
        updated_at = v_now
    WHERE complaint_id = p_complaint_id
      AND dispute_state <> 'admin_resolved';

    RETURN pg_catalog.jsonb_build_object(
      'verification_id', v_verif_id,
      'complaint_id', p_complaint_id,
      'evidence_id', p_evidence_id,
      'decision', v_decision,
      'reason', v_clean_reason,
      'complaint_status', v_final_status,
      'action', v_action,
      'reopened', FALSE,
      'escalated_to_admin', FALSE,
      'reopen_count', COALESCE((SELECT reopen_count FROM public.complaint_dispute_cases WHERE complaint_id = p_complaint_id), 0),
      'max_reopens', v_max_reopens,
      'sla_deadline', v_complaint.sla_deadline,
      'created_at', v_created_at
    );
  END IF;

  -- Dispute branch: check current reopen_count under row lock
  SELECT reopen_count
  INTO v_reopen_count
  FROM public.complaint_dispute_cases
  WHERE complaint_id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_reopen_count := 0;
  END IF;

  IF v_reopen_count >= v_max_reopens THEN
    -- Limit reached: do NOT reopen automatically; route to admin queue & notify admins
    v_action := 'escalated_to_admin';

    INSERT INTO public.complaint_dispute_cases (
      complaint_id, dispute_state, reopen_count, latest_verification_id, latest_evidence_id, latest_reason, created_at, updated_at
    ) VALUES (
      p_complaint_id, 'escalated_to_admin', v_reopen_count, v_verif_id, p_evidence_id, v_clean_reason, v_now, v_now
    )
    ON CONFLICT (complaint_id) DO UPDATE
      SET dispute_state = 'escalated_to_admin',
          latest_verification_id = EXCLUDED.latest_verification_id,
          latest_evidence_id = EXCLUDED.latest_evidence_id,
          latest_reason = EXCLUDED.latest_reason,
          updated_at = v_now;

    INSERT INTO public.complaint_status_history (
      complaint_id, status, previous_status, title, public_description, internal_note, actor_id, created_at
    ) VALUES (
      p_complaint_id,
      v_complaint.status,
      v_complaint.status,
      'Dispute Escalated for Admin Review',
      v_clean_reason,
      NULL,
      v_caller_id,
      v_now
    );

    INSERT INTO public.complaint_verification_history (
      complaint_id, evidence_id, event_type, actor_type, actor_id, result, details, created_at
    ) VALUES (
      p_complaint_id, p_evidence_id, 'citizen_disputed', 'citizen', v_caller_id, 'escalated_to_admin', v_clean_reason, v_now
    );

    FOR v_admin IN SELECT id FROM public.profiles WHERE role = 'admin'::public.user_role LOOP
      INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
      VALUES (
        v_admin.id,
        p_complaint_id,
        'escalation',
        'Repeated Citizen Dispute Requires Admin Review',
        'Complaint ' || v_complaint.complaint_number || ' reached the maximum automatic reopen limit and requires admin review.',
        'dispute_admin_queue:' || v_verif_id::text
      )
      ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
      'verification_id', v_verif_id,
      'complaint_id', p_complaint_id,
      'evidence_id', p_evidence_id,
      'decision', v_decision,
      'reason', v_clean_reason,
      'complaint_status', v_complaint.status::text,
      'action', v_action,
      'reopened', FALSE,
      'escalated_to_admin', TRUE,
      'reopen_count', v_reopen_count,
      'max_reopens', v_max_reopens,
      'sla_deadline', v_complaint.sla_deadline,
      'created_at', v_created_at
    );
  END IF;

  -- Within reopen limit: reopen complaint, restart SLA clock, escalate, and notify officer
  v_action := 'reopened';
  IF v_complaint.department_id IS NOT NULL AND v_complaint.assigned_officer_id IS NOT NULL THEN
    v_reopen_status := 'in_progress'::public.complaint_status;
  ELSE
    v_reopen_status := 'under_review'::public.complaint_status;
  END IF;

  SELECT sla_hours INTO v_sla_hours
  FROM public.category_sla_rules
  WHERE category = v_complaint.category;

  IF v_sla_hours IS NULL AND v_complaint.department_id IS NOT NULL THEN
    SELECT default_sla_hours INTO v_sla_hours
    FROM public.departments
    WHERE id = v_complaint.department_id;
  END IF;
  v_sla_hours := COALESCE(v_sla_hours, 48);
  v_new_sla_deadline := v_now + pg_catalog.make_interval(hours => v_sla_hours);

  UPDATE public.complaints
  SET status = v_reopen_status,
      sla_deadline = v_new_sla_deadline,
      updated_at = v_now
  WHERE id = p_complaint_id;

  INSERT INTO public.complaint_sla_state (complaint_id)
  VALUES (p_complaint_id)
  ON CONFLICT (complaint_id) DO NOTHING;

  SELECT current_level INTO v_curr_level
  FROM public.complaint_sla_state
  WHERE complaint_id = p_complaint_id
  FOR UPDATE;
  v_curr_level := COALESCE(v_curr_level, 0);
  v_next_level := LEAST(3, v_curr_level + 1);

  -- Reset overdue flag for restarted SLA clock
  UPDATE public.complaint_sla_state
  SET overdue_marked_at = NULL,
      updated_at = v_now
  WHERE complaint_id = p_complaint_id;

  -- Resolve assigned officer profile for Phase 7 escalation + notification
  v_off_profile := NULL;
  IF v_complaint.assigned_officer_id IS NOT NULL THEN
    SELECT o.profile_id INTO v_off_profile
    FROM public.officers o
    WHERE o.id = v_complaint.assigned_officer_id AND o.is_active = TRUE;
  END IF;

  IF v_next_level > v_curr_level THEN
    v_esc_id := NULL;
    IF v_next_level = 1 AND v_off_profile IS NOT NULL THEN
      INSERT INTO public.complaint_escalations (
        complaint_id, from_level, to_level, status, reason, triggered_by,
        triggered_by_profile_id, recipient_profile_id, recipient_officer_id, created_at
      ) VALUES (
        p_complaint_id, v_curr_level, 1, 'completed', 'citizen_dispute_reopened', 'system',
        NULL, v_off_profile, v_complaint.assigned_officer_id, v_now
      )
      ON CONFLICT (complaint_id, to_level) WHERE status = 'completed' DO NOTHING
      RETURNING id INTO v_esc_id;
    ELSIF v_next_level = 2 AND v_complaint.department_id IS NOT NULL THEN
      SELECT head_profile_id, head_officer_id INTO v_head
      FROM public.get_active_department_head(v_complaint.department_id);
      IF v_head.head_profile_id IS NOT NULL THEN
        INSERT INTO public.complaint_escalations (
          complaint_id, from_level, to_level, status, reason, triggered_by,
          triggered_by_profile_id, recipient_profile_id, recipient_officer_id, created_at
        ) VALUES (
          p_complaint_id, v_curr_level, 2, 'completed', 'citizen_dispute_reopened', 'system',
          NULL, v_head.head_profile_id, v_head.head_officer_id, v_now
        )
        ON CONFLICT (complaint_id, to_level) WHERE status = 'completed' DO NOTHING
        RETURNING id INTO v_esc_id;
      END IF;
    ELSIF v_next_level = 3 THEN
      SELECT id INTO v_head FROM public.profiles WHERE role = 'admin'::public.user_role LIMIT 1;
      IF v_head.id IS NOT NULL THEN
        INSERT INTO public.complaint_escalations (
          complaint_id, from_level, to_level, status, reason, triggered_by,
          triggered_by_profile_id, recipient_profile_id, recipient_officer_id, created_at
        ) VALUES (
          p_complaint_id, v_curr_level, 3, 'completed', 'citizen_dispute_reopened', 'system',
          NULL, v_head.id, NULL, v_now
        )
        ON CONFLICT (complaint_id, to_level) WHERE status = 'completed' DO NOTHING
        RETURNING id INTO v_esc_id;
      END IF;
    END IF;

    IF v_esc_id IS NOT NULL THEN
      UPDATE public.complaint_sla_state
      SET current_level = v_next_level,
          last_escalated_at = v_now,
          updated_at = v_now
      WHERE complaint_id = p_complaint_id;
    END IF;
  END IF;

  -- Notify assigned officer (Phase 7 notifications table)
  IF v_off_profile IS NOT NULL THEN
    INSERT INTO public.notifications (
      recipient_profile_id, complaint_id, kind, title, message, event_key
    ) VALUES (
      v_off_profile,
      p_complaint_id,
      'escalation',
      'Resolution Disputed — Complaint Reopened',
      'Complaint ' || v_complaint.complaint_number || ' was disputed by the citizen and reopened with a restarted SLA deadline.',
      'dispute_reopen:' || v_verif_id::text
    )
    ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
  END IF;

  INSERT INTO public.complaint_status_history (
    complaint_id, status, previous_status, title, public_description, internal_note, actor_id, created_at
  ) VALUES (
    p_complaint_id, v_reopen_status, 'resolved'::public.complaint_status,
    'Resolution Disputed — Reopened', v_clean_reason, NULL, v_caller_id, v_now
  );

  INSERT INTO public.complaint_dispute_cases (
    complaint_id, dispute_state, reopen_count, latest_verification_id, latest_evidence_id, latest_reason, created_at, updated_at
  ) VALUES (
    p_complaint_id, 'reopened', v_reopen_count + 1, v_verif_id, p_evidence_id, v_clean_reason, v_now, v_now
  )
  ON CONFLICT (complaint_id) DO UPDATE
    SET dispute_state = 'reopened',
        reopen_count = v_reopen_count + 1,
        latest_verification_id = EXCLUDED.latest_verification_id,
        latest_evidence_id = EXCLUDED.latest_evidence_id,
        latest_reason = EXCLUDED.latest_reason,
        updated_at = v_now;

  INSERT INTO public.complaint_verification_history (
    complaint_id, evidence_id, event_type, actor_type, actor_id, result, details, created_at
  ) VALUES (
    p_complaint_id, p_evidence_id, 'citizen_disputed', 'citizen', v_caller_id, 'reopened', v_clean_reason, v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'verification_id', v_verif_id,
    'complaint_id', p_complaint_id,
    'evidence_id', p_evidence_id,
    'decision', v_decision,
    'reason', v_clean_reason,
    'complaint_status', v_reopen_status::text,
    'action', v_action,
    'reopened', TRUE,
    'escalated_to_admin', FALSE,
    'reopen_count', v_reopen_count + 1,
    'max_reopens', v_max_reopens,
    'sla_deadline', v_new_sla_deadline,
    'created_at', v_created_at
  );
END;
$$;

ALTER FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.submit_resolution_verification(UUID, UUID, TEXT, TEXT, INT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Non-Response Auto-Close RPC (service_role only, supports dry-run)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_unconfirmed_resolved_complaints(
  p_timeout_days INT DEFAULT 7,
  p_batch_limit INT DEFAULT 100,
  p_dry_run BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_days INT;
  v_limit INT;
  v_cutoff TIMESTAMPTZ;
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_cand RECORD;
  v_comp RECORD;
  v_eligible_ids UUID[] := ARRAY[]::UUID[];
  v_closed_ids UUID[] := ARRAY[]::UUID[];
BEGIN
  v_days := COALESCE(p_timeout_days, 7);
  IF v_days < 1 OR v_days > 365 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_timeout_days must be between 1 and 365.'
      USING ERRCODE = '22023';
  END IF;

  v_limit := COALESCE(p_batch_limit, 100);
  IF v_limit < 1 OR v_limit > 250 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_batch_limit must be between 1 and 250.'
      USING ERRCODE = '22023';
  END IF;

  v_cutoff := v_now - pg_catalog.make_interval(days => v_days);

  FOR v_cand IN
    SELECT
      c.id AS complaint_id,
      ev.id AS evidence_id,
      COALESCE(ev.created_at, c.updated_at) AS resolved_ts
    FROM public.complaints c
    LEFT JOIN LATERAL (
      SELECT e.id, e.created_at
      FROM public.complaint_resolution_evidence e
      WHERE e.complaint_id = c.id
        AND e.upload_status = 'completed'
        AND e.exif_stripped IS TRUE
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1
    ) ev ON TRUE
    WHERE c.status = 'resolved'::public.complaint_status
      AND COALESCE(ev.created_at, c.updated_at) <= v_cutoff
      AND NOT EXISTS (
        SELECT 1 FROM public.complaint_resolution_verifications v
        WHERE v.complaint_id = c.id
          AND (ev.id IS NULL OR v.evidence_id = ev.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.complaint_dispute_cases dc
        WHERE dc.complaint_id = c.id
          AND dc.dispute_state IN ('open_dispute', 'escalated_to_admin')
      )
    ORDER BY COALESCE(ev.created_at, c.updated_at) ASC, c.id ASC
    LIMIT v_limit
  LOOP
    v_eligible_ids := pg_catalog.array_append(v_eligible_ids, v_cand.complaint_id);

    IF COALESCE(p_dry_run, FALSE) THEN
      CONTINUE;
    END IF;

    SELECT id, status INTO v_comp
    FROM public.complaints
    WHERE id = v_cand.complaint_id
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND OR v_comp.status IS DISTINCT FROM 'resolved'::public.complaint_status THEN
      CONTINUE;
    END IF;

    UPDATE public.complaints
    SET status = 'not_confirmed_by_citizen'::public.complaint_status,
        updated_at = v_now
    WHERE id = v_cand.complaint_id;

    INSERT INTO public.complaint_status_history (
      complaint_id, status, previous_status, title, public_description, internal_note, actor_id, created_at
    ) VALUES (
      v_cand.complaint_id,
      'not_confirmed_by_citizen'::public.complaint_status,
      'resolved'::public.complaint_status,
      'Closed — Not Confirmed by Citizen',
      'Closed automatically because the reporting citizen did not confirm or dispute within the verification window.',
      NULL,
      NULL,
      v_now
    );

    INSERT INTO public.complaint_verification_history (
      complaint_id, evidence_id, event_type, actor_type, actor_id, result, details, created_at
    ) VALUES (
      v_cand.complaint_id,
      v_cand.evidence_id,
      'auto_closed_unconfirmed',
      'system',
      NULL,
      'not_confirmed_by_citizen',
      'No citizen response within ' || v_days::text || ' day(s).',
      v_now
    );

    UPDATE public.complaint_dispute_cases
    SET dispute_state = 'closed_unconfirmed',
        updated_at = v_now
    WHERE complaint_id = v_cand.complaint_id;

    v_closed_ids := pg_catalog.array_append(v_closed_ids, v_cand.complaint_id);
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'dry_run', COALESCE(p_dry_run, FALSE),
    'timeout_days', v_days,
    'eligible_count', pg_catalog.coalesce(pg_catalog.array_length(v_eligible_ids, 1), 0),
    'closed_count', pg_catalog.coalesce(pg_catalog.array_length(v_closed_ids, 1), 0),
    'complaint_ids', CASE WHEN COALESCE(p_dry_run, FALSE) THEN v_eligible_ids ELSE v_closed_ids END
  );
END;
$$;

ALTER FUNCTION public.close_unconfirmed_resolved_complaints(INT, INT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.close_unconfirmed_resolved_complaints(INT, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_unconfirmed_resolved_complaints(INT, INT, BOOLEAN) TO service_role;

-- -----------------------------------------------------------------------------
-- 7. Phase 8.4 Admin RPCs: Disputed List, Full Unified History, Admin Decision
-- -----------------------------------------------------------------------------
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
  v_dispute_case RECORD;
  v_history JSONB;
  v_events JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint_id is required.'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, status INTO v_comp FROM public.complaints WHERE id = p_complaint_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_latest_ev_id
  FROM public.complaint_resolution_evidence
  WHERE complaint_id = p_complaint_id
    AND upload_status = 'completed'
    AND exif_stripped IS TRUE
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  SELECT v.decision INTO v_latest_decision
  FROM public.complaint_resolution_verifications v
  WHERE v.complaint_id = p_complaint_id
  ORDER BY v.created_at DESC, v.id DESC
  LIMIT 1;

  SELECT dispute_state, reopen_count, latest_reason, admin_resolution_note, admin_decided_at
  INTO v_dispute_case
  FROM public.complaint_dispute_cases
  WHERE complaint_id = p_complaint_id;

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

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', ev_row.id,
        'evidence_id', ev_row.evidence_id,
        'event_type', ev_row.event_type,
        'actor_type', ev_row.actor_type,
        'actor_display_name', ev_row.actor_display_name,
        'result', ev_row.result,
        'details', ev_row.details,
        'created_at', ev_row.created_at
      )
      ORDER BY ev_row.created_at DESC, ev_row.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_events
  FROM (
    SELECT
      h.id,
      h.evidence_id,
      h.event_type,
      h.actor_type,
      CASE h.actor_type
        WHEN 'ai' THEN 'Gemini Vision (Advisory)'
        WHEN 'system' THEN 'Automated System'
        ELSE COALESCE(NULLIF(pg_catalog.btrim(p.full_name), ''), pg_catalog.initcap(h.actor_type))
      END AS actor_display_name,
      h.result,
      h.details,
      h.created_at
    FROM public.complaint_verification_history h
    LEFT JOIN public.profiles p ON p.id = h.actor_id
    WHERE h.complaint_id = p_complaint_id
    ORDER BY h.created_at DESC, h.id DESC
  ) ev_row;

  RETURN pg_catalog.jsonb_build_object(
    'complaint_id', v_comp.id,
    'complaint_status', v_comp.status::text,
    'latest_evidence_id', v_latest_ev_id,
    'latest_decision', v_latest_decision,
    'dispute_state', v_dispute_case.dispute_state,
    'reopen_count', COALESCE(v_dispute_case.reopen_count, 0),
    'admin_resolution_note', v_dispute_case.admin_resolution_note,
    'admin_decided_at', v_dispute_case.admin_decided_at,
    'history', v_history,
    'events', v_events
  );
END;
$$;

ALTER FUNCTION public.get_admin_complaint_verifications(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_complaint_verifications(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_complaint_verifications(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_admin_disputed_complaints(
  p_filter TEXT DEFAULT NULL,
  p_page INT DEFAULT 1,
  p_page_size INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_filter TEXT;
  v_page INT;
  v_size INT;
  v_offset INT;
  v_total INT;
  v_items JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  v_filter := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_filter, ''))), '');
  IF v_filter IS NOT NULL AND v_filter NOT IN ('open_dispute', 'reopened', 'escalated_to_admin', 'admin_resolved', 'closed_unconfirmed') THEN
    RAISE EXCEPTION 'Invalid Parameter: unsupported dispute filter.'
      USING ERRCODE = '22023';
  END IF;

  v_page := GREATEST(1, COALESCE(p_page, 1));
  v_size := LEAST(100, GREATEST(1, COALESCE(p_page_size, 20)));
  v_offset := (v_page - 1) * v_size;

  SELECT pg_catalog.count(*)::int
  INTO v_total
  FROM public.complaint_dispute_cases dc
  WHERE (v_filter IS NULL OR dc.dispute_state = v_filter);

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'complaint_id', r.complaint_id,
        'complaint_reference', r.complaint_reference,
        'title', r.title,
        'category', r.category,
        'ward', r.ward,
        'complaint_status', r.complaint_status,
        'dispute_state', r.dispute_state,
        'reopen_count', r.reopen_count,
        'latest_reason', r.latest_reason,
        'citizen_display_name', r.citizen_display_name,
        'sla_deadline', r.sla_deadline,
        'updated_at', r.updated_at,
        'admin_decided_at', r.admin_decided_at
      )
      ORDER BY r.updated_at DESC, r.complaint_id DESC
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT
      dc.complaint_id,
      COALESCE(c.complaint_number, c.id::text) AS complaint_reference,
      c.title,
      c.category,
      c.ward,
      c.status::text AS complaint_status,
      dc.dispute_state,
      dc.reopen_count,
      dc.latest_reason,
      COALESCE(NULLIF(pg_catalog.btrim(p.full_name), ''), 'Reporting Citizen') AS citizen_display_name,
      c.sla_deadline,
      dc.updated_at,
      dc.admin_decided_at
    FROM public.complaint_dispute_cases dc
    JOIN public.complaints c ON c.id = dc.complaint_id
    LEFT JOIN public.profiles p ON p.id = c.citizen_id
    WHERE (v_filter IS NULL OR dc.dispute_state = v_filter)
    ORDER BY dc.updated_at DESC, dc.complaint_id DESC
    LIMIT v_size OFFSET v_offset
  ) r;

  RETURN pg_catalog.jsonb_build_object(
    'items', v_items,
    'page', v_page,
    'page_size', v_size,
    'total', v_total,
    'total_pages', GREATEST(1, pg_catalog.ceil(v_total::numeric / v_size)::int)
  );
END;
$$;

ALTER FUNCTION public.list_admin_disputed_complaints(TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_disputed_complaints(TEXT, INT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.list_admin_disputed_complaints(TEXT, INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_decide_disputed_complaint(
  p_complaint_id UUID,
  p_action TEXT,
  p_note TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_id UUID;
  v_action TEXT;
  v_clean_note TEXT;
  v_comp RECORD;
  v_dc RECORD;
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_new_status public.complaint_status;
  v_sla_hours INT := 48;
  v_off_profile UUID;
BEGIN
  v_admin_id := auth.uid();
  IF v_admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_complaint_id is required.'
      USING ERRCODE = '22023';
  END IF;

  v_action := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_action, '')));
  IF v_action NOT IN ('reopen', 'keep_resolved', 'close_unconfirmed') THEN
    RAISE EXCEPTION 'Invalid Parameter: action must be reopen, keep_resolved, or close_unconfirmed.'
      USING ERRCODE = '22023';
  END IF;

  v_clean_note := NULLIF(pg_catalog.btrim(COALESCE(p_note, '')), '');
  IF v_clean_note IS NULL OR pg_catalog.char_length(v_clean_note) < 5 OR pg_catalog.char_length(v_clean_note) > 1000 THEN
    RAISE EXCEPTION 'Invalid Parameter: Admin decision note (5..1000 chars) is required.'
      USING ERRCODE = '22023';
  END IF;

  SELECT id, complaint_number, category, status, department_id, assigned_officer_id
  INTO v_comp
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not Found: Complaint % does not exist.', p_complaint_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_dc
  FROM public.complaint_dispute_cases
  WHERE complaint_id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid State: Complaint % has no dispute case.', p_complaint_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_action = 'reopen' THEN
    IF v_comp.department_id IS NOT NULL AND v_comp.assigned_officer_id IS NOT NULL THEN
      v_new_status := 'in_progress'::public.complaint_status;
    ELSE
      v_new_status := 'under_review'::public.complaint_status;
    END IF;

    SELECT sla_hours INTO v_sla_hours FROM public.category_sla_rules WHERE category = v_comp.category;
    v_sla_hours := COALESCE(v_sla_hours, 48);

    UPDATE public.complaints
    SET status = v_new_status,
        sla_deadline = v_now + pg_catalog.make_interval(hours => v_sla_hours),
        updated_at = v_now
    WHERE id = p_complaint_id;

    UPDATE public.complaint_sla_state
    SET overdue_marked_at = NULL,
        updated_at = v_now
    WHERE complaint_id = p_complaint_id;

    IF v_comp.assigned_officer_id IS NOT NULL THEN
      SELECT o.profile_id INTO v_off_profile
      FROM public.officers o
      WHERE o.id = v_comp.assigned_officer_id AND o.is_active = TRUE;
      IF v_off_profile IS NOT NULL THEN
        INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
        VALUES (
          v_off_profile,
          p_complaint_id,
          'escalation',
          'Admin Reopened Disputed Complaint',
          'Administrator reopened disputed complaint ' || v_comp.complaint_number || ': ' || pg_catalog.left(v_clean_note, 200),
          'admin_reopen:' || p_complaint_id::text || ':' || v_now::text
        )
        ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
      END IF;
    END IF;

    INSERT INTO public.complaint_status_history (
      complaint_id, status, previous_status, title, public_description, internal_note, actor_id, created_at
    ) VALUES (
      p_complaint_id, v_new_status, v_comp.status, 'Admin Reopened After Dispute', v_clean_note, NULL, v_admin_id, v_now
    );

    UPDATE public.complaint_dispute_cases
    SET dispute_state = 'reopened',
        reopen_count = v_dc.reopen_count + 1,
        admin_resolution_note = v_clean_note,
        admin_decided_by = v_admin_id,
        admin_decided_at = v_now,
        updated_at = v_now
    WHERE complaint_id = p_complaint_id;

  ELSIF v_action = 'close_unconfirmed' THEN
    v_new_status := 'not_confirmed_by_citizen'::public.complaint_status;

    UPDATE public.complaints
    SET status = v_new_status,
        updated_at = v_now
    WHERE id = p_complaint_id;

    INSERT INTO public.complaint_status_history (
      complaint_id, status, previous_status, title, public_description, internal_note, actor_id, created_at
    ) VALUES (
      p_complaint_id, v_new_status, v_comp.status, 'Closed by Admin (Not Confirmed by Citizen)', v_clean_note, NULL, v_admin_id, v_now
    );

    UPDATE public.complaint_dispute_cases
    SET dispute_state = 'admin_resolved',
        admin_resolution_note = v_clean_note,
        admin_decided_by = v_admin_id,
        admin_decided_at = v_now,
        updated_at = v_now
    WHERE complaint_id = p_complaint_id;

  ELSE
    -- keep_resolved
    v_new_status := v_comp.status;

    INSERT INTO public.complaint_status_history (
      complaint_id, status, previous_status, title, public_description, internal_note, actor_id, created_at
    ) VALUES (
      p_complaint_id, v_comp.status, v_comp.status, 'Admin Reviewed Dispute — Resolution Upheld', v_clean_note, NULL, v_admin_id, v_now
    );

    UPDATE public.complaint_dispute_cases
    SET dispute_state = 'admin_resolved',
        admin_resolution_note = v_clean_note,
        admin_decided_by = v_admin_id,
        admin_decided_at = v_now,
        updated_at = v_now
    WHERE complaint_id = p_complaint_id;
  END IF;

  INSERT INTO public.complaint_verification_history (
    complaint_id, evidence_id, event_type, actor_type, actor_id, result, details, created_at
  ) VALUES (
    p_complaint_id, v_dc.latest_evidence_id, 'admin_decision', 'admin', v_admin_id, v_action, v_clean_note, v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'complaint_id', p_complaint_id,
    'action', v_action,
    'complaint_status', v_new_status::text,
    'dispute_state', CASE WHEN v_action = 'reopen' THEN 'reopened' ELSE 'admin_resolved' END,
    'admin_resolution_note', v_clean_note,
    'admin_decided_at', v_now
  );
END;
$$;

ALTER FUNCTION public.admin_decide_disputed_complaint(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_decide_disputed_complaint(UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_disputed_complaint(UUID, TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Final Privilege & RLS Audit Block
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl TEXT;
  v_relacl aclitem[];
  v_fn RECORD;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['complaint_dispute_cases', 'complaint_verification_history'] LOOP
    SELECT c.relacl
    INTO v_relacl
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_tbl
      AND c.relrowsecurity = TRUE
      AND c.relforcerowsecurity = TRUE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Audit Failed: RLS + FORCE RLS must be enabled on public.%.', v_tbl;
    END IF;

    IF (v_relacl IS NOT NULL AND EXISTS (SELECT 1 FROM pg_catalog.aclexplode(v_relacl) a WHERE a.grantee = 0))
       OR pg_catalog.has_table_privilege('anon', 'public.' || v_tbl, 'SELECT')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'INSERT')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'UPDATE')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'DELETE')
       OR pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'TRUNCATE')
       OR pg_catalog.has_table_privilege('service_role', 'public.' || v_tbl, 'SELECT')
       OR pg_catalog.has_table_privilege('service_role', 'public.' || v_tbl, 'INSERT') THEN
      RAISE EXCEPTION 'Audit Failed: Unauthorized table privilege on public.%.', v_tbl;
    END IF;
  END LOOP;

  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'guard_verification_history_immutable',
        'complete_ai_resolution_check',
        'close_unconfirmed_resolved_complaints'
      )
  ) LOOP
    IF v_fn.proacl IS NULL
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(v_fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Server function public.%() grants EXECUTE to PUBLIC/anon/authenticated.', v_fn.proname;
    END IF;
  END LOOP;

  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'submit_resolution_verification',
        'get_admin_complaint_verifications',
        'list_admin_disputed_complaints',
        'admin_decide_disputed_complaint'
      )
  ) LOOP
    IF v_fn.proacl IS NULL
       OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(v_fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_fn.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Authenticated RPC public.%() has unexpected EXECUTE grants.', v_fn.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
