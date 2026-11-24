-- =============================================================================
-- Migration: 20261124_phase4_1_admin_officer_authorization.sql
-- Module: Phase 4.1 — Municipal Admin Authorization & Access Architecture
-- Target: Supabase PostgreSQL
--
-- Safety Guarantees:
--   - Idempotent and transaction-safe (BEGIN ... COMMIT).
--   - Preserves existing public.user_role enum ('citizen', 'officer', 'admin').
--   - Adds helper public.get_current_officer_department_id() for department-level scoping.
--   - Updates public.complaints SELECT policy to grant department officers
--     visibility into complaints belonging to their assigned municipal department.
--   - Preserves strict administrative control over assignments: officers cannot
--     assign complaints to themselves or alter department records.
--   - Preserves immutable audit history policies and citizen RLS boundaries.
--   - Includes precondition checks, post-migration verification queries, and
--     explicit rollback instructions.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Exhaustive Precondition Checks
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing_cols TEXT;
  v_missing_roles TEXT;
BEGIN
  -- 1.1 Verify required tables exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaints'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaints does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'officers'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.officers does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'departments'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.departments does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaint_status_history does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.profiles does not exist.';
  END IF;

  -- 1.2 Verify required functions exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'is_admin' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Helper function public.is_admin() does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_current_officer_id' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Helper function public.get_current_officer_id() does not exist.';
  END IF;

  -- 1.3 Verify required table columns exist
  SELECT string_agg(col, ', ')
    INTO v_missing_cols
    FROM (
      SELECT 'officers.profile_id' AS col WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'officers' AND column_name = 'profile_id'
      )
      UNION ALL
      SELECT 'officers.is_active' WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'officers' AND column_name = 'is_active'
      )
      UNION ALL
      SELECT 'officers.department_id' WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'officers' AND column_name = 'department_id'
      )
      UNION ALL
      SELECT 'complaints.department_id' WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'department_id'
      )
      UNION ALL
      SELECT 'complaints.assigned_officer_id' WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'assigned_officer_id'
      )
      UNION ALL
      SELECT 'complaints.citizen_id' WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'citizen_id'
      )
      UNION ALL
      SELECT 'profiles.updated_at' WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'updated_at'
      )
    ) req;

  IF v_missing_cols IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Missing required column(s): %', v_missing_cols;
  END IF;

  -- 1.4 Verify public.user_role enum exists and contains all required values
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'user_role' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Type public.user_role does not exist.';
  END IF;

  SELECT string_agg(val, ', ')
    INTO v_missing_roles
    FROM (
      SELECT 'citizen' AS val WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_enum e
        JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'user_role' AND n.nspname = 'public' AND e.enumlabel = 'citizen'
      )
      UNION ALL
      SELECT 'officer' WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_enum e
        JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'user_role' AND n.nspname = 'public' AND e.enumlabel = 'officer'
      )
      UNION ALL
      SELECT 'admin' WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_enum e
        JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'user_role' AND n.nspname = 'public' AND e.enumlabel = 'admin'
      )
    ) req_roles;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: public.user_role enum missing required label(s): %', v_missing_roles;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Helper Function: Get Active Officer's Municipal Department ID
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_current_officer_department_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT department_id
  FROM public.officers
  WHERE profile_id = auth.uid()
    AND is_active = TRUE
  LIMIT 1;
$$;

ALTER FUNCTION public.get_current_officer_department_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_current_officer_department_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_officer_department_id() TO authenticated;

COMMENT ON FUNCTION public.get_current_officer_department_id() IS
  'Returns the department_id of the currently authenticated active officer. Used for departmental queue RLS.';

-- -----------------------------------------------------------------------------
-- 3. Departmental Indexes (Avoids Duplicating Existing Indexes)
-- -----------------------------------------------------------------------------
-- Existing indexes idx_complaints_citizen and idx_complaint_history_complaint
-- are preserved without creating redundant index definitions.
CREATE INDEX IF NOT EXISTS idx_complaints_department
  ON public.complaints(department_id);

CREATE INDEX IF NOT EXISTS idx_complaints_assigned_officer
  ON public.complaints(assigned_officer_id);

-- -----------------------------------------------------------------------------
-- 4. Update Complaints SELECT Policy (Department-level visibility)
-- -----------------------------------------------------------------------------
-- Drop prior complaint SELECT policies to prevent unintended OR-composition
DROP POLICY IF EXISTS "Complaints readable by owner, assigned officer, or admin" ON public.complaints;
DROP POLICY IF EXISTS "Complaints readable by owner, department officer, or admin" ON public.complaints;

-- Wraps stable functions in scalar subqueries (SELECT ...) to prevent per-row re-evaluation
CREATE POLICY "Complaints readable by owner, department officer, or admin" ON public.complaints
  FOR SELECT TO authenticated
  USING (
    citizen_id = (SELECT auth.uid()) OR
    (department_id IS NOT NULL AND department_id = (SELECT public.get_current_officer_department_id())) OR
    assigned_officer_id = (SELECT public.get_current_officer_id()) OR
    (SELECT public.is_admin())
  );

