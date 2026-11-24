-- =============================================================================
-- Migration: 20261124_phase4_2_admin_complaint_management.sql
-- Module: Phase 4.2 — Municipal Admin Complaint Management & Assignment Engine (Revised)
-- Target: Supabase PostgreSQL
--
-- Safety Guarantees:
--   - Idempotent and transaction-safe (BEGIN ... COMMIT).
--   - Adds missing columns 'description' and 'is_active' to public.departments.
--   - Prohibits hard deletion of municipal departments (forces deactivation).
--   - Enforces single write path on complaints: revokes direct UPDATE on
--     department_id, assigned_officer_id, priority, sla_deadline, and image_url.
--     Changes to department, officer, priority, and SLA MUST route through assign_complaint_admin.
--   - Re-grants column-level UPDATE only on operational columns: (title, description, location, ward, latitude, longitude, completion_image_url).
--   - Prohibits direct table-level mutations on public.officers: REVOKE INSERT, UPDATE, DELETE from authenticated, anon, PUBLIC.
--     Officer modifications must route through link_officer_user and update_officer_status RPCs.
--   - Updates guard_profile_updates() so verified admins can link citizens as officers
--     via authorized functions, while admin promotions remain strictly restricted.
--   - Protects complaint INSERT: guard_complaint_assignment_integrity uses nested IF
--     to ensure OLD record is never referenced during INSERT.
--   - Implements append-only public.complaint_assignment_audit with ON DELETE RESTRICT.
--   - Implements append-only public.officer_management_audit with ON DELETE RESTRICT.
--   - Adds guard trigger trg_guard_officer_updates on public.officers blocking deactivation
--     or department transfers while an officer holds open complaints, whoever runs the update.
--   - Adds audit trigger trg_audit_officer_updates recording all department/status changes.
--   - Implements atomic public.assign_complaint_admin() with row lock (FOR UPDATE),
--     officer lock (FOR SHARE) to prevent concurrent deactivation, required
--     p_expected_updated_at concurrency check, terminal state check (rejecting resolved/rejected),
--     and COALESCE priority fallback.
--   - Implements public.link_officer_user() locking profiles FOR UPDATE, strictly
--     restricting promotion to role = 'citizen' (rejecting admins & existing officers),
--     and writing audit records with UUIDs only (zero email PII).
--   - Complete rollback section restoring exact Phase 2 guard_profile_updates() and grants.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaints'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaints does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'departments'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.departments does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'officers'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.officers does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.profiles does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'is_admin' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Helper function public.is_admin() does not exist.';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Department Enhancements & Hard Delete Prevention
-- -----------------------------------------------------------------------------
ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS description TEXT NULL,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Revoke DELETE privilege on departments from all client roles
REVOKE DELETE ON TABLE public.departments FROM PUBLIC, anon, authenticated;

-- Guard trigger to block hard deletion even if executed by database operators
CREATE OR REPLACE FUNCTION public.guard_departments_no_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Municipal departments cannot be hard-deleted. Use deactivation (is_active = FALSE) instead to preserve civic history.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_departments_no_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_departments_no_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_departments_no_delete ON public.departments;
CREATE TRIGGER trg_guard_departments_no_delete
  BEFORE DELETE ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.guard_departments_no_delete();

-- Guard trigger preventing deactivation of departments that hold open complaints
CREATE OR REPLACE FUNCTION public.guard_department_deactivation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_open_count INT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.is_active = FALSE AND OLD.is_active = TRUE THEN
    SELECT count(*) INTO v_open_count
    FROM public.complaints
    WHERE department_id = OLD.id
      AND status NOT IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status);

    IF v_open_count > 0 THEN
      RAISE EXCEPTION 'Cannot deactivate department "%" because it holds % open complaint(s). Reassign these complaints before deactivating.'
        , OLD.name, v_open_count
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_department_deactivation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_department_deactivation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_department_deactivation ON public.departments;
CREATE TRIGGER trg_guard_department_deactivation
  BEFORE UPDATE OF is_active ON public.departments
  FOR EACH ROW EXECUTE FUNCTION public.guard_department_deactivation();

