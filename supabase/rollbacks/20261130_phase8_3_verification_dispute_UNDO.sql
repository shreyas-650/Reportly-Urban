-- =============================================================================
-- Rollback: 20261130_phase8_3_verification_dispute_UNDO.sql
-- Reverts Phase 8.3 objects safely without touching prior complaint history.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.get_admin_complaint_verifications(UUID);
DROP FUNCTION IF EXISTS public.submit_resolution_verification(UUID, UUID, TEXT, TEXT);

DROP TRIGGER IF EXISTS trg_guard_resolution_verification_truncate ON public.complaint_resolution_verifications;
DROP TRIGGER IF EXISTS trg_guard_resolution_verification_immutable ON public.complaint_resolution_verifications;
DROP TRIGGER IF EXISTS trg_guard_resolution_verification_insert ON public.complaint_resolution_verifications;

DROP FUNCTION IF EXISTS public.guard_resolution_verification_immutable();
DROP FUNCTION IF EXISTS public.guard_resolution_verification_insert();

DROP TABLE IF EXISTS public.complaint_resolution_verifications;

DROP FUNCTION IF EXISTS public.count_ai_resolution_checks_since(TIMESTAMPTZ, UUID);
DROP FUNCTION IF EXISTS public.get_ai_resolution_check_inputs(UUID);

DROP INDEX IF EXISTS public.uidx_ai_res_check_auto_evidence_prompt;
CREATE UNIQUE INDEX IF NOT EXISTS uidx_ai_res_check_auto_evidence_prompt
  ON public.complaint_resolution_ai_checks (evidence_id, prompt_version)
  WHERE trigger_source = 'automatic';

COMMIT;
