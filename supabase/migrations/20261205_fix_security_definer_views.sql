-- =============================================================================
-- Migration: 20261205_fix_security_definer_views.sql
-- Module: Supabase Security Advisor — Fix All 3 SECURITY DEFINER View Findings
-- Target: Supabase PostgreSQL (PG 15+)
--
-- Views addressed:
--   1. public.public_officers
--   2. public.public_complaints
--   3. public.public_complaint_history
--
-- Design summary:
--   - Does NOT weaken RLS on any base table (officers, complaints,
--     complaint_status_history, departments).
--   - Does NOT break Phase 6 public endpoints (which use Phase 6.2 RPCs).
--   - Does NOT break citizen or assigned officer complaint history timelines.
--   - public.public_officers & public.public_complaints:
--       Converted directly to security_invoker = true + anon/PUBLIC revoked.
--   - public.public_complaint_history:
--       Bare security_invoker = true against public.complaint_status_history
--       would break citizens and officers because Phase 7.4 locked
--       public.complaint_status_history RLS strictly to is_admin() to protect
--       internal_note, notes, and actor_id. Instead, wraps a hardened,
--       ownership-filtered, sanitized SECURITY DEFINER function
--       public.get_visible_complaint_history() (SET search_path = '') inside a
--       WITH (security_barrier = TRUE, security_invoker = TRUE) view.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'Precondition Failed: PostgreSQL 15+ is required for view security_invoker.';
  END IF;

  SELECT pg_catalog.string_agg(req.label, ', ')
  INTO v_missing
  FROM (
    SELECT 'view public.public_officers' AS label WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'public_officers'
    )
    UNION ALL
    SELECT 'view public.public_complaints' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'public_complaints'
    )
    UNION ALL
    SELECT 'view public.public_complaint_history' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.views
      WHERE table_schema = 'public' AND table_name = 'public_complaint_history'
    )
    UNION ALL
    SELECT 'table public.officers' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'officers'
    )
    UNION ALL
    SELECT 'table public.departments' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'departments'
    )
    UNION ALL
    SELECT 'table public.complaints' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaints'
    )
    UNION ALL
    SELECT 'table public.complaint_status_history' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
    )
    UNION ALL
    SELECT 'function public.is_admin()' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin' AND p.pronargs = 0
    )
    UNION ALL
    SELECT 'function public.get_current_officer_id()' WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_current_officer_id' AND p.pronargs = 0
    )
  ) req;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Missing required database object(s): %', v_missing;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Fix View 1: public.public_officers (SECURITY INVOKER + Revoke anon/PUBLIC)
-- -----------------------------------------------------------------------------
ALTER VIEW public.public_officers SET (security_barrier = TRUE, security_invoker = TRUE);

REVOKE ALL ON public.public_officers FROM PUBLIC, anon;
GRANT SELECT ON public.public_officers TO authenticated;

COMMENT ON VIEW public.public_officers IS
  'Security-invoker view over public.officers and public.departments; inherits strict officers RLS (self-officer or admin only).';

-- -----------------------------------------------------------------------------
-- 3. Fix View 2: public.public_complaints (SECURITY INVOKER + Preserve Anon Revoke)
-- -----------------------------------------------------------------------------
ALTER VIEW public.public_complaints SET (security_barrier = TRUE, security_invoker = TRUE);

REVOKE ALL ON public.public_complaints FROM PUBLIC, anon;
GRANT SELECT ON public.public_complaints TO authenticated;

COMMENT ON VIEW public.public_complaints IS
  'Security-invoker view over public.complaints, departments, and officers; inherits strict complaints and officers RLS with zero cross-citizen or unauthorized officer exposure.';

