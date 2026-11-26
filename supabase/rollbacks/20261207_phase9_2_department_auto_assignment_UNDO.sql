-- =============================================================================
-- UNDO: 20261207_phase9_2_department_auto_assignment_UNDO.sql
-- Reverts Phase 9.2 additive tables, triggers, and functions cleanly.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_phase9_2_track_staff_department_change ON public.complaints;
DROP FUNCTION IF EXISTS public.phase9_2_track_staff_department_change();

DROP FUNCTION IF EXISTS public.upsert_category_department_mapping(TEXT, UUID, TEXT, BOOLEAN, UUID);
DROP FUNCTION IF EXISTS public.evaluate_and_assign_department_ai(UUID, TEXT, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS public.refresh_ai_category_accuracy_metrics();

DROP TABLE IF EXISTS public.complaint_department_triage_queue;

DROP TRIGGER IF EXISTS trg_guard_immutable_dept_assign_events_truncate ON public.department_assignment_events;
DROP TRIGGER IF EXISTS trg_guard_immutable_dept_assign_events ON public.department_assignment_events;
DROP FUNCTION IF EXISTS public.guard_immutable_dept_assign_events();
DROP TABLE IF EXISTS public.department_assignment_events;

DROP TABLE IF EXISTS public.ai_category_accuracy_metrics;
DROP TABLE IF EXISTS public.category_department_mappings;

COMMIT;
