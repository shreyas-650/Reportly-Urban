-- =============================================================================
-- Migration: 20261125_phase7_4_restrict_status_history.sql
-- Module: Phase 7.4 — Restrict Direct Status History & Internal Notes to Admin
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   Hardens the PostgreSQL RLS boundary on public.complaint_status_history so
--   direct SELECT access (including internal_note and legacy notes) is granted
--   strictly to administrators. Assigned officers and citizens continue reading
--   sanitized status progress from public.public_complaint_history.
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS "History readable by assigned officer or admin" ON public.complaint_status_history;
CREATE POLICY "History with internal notes readable by admin only"
  ON public.complaint_status_history
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

COMMIT;