-- -----------------------------------------------------------------------------
-- 4. Fix View 3: public.public_complaint_history
--    Hardened SECURITY DEFINER projection function + SECURITY INVOKER view
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_visible_complaint_history()
RETURNS TABLE (
  id UUID,
  complaint_id UUID,
  status public.complaint_status,
  stage_title TEXT,
  created_at TIMESTAMPTZ,
  public_description TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    h.id,
    h.complaint_id,
    h.status,
    CASE h.status::text
      WHEN 'submitted' THEN 'Report Registered'
      WHEN 'under_review' THEN 'Under Municipal Review'
      WHEN 'in_progress' THEN 'Remediation In Progress'
      WHEN 'resolved' THEN 'Issue Resolved'
      WHEN 'rejected' THEN 'Report Rejected'
      WHEN 'not_confirmed_by_citizen' THEN 'Closed (Not Confirmed by Citizen)'
      ELSE 'Status Updated'
    END AS stage_title,
    h.created_at,
    h.public_description
  FROM public.complaint_status_history h
  WHERE (SELECT auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.complaints c
      WHERE c.id = h.complaint_id
        AND (
          c.citizen_id = (SELECT auth.uid())
          OR c.assigned_officer_id = (SELECT public.get_current_officer_id())
          OR (SELECT public.is_admin())
        )
    );
$$;

ALTER FUNCTION public.get_visible_complaint_history() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_visible_complaint_history() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_visible_complaint_history() TO authenticated;

COMMENT ON FUNCTION public.get_visible_complaint_history() IS
  'Returns strictly sanitized complaint status timeline rows (omitting internal_note, notes, and actor_id) only for the complaint owner, assigned officer, or admin, while keeping base complaint_status_history RLS admin-only.';

CREATE OR REPLACE VIEW public.public_complaint_history
WITH (security_barrier = TRUE, security_invoker = TRUE) AS
  SELECT
    t.id,
    t.complaint_id,
    t.status,
    t.stage_title,
    t.created_at,
    t.public_description
  FROM public.get_visible_complaint_history() t;

ALTER VIEW public.public_complaint_history OWNER TO postgres;
REVOKE ALL ON public.public_complaint_history FROM PUBLIC, anon;
GRANT SELECT ON public.public_complaint_history TO authenticated;

COMMENT ON VIEW public.public_complaint_history IS
  'Security-invoker & security-barrier timeline view backed by get_visible_complaint_history(); preserves Phase 7.4 admin-only isolation on public.complaint_status_history.';

-- -----------------------------------------------------------------------------
-- 5. Post-Migration Security Verification Block
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_view RECORD;
  v_fn RECORD;
  v_relacl aclitem[];
BEGIN
  -- 5.1 Verify all 3 views have security_invoker=true, security_barrier=true, and zero PUBLIC/anon grants
  FOR v_view IN (
    SELECT c.oid, c.relname, c.reloptions, c.relacl
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'v'
      AND c.relname IN ('public_officers', 'public_complaints', 'public_complaint_history')
  ) LOOP
    IF v_view.reloptions IS NULL
       OR NOT ('security_invoker=true' = ANY(v_view.reloptions))
       OR NOT ('security_barrier=true' = ANY(v_view.reloptions)) THEN
      RAISE EXCEPTION 'Audit Failed: View public.% must have security_invoker=true and security_barrier=true.', v_view.relname;
    END IF;

    v_relacl := v_view.relacl;
    IF (
      v_relacl IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(v_relacl) a WHERE a.grantee = 0
      )
    ) OR pg_catalog.has_table_privilege('anon', 'public.' || v_view.relname, 'SELECT') THEN
      RAISE EXCEPTION 'Audit Failed: View public.% must not grant access to PUBLIC or anon.', v_view.relname;
    END IF;
  END LOOP;

  -- 5.2 Verify get_visible_complaint_history() security attributes and ACLs
  SELECT p.oid, p.prosecdef, p.proconfig, p.proacl
  INTO v_fn
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'get_visible_complaint_history'
    AND p.pronargs = 0;

  IF NOT FOUND OR v_fn.prosecdef IS NOT TRUE THEN
    RAISE EXCEPTION 'Audit Failed: public.get_visible_complaint_history() must be SECURITY DEFINER.';
  END IF;

  -- PostgreSQL stores SET search_path = '' in pg_proc.proconfig as 'search_path=""' (or 'search_path=')
  IF v_fn.proconfig IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_fn.proconfig) cfg
    WHERE cfg ~ '^search_path=(|"")$'
  ) THEN
    RAISE EXCEPTION 'Audit Failed: public.get_visible_complaint_history() must fix SET search_path = ''''.';
  END IF;

  IF (
    v_fn.proacl IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(v_fn.proacl) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    )
  ) OR pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Audit Failed: public.get_visible_complaint_history() must not be executable by PUBLIC or anon.';
  END IF;

  -- 5.3 Verify Phase 7.4 base-table RLS policy on complaint_status_history remains strictly intact
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'complaint_status_history'
      AND policyname = 'History with internal notes readable by admin only'
  ) THEN
    RAISE EXCEPTION 'Audit Failed: Expected admin-only RLS policy on public.complaint_status_history is missing.';
  END IF;
END $$;

COMMIT;
