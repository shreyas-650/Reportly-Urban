-- =============================================================================
-- Migration: 20261127_phase7_sla_escalation.sql
-- Module: Phase 7.1 — Deadlines, Reminders, Overdue Marking & Escalation Engine
-- Target: Supabase PostgreSQL
--
-- IMPORTANT: DO NOT EXECUTE WITHOUT EXPLICIT APPROVAL OF:
--   1. Dedicated department_heads(department_id, profile_id, active) mapping
--   2. Server-side sla_deadline computation at complaint submission (INSERT)
--   3. Separate NULL sla_deadline backfill policy (NOT applied in this file)
--   4. Reassignment handling via AFTER UPDATE trigger (preserving assign_complaint_admin)
--
-- Safety Guarantees:
--   - Wrapped in a single transaction (BEGIN ... COMMIT).
--   - Preserves all Phase 2/3/4/5/6 tables, RLS policies, and Phase 6.2 public RPCs.
--   - Does NOT backfill existing NULL sla_deadline rows on public.complaints.
--   - Tracks escalation/overdue sweep state in public.complaint_sla_state so sweeps
--     never bump public.complaints.updated_at or trigger false 40001 conflicts.
--   - Immutable audit tables (complaint_escalations, complaint_reminders) block
--     UPDATE, DELETE, and TRUNCATE (SQLSTATE 42501).
--   - Transactional per-complaint subtransaction (savepoints) inside run_sla_sweep()
--     ensuring reminder/escalation/notification/sla_state writes commit or roll back together.
--   - Advisory lock (pg_try_advisory_xact_lock) + FOR UPDATE SKIP LOCKED prevent races.
--   - All client writes revoked; mutations via hardened SECURITY DEFINER RPCs only.
--   - Complete verification assertions + operator-controlled rollback (no CASCADE).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Exhaustive Precondition Checks
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_cat_check TEXT;
  v_missing_cols TEXT;
  v_missing_roles TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'complaints') THEN
    RAISE EXCEPTION 'Precondition Failed: public.complaints does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'departments') THEN
    RAISE EXCEPTION 'Precondition Failed: public.departments does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'officers') THEN
    RAISE EXCEPTION 'Precondition Failed: public.officers does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'profiles') THEN
    RAISE EXCEPTION 'Precondition Failed: public.profiles does not exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'complaint_status_history') THEN
    RAISE EXCEPTION 'Precondition Failed: public.complaint_status_history does not exist.';
  END IF;

  -- Verify public.user_role enum exists with expected labels: citizen, officer, admin
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'user_role' AND t.typtype = 'e'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Enum type public.user_role does not exist.';
  END IF;

  SELECT pg_catalog.string_agg(lbl, ', ')
  INTO v_missing_roles
  FROM pg_catalog.unnest(ARRAY['citizen', 'officer', 'admin']) AS lbl
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum e
    JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'user_role' AND e.enumlabel = lbl
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Enum public.user_role is missing required label(s): %.', v_missing_roles;
  END IF;

  -- Verify required columns on profiles, officers, and complaints
  SELECT pg_catalog.string_agg(req.tbl || '.' || req.col, ', ')
  INTO v_missing_cols
  FROM (VALUES
    ('profiles', 'role'),
    ('profiles', 'created_at'),
    ('officers', 'profile_id'),
    ('officers', 'is_active'),
    ('officers', 'department_id'),
    ('complaints', 'complaint_number'),
    ('complaints', 'assigned_officer_id'),
    ('complaints', 'department_id'),
    ('complaints', 'category'),
    ('complaints', 'sla_deadline'),
    ('complaints', 'created_at'),
    ('complaints', 'updated_at')
  ) AS req(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = req.tbl
      AND c.column_name = req.col
  );

  IF v_missing_cols IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Missing required column(s): %.', v_missing_cols;
  END IF;

  IF to_regprocedure('public.is_admin()') IS NULL OR
     to_regprocedure('public.get_current_officer_id()') IS NULL OR
     to_regprocedure('public.get_current_officer_department_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Required Phase 2/4.1 auth helper functions are missing.';
  END IF;

  -- Confirm complaints.category uses the exact six expected municipal categories
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_cat_check
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.complaints'::regclass
    AND c.contype = 'c'
    AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%category%'
    AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%public_infrastructure%'
  LIMIT 1;

  IF v_cat_check IS NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Expected category CHECK constraint not found on public.complaints.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Category SLA Rules (Exact 6 Categories, Admin-Managed via RPC)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.category_sla_rules (
  category VARCHAR(50) PRIMARY KEY CHECK (
    category IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure')
  ),
  sla_hours INT NOT NULL CHECK (sla_hours > 0 AND sla_hours <= 8760),
  reminder_before_hours INT NOT NULL CHECK (reminder_before_hours >= 0 AND reminder_before_hours < sla_hours),
  level2_after_hours INT NOT NULL CHECK (level2_after_hours >= 0),
  level3_after_hours INT NOT NULL CHECK (level3_after_hours > level2_after_hours),
  updated_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.category_sla_rules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.category_sla_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.category_sla_rules TO authenticated;

DROP POLICY IF EXISTS "Staff and admins can read category SLA rules" ON public.category_sla_rules;
CREATE POLICY "Staff and admins can read category SLA rules"
  ON public.category_sla_rules
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin()) OR
    (SELECT public.get_current_officer_id()) IS NOT NULL
  );

-- Guard to disallow inserting additional categories or deleting seeded categories
CREATE OR REPLACE FUNCTION public.guard_category_sla_rules_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Category SLA rules cannot be deleted.' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.category IS DISTINCT FROM OLD.category THEN
      RAISE EXCEPTION 'Category key in category_sla_rules cannot be altered.' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_category_sla_rules_lock() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_category_sla_rules_lock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_category_sla_rules_lock ON public.category_sla_rules;
CREATE TRIGGER trg_guard_category_sla_rules_lock
  BEFORE UPDATE OR DELETE ON public.category_sla_rules
  FOR EACH ROW EXECUTE FUNCTION public.guard_category_sla_rules_lock();

-- Seed exact 6 categories aligned with departments.default_sla_hours / frontend SLA config
INSERT INTO public.category_sla_rules (category, sla_hours, reminder_before_hours, level2_after_hours, level3_after_hours)
VALUES
  ('potholes', 48, 12, 24, 72),
  ('garbage', 24, 6, 12, 36),
  ('streetlights', 36, 8, 18, 48),
  ('water_leakage', 18, 4, 12, 36),
  ('drainage', 24, 6, 12, 36),
  ('public_infrastructure', 72, 12, 24, 72)
ON CONFLICT (category) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Explicit Department Heads Mapping (Admin-Managed, 1 Active Head per Dept)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.department_heads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  deactivated_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_department_heads_active_dept
  ON public.department_heads (department_id)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_department_heads_active_profile
  ON public.department_heads (profile_id)
  WHERE active = TRUE;

ALTER TABLE public.department_heads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.department_heads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.department_heads TO authenticated;

DROP POLICY IF EXISTS "Department heads readable by admins, self, or department officers" ON public.department_heads;
CREATE POLICY "Department heads readable by admins, self, or department officers"
  ON public.department_heads
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin()) OR
    profile_id = (SELECT auth.uid()) OR
    department_id = (SELECT public.get_current_officer_department_id())
  );

