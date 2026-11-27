-- =============================================================================
-- UNDO Rollback Script: 20261210_phase9_5_suspicious_claim_screening_UNDO.sql
-- Reverses Phase 9.5 objects ONLY. Never touches complaints, complaint_status
-- enum, complaint_status_history, or Phase 9.1 - 9.4 tables/functions.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_guard_immutable_screening_events ON public.complaint_screening_events;
DROP TRIGGER IF EXISTS trg_guard_immutable_screening_events_truncate ON public.complaint_screening_events;

DROP FUNCTION IF EXISTS public.get_admin_complaint_screening(UUID);
DROP FUNCTION IF EXISTS public.list_admin_screening_queue(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.admin_decide_complaint_screening(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.record_and_evaluate_complaint_screening(
  UUID, TEXT, TEXT, TEXT, DOUBLE PRECISION, TEXT[], TEXT[], BOOLEAN, UUID, TEXT, TEXT, BOOLEAN, JSONB, INT, DOUBLE PRECISION, INT, DOUBLE PRECISION
);
DROP FUNCTION IF EXISTS public.refresh_ai_screening_accuracy_metrics(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_screening_deterministic_signals(UUID, TEXT, INT, DOUBLE PRECISION, INT);
DROP FUNCTION IF EXISTS public.count_screening_ai_decisions_for_citizen_since(UUID, TIMESTAMPTZ, UUID);
DROP FUNCTION IF EXISTS public.get_complaint_screening_gate_state(UUID, TEXT);
DROP FUNCTION IF EXISTS public.is_complaint_screening_flagged(UUID);
DROP FUNCTION IF EXISTS public.guard_immutable_screening_events();
DROP FUNCTION IF EXISTS public.guard_immutable_screening_events_truncate();

DROP TABLE IF EXISTS public.complaint_screening_events;
DROP TABLE IF EXISTS public.complaint_screening_reviews;
DROP TABLE IF EXISTS public.ai_screening_accuracy_metrics;

COMMIT;
