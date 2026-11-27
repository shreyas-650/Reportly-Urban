-- =============================================================================
-- UNDO Rollback Script: 20261211_phase9_6_accuracy_dashboard_and_appeals_UNDO.sql
-- Safety Correction 10: Drops ONLY newly introduced Phase 9.6 functions, triggers,
-- and RLS policies. Preserves public.complaint_review_appeals,
-- public.complaint_review_appeal_decisions, and public.phase9_feature_settings
-- so historical appeal records and decisions are never lost.
-- =============================================================================

BEGIN;

-- Disable appeal feature in DB if settings row exists
UPDATE public.phase9_feature_settings
SET is_enabled = FALSE, updated_at = pg_catalog.now()
WHERE feature_key = 'screening_appeal';

DROP TRIGGER IF EXISTS trg_guard_immutable_appeal_decisions ON public.complaint_review_appeal_decisions;
DROP TRIGGER IF EXISTS trg_guard_immutable_appeal_decisions_truncate ON public.complaint_review_appeal_decisions;
DROP TRIGGER IF EXISTS trg_guard_review_appeals_delete ON public.complaint_review_appeals;
DROP TRIGGER IF EXISTS trg_guard_review_appeals_truncate ON public.complaint_review_appeals;

DROP POLICY IF EXISTS "Admins can read phase9 feature settings" ON public.phase9_feature_settings;
DROP POLICY IF EXISTS "Admins can read complaint review appeals" ON public.complaint_review_appeals;
DROP POLICY IF EXISTS "Admins can read appeal decisions" ON public.complaint_review_appeal_decisions;

DROP FUNCTION IF EXISTS public.get_admin_ward_accuracy_fairness(INT);
DROP FUNCTION IF EXISTS public.get_admin_accuracy_dashboard(TEXT, INT);
DROP FUNCTION IF EXISTS public.admin_decide_complaint_review_appeal(UUID, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS public.list_admin_review_appeals(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.submit_complaint_review_appeal(UUID, TEXT, INT, INT, INT, INT);
DROP FUNCTION IF EXISTS public.get_citizen_review_appeal_status(UUID, INT, INT, INT);
DROP FUNCTION IF EXISTS public.admin_set_appeal_feature_enabled(BOOLEAN);
DROP FUNCTION IF EXISTS public.guard_complaint_review_appeals_delete();
DROP FUNCTION IF EXISTS public.guard_immutable_appeal_decisions();

COMMIT;

-- =============================================================================
-- MANUAL DATA REMOVAL (Optional — ONLY run intentionally by operator)
-- =============================================================================
-- DROP TABLE IF EXISTS public.complaint_review_appeal_decisions;
-- DROP TABLE IF EXISTS public.complaint_review_appeals;
-- DROP TABLE IF EXISTS public.phase9_feature_settings;