COMMENT ON POLICY "Complaints readable by owner, department officer, or admin" ON public.complaints IS
  'Citizens see own complaints; officers see their department queue or direct assignments; admins see all.';

-- -----------------------------------------------------------------------------
-- 5. Update Complaint Status History SELECT Policy (Department-level audit visibility)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "History readable by complaint owner, assigned officer, or admin" ON public.complaint_status_history;
DROP POLICY IF EXISTS "History readable by complaint owner, department officer, or admin" ON public.complaint_status_history;

CREATE POLICY "History readable by complaint owner, department officer, or admin" ON public.complaint_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_status_history.complaint_id
      AND (
        c.citizen_id = (SELECT auth.uid()) OR
        (c.department_id IS NOT NULL AND c.department_id = (SELECT public.get_current_officer_department_id())) OR
        c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
        (SELECT public.is_admin())
      )
    )
  );

COMMENT ON POLICY "History readable by complaint owner, department officer, or admin" ON public.complaint_status_history IS
  'Allows history access to the complaint owner, departmental officers, and administrators.';

-- -----------------------------------------------------------------------------
-- 6. Append-Only Administrator Promotion Audit Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_promotion_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  promoted_by_actor TEXT NOT NULL,
  promoted_by_role TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'PROMOTE_TO_MUNICIPAL_ADMIN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.admin_promotion_audit ENABLE ROW LEVEL SECURITY;

-- Revoke all table-level write operations from all client roles
REVOKE ALL ON TABLE public.admin_promotion_audit FROM PUBLIC, anon, authenticated;

-- Grant SELECT to authenticated callers so PostgREST can evaluate RLS
-- (Non-admins receive 0 rows from RLS policy; write privileges remain strictly revoked)
GRANT SELECT ON TABLE public.admin_promotion_audit TO authenticated;

-- Allow administrators to view promotion history; non-admins see 0 rows
DROP POLICY IF EXISTS "Admins can view promotion audit" ON public.admin_promotion_audit;
CREATE POLICY "Admins can view promotion audit" ON public.admin_promotion_audit
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

-- Enforce strict immutability: block UPDATE, DELETE, and TRUNCATE even for postgres
CREATE OR REPLACE FUNCTION public.guard_immutable_admin_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Admin promotion audit records are strictly immutable and cannot be updated or deleted by any user.' USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_admin_audit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_admin_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_admin_audit ON public.admin_promotion_audit;
CREATE TRIGGER trg_guard_immutable_admin_audit
  BEFORE UPDATE OR DELETE ON public.admin_promotion_audit
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_admin_audit();

CREATE OR REPLACE FUNCTION public.guard_immutable_admin_audit_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Admin promotion audit records are strictly immutable and truncating is prohibited.' USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_admin_audit_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_admin_audit_truncate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_admin_audit_truncate ON public.admin_promotion_audit;
CREATE TRIGGER trg_guard_immutable_admin_audit_truncate
  BEFORE TRUNCATE ON public.admin_promotion_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_admin_audit_truncate();