-- Helper: returns active department head profile_id & officer_id ONLY if department & staff role remain active
CREATE OR REPLACE FUNCTION public.get_active_department_head(p_department_id UUID)
RETURNS TABLE (
  head_profile_id UUID,
  head_officer_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT
    dh.profile_id AS head_profile_id,
    o.id AS head_officer_id
  FROM public.department_heads dh
  JOIN public.departments d ON d.id = dh.department_id AND d.is_active = TRUE
  JOIN public.profiles p ON p.id = dh.profile_id
  LEFT JOIN public.officers o ON o.profile_id = dh.profile_id AND o.department_id = dh.department_id
  WHERE dh.department_id = p_department_id
    AND dh.active = TRUE
    AND (
      p.role = 'admin'::public.user_role OR
      (p.role = 'officer'::public.user_role AND o.id IS NOT NULL AND o.is_active = TRUE)
    )
  LIMIT 1;
$$;

ALTER FUNCTION public.get_active_department_head(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_active_department_head(UUID) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Complaint SLA Tracking State (Decoupled from complaints.updated_at)
-- -----------------------------------------------------------------------------
-- Keeps background sweep mutations out of public.complaints so admin/officer
-- optimistic concurrency checks on complaints.updated_at never break falsely.
CREATE TABLE IF NOT EXISTS public.complaint_sla_state (
  complaint_id UUID PRIMARY KEY REFERENCES public.complaints(id) ON DELETE RESTRICT,
  current_level INT NOT NULL DEFAULT 0 CHECK (current_level BETWEEN 0 AND 3),
  overdue_marked_at TIMESTAMPTZ NULL,
  last_escalated_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.complaint_sla_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_sla_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.complaint_sla_state TO authenticated;

DROP POLICY IF EXISTS "SLA state readable by admins, assigned officer, or active dept head" ON public.complaint_sla_state;
CREATE POLICY "SLA state readable by admins, assigned officer, or active dept head"
  ON public.complaint_sla_state
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin()) OR
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_sla_state.complaint_id
        AND (
          c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
          EXISTS (
            SELECT 1 FROM public.department_heads dh
            WHERE dh.department_id = c.department_id
              AND dh.profile_id = (SELECT auth.uid())
              AND dh.active = TRUE
          )
        )
    )
  );

-- -----------------------------------------------------------------------------
-- 5. Immutable Complaint Escalation History Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  from_level INT NOT NULL CHECK (from_level BETWEEN 0 AND 2),
  to_level INT NOT NULL CHECK (to_level BETWEEN 1 AND 3 AND to_level = from_level + 1),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'blocked')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) >= 3),
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('system', 'admin')),
  triggered_by_profile_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_profile_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_officer_id UUID NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT chk_escalation_recipient_required_when_completed CHECK (
    (status = 'completed' AND recipient_profile_id IS NOT NULL) OR
    (status = 'blocked' AND recipient_profile_id IS NULL)
  ),
  CONSTRAINT chk_escalation_actor_integrity CHECK (
    (triggered_by = 'admin' AND triggered_by_profile_id IS NOT NULL) OR
    (triggered_by = 'system' AND triggered_by_profile_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_complaint_escalations_completed_level
  ON public.complaint_escalations (complaint_id, to_level)
  WHERE status = 'completed';

CREATE UNIQUE INDEX IF NOT EXISTS uq_complaint_escalations_blocked_reason
  ON public.complaint_escalations (complaint_id, to_level, reason)
  WHERE status = 'blocked';

CREATE INDEX IF NOT EXISTS idx_complaint_escalations_complaint_created
  ON public.complaint_escalations (complaint_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_complaint_escalations_status_created
  ON public.complaint_escalations (status, created_at DESC);

ALTER TABLE public.complaint_escalations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_escalations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.complaint_escalations TO authenticated;

-- Reassigned previous officers and inactive department heads lose read access immediately
DROP POLICY IF EXISTS "Escalations readable by admins, current officer, or active dept head" ON public.complaint_escalations;
CREATE POLICY "Escalations readable by admins, current officer, or active dept head"
  ON public.complaint_escalations
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin()) OR
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_escalations.complaint_id
        AND (
          c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
          EXISTS (
            SELECT 1 FROM public.department_heads dh
            WHERE dh.department_id = c.department_id
              AND dh.profile_id = (SELECT auth.uid())
              AND dh.active = TRUE
          )
        )
    )
  );

-- Immutability guards (no UPDATE, DELETE, TRUNCATE) matching Phase 4.3 pattern
CREATE OR REPLACE FUNCTION public.guard_immutable_complaint_escalations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Complaint escalation records are strictly immutable and cannot be updated, deleted, or truncated.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_complaint_escalations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_complaint_escalations() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_complaint_escalations ON public.complaint_escalations;
CREATE TRIGGER trg_guard_immutable_complaint_escalations
  BEFORE UPDATE OR DELETE ON public.complaint_escalations
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_complaint_escalations();

DROP TRIGGER IF EXISTS trg_guard_immutable_complaint_escalations_truncate ON public.complaint_escalations;
CREATE TRIGGER trg_guard_immutable_complaint_escalations_truncate
  BEFORE TRUNCATE ON public.complaint_escalations
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_complaint_escalations();

-- -----------------------------------------------------------------------------
-- 6. Immutable Complaint Reminders Table (Dedupe per complaint, kind, recipient)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('pre_deadline', 'overdue')),
  recipient_officer_id UUID NOT NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  recipient_profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT uq_complaint_reminders_dedupe UNIQUE (complaint_id, kind, recipient_officer_id)
);

CREATE INDEX IF NOT EXISTS idx_complaint_reminders_officer_created
  ON public.complaint_reminders (recipient_officer_id, created_at DESC);

ALTER TABLE public.complaint_reminders ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_reminders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.complaint_reminders TO authenticated;

DROP POLICY IF EXISTS "Reminders readable by admins or currently assigned officer" ON public.complaint_reminders;
CREATE POLICY "Reminders readable by admins or currently assigned officer"
  ON public.complaint_reminders
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin()) OR
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_reminders.complaint_id
        AND c.assigned_officer_id = (SELECT public.get_current_officer_id())
    )
  );

CREATE OR REPLACE FUNCTION public.guard_immutable_complaint_reminders()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Complaint reminder audit records are strictly immutable and cannot be updated, deleted, or truncated.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_complaint_reminders() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_complaint_reminders() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_complaint_reminders ON public.complaint_reminders;
CREATE TRIGGER trg_guard_immutable_complaint_reminders
  BEFORE UPDATE OR DELETE ON public.complaint_reminders
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_complaint_reminders();

DROP TRIGGER IF EXISTS trg_guard_immutable_complaint_reminders_truncate ON public.complaint_reminders;
CREATE TRIGGER trg_guard_immutable_complaint_reminders_truncate
  BEFORE TRUNCATE ON public.complaint_reminders
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_complaint_reminders();

