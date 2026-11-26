-- =============================================================================
-- Rollback: 20261205_fix_security_definer_views_UNDO.sql
-- Module: Rollback for 20261205_fix_security_definer_views.sql
-- Target: Supabase PostgreSQL
-- =============================================================================

BEGIN;

-- 1. Restore Phase 8.4 definition of public.public_complaint_history
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

-- 2. Drop helper table function
DROP FUNCTION IF EXISTS public.get_visible_complaint_history();

-- 3. Reset security_invoker on public.public_complaints (preserving Phase 6 anon revocation)
ALTER VIEW public.public_complaints RESET (security_invoker);
REVOKE ALL ON public.public_complaints FROM PUBLIC, anon;
GRANT SELECT ON public.public_complaints TO authenticated;

-- 4. Reset security_invoker and restore Phase 2 anon/authenticated SELECT on public.public_officers
ALTER VIEW public.public_officers RESET (security_invoker);
GRANT SELECT ON public.public_officers TO anon, authenticated;

COMMIT;