-- -----------------------------------------------------------------------------
-- 3. Profile Privilege Modification Guard Revision
-- -----------------------------------------------------------------------------
-- Allows verified municipal administrators (via link_officer_user) to promote
-- citizens to officers through the API, while admin promotions remain strictly
-- reserved for backend operators via provision_admin_user. Citizens remain 100% blocked.
CREATE OR REPLACE FUNCTION public.guard_profile_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (NEW.role IS DISTINCT FROM OLD.role) OR
     (NEW.civic_points IS DISTINCT FROM OLD.civic_points) OR
     (NEW.badge_level IS DISTINCT FROM OLD.badge_level) THEN

    -- Role transition to 'admin' is strictly reserved for database operators or backend service_role
    IF NEW.role = 'admin'::public.user_role AND OLD.role IS DISTINCT FROM 'admin'::public.user_role THEN
      IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
        RAISE EXCEPTION 'Promotion to admin role requires authorized service credentials.' USING ERRCODE = '42501';
      END IF;

    -- Role transitions to 'officer' or 'citizen' are permitted if caller is a verified municipal admin
    -- or has service_role or session_user in ('postgres', 'supabase_admin')
    ELSIF auth.role() IS DISTINCT FROM 'service_role'
       AND session_user NOT IN ('postgres', 'supabase_admin')
       AND NOT (SELECT public.is_admin()) THEN
      RAISE EXCEPTION 'Modifications to role, points, or badges require authorized administrative or service credentials.' USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_profile_updates() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_profile_updates() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Single Write Path for Assignments: Revoke Direct UPDATE on Complaints
-- -----------------------------------------------------------------------------
-- Explicitly revoke broad table UPDATE and specific column UPDATE on assignment,
-- priority, and SLA columns. Changes to department, officer, priority, and SLA
-- MUST go strictly through assign_complaint_admin.
REVOKE UPDATE ON TABLE public.complaints FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (department_id, assigned_officer_id, priority, sla_deadline, image_url)
  ON TABLE public.complaints FROM PUBLIC, anon, authenticated;

GRANT UPDATE (title, description, location, ward, latitude, longitude, completion_image_url)
  ON TABLE public.complaints TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Revoke Direct Table Modifications on Officers
-- -----------------------------------------------------------------------------
-- Prohibits direct INSERT, UPDATE, DELETE on officers from client roles.
-- Officer linking and lifecycle changes MUST go through link_officer_user and update_officer_status RPCs.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.officers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.officers TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Database-Level Assignment Integrity Guard (Safe for INSERT)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_complaint_assignment_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_officer RECORD;
  v_dept_active BOOLEAN;
BEGIN
  -- 6.1 Department validity check
  IF NEW.department_id IS NOT NULL THEN
    SELECT is_active INTO v_dept_active
    FROM public.departments
    WHERE id = NEW.department_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assignment Integrity Violation: Department % does not exist.', NEW.department_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_dept_active THEN
      RAISE EXCEPTION 'Assignment Integrity Violation: Cannot assign complaint to inactive department %.', NEW.department_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 6.2 Auto-clear officer assignment if department changed and officer is not reassigned
  -- Uses nested IF to strictly ensure OLD is NEVER accessed during INSERT statements
  IF TG_OP = 'UPDATE' THEN
    IF OLD.department_id IS DISTINCT FROM NEW.department_id THEN
      IF NEW.assigned_officer_id IS NOT NULL AND NEW.assigned_officer_id = OLD.assigned_officer_id THEN
        -- The officer belonged to the prior department; auto-clear unless a new officer was explicitly set
        NEW.assigned_officer_id := NULL;
      END IF;
    END IF;
  END IF;

  -- 6.3 Officer validity check
  IF NEW.assigned_officer_id IS NOT NULL THEN
    IF NEW.department_id IS NULL THEN
      RAISE EXCEPTION 'Assignment Integrity Violation: Cannot assign an officer when no department is assigned.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT id, department_id, is_active INTO v_officer
    FROM public.officers
    WHERE id = NEW.assigned_officer_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assignment Integrity Violation: Officer % does not exist.', NEW.assigned_officer_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_officer.is_active THEN
      RAISE EXCEPTION 'Assignment Integrity Violation: Officer % is inactive and cannot receive complaint assignments.', NEW.assigned_officer_id
        USING ERRCODE = 'P0001';
    END IF;

    IF v_officer.department_id IS DISTINCT FROM NEW.department_id THEN
      RAISE EXCEPTION 'Assignment Integrity Violation: Officer % belongs to department %, not assigned department %.',
        NEW.assigned_officer_id, v_officer.department_id, NEW.department_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_complaint_assignment_integrity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_complaint_assignment_integrity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_complaint_assignment_integrity ON public.complaints;