-- -----------------------------------------------------------------------------
-- 7. In-App Notifications Table (Transactional + Idempotent + Reassignment-Safe)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_profile_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  complaint_id UUID NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('reminder', 'escalation', 'escalation_blocked', 'assignment')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  event_key TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT uq_notifications_recipient_event UNIQUE (recipient_profile_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread_created
  ON public.notifications (recipient_profile_id, is_read, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_complaint
  ON public.notifications (complaint_id)
  WHERE complaint_id IS NOT NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.notifications TO authenticated;

-- Post-reassignment safety: non-admin previous officers cannot read notifications for complaints
-- they are no longer assigned to (and not currently active head of).
DROP POLICY IF EXISTS "Notifications readable by authorized current recipient" ON public.notifications;
CREATE POLICY "Notifications readable by authorized current recipient"
  ON public.notifications
  FOR SELECT TO authenticated
  USING (
    recipient_profile_id = (SELECT auth.uid())
    AND (
      (SELECT public.is_admin()) OR
      complaint_id IS NULL OR
      EXISTS (
        SELECT 1 FROM public.complaints c
        WHERE c.id = notifications.complaint_id
          AND (
            c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
            EXISTS (
              SELECT 1 FROM public.department_heads dh
              WHERE dh.department_id = c.department_id
                AND dh.profile_id = (SELECT auth.uid())
                AND dh.active = TRUE
            )
          )
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 8. SLA Sweep Run Ledger (Operational Telemetry, Admin Read-Only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sweep_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  finished_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'skipped_locked', 'failed')),
  triggered_by TEXT NOT NULL,
  scanned_count INT NOT NULL DEFAULT 0,
  reminders_sent_count INT NOT NULL DEFAULT 0,
  escalations_completed_count INT NOT NULL DEFAULT 0,
  escalations_blocked_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  error_details JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_sweep_runs_started
  ON public.sweep_runs (started_at DESC);

ALTER TABLE public.sweep_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sweep_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sweep_runs TO authenticated;

DROP POLICY IF EXISTS "Admins can view SLA sweep runs" ON public.sweep_runs;
CREATE POLICY "Admins can view SLA sweep runs"
  ON public.sweep_runs
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- -----------------------------------------------------------------------------
-- 9. Triggers for Server-Computed Submission SLA Deadline & Reassignment Alerts
-- -----------------------------------------------------------------------------
-- 9.1 Compute sla_deadline server-side on complaint submission (runs alphabetically
-- AFTER trg_new_complaint_pre_insert so NEW.created_at is already authoritative).
CREATE OR REPLACE FUNCTION public.assign_default_sla_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sla_hours INT;
BEGIN
  SELECT sla_hours INTO v_sla_hours
  FROM public.category_sla_rules
  WHERE category = NEW.category;

  IF v_sla_hours IS NULL THEN
    RAISE EXCEPTION 'Missing category SLA rule for category "%".', NEW.category USING ERRCODE = 'P0001';
  END IF;

  -- Strictly server-computed; overwrites any client-supplied value on INSERT
  NEW.sla_deadline := COALESCE(NEW.created_at, pg_catalog.now()) + pg_catalog.make_interval(hours => v_sla_hours);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.assign_default_sla_on_insert() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_default_sla_on_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_z_phase7_assign_default_sla ON public.complaints;
CREATE TRIGGER trg_z_phase7_assign_default_sla
  BEFORE INSERT ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.assign_default_sla_on_insert();

-- 9.2 Create initial complaint_sla_state row & reassignment notification atomically
CREATE OR REPLACE FUNCTION public.handle_phase7_complaint_assignment_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_new_officer_profile UUID;
  v_head_profile UUID;
  v_event_suffix TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.complaint_sla_state (complaint_id)
    VALUES (NEW.id)
    ON CONFLICT (complaint_id) DO NOTHING;
    RETURN NEW;
  END IF;

  -- Reassignment handling on UPDATE
  IF NEW.status IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status) THEN
    RETURN NEW;
  END IF;

  v_event_suffix := pg_catalog.gen_random_uuid()::text;

  IF NEW.assigned_officer_id IS NOT NULL
     AND OLD.assigned_officer_id IS DISTINCT FROM NEW.assigned_officer_id THEN
    SELECT o.profile_id INTO v_new_officer_profile
    FROM public.officers o
    WHERE o.id = NEW.assigned_officer_id
      AND o.is_active = TRUE;

    IF v_new_officer_profile IS NOT NULL THEN
      INSERT INTO public.notifications (
        recipient_profile_id,
        complaint_id,
        kind,
        title,
        message,
        event_key
      ) VALUES (
        v_new_officer_profile,
        NEW.id,
        'assignment',
        'Complaint Assigned to You',
        'Complaint ' || NEW.complaint_number || ' has been assigned to you for action.',
        'assignment:officer:' || NEW.id::text || ':' || v_event_suffix
      )
      ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
    END IF;
  ELSIF NEW.department_id IS NOT NULL
     AND OLD.department_id IS DISTINCT FROM NEW.department_id
     AND NEW.assigned_officer_id IS NULL THEN
    SELECT head_profile_id INTO v_head_profile
    FROM public.get_active_department_head(NEW.department_id);

    IF v_head_profile IS NOT NULL THEN
      INSERT INTO public.notifications (
        recipient_profile_id,
        complaint_id,
        kind,
        title,
        message,
        event_key
      ) VALUES (
        v_head_profile,
        NEW.id,
        'assignment',
        'Complaint Routed to Department',
        'Complaint ' || NEW.complaint_number || ' has been routed to your department and awaits officer assignment.',
        'assignment:dept:' || NEW.id::text || ':' || v_event_suffix
      )
      ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_phase7_complaint_assignment_events() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_phase7_complaint_assignment_events() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_z_phase7_complaint_state_init ON public.complaints;
CREATE TRIGGER trg_z_phase7_complaint_state_init
  AFTER INSERT ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.handle_phase7_complaint_assignment_events();

DROP TRIGGER IF EXISTS trg_z_phase7_complaint_reassignment_notify ON public.complaints;
CREATE TRIGGER trg_z_phase7_complaint_reassignment_notify
  AFTER UPDATE OF assigned_officer_id, department_id ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.handle_phase7_complaint_assignment_events();

-- -----------------------------------------------------------------------------
-- 10. Hardened SECURITY DEFINER RPCs
-- -----------------------------------------------------------------------------

-- 10.1 Admin RPC: Edit Category SLA Rule
CREATE OR REPLACE FUNCTION public.update_category_sla_rule(
  p_category VARCHAR(50),
  p_sla_hours INT,
  p_reminder_before_hours INT,
  p_level2_after_hours INT,
  p_level3_after_hours INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID;
  v_row RECORD;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;
  v_actor_id := auth.uid();

  IF p_category IS NULL OR p_category NOT IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure') THEN
    RAISE EXCEPTION 'Invalid category "%".', p_category USING ERRCODE = 'P0001';
  END IF;
  IF p_sla_hours IS NULL OR p_sla_hours <= 0 OR p_sla_hours > 8760 THEN
    RAISE EXCEPTION 'sla_hours must be between 1 and 8760.' USING ERRCODE = 'P0001';
  END IF;
  IF p_reminder_before_hours IS NULL OR p_reminder_before_hours < 0 OR p_reminder_before_hours >= p_sla_hours THEN
    RAISE EXCEPTION 'reminder_before_hours must be >= 0 and strictly less than sla_hours.' USING ERRCODE = 'P0001';
  END IF;
  IF p_level2_after_hours IS NULL OR p_level2_after_hours < 0 THEN
    RAISE EXCEPTION 'level2_after_hours must be >= 0.' USING ERRCODE = 'P0001';
  END IF;
  IF p_level3_after_hours IS NULL OR p_level3_after_hours <= p_level2_after_hours THEN
    RAISE EXCEPTION 'level3_after_hours must be strictly greater than level2_after_hours.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.category_sla_rules
  SET sla_hours = p_sla_hours,
      reminder_before_hours = p_reminder_before_hours,
      level2_after_hours = p_level2_after_hours,
      level3_after_hours = p_level3_after_hours,
      updated_by = v_actor_id,
      updated_at = pg_catalog.now()
  WHERE category = p_category
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Category SLA rule "%" not found.', p_category USING ERRCODE = 'P0002';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'category', v_row.category,
    'sla_hours', v_row.sla_hours,
    'reminder_before_hours', v_row.reminder_before_hours,
    'level2_after_hours', v_row.level2_after_hours,
    'level3_after_hours', v_row.level3_after_hours,
    'updated_at', v_row.updated_at
  );
END;
$$;

ALTER FUNCTION public.update_category_sla_rule(VARCHAR, INT, INT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_category_sla_rule(VARCHAR, INT, INT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_category_sla_rule(VARCHAR, INT, INT, INT, INT) TO authenticated;

-- 10.2 Admin RPC: Assign / Clear Explicit Department Head
CREATE OR REPLACE FUNCTION public.set_department_head(
  p_department_id UUID,
  p_profile_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID;
  v_dept_active BOOLEAN;
  v_role public.user_role;
  v_officer_active BOOLEAN;
  v_new_id UUID;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;
  v_actor_id := auth.uid();

  IF p_department_id IS NULL THEN
    RAISE EXCEPTION 'department_id is required.' USING ERRCODE = 'P0001';
  END IF;

  SELECT is_active INTO v_dept_active
  FROM public.departments
  WHERE id = p_department_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Department % not found.', p_department_id USING ERRCODE = '23503';
  END IF;
  IF NOT v_dept_active THEN
    RAISE EXCEPTION 'Cannot configure a department head for an inactive department.' USING ERRCODE = 'P0001';
  END IF;

  -- Deactivate any existing active head for this department
  UPDATE public.department_heads
  SET active = FALSE,
      deactivated_at = pg_catalog.now()
  WHERE department_id = p_department_id
    AND active = TRUE;

  IF p_profile_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'department_id', p_department_id,
      'active_head_profile_id', NULL,
      'cleared', true
    );
  END IF;

  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile % not found.', p_profile_id USING ERRCODE = '23503';
  END IF;

  IF v_role = 'citizen'::public.user_role THEN
    RAISE EXCEPTION 'A citizen profile cannot be assigned as a department head.' USING ERRCODE = 'P0001';
  END IF;

  IF v_role = 'officer'::public.user_role THEN
    SELECT is_active INTO v_officer_active
    FROM public.officers
    WHERE profile_id = p_profile_id
      AND department_id = p_department_id;

    IF NOT FOUND OR NOT COALESCE(v_officer_active, FALSE) THEN
      RAISE EXCEPTION 'Officer must be active and belong to this department to serve as its head.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  INSERT INTO public.department_heads (department_id, profile_id, active, assigned_by)
  VALUES (p_department_id, p_profile_id, TRUE, v_actor_id)
  RETURNING id INTO v_new_id;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_new_id,
    'department_id', p_department_id,
    'active_head_profile_id', p_profile_id,
    'active', true
  );
END;
$$;

ALTER FUNCTION public.set_department_head(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_department_head(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_department_head(UUID, UUID) TO authenticated;

-- 10.3 Admin RPC: Manual Escalation (+1 Level Only, Transactional with Notification)
CREATE OR REPLACE FUNCTION public.escalate_complaint_manual(
  p_complaint_id UUID,
  p_reason TEXT,
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
  v_curr_level INT;
  v_next_level INT;
  v_trimmed_reason TEXT;
  v_recipient_profile UUID;
  v_recipient_officer UUID;
  v_head RECORD;
  v_admin RECORD;
  v_escalation_id UUID;
  v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;
  v_actor_id := auth.uid();

  v_trimmed_reason := NULLIF(pg_catalog.btrim(p_reason), '');
  IF v_trimmed_reason IS NULL OR pg_catalog.length(v_trimmed_reason) < 5 THEN
    RAISE EXCEPTION 'A manual escalation reason of at least 5 characters is required.' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, complaint_number, status, department_id, assigned_officer_id, updated_at
  INTO v_comp
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Complaint % not found.', p_complaint_id USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_updated_at IS NOT NULL
     AND pg_catalog.date_trunc('milliseconds', v_comp.updated_at) <> pg_catalog.date_trunc('milliseconds', p_expected_updated_at) THEN
    RAISE EXCEPTION 'Concurrency Conflict: Complaint was updated elsewhere. Refresh and retry.' USING ERRCODE = '40001';
  END IF;

  IF v_comp.status IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status) THEN
    RAISE EXCEPTION 'Terminal State Violation: Cannot escalate a % complaint.', v_comp.status USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.complaint_sla_state (complaint_id)
  VALUES (p_complaint_id)
  ON CONFLICT (complaint_id) DO NOTHING;

  SELECT current_level INTO v_curr_level
  FROM public.complaint_sla_state
  WHERE complaint_id = p_complaint_id
  FOR UPDATE;

  IF v_curr_level >= 3 THEN
    RAISE EXCEPTION 'Complaint is already at maximum escalation Level 3.' USING ERRCODE = 'P0001';
  END IF;

  v_next_level := v_curr_level + 1;

  IF v_next_level = 1 THEN
    IF v_comp.assigned_officer_id IS NULL THEN
      RAISE EXCEPTION 'Cannot escalate to Level 1: complaint has no assigned officer.' USING ERRCODE = 'P0001';
    END IF;
    SELECT o.profile_id, o.id INTO v_recipient_profile, v_recipient_officer
    FROM public.officers o
    WHERE o.id = v_comp.assigned_officer_id AND o.is_active = TRUE;

    IF v_recipient_profile IS NULL THEN
      RAISE EXCEPTION 'Cannot escalate to Level 1: assigned officer profile is missing or inactive.' USING ERRCODE = 'P0001';
    END IF;

  ELSIF v_next_level = 2 THEN
    IF v_comp.department_id IS NULL THEN
      RAISE EXCEPTION 'Cannot escalate to Level 2: complaint has no assigned department.' USING ERRCODE = 'P0001';
    END IF;
    SELECT head_profile_id, head_officer_id INTO v_head
    FROM public.get_active_department_head(v_comp.department_id);

    IF v_head.head_profile_id IS NULL THEN
      RAISE EXCEPTION 'Cannot escalate to Level 2 (no_department_head): assign an active department head first.' USING ERRCODE = 'P0001';
    END IF;
    v_recipient_profile := v_head.head_profile_id;
    v_recipient_officer := v_head.head_officer_id;

  ELSIF v_next_level = 3 THEN
    SELECT p.id INTO v_recipient_profile
    FROM public.profiles p
    WHERE p.role = 'admin'::public.user_role
    ORDER BY (p.id = v_actor_id) DESC, p.created_at ASC
    LIMIT 1;
    v_recipient_officer := NULL;
  END IF;

  INSERT INTO public.complaint_escalations (
    complaint_id,
    from_level,
    to_level,
    status,
    reason,
    triggered_by,
    triggered_by_profile_id,
    recipient_profile_id,
    recipient_officer_id,
    created_at
  ) VALUES (
    p_complaint_id,
    v_curr_level,
    v_next_level,
    'completed',
    v_trimmed_reason,
    'admin',
    v_actor_id,
    v_recipient_profile,
    v_recipient_officer,
    v_now
  )
  RETURNING id INTO v_escalation_id;

  UPDATE public.complaint_sla_state
  SET current_level = v_next_level,
      last_escalated_at = v_now,
      updated_at = v_now
  WHERE complaint_id = p_complaint_id;

  IF v_next_level IN (1, 2) THEN
    INSERT INTO public.notifications (
      recipient_profile_id,
      complaint_id,
      kind,
      title,
      message,
      event_key
    ) VALUES (
      v_recipient_profile,
      p_complaint_id,
      'escalation',
      'Complaint Escalated to Level ' || v_next_level,
      'Complaint ' || v_comp.complaint_number || ' was escalated to Level ' || v_next_level || ' (' || v_trimmed_reason || ').',
      'escalation:' || v_escalation_id::text
    );
  ELSE
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin'::public.user_role
    LOOP
      INSERT INTO public.notifications (
        recipient_profile_id,
        complaint_id,
        kind,
        title,
        message,
        event_key
      ) VALUES (
        v_admin.id,
        p_complaint_id,
        'escalation',
        'Complaint Escalated to Level 3 (Admin)',
        'Complaint ' || v_comp.complaint_number || ' was escalated to Level 3 (' || v_trimmed_reason || ').',
        'escalation:' || v_escalation_id::text
      )
      ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
    END LOOP;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'escalation_id', v_escalation_id,
    'complaint_id', p_complaint_id,
    'from_level', v_curr_level,
    'to_level', v_next_level,
    'status', 'completed'
  );
END;
$$;

ALTER FUNCTION public.escalate_complaint_manual(UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.escalate_complaint_manual(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.escalate_complaint_manual(UUID, TEXT, TIMESTAMPTZ) TO authenticated;

-- 10.4 Mark Own Authorized Notification Read
CREATE OR REPLACE FUNCTION public.mark_notification_read(p_notification_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID;
  v_updated INT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.notifications n
  SET is_read = TRUE,
      read_at = COALESCE(read_at, pg_catalog.now())
  WHERE n.id = p_notification_id
    AND n.recipient_profile_id = v_caller_id
    AND (
      (SELECT public.is_admin()) OR
      n.complaint_id IS NULL OR
      EXISTS (
        SELECT 1 FROM public.complaints c
        WHERE c.id = n.complaint_id
          AND (
            c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
            EXISTS (
              SELECT 1 FROM public.department_heads dh
              WHERE dh.department_id = c.department_id
                AND dh.profile_id = v_caller_id
                AND dh.active = TRUE
            )
          )
      )
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

ALTER FUNCTION public.mark_notification_read(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mark_notification_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(UUID) TO authenticated;

-- 10.5 Citizen Private Neutral Follow-Up Indicator (Zero officer/level/escalation leaks)
CREATE OR REPLACE FUNCTION public.get_citizen_complaint_followup_status(p_complaint_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
DECLARE
  v_caller_id UUID;
  v_comp RECORD;
  v_followed_up BOOLEAN := FALSE;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;

  SELECT c.id, c.citizen_id, c.assigned_officer_id, c.status, c.sla_deadline
  INTO v_comp
  FROM public.complaints c
  WHERE c.id = p_complaint_id;

  IF NOT FOUND OR (
    v_comp.citizen_id <> v_caller_id AND
    v_comp.assigned_officer_id IS DISTINCT FROM (SELECT public.get_current_officer_id()) AND
    NOT (SELECT public.is_admin())
  ) THEN
    RAISE EXCEPTION 'Complaint not found or access denied.' USING ERRCODE = '42501';
  END IF;

  IF v_comp.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status) THEN
    SELECT (
      COALESCE(s.current_level, 0) > 0 OR
      s.overdue_marked_at IS NOT NULL OR
      (c.sla_deadline IS NOT NULL AND c.sla_deadline < pg_catalog.now())
    )
    INTO v_followed_up
    FROM public.complaints c
    LEFT JOIN public.complaint_sla_state s ON s.complaint_id = c.id
    WHERE c.id = p_complaint_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object('is_followed_up', COALESCE(v_followed_up, FALSE));
END;
$$;

ALTER FUNCTION public.get_citizen_complaint_followup_status(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_citizen_complaint_followup_status(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_citizen_complaint_followup_status(UUID) TO authenticated;

-- 10.6 Idempotent, Concurrent-Safe, Transactional SLA Sweep RPC (service_role ONLY)
-- WARNING: The first sweep will notify for every already-overdue complaint.
-- Do NOT schedule this sweep until legacy deadline data has been handled.
CREATE OR REPLACE FUNCTION public.run_sla_sweep(
  p_batch_limit INT DEFAULT 100,
  p_triggered_by TEXT DEFAULT 'scheduler'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(p_batch_limit, 100), 1), 250);
  v_trigger_label TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_triggered_by), ''), 'scheduler');
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_run_id UUID;
  v_scanned INT := 0;
  v_reminders_sent INT := 0;
  v_escalated INT := 0;
  v_blocked INT := 0;
  v_err_count INT := 0;
  v_errors JSONB := '[]'::jsonb;
  v_cand RECORD;
  v_comp RECORD;
  v_rule RECORD;
  v_curr_level INT;
  v_overdue_marked TIMESTAMPTZ;
  v_off_profile UUID;
  v_head_profile_id UUID;
  v_head_officer_id UUID;
  v_admin RECORD;
  v_primary_admin UUID;
  v_rem_id UUID;
  v_esc_id UUID;
  v_block_reason TEXT;
  v_next_level INT;
  v_due BOOLEAN;
  v_level1_escalated_this_run BOOLEAN;
BEGIN
  -- Acquire non-blocking transaction advisory lock so overlapping sweeps never double-process
  IF NOT pg_catalog.pg_try_advisory_xact_lock(720261127) THEN
    INSERT INTO public.sweep_runs (started_at, finished_at, status, triggered_by)
    VALUES (v_now, pg_catalog.now(), 'skipped_locked', v_trigger_label)
    RETURNING id INTO v_run_id;

    RETURN pg_catalog.jsonb_build_object(
      'run_id', v_run_id,
      'status', 'skipped_locked',
      'scanned_count', 0,
      'reminders_sent_count', 0,
      'escalations_completed_count', 0,
      'escalations_blocked_count', 0,
      'error_count', 0
    );
  END IF;

  INSERT INTO public.sweep_runs (started_at, status, triggered_by)
  VALUES (v_now, 'running', v_trigger_label)
  RETURNING id INTO v_run_id;

  FOR v_cand IN
    SELECT c.id
    FROM public.complaints c
    JOIN public.category_sla_rules r ON r.category = c.category
    LEFT JOIN public.complaint_sla_state s ON s.complaint_id = c.id
    WHERE c.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
      AND c.sla_deadline IS NOT NULL
      AND (
        -- Needs pre-deadline reminder for current active officer
        (
          c.assigned_officer_id IS NOT NULL
          AND v_now >= (c.sla_deadline - pg_catalog.make_interval(hours => r.reminder_before_hours))
          AND v_now < c.sla_deadline
          AND NOT EXISTS (
            SELECT 1 FROM public.complaint_reminders rm
            WHERE rm.complaint_id = c.id
              AND rm.kind = 'pre_deadline'
              AND rm.recipient_officer_id = c.assigned_officer_id
          )
        )
        OR
        -- Needs overdue marking / overdue reminder
        (
          v_now >= c.sla_deadline
          AND (
            s.overdue_marked_at IS NULL
            OR (
              c.assigned_officer_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.complaint_reminders rm
                WHERE rm.complaint_id = c.id
                  AND rm.kind = 'overdue'
                  AND rm.recipient_officer_id = c.assigned_officer_id
              )
            )
          )
        )
        OR
        -- Level 0 -> 1 escalation eligible (or retriable if officer was assigned since last block)
        (
          COALESCE(s.current_level, 0) = 0
          AND v_now >= c.sla_deadline
          AND (
            (c.assigned_officer_id IS NOT NULL)
            OR NOT EXISTS (
              SELECT 1 FROM public.complaint_escalations ce
              WHERE ce.complaint_id = c.id AND ce.to_level = 1 AND ce.status = 'blocked' AND ce.reason = 'no_assigned_officer'
            )
          )
        )
        OR
        -- Level 1 -> 2 escalation eligible (or retriable if active department head now exists)
        (
          COALESCE(s.current_level, 0) = 1
          AND v_now >= (c.sla_deadline + pg_catalog.make_interval(hours => r.level2_after_hours))
          AND (
            (c.department_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.get_active_department_head(c.department_id)))
            OR NOT EXISTS (
              SELECT 1 FROM public.complaint_escalations ce
              WHERE ce.complaint_id = c.id
                AND ce.to_level = 2
                AND ce.status = 'blocked'
                AND ce.reason = CASE WHEN c.department_id IS NULL THEN 'no_department' ELSE 'no_department_head' END
            )
          )
        )
        OR
        -- Level 2 -> 3 escalation eligible
        (
          COALESCE(s.current_level, 0) = 2
          AND v_now >= (c.sla_deadline + pg_catalog.make_interval(hours => r.level3_after_hours))
        )
      )
    ORDER BY c.sla_deadline ASC, c.id ASC
    LIMIT v_limit
  LOOP
    BEGIN
      -- Lock complaint row without waiting (prevents racing with admin transitions/assignments)
      SELECT id, complaint_number, category, status, department_id, assigned_officer_id, sla_deadline
      INTO v_comp
      FROM public.complaints
      WHERE id = v_cand.id
      FOR UPDATE SKIP LOCKED;

      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      -- Re-verify eligibility under lock
      IF v_comp.status NOT IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
         OR v_comp.sla_deadline IS NULL THEN
        CONTINUE;
      END IF;

      v_scanned := v_scanned + 1;

      SELECT sla_hours, reminder_before_hours, level2_after_hours, level3_after_hours
      INTO v_rule
      FROM public.category_sla_rules
      WHERE category = v_comp.category;

      INSERT INTO public.complaint_sla_state (complaint_id)
      VALUES (v_comp.id)
      ON CONFLICT (complaint_id) DO NOTHING;

      SELECT current_level, overdue_marked_at
      INTO v_curr_level, v_overdue_marked
      FROM public.complaint_sla_state
      WHERE complaint_id = v_comp.id
      FOR UPDATE;

      -- A. Mark overdue state timestamp cleanly in complaint_sla_state
      IF v_now >= v_comp.sla_deadline AND v_overdue_marked IS NULL THEN
        UPDATE public.complaint_sla_state
        SET overdue_marked_at = v_now,
            updated_at = v_now
        WHERE complaint_id = v_comp.id;
      END IF;

      -- B. Resolve assigned officer profile if assigned
      v_off_profile := NULL;
      IF v_comp.assigned_officer_id IS NOT NULL THEN
        SELECT o.profile_id INTO v_off_profile
        FROM public.officers o
        WHERE o.id = v_comp.assigned_officer_id
          AND o.is_active = TRUE;
      END IF;

      -- C. Pre-deadline reminder (deduped per complaint, kind, recipient_officer_id)
      IF v_off_profile IS NOT NULL
         AND v_now >= (v_comp.sla_deadline - pg_catalog.make_interval(hours => v_rule.reminder_before_hours))
         AND v_now < v_comp.sla_deadline THEN
        v_rem_id := NULL;
        INSERT INTO public.complaint_reminders (complaint_id, kind, recipient_officer_id, recipient_profile_id)
        VALUES (v_comp.id, 'pre_deadline', v_comp.assigned_officer_id, v_off_profile)
        ON CONFLICT ON CONSTRAINT uq_complaint_reminders_dedupe DO NOTHING
        RETURNING id INTO v_rem_id;

        IF v_rem_id IS NOT NULL THEN
          INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
          VALUES (
            v_off_profile,
            v_comp.id,
            'reminder',
            'Upcoming SLA Deadline Reminder',
            'Complaint ' || v_comp.complaint_number || ' is approaching its SLA deadline.',
            'reminder:' || v_rem_id::text
          );
          v_reminders_sent := v_reminders_sent + 1;
        END IF;
      END IF;

      -- D. Escalation: advance AT MOST ONE level per sweep step (never skip levels)
      v_level1_escalated_this_run := FALSE;
      v_due := FALSE;
      v_next_level := v_curr_level + 1;
      IF v_curr_level = 0 AND v_now >= v_comp.sla_deadline THEN
        v_due := TRUE;
      ELSIF v_curr_level = 1 AND v_now >= (v_comp.sla_deadline + pg_catalog.make_interval(hours => v_rule.level2_after_hours)) THEN
        v_due := TRUE;
      ELSIF v_curr_level = 2 AND v_now >= (v_comp.sla_deadline + pg_catalog.make_interval(hours => v_rule.level3_after_hours)) THEN
        v_due := TRUE;
      END IF;

      IF v_due THEN
        IF v_next_level = 1 THEN
          IF v_off_profile IS NULL THEN
            v_esc_id := NULL;
            INSERT INTO public.complaint_escalations (
              complaint_id, from_level, to_level, status, reason, triggered_by
            ) VALUES (
              v_comp.id, 0, 1, 'blocked', 'no_assigned_officer', 'system'
            )
            ON CONFLICT (complaint_id, to_level, reason) WHERE status = 'blocked' DO NOTHING
            RETURNING id INTO v_esc_id;

            IF v_esc_id IS NOT NULL THEN
              v_blocked := v_blocked + 1;
              FOR v_admin IN SELECT id FROM public.profiles WHERE role = 'admin'::public.user_role LOOP
                INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
                VALUES (
                  v_admin.id,
                  v_comp.id,
                  'escalation_blocked',
                  'Level 1 Escalation Blocked',
                  'Complaint ' || v_comp.complaint_number || ' is overdue but has no active assigned officer.',
                  'escalation_blocked:' || v_esc_id::text
                )
                ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
              END LOOP;
            END IF;
          ELSE
            v_esc_id := NULL;
            INSERT INTO public.complaint_escalations (
              complaint_id, from_level, to_level, status, reason, triggered_by,
              recipient_profile_id, recipient_officer_id
            ) VALUES (
              v_comp.id, 0, 1, 'completed', 'sla_overdue_level1', 'system',
              v_off_profile, v_comp.assigned_officer_id
            )
            ON CONFLICT (complaint_id, to_level) WHERE status = 'completed' DO NOTHING
            RETURNING id INTO v_esc_id;

            IF v_esc_id IS NOT NULL THEN
              UPDATE public.complaint_sla_state
              SET current_level = 1, last_escalated_at = v_now, updated_at = v_now
              WHERE complaint_id = v_comp.id;

              INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
              VALUES (
                v_off_profile,
                v_comp.id,
                'escalation',
                'Level 1 SLA Escalation',
                'Complaint ' || v_comp.complaint_number || ' has been escalated to Level 1 due to overdue SLA.',
                'escalation:' || v_esc_id::text
              );
              v_escalated := v_escalated + 1;
              v_level1_escalated_this_run := TRUE;
            END IF;
          END IF;

        ELSIF v_next_level = 2 THEN
          v_head_profile_id := NULL;
          v_head_officer_id := NULL;
          IF v_comp.department_id IS NOT NULL THEN
            SELECT head_profile_id, head_officer_id
            INTO v_head_profile_id, v_head_officer_id
            FROM public.get_active_department_head(v_comp.department_id);
          END IF;

          IF v_comp.department_id IS NULL OR v_head_profile_id IS NULL THEN
            v_block_reason := CASE WHEN v_comp.department_id IS NULL THEN 'no_department' ELSE 'no_department_head' END;
            v_esc_id := NULL;
            INSERT INTO public.complaint_escalations (
              complaint_id, from_level, to_level, status, reason, triggered_by
            ) VALUES (
              v_comp.id, 1, 2, 'blocked', v_block_reason, 'system'
            )
            ON CONFLICT (complaint_id, to_level, reason) WHERE status = 'blocked' DO NOTHING
            RETURNING id INTO v_esc_id;

            IF v_esc_id IS NOT NULL THEN
              v_blocked := v_blocked + 1;
              FOR v_admin IN SELECT id FROM public.profiles WHERE role = 'admin'::public.user_role LOOP
                INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
                VALUES (
                  v_admin.id,
                  v_comp.id,
                  'escalation_blocked',
                  'Level 2 Escalation Blocked (' || v_block_reason || ')',
                  'Complaint ' || v_comp.complaint_number || ' reached the Level 2 threshold but no active department head is configured.',
                  'escalation_blocked:' || v_esc_id::text
                )
                ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
              END LOOP;
            END IF;
          ELSE
            v_esc_id := NULL;
            INSERT INTO public.complaint_escalations (
              complaint_id, from_level, to_level, status, reason, triggered_by,
              recipient_profile_id, recipient_officer_id
            ) VALUES (
              v_comp.id, 1, 2, 'completed', 'sla_threshold_level2', 'system',
              v_head_profile_id, v_head_officer_id
            )
            ON CONFLICT (complaint_id, to_level) WHERE status = 'completed' DO NOTHING
            RETURNING id INTO v_esc_id;

            IF v_esc_id IS NOT NULL THEN
              UPDATE public.complaint_sla_state
              SET current_level = 2, last_escalated_at = v_now, updated_at = v_now
              WHERE complaint_id = v_comp.id;

              INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
              VALUES (
                v_head_profile_id,
                v_comp.id,
                'escalation',
                'Level 2 Department Head Escalation',
                'Complaint ' || v_comp.complaint_number || ' has escalated to Level 2 (Department Head).',
                'escalation:' || v_esc_id::text
              );
              v_escalated := v_escalated + 1;
            END IF;
          END IF;

        ELSIF v_next_level = 3 THEN
          SELECT p.id INTO v_primary_admin
          FROM public.profiles p
          WHERE p.role = 'admin'::public.user_role
          ORDER BY p.created_at ASC, p.id ASC
          LIMIT 1;

          IF v_primary_admin IS NULL THEN
            RAISE EXCEPTION 'No active administrator profile found for Level 3 escalation.' USING ERRCODE = 'P0001';
          END IF;

          v_esc_id := NULL;
          INSERT INTO public.complaint_escalations (
            complaint_id, from_level, to_level, status, reason, triggered_by,
            recipient_profile_id, recipient_officer_id
          ) VALUES (
            v_comp.id, 2, 3, 'completed', 'sla_threshold_level3', 'system',
            v_primary_admin, NULL
          )
          ON CONFLICT (complaint_id, to_level) WHERE status = 'completed' DO NOTHING
          RETURNING id INTO v_esc_id;

          IF v_esc_id IS NOT NULL THEN
            UPDATE public.complaint_sla_state
            SET current_level = 3, last_escalated_at = v_now, updated_at = v_now
            WHERE complaint_id = v_comp.id;

            FOR v_admin IN SELECT id FROM public.profiles WHERE role = 'admin'::public.user_role LOOP
              INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
              VALUES (
                v_admin.id,
                v_comp.id,
                'escalation',
                'Level 3 Administrator Escalation',
                'Complaint ' || v_comp.complaint_number || ' has escalated to Level 3 (Administrator).',
                'escalation:' || v_esc_id::text
              )
              ON CONFLICT (recipient_profile_id, event_key) DO NOTHING;
            END LOOP;
            v_escalated := v_escalated + 1;
          END IF;
        END IF;
      END IF;

      -- E. Overdue reminder (deduped per complaint, kind, recipient_officer_id)
      -- Suppressed in the same run if Level 1 escalation already notified this officer.
      IF v_off_profile IS NOT NULL
         AND v_now >= v_comp.sla_deadline
         AND NOT v_level1_escalated_this_run THEN
        v_rem_id := NULL;
        INSERT INTO public.complaint_reminders (complaint_id, kind, recipient_officer_id, recipient_profile_id)
        VALUES (v_comp.id, 'overdue', v_comp.assigned_officer_id, v_off_profile)
        ON CONFLICT ON CONSTRAINT uq_complaint_reminders_dedupe DO NOTHING
        RETURNING id INTO v_rem_id;

        IF v_rem_id IS NOT NULL THEN
          INSERT INTO public.notifications (recipient_profile_id, complaint_id, kind, title, message, event_key)
          VALUES (
            v_off_profile,
            v_comp.id,
            'reminder',
            'Complaint Past SLA Deadline',
            'Complaint ' || v_comp.complaint_number || ' has passed its SLA deadline and requires immediate attention.',
            'reminder:' || v_rem_id::text
          );
          v_reminders_sent := v_reminders_sent + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Rolls back only this complaint's subtransaction cleanly
      v_err_count := v_err_count + 1;
      v_errors := v_errors || pg_catalog.jsonb_build_object(
        'complaint_id', v_cand.id,
        'sqlstate', SQLSTATE
      );
    END;
  END LOOP;

  UPDATE public.sweep_runs
  SET finished_at = pg_catalog.now(),
      status = 'completed',
      scanned_count = v_scanned,
      reminders_sent_count = v_reminders_sent,
      escalations_completed_count = v_escalated,
      escalations_blocked_count = v_blocked,
      error_count = v_err_count,
      error_details = CASE WHEN v_err_count > 0 THEN v_errors ELSE NULL END
  WHERE id = v_run_id;

  RETURN pg_catalog.jsonb_build_object(
    'run_id', v_run_id,
    'status', 'completed',
    'scanned_count', v_scanned,
    'reminders_sent_count', v_reminders_sent,
    'escalations_completed_count', v_escalated,
    'escalations_blocked_count', v_blocked,
    'error_count', v_err_count
  );
END;
$$;

ALTER FUNCTION public.run_sla_sweep(INT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.run_sla_sweep(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_sla_sweep(INT, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 11. Post-Migration Verification Assertions
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl TEXT;
  v_rls BOOLEAN;
  v_fn RECORD;
  v_list_res JSONB;
  v_actual_keys TEXT[];
  v_expected_keys TEXT[] := ARRAY[
    'category', 'latitude', 'longitude', 'public_reference',
    'status', 'submitted_date', 'title', 'ward'
  ];
BEGIN
  -- 11.1 Verify all 7 new tables exist, have RLS enabled, and revoke anon & authenticated mutations
  FOR v_tbl IN
    SELECT pg_catalog.unnest(ARRAY[
      'category_sla_rules',
      'department_heads',
      'complaint_sla_state',
      'complaint_escalations',
      'complaint_reminders',
      'notifications',
      'sweep_runs'
    ])
  LOOP
    SELECT c.relrowsecurity INTO v_rls
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_tbl;

    IF v_rls IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Verification Failed: RLS not enabled on public.%.', v_tbl;
    END IF;

    IF pg_catalog.has_table_privilege('anon', 'public.' || v_tbl, 'SELECT') OR
       pg_catalog.has_table_privilege('anon', 'public.' || v_tbl, 'INSERT') OR
       pg_catalog.has_table_privilege('anon', 'public.' || v_tbl, 'UPDATE') OR
       pg_catalog.has_table_privilege('anon', 'public.' || v_tbl, 'DELETE') THEN
      RAISE EXCEPTION 'Verification Failed: anon holds privileges on public.%.', v_tbl;
    END IF;

    IF pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'INSERT') OR
       pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'UPDATE') OR
       pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'DELETE') OR
       pg_catalog.has_table_privilege('authenticated', 'public.' || v_tbl, 'TRUNCATE') THEN
      RAISE EXCEPTION 'Verification Failed: authenticated holds direct mutation privileges on public.%.', v_tbl;
    END IF;
  END LOOP;

  -- 11.2 Verify exact 6 category SLA rules seeded
  IF (SELECT pg_catalog.count(*) FROM public.category_sla_rules) <> 6 THEN
    RAISE EXCEPTION 'Verification Failed: Expected exactly 6 seeded category_sla_rules rows.';
  END IF;

  -- 11.3 Verify all new RPC signatures exist via to_regprocedure & check privilege isolation
  IF to_regprocedure('public.update_category_sla_rule(character varying,integer,integer,integer,integer)') IS NULL OR
     to_regprocedure('public.set_department_head(uuid,uuid)') IS NULL OR
     to_regprocedure('public.escalate_complaint_manual(uuid,text,timestamp with time zone)') IS NULL OR
     to_regprocedure('public.mark_notification_read(uuid)') IS NULL OR
     to_regprocedure('public.get_citizen_complaint_followup_status(uuid)') IS NULL OR
     to_regprocedure('public.run_sla_sweep(integer,text)') IS NULL THEN
    RAISE EXCEPTION 'Verification Failed: One or more Phase 7 RPC signatures are missing.';
  END IF;

  FOR v_fn IN
    SELECT p.oid, p.proname, p.prosecdef, r.rolname AS owner_name, p.proconfig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'update_category_sla_rule',
        'set_department_head',
        'escalate_complaint_manual',
        'mark_notification_read',
        'get_citizen_complaint_followup_status',
        'run_sla_sweep',
        'get_active_department_head'
      )
  LOOP
    IF NOT v_fn.prosecdef THEN
      RAISE EXCEPTION 'Verification Failed: % is not SECURITY DEFINER.', v_fn.proname;
    END IF;
    IF v_fn.owner_name <> 'postgres' THEN
      RAISE EXCEPTION 'Verification Failed: % owner is %, expected postgres.', v_fn.proname, v_fn.owner_name;
    END IF;
    IF v_fn.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_fn.proconfig) cfg WHERE cfg ~ '^search_path=(|"")$'
    ) THEN
      RAISE EXCEPTION 'Verification Failed: % missing fixed empty search_path.', v_fn.proname;
    END IF;
    IF pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Verification Failed: anon has EXECUTE on %.', v_fn.proname;
    END IF;
  END LOOP;

  -- Specifically confirm run_sla_sweep and get_active_department_head cannot be called by authenticated
  IF pg_catalog.has_function_privilege('authenticated', 'public.run_sla_sweep(integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification Failed: authenticated role must NOT have EXECUTE on run_sla_sweep.';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role', 'public.run_sla_sweep(integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification Failed: service_role missing EXECUTE on run_sla_sweep.';
  END IF;
  IF pg_catalog.has_function_privilege('authenticated', 'public.get_active_department_head(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification Failed: authenticated role must NOT have EXECUTE on get_active_department_head.';
  END IF;

  -- Confirm authenticated HAS EXECUTE on user/admin RPCs
  IF NOT pg_catalog.has_function_privilege('authenticated', 'public.update_category_sla_rule(character varying,integer,integer,integer,integer)', 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('authenticated', 'public.set_department_head(uuid,uuid)', 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('authenticated', 'public.escalate_complaint_manual(uuid,text,timestamp with time zone)', 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('authenticated', 'public.mark_notification_read(uuid)', 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('authenticated', 'public.get_citizen_complaint_followup_status(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification Failed: authenticated role missing EXECUTE on an expected Phase 7 RPC.';
  END IF;

  -- 11.4 Confirm Phase 6.2 public function allow-list remains completely unaltered
  v_list_res := public.public_complaint_list(NULL, NULL, NULL, 1, 20);
  IF pg_catalog.jsonb_array_length(v_list_res -> 'items') > 0 THEN
    SELECT pg_catalog.array_agg(k ORDER BY k)
    INTO v_actual_keys
    FROM pg_catalog.jsonb_object_keys((v_list_res -> 'items') -> 0) AS k;

    IF v_actual_keys IS DISTINCT FROM v_expected_keys THEN
      RAISE EXCEPTION 'Verification Failed: Phase 6 public field allow-list drifted!';
    END IF;
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- OPERATOR-CONTROLLED ROLLBACK SECTION (NO CASCADE — REVERSE DEPENDENCY ORDER)
-- =============================================================================
-- Notes:
--   1. Only execute manually if rolling back Phase 7 before production adoption.
--   2. Preserves all complaints & Phase 6.2 public functions untouched.
--
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.run_sla_sweep(INT, TEXT) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.get_citizen_complaint_followup_status(UUID) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION public.mark_notification_read(UUID) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION public.escalate_complaint_manual(UUID, TEXT, TIMESTAMPTZ) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION public.set_department_head(UUID, UUID) FROM authenticated;
-- REVOKE EXECUTE ON FUNCTION public.update_category_sla_rule(VARCHAR, INT, INT, INT, INT) FROM authenticated;
--
-- DROP TRIGGER IF EXISTS trg_z_phase7_complaint_reassignment_notify ON public.complaints;
-- DROP TRIGGER IF EXISTS trg_z_phase7_complaint_state_init ON public.complaints;
-- DROP TRIGGER IF EXISTS trg_z_phase7_assign_default_sla ON public.complaints;
--
-- DROP FUNCTION IF EXISTS public.run_sla_sweep(INT, TEXT);
-- DROP FUNCTION IF EXISTS public.get_citizen_complaint_followup_status(UUID);
-- DROP FUNCTION IF EXISTS public.mark_notification_read(UUID);
-- DROP FUNCTION IF EXISTS public.escalate_complaint_manual(UUID, TEXT, TIMESTAMPTZ);
-- DROP FUNCTION IF EXISTS public.set_department_head(UUID, UUID);
-- DROP FUNCTION IF EXISTS public.update_category_sla_rule(VARCHAR, INT, INT, INT, INT);
-- DROP FUNCTION IF EXISTS public.handle_phase7_complaint_assignment_events();
-- DROP FUNCTION IF EXISTS public.assign_default_sla_on_insert();
-- DROP FUNCTION IF EXISTS public.get_active_department_head(UUID);
--
-- DROP TRIGGER IF EXISTS trg_guard_immutable_complaint_reminders_truncate ON public.complaint_reminders;
-- DROP TRIGGER IF EXISTS trg_guard_immutable_complaint_reminders ON public.complaint_reminders;
-- DROP FUNCTION IF EXISTS public.guard_immutable_complaint_reminders();
--
-- DROP TRIGGER IF EXISTS trg_guard_immutable_complaint_escalations_truncate ON public.complaint_escalations;
-- DROP TRIGGER IF EXISTS trg_guard_immutable_complaint_escalations ON public.complaint_escalations;
-- DROP FUNCTION IF EXISTS public.guard_immutable_complaint_escalations();
--
-- DROP TRIGGER IF EXISTS trg_guard_category_sla_rules_lock ON public.category_sla_rules;
-- DROP FUNCTION IF EXISTS public.guard_category_sla_rules_lock();
--
-- DROP INDEX IF EXISTS public.idx_sweep_runs_started;
-- DROP TABLE IF EXISTS public.sweep_runs;
--
-- DROP INDEX IF EXISTS public.idx_notifications_complaint;
-- DROP INDEX IF EXISTS public.idx_notifications_recipient_unread_created;
-- DROP TABLE IF EXISTS public.notifications;
--
-- DROP INDEX IF EXISTS public.idx_complaint_reminders_officer_created;
-- DROP TABLE IF EXISTS public.complaint_reminders;
--
-- DROP INDEX IF EXISTS public.idx_complaint_escalations_status_created;
-- DROP INDEX IF EXISTS public.idx_complaint_escalations_complaint_created;
-- DROP INDEX IF EXISTS public.uq_complaint_escalations_blocked_reason;
-- DROP INDEX IF EXISTS public.uq_complaint_escalations_completed_level;
-- DROP TABLE IF EXISTS public.complaint_escalations;
--
-- DROP TABLE IF EXISTS public.complaint_sla_state;
--
-- DROP INDEX IF EXISTS public.idx_department_heads_active_profile;
-- DROP INDEX IF EXISTS public.uq_department_heads_active_dept;
-- DROP TABLE IF EXISTS public.department_heads;
--
-- DROP TABLE IF EXISTS public.category_sla_rules;
-- COMMIT;
