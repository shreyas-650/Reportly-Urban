-- =============================================================================
-- Rollback: 20261213_india_geospatial_bounds_UNDO.sql
-- Removes the additive India-only coordinate guard trigger and function from
-- public.complaints. Leaves existing rows and Phase 4.4 constraints untouched.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_guard_complaints_india_bounds ON public.complaints;
DROP FUNCTION IF EXISTS public.guard_complaints_india_bounds();

COMMIT;
