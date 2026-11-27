-- =============================================================================
-- UNDO: 20261209_phase9_3_officer_auto_assignment_UNDO.sql
-- Reverts Phase 9.3 additive tables, trigger, and function cleanly.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_phase9_3_track_staff_officer_change ON public.complaints;
DROP FUNCTION IF EXISTS public.phase9_3_track_staff_officer_change();

DROP FUNCTION IF EXISTS public.evaluate_and_assign_officer_ai(UUID, TEXT, INT, BOOLEAN);

DROP TABLE IF EXISTS public.complaint_officer_triage_queue;

DROP TRIGGER IF EXISTS trg_guard_immutable_officer_assign_events_truncate ON public.officer_assignment_events;
DROP TRIGGER IF EXISTS trg_guard_immutable_officer_assign_events ON public.officer_assignment_events;
DROP FUNCTION IF EXISTS public.guard_immutable_officer_assign_events();
DROP TABLE IF EXISTS public.officer_assignment_events;

COMMIT;
