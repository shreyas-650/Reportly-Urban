-- =============================================================================
-- Rollback: 20261202_phase8_4_complete_verification_and_disputes_UNDO.sql
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.admin_decide_disputed_complaint(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.list_admin_disputed_complaints(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.close_unconfirmed_resolved_complaints(INT, INT, BOOLEAN);

DROP TRIGGER IF EXISTS trg_guard_verification_history_truncate ON public.complaint_verification_history;
DROP TRIGGER IF EXISTS trg_guard_verification_history_immutable ON public.complaint_verification_history;
DROP FUNCTION IF EXISTS public.guard_verification_history_immutable();

DROP TABLE IF EXISTS public.complaint_verification_history;
DROP TABLE IF EXISTS public.complaint_dispute_cases;

COMMIT;