CREATE TRIGGER trg_guard_complaint_assignment_integrity
  BEFORE INSERT OR UPDATE OF department_id, assigned_officer_id ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.guard_complaint_assignment_integrity();

-- -----------------------------------------------------------------------------
-- 7. Append-Only Complaint Assignment Audit Table (RESTRICT Foreign Keys)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_assignment_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  actor_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  prev_department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  new_department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  prev_officer_id UUID NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  new_officer_id UUID NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  prev_priority public.complaint_priority NOT NULL,
  new_priority public.complaint_priority NOT NULL,
  prev_sla_deadline TIMESTAMPTZ NULL,
  new_sla_deadline TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.complaint_assignment_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_assignment_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.complaint_assignment_audit TO authenticated;

DROP POLICY IF EXISTS "Admins can view assignment audit" ON public.complaint_assignment_audit;
CREATE POLICY "Admins can view assignment audit" ON public.complaint_assignment_audit
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Strict immutability triggers (UPDATE, DELETE, TRUNCATE blocked)
CREATE OR REPLACE FUNCTION public.guard_immutable_assignment_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Complaint assignment audit records are strictly immutable and cannot be modified or deleted.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_assignment_audit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_assignment_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_assignment_audit ON public.complaint_assignment_audit;
CREATE TRIGGER trg_guard_immutable_assignment_audit
  BEFORE UPDATE OR DELETE ON public.complaint_assignment_audit
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_assignment_audit();

DROP TRIGGER IF EXISTS trg_guard_immutable_assignment_audit_truncate ON public.complaint_assignment_audit;
CREATE TRIGGER trg_guard_immutable_assignment_audit_truncate
  BEFORE TRUNCATE ON public.complaint_assignment_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_assignment_audit();

CREATE INDEX IF NOT EXISTS idx_assignment_audit_complaint
  ON public.complaint_assignment_audit(complaint_id);

CREATE INDEX IF NOT EXISTS idx_assignment_audit_created
  ON public.complaint_assignment_audit(created_at DESC);

-- -----------------------------------------------------------------------------
-- 8. Officer Roster Guard & Append-Only Audit Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.officer_management_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  officer_id UUID NOT NULL REFERENCES public.officers(id) ON DELETE RESTRICT,
  actor_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  prev_department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  new_department_id UUID NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  prev_is_active BOOLEAN NULL,
  new_is_active BOOLEAN NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.officer_management_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.officer_management_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.officer_management_audit TO authenticated;

DROP POLICY IF EXISTS "Admins can view officer management audit" ON public.officer_management_audit;
CREATE POLICY "Admins can view officer management audit" ON public.officer_management_audit
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Strict immutability triggers for officer management audit
CREATE OR REPLACE FUNCTION public.guard_immutable_officer_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Officer management audit records are strictly immutable and cannot be modified or deleted.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_officer_audit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_officer_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_officer_audit ON public.officer_management_audit;
CREATE TRIGGER trg_guard_immutable_officer_audit
  BEFORE UPDATE OR DELETE ON public.officer_management_audit
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_officer_audit();

DROP TRIGGER IF EXISTS trg_guard_immutable_officer_audit_truncate ON public.officer_management_audit;
CREATE TRIGGER trg_guard_immutable_officer_audit_truncate
  BEFORE TRUNCATE ON public.officer_management_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_officer_audit();

CREATE INDEX IF NOT EXISTS idx_officer_audit_officer
  ON public.officer_management_audit(officer_id);

CREATE INDEX IF NOT EXISTS idx_officer_audit_created
  ON public.officer_management_audit(created_at DESC);