-- -----------------------------------------------------------------------------
-- 7. Hardened Administrator Provisioning Procedure
-- -----------------------------------------------------------------------------
-- Secure stored procedure callable ONLY by service_role, postgres, or database owner.
-- Never callable by anonymous visitors or ordinary authenticated users.
CREATE OR REPLACE PROCEDURE public.provision_admin_user(p_user_email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role TEXT;
  v_target_user_id UUID;
  v_target_profile_id UUID;
  v_actor_identity TEXT;
  v_actor_role TEXT;
  v_row_count INT;
BEGIN
  -- 7.1 Authoritative caller authorization: Inspect JWT claims or session_user
  BEGIN
    v_jwt_role := pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'role';
  EXCEPTION WHEN OTHERS THEN
    v_jwt_role := NULL;
  END;

  IF (v_jwt_role IS DISTINCT FROM 'service_role') AND (session_user NOT IN ('postgres', 'supabase_admin')) THEN
    RAISE EXCEPTION 'Security Violation: Only database operators or authorized backend service roles can provision administrators.'
      USING ERRCODE = '42501';
  END IF;

  -- 7.2 Determine trusted actor identity (never caller-supplied parameters)
  IF session_user IN ('postgres', 'supabase_admin') THEN
    v_actor_identity := session_user;
    v_actor_role := session_user;
  ELSE
    v_actor_identity := COALESCE(
      pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
      'service_role'
    );
    v_actor_role := 'service_role';
  END IF;

  -- 7.3 Locate user by email in auth.users
  SELECT id INTO v_target_user_id
  FROM auth.users
  WHERE email = LOWER(TRIM(p_user_email));

  IF v_target_user_id IS NULL THEN
    RAISE EXCEPTION 'Provisioning Failed: Target user with email % not found in auth.users.', p_user_email
      USING ERRCODE = 'P0002';
  END IF;

  -- 7.4 Verify target profile exists in public.profiles
  SELECT id INTO v_target_profile_id
  FROM public.profiles
  WHERE id = v_target_user_id;

  IF v_target_profile_id IS NULL THEN
    RAISE EXCEPTION 'Provisioning Failed: Corresponding public.profiles record for user UUID % not found.', v_target_user_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 7.5 Update profile role to admin
  UPDATE public.profiles
  SET role = 'admin'::public.user_role,
      updated_at = pg_catalog.now()
  WHERE id = v_target_user_id;

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count = 0 THEN
    RAISE EXCEPTION 'Provisioning Failed: Zero rows updated in public.profiles for user UUID %.', v_target_user_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 7.6 Record audit entry atomically in the same transaction
  INSERT INTO public.admin_promotion_audit (
    target_user_id,
    promoted_by_actor,
    promoted_by_role,
    action,
    created_at
  ) VALUES (
    v_target_user_id,
    v_actor_identity,
    v_actor_role,
    'PROMOTE_TO_MUNICIPAL_ADMIN',
    pg_catalog.now()
  );

  RAISE NOTICE 'Success: User % (UUID: %) successfully promoted to municipal admin by % (%).',
    p_user_email, v_target_user_id, v_actor_identity, v_actor_role;
END;
$$;

ALTER PROCEDURE public.provision_admin_user(TEXT) OWNER TO postgres;
REVOKE ALL ON PROCEDURE public.provision_admin_user(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON PROCEDURE public.provision_admin_user(TEXT) TO postgres, service_role;

-- -----------------------------------------------------------------------------
-- 8. Post-Migration Verification Assertions
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  -- 8.1 Verify officer department helper function is present
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_current_officer_department_id' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Function public.get_current_officer_department_id() was not created.';
  END IF;

  -- 8.2 Verify department-scoped complaints SELECT policy exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polname = 'Complaints readable by owner, department officer, or admin'
      AND polrelid = 'public.complaints'::regclass
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Policy "Complaints readable by owner, department officer, or admin" missing.';
  END IF;

  -- 8.3 Verify department-scoped complaint history SELECT policy exists with exact name
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
    WHERE polname = 'History readable by complaint owner, department officer, or admin'
      AND polrelid = 'public.complaint_status_history'::regclass
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Exact policy "History readable by complaint owner, department officer, or admin" missing.';
  END IF;

  -- 8.4 Verify departmental indexes exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public' AND tablename = 'complaints' AND indexname = 'idx_complaints_department'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Index public.idx_complaints_department missing.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public' AND tablename = 'complaints' AND indexname = 'idx_complaints_assigned_officer'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Index public.idx_complaints_assigned_officer missing.';
  END IF;

  -- 8.5 Verify provisioning procedure exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'provision_admin_user' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Procedure public.provision_admin_user() was not created.';
  END IF;

  -- 8.6 Verify audit table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'admin_promotion_audit'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Table public.admin_promotion_audit was not created.';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- Rollback Instructions (if needed):
-- =============================================================================
-- BEGIN;
-- -- 1. Drop the replacement complaint SELECT policy
-- DROP POLICY IF EXISTS "Complaints readable by owner, department officer, or admin" ON public.complaints;
-- DROP POLICY IF EXISTS "Complaints readable by owner, assigned officer, or admin" ON public.complaints;
--
-- -- 2. Restore exact original Phase 2 complaints SELECT policy
-- CREATE POLICY "Complaints readable by owner, assigned officer, or admin" ON public.complaints
--   FOR SELECT TO authenticated
--   USING (
--     citizen_id = auth.uid() OR
--     assigned_officer_id = public.get_current_officer_id() OR
--     public.is_admin()
--   );
--
-- -- 3. Drop the replacement complaint history SELECT policy
-- DROP POLICY IF EXISTS "History readable by complaint owner, department officer, or admin" ON public.complaint_status_history;
-- DROP POLICY IF EXISTS "History readable by complaint owner, assigned officer, or admin" ON public.complaint_status_history;
--
-- -- 4. Restore exact original Phase 2 history SELECT policy
-- CREATE POLICY "History readable by complaint owner, assigned officer, or admin" ON public.complaint_status_history
--   FOR SELECT TO authenticated
--   USING (
--     EXISTS (
--       SELECT 1 FROM public.complaints c
--       WHERE c.id = complaint_status_history.complaint_id
--       AND (
--         c.citizen_id = auth.uid() OR
--         c.assigned_officer_id = public.get_current_officer_id() OR
--         public.is_admin()
--       )
--     )
--   );
--
-- -- 5. Drop newly created complaint indexes (preserves idx_complaints_citizen and idx_complaint_history_complaint)
-- DROP INDEX IF EXISTS public.idx_complaints_department;
-- DROP INDEX IF EXISTS public.idx_complaints_assigned_officer;
--
-- -- 6. Drop helper function and provisioning procedure introduced by this migration
-- -- (Dropped after dependent policies have been removed or restored)
-- DROP FUNCTION IF EXISTS public.get_current_officer_department_id();
-- DROP PROCEDURE IF EXISTS public.provision_admin_user(TEXT);
--
-- -- NOTE ON AUDIT PRESERVATION:
-- -- As required by municipal governance standards, the table public.admin_promotion_audit,
-- -- its promotion records, and its immutability triggers/functions are NOT dropped during rollback.
-- COMMIT;
