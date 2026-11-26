-- =============================================================================
-- Rollback: 20261203_phase9_1_ai_decisions_shadow_mode_UNDO.sql
-- Module: Phase 9.1 — AI Category & Priority Suggestions (Shadow Mode)
-- Target: Supabase PostgreSQL
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.decide_ai_category_priority_suggestion(UUID, TEXT, TEXT, public.complaint_priority, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.complete_ai_decision(UUID, TEXT, TEXT, public.complaint_priority, DOUBLE PRECISION, JSONB, TEXT);
DROP FUNCTION IF EXISTS public.claim_ai_decision(UUID, TEXT, TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS public.count_ai_decisions_since(TIMESTAMPTZ, UUID);
DROP FUNCTION IF EXISTS public.get_ai_suggestion_inputs(UUID);

DROP TRIGGER IF EXISTS trg_guard_ai_decisions_truncate ON public.ai_decisions;
DROP FUNCTION IF EXISTS public.guard_ai_decisions_truncate();

DROP TRIGGER IF EXISTS trg_guard_ai_decisions_update_delete ON public.ai_decisions;
DROP FUNCTION IF EXISTS public.guard_ai_decisions_update_delete();

DROP TRIGGER IF EXISTS trg_guard_ai_decisions_insert ON public.ai_decisions;
DROP FUNCTION IF EXISTS public.guard_ai_decisions_insert();

DROP TABLE IF EXISTS public.ai_decisions;

COMMIT;