-- Guard trigger on public.officers: blocks changing department_id or deactivating
-- while the officer holds open complaints, regardless of caller
CREATE OR REPLACE FUNCTION public.guard_officer_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_open_complaints INT;
  v_dept_active BOOLEAN;
BEGIN
  -- Block department transfer or deactivation while holding open complaints
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id) OR
     (NEW.is_active = FALSE AND OLD.is_active = TRUE) THEN

    SELECT count(*) INTO v_open_complaints
    FROM public.complaints
    WHERE assigned_officer_id = OLD.id
      AND status NOT IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status);

    IF v_open_complaints > 0 THEN
      RAISE EXCEPTION 'Officer Integrity Violation: Cannot transfer or deactivate officer "%" (ID: %) while they hold % open complaint(s). Reassign all complaints first.',
        OLD.official_name, OLD.id, v_open_complaints
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Validate target department if changing department
  IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
    SELECT is_active INTO v_dept_active
    FROM public.departments
    WHERE id = NEW.department_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Officer Integrity Violation: Target department % does not exist.', NEW.department_id
        USING ERRCODE = '23503';
    END IF;

    IF NOT v_dept_active THEN
      RAISE EXCEPTION 'Officer Integrity Violation: Cannot transfer officer to inactive department %.', NEW.department_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_officer_updates() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_officer_updates() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_officer_updates ON public.officers;
CREATE TRIGGER trg_guard_officer_updates
  BEFORE UPDATE ON public.officers
  FOR EACH ROW EXECUTE FUNCTION public.guard_officer_updates();

-- Audit trigger on public.officers: records department and status changes
CREATE OR REPLACE FUNCTION public.audit_officer_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID;
  v_action TEXT;
