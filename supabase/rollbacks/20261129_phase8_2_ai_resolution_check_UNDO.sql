-- =============================================================================
-- Rollback: 20261129_phase8_2_ai_resolution_check_UNDO.sql
-- Reverts: 20261129_phase8_2_ai_resolution_check.sql
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   Drops ONLY objects created by 20261129_phase8_2_ai_resolution_check.sql.
--   Does NOT modify or delete any pre-existing tables, complaints, evidence,
--   policies, or functions.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.complete_ai_resolution_check(
  UUID, TEXT, TEXT, DOUBLE PRECISION, TEXT, TEXT
);

DROP FUNCTION IF EXISTS public.claim_ai_resolution_check(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, INT
);

DROP POLICY IF EXISTS "Admins can read AI resolution checks" ON public.complaint_resolution_ai_checks;

DROP TRIGGER IF EXISTS trg_guard_ai_resolution_check_immutable ON public.complaint_resolution_ai_checks;
DROP FUNCTION IF EXISTS public.guard_ai_resolution_check_immutable();

DROP TRIGGER IF EXISTS trg_guard_ai_resolution_check_evidence ON public.complaint_resolution_ai_checks;
DROP FUNCTION IF EXISTS public.guard_ai_resolution_check_evidence();

DROP TABLE IF EXISTS public.complaint_resolution_ai_checks;

COMMIT;
