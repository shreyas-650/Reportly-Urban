-- =============================================================================
-- Undo Migration: 20261125_phase7_4_restrict_status_history_UNDO.sql
-- Module: Phase 7.4 — Restore Phase 4.3 Status History RLS Policy
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   Reverts 20261125_phase7_4_restrict_status_history.sql by restoring the
--   exact original SELECT policy from 20261124_phase4_3_complaint_status_workflow.sql.
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "History with internal notes readable by admin only" ON public.complaint_status_history;

CREATE POLICY "History readable by assigned officer or admin"
  ON public.complaint_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_status_history.complaint_id
      AND (
        c.assigned_officer_id = (SELECT public.get_current_officer_id()) OR
        (SELECT public.is_admin())
      )
    )
  );

COMMENT ON POLICY "History readable by assigned officer or admin" ON public.complaint_status_history IS
  'Protects operational notes: status history is viewable only by the assigned officer and administrators.';

COMMIT;