BEGIN
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id) OR (NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
    v_actor_id := auth.uid();

    IF (NEW.department_id IS DISTINCT FROM OLD.department_id) AND (NEW.is_active IS DISTINCT FROM OLD.is_active) THEN
      v_action := 'DEPARTMENT_TRANSFER_AND_STATUS_CHANGE';
    ELSIF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
      v_action := 'DEPARTMENT_TRANSFER';
    ELSE
      v_action := 'STATUS_CHANGE';
    END IF;

    INSERT INTO public.officer_management_audit (
      officer_id,
      actor_id,
      action,
      prev_department_id,
      new_department_id,
      prev_is_active,
      new_is_active,
      created_at
    ) VALUES (
      NEW.id,
      v_actor_id,
      v_action,
      OLD.department_id,
      NEW.department_id,
      OLD.is_active,
      NEW.is_active,
      pg_catalog.now()
    );
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.audit_officer_updates() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.audit_officer_updates() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_officer_updates ON public.officers;
CREATE TRIGGER trg_audit_officer_updates
  AFTER UPDATE ON public.officers
  FOR EACH ROW EXECUTE FUNCTION public.audit_officer_updates();

-- -----------------------------------------------------------------------------
-- 9. Atomic Assignment, Priority & SLA Deadline Function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_complaint_admin(
  p_complaint_id UUID,
  p_department_id UUID,
  p_officer_id UUID,
  p_priority public.complaint_priority,
  p_sla_deadline TIMESTAMPTZ,
  p_expected_updated_at TIMESTAMPTZ
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old RECORD;
  v_final_officer_id UUID := p_officer_id;
  v_final_priority public.complaint_priority;
  v_dept_active BOOLEAN;
  v_officer RECORD;
  v_actor_id UUID;
  v_new RECORD;
BEGIN
  -- 9.1 Check administrative privileges
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Only municipal administrators can assign complaints.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Security Violation: Missing authenticated actor.' USING ERRCODE = '42501';
  END IF;

  -- 9.2 Validate required expected_updated_at (NOT NULL check)
  IF p_expected_updated_at IS NULL THEN
    RAISE EXCEPTION 'Concurrency Requirement: p_expected_updated_at is required and cannot be null.'
      USING ERRCODE = 'P0004';
  END IF;

  -- 9.3 Lock complaint row for update (pessimistic concurrency)
  SELECT id, department_id, assigned_officer_id, priority, sla_deadline, updated_at, status
  INTO v_old
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Complaint % not found.', p_complaint_id USING ERRCODE = 'P0002';
  END IF;

  -- 9.4 Terminal state check: reject assignment changes on resolved or rejected complaints
  IF v_old.status IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status) THEN
    RAISE EXCEPTION 'Terminal State Violation: Cannot modify assignments or SLA on a % complaint.', v_old.status
      USING ERRCODE = 'P0001';
  END IF;

  -- 9.5 Concurrency check: Reject if modified since loaded (millisecond truncation)
  IF date_trunc('milliseconds', v_old.updated_at) != date_trunc('milliseconds', p_expected_updated_at) THEN
    RAISE EXCEPTION 'Concurrency Conflict: This complaint was modified by another operator (expected %, current %). Please refresh and try again.',
      p_expected_updated_at, v_old.updated_at
      USING ERRCODE = 'P0004';
  END IF;

  -- 9.6 Priority resolution with COALESCE fallback
  v_final_priority := COALESCE(p_priority, v_old.priority);

  -- 9.7 Department validation
  IF p_department_id IS NOT NULL THEN
    SELECT is_active INTO v_dept_active
    FROM public.departments
    WHERE id = p_department_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Department % does not exist.', p_department_id USING ERRCODE = '23503';
    END IF;

    IF NOT v_dept_active THEN
      RAISE EXCEPTION 'Cannot assign complaint to an inactive department.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 9.8 Handle department change clearing officer
  IF v_old.department_id IS DISTINCT FROM p_department_id THEN
    -- If officer was not explicitly provided for the new department, or was the old officer, clear it
    IF v_final_officer_id IS NOT NULL AND v_final_officer_id = v_old.assigned_officer_id THEN
      v_final_officer_id := NULL;
    END IF;
  END IF;

  -- 9.9 Officer validation and row lock (FOR SHARE) to prevent concurrent deactivation/transfer
  IF v_final_officer_id IS NOT NULL THEN
    IF p_department_id IS NULL THEN
      RAISE EXCEPTION 'Cannot assign an officer without assigning a municipal department.' USING ERRCODE = 'P0001';
    END IF;

    -- Concurrency Guard: Lock officer row with FOR SHARE
    SELECT id, department_id, is_active INTO v_officer
    FROM public.officers
    WHERE id = v_final_officer_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Officer % does not exist.', v_final_officer_id USING ERRCODE = '23503';
    END IF;

    IF NOT v_officer.is_active THEN
      RAISE EXCEPTION 'Officer % is inactive and cannot receive assignments.', v_final_officer_id USING ERRCODE = 'P0001';
    END IF;

    IF v_officer.department_id IS DISTINCT FROM p_department_id THEN
      RAISE EXCEPTION 'Officer belongs to a different department than the assigned department.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- 9.10 Update complaint record atomically (does NOT alter status)
  UPDATE public.complaints
  SET department_id = p_department_id,
      assigned_officer_id = v_final_officer_id,
      priority = v_final_priority,
      sla_deadline = p_sla_deadline,
      updated_at = pg_catalog.now()
  WHERE id = p_complaint_id
  RETURNING * INTO v_new;

  -- 9.11 Insert immutable assignment audit row
  INSERT INTO public.complaint_assignment_audit (
    complaint_id,
    actor_id,
    prev_department_id,
    new_department_id,
    prev_officer_id,
    new_officer_id,
    prev_priority,
    new_priority,
    prev_sla_deadline,
    new_sla_deadline,
    created_at
  ) VALUES (
    p_complaint_id,
    v_actor_id,
    v_old.department_id,
    p_department_id,
    v_old.assigned_officer_id,
    v_final_officer_id,
    v_old.priority,
    v_final_priority,
    v_old.sla_deadline,
    p_sla_deadline,
    pg_catalog.now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'complaint_id', v_new.id,
    'department_id', v_new.department_id,
    'assigned_officer_id', v_new.assigned_officer_id,
    'priority', v_new.priority,
    'sla_deadline', v_new.sla_deadline,
    'updated_at', v_new.updated_at
  );
END;
$$;

ALTER FUNCTION public.assign_complaint_admin(UUID, UUID, UUID, public.complaint_priority, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_complaint_admin(UUID, UUID, UUID, public.complaint_priority, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_complaint_admin(UUID, UUID, UUID, public.complaint_priority, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- -----------------------------------------------------------------------------
-- 10. Officer Roster Management Functions
-- -----------------------------------------------------------------------------

-- 10.1 Admin Officers Directory Query Function (Safely resolves officer email without exposing auth.users directly)
CREATE OR REPLACE FUNCTION public.get_admin_officers_directory()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_agg(row_to_json(roster))
  INTO v_result
  FROM (
    SELECT
      o.id,
      o.profile_id,
      o.department_id,
      d.name AS department_name,
      d.code AS department_code,
      o.official_name,
      o.designation,
      o.assigned_ward,
      o.is_active,
      o.created_at,
      u.email AS officer_email,
      p.phone_number AS officer_phone,
      (
        SELECT count(*)
        FROM public.complaints c
        WHERE c.assigned_officer_id = o.id
          AND c.status NOT IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status)
      ) AS active_complaints_count,
      (
        SELECT count(*)
        FROM public.complaints c
        WHERE c.assigned_officer_id = o.id
          AND c.status = 'resolved'::public.complaint_status
      ) AS resolved_complaints_count
    FROM public.officers o
    JOIN public.departments d ON d.id = o.department_id
    LEFT JOIN public.profiles p ON p.id = o.profile_id
    LEFT JOIN auth.users u ON u.id = o.profile_id
    ORDER BY o.official_name ASC
  ) roster;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

ALTER FUNCTION public.get_admin_officers_directory() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_officers_directory() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_officers_directory() TO authenticated;

-- 10.2 Link Registered User as Officer (Admin-only, citizen-only role promotion with lock & audit)
CREATE OR REPLACE FUNCTION public.link_officer_user(
  p_user_email TEXT,
  p_department_id UUID,
  p_official_name TEXT,
  p_designation TEXT,
  p_assigned_ward TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target_user_id UUID;
  v_target_profile RECORD;
  v_existing_officer UUID;
  v_dept_active BOOLEAN;
  v_new_officer_id UUID;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  -- Verify department exists and is active
  SELECT is_active INTO v_dept_active
  FROM public.departments
  WHERE id = p_department_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Department does not exist.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_dept_active THEN
    RAISE EXCEPTION 'Cannot link officer to an inactive department.' USING ERRCODE = 'P0001';
  END IF;

  -- Locate user by email in auth.users
  SELECT id INTO v_target_user_id
  FROM auth.users
  WHERE email = LOWER(TRIM(p_user_email));

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'User with email "%" not found. The officer must create an account first.', p_user_email
      USING ERRCODE = 'P0002';
  END IF;

  -- Lock the target public.profiles row before checking its role
  SELECT id, role INTO v_target_profile
  FROM public.profiles
  WHERE id = v_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile record for user UUID % not found.', v_target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Strictly require target profile to have role = 'citizen'.
  -- Reject admins, existing officers, or any unexpected role.
  IF v_target_profile.role IS DISTINCT FROM 'citizen'::public.user_role THEN
    RAISE EXCEPTION 'Role Violation: Only users with "citizen" role can be promoted to officer. User % has role "%".',
      p_user_email, v_target_profile.role
      USING ERRCODE = '42501';
  END IF;

  -- Check unique constraint on public.officers.profile_id
  SELECT id INTO v_existing_officer
  FROM public.officers
  WHERE profile_id = v_target_user_id;

  IF v_existing_officer IS NOT NULL THEN
    RAISE EXCEPTION 'User is already linked to an officer record (Officer ID: %).', v_existing_officer
      USING ERRCODE = '23505';
  END IF;

  -- Update role to officer in public.profiles (safely allowed by updated guard_profile_updates)
  UPDATE public.profiles
  SET role = 'officer'::public.user_role,
      updated_at = pg_catalog.now()
  WHERE id = v_target_user_id;

  -- Insert into public.officers
  INSERT INTO public.officers (
    profile_id,
    department_id,
    official_name,
    designation,
    assigned_ward,
    is_active,
    created_at
  ) VALUES (
    v_target_user_id,
    p_department_id,
    TRIM(p_official_name),
    TRIM(p_designation),
    NULLIF(TRIM(p_assigned_ward), ''),
    TRUE,
    pg_catalog.now()
  )
  RETURNING id INTO v_new_officer_id;

  -- Insert immutable officer management audit row (Strictly IDs only, no email PII in notes)
  INSERT INTO public.officer_management_audit (
    officer_id,
    actor_id,
    action,
    prev_department_id,
    new_department_id,
    prev_is_active,
    new_is_active,
    notes,
    created_at
  ) VALUES (
    v_new_officer_id,
    auth.uid(),
    'LINK_OFFICER',
    NULL,
    p_department_id,
    NULL,
    TRUE,
    'Linked profile UUID ' || v_target_user_id || ' to department UUID ' || p_department_id || '.',
    pg_catalog.now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'officer_id', v_new_officer_id,
    'profile_id', v_target_user_id
  );
END;
$$;

ALTER FUNCTION public.link_officer_user(TEXT, UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.link_officer_user(TEXT, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_officer_user(TEXT, UUID, TEXT, TEXT, TEXT) TO authenticated;

-- 10.3 Update Officer Status / Transfer Department (Checked via trigger trg_guard_officer_updates)
CREATE OR REPLACE FUNCTION public.update_officer_status(
  p_officer_id UUID,
  p_is_active BOOLEAN,
  p_new_department_id UUID DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_curr_officer RECORD;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_curr_officer
  FROM public.officers
  WHERE id = p_officer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Officer does not exist.' USING ERRCODE = 'P0002';
  END IF;

  -- Apply update. Trigger trg_guard_officer_updates will enforce zero open complaints
  -- and trg_audit_officer_updates will record the audit log.
  IF p_new_department_id IS NOT NULL AND p_new_department_id IS DISTINCT FROM v_curr_officer.department_id THEN
    UPDATE public.officers
    SET department_id = p_new_department_id,
        is_active = p_is_active
    WHERE id = p_officer_id;
  ELSE
    UPDATE public.officers
    SET is_active = p_is_active
    WHERE id = p_officer_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'officer_id', p_officer_id,
    'is_active', p_is_active
  );
END;
$$;

ALTER FUNCTION public.update_officer_status(UUID, BOOLEAN, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_officer_status(UUID, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_officer_status(UUID, BOOLEAN, UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- 11. Admin Overview Statistics Function
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_overview_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  WITH status_counts AS (
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE status = 'submitted'::public.complaint_status) AS submitted,
      count(*) FILTER (WHERE status = 'under_review'::public.complaint_status) AS under_review,
      count(*) FILTER (WHERE status = 'in_progress'::public.complaint_status) AS in_progress,
      count(*) FILTER (WHERE status = 'resolved'::public.complaint_status) AS resolved,
      count(*) FILTER (WHERE status = 'rejected'::public.complaint_status) AS rejected,
      count(*) FILTER (WHERE sla_deadline IS NOT NULL AND sla_deadline < pg_catalog.now() AND status NOT IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status)) AS overdue
    FROM public.complaints
  ),
  priority_counts AS (
    SELECT
      count(*) FILTER (WHERE priority = 'low'::public.complaint_priority) AS low,
      count(*) FILTER (WHERE priority = 'normal'::public.complaint_priority) AS normal,
      count(*) FILTER (WHERE priority = 'medium'::public.complaint_priority) AS medium,
      count(*) FILTER (WHERE priority = 'high'::public.complaint_priority) AS high,
      count(*) FILTER (WHERE priority = 'emergency'::public.complaint_priority) AS emergency
    FROM public.complaints
  ),
  dept_counts AS (
    SELECT
      d.id AS department_id,
      d.name AS department_name,
      d.code AS department_code,
      d.is_active,
      count(c.id) AS complaint_count,
      count(c.id) FILTER (WHERE c.status NOT IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status)) AS active_complaint_count
    FROM public.departments d
    LEFT JOIN public.complaints c ON c.department_id = d.id
    GROUP BY d.id, d.name, d.code, d.is_active
    ORDER BY d.name ASC
  ),
  recent_comps AS (
    SELECT
      c.id,
      c.complaint_number,
      c.title,
      c.status,
      c.priority,
      c.ward,
      c.sla_deadline,
      c.created_at,
      d.name AS department_name
    FROM public.complaints c
    LEFT JOIN public.departments d ON d.id = c.department_id
    ORDER BY c.created_at DESC
    LIMIT 6
  )
  SELECT jsonb_build_object(
    'counts', (SELECT row_to_json(sc) FROM status_counts sc),
    'priority', (SELECT row_to_json(pc) FROM priority_counts pc),
    'by_department', (SELECT jsonb_agg(row_to_json(dc)) FROM dept_counts dc),
    'recent_complaints', (SELECT jsonb_agg(row_to_json(rc)) FROM recent_comps rc)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.get_admin_overview_stats() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_overview_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_overview_stats() TO authenticated;

-- -----------------------------------------------------------------------------
-- 12. Post-Migration Verification Assertions
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'is_active'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Column departments.is_active missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaint_assignment_audit'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Table public.complaint_assignment_audit missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'officer_management_audit'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Table public.officer_management_audit missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'assign_complaint_admin' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Function public.assign_complaint_admin missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_admin_overview_stats' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Function public.get_admin_overview_stats missing.';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- Rollback Instructions (if needed):
-- =============================================================================
-- BEGIN;
-- -- 1. Drop assignment integrity triggers and functions
-- DROP TRIGGER IF EXISTS trg_guard_complaint_assignment_integrity ON public.complaints;
-- DROP FUNCTION IF EXISTS public.guard_complaint_assignment_integrity();
--
-- -- 2. Drop department triggers and functions
-- DROP TRIGGER IF EXISTS trg_guard_departments_no_delete ON public.departments;
-- DROP FUNCTION IF EXISTS public.guard_departments_no_delete();
-- DROP TRIGGER IF EXISTS trg_guard_department_deactivation ON public.departments;
-- DROP FUNCTION IF EXISTS public.guard_department_deactivation();
--
-- -- 3. Drop officer triggers and functions
-- DROP TRIGGER IF EXISTS trg_guard_officer_updates ON public.officers;
-- DROP FUNCTION IF EXISTS public.guard_officer_updates();
-- DROP TRIGGER IF EXISTS trg_audit_officer_updates ON public.officers;
-- DROP FUNCTION IF EXISTS public.audit_officer_updates();
--
-- -- 4. Restore exact original Phase 2 guard_profile_updates()
-- CREATE OR REPLACE FUNCTION public.guard_profile_updates()
-- RETURNS TRIGGER
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = ''
-- AS $$
-- BEGIN
--   IF (NEW.role IS DISTINCT FROM OLD.role) OR
--      (NEW.civic_points IS DISTINCT FROM OLD.civic_points) OR
--      (NEW.badge_level IS DISTINCT FROM OLD.badge_level) THEN
--     IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
--       RAISE EXCEPTION 'Modifications to role, points, or badges require authorized backend service credentials.' USING ERRCODE = '42501';
--     END IF;
--   END IF;
--
--   NEW.updated_at := pg_catalog.now();
--   RETURN NEW;
-- END;
-- $$;
--
-- -- 5. Drop administrative RPCs
-- DROP FUNCTION IF EXISTS public.assign_complaint_admin(UUID, UUID, UUID, public.complaint_priority, TIMESTAMPTZ, TIMESTAMPTZ);
-- DROP FUNCTION IF EXISTS public.get_admin_officers_directory();
-- DROP FUNCTION IF EXISTS public.link_officer_user(TEXT, UUID, TEXT, TEXT, TEXT);
-- DROP FUNCTION IF EXISTS public.update_officer_status(UUID, BOOLEAN, UUID);
-- DROP FUNCTION IF EXISTS public.get_admin_overview_stats();
--
-- -- 6. Restore exact original Phase 2 grants on complaints
-- GRANT UPDATE (title, description, location, ward, latitude, longitude, priority, department_id, assigned_officer_id, image_url, completion_image_url, sla_deadline) ON TABLE public.complaints TO authenticated;
--
-- -- 7. Restore exact original Phase 2 grants on officers
-- GRANT INSERT, UPDATE, DELETE ON TABLE public.officers TO authenticated;
--
-- -- Note: Audit tables public.complaint_assignment_audit and public.officer_management_audit
-- -- are preserved to maintain civic accountability and audit history.
-- COMMIT;
