-- =============================================================================
-- Rollback: 20261204_phase9_4_duplicate_detection_UNDO.sql
-- Module: Phase 9.4 — Duplicate Detection
-- Target: Supabase PostgreSQL
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.decide_duplicate_link(UUID, TEXT);
DROP FUNCTION IF EXISTS public.list_admin_suspected_duplicates(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.get_admin_complaint_duplicates(UUID);
DROP FUNCTION IF EXISTS public.record_duplicate_link(UUID, UUID, DOUBLE PRECISION, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.find_duplicate_complaint_candidates(UUID, DOUBLE PRECISION, INT, INT);

DROP TRIGGER IF EXISTS trg_guard_duplicate_links_truncate ON public.complaint_duplicate_links;
DROP FUNCTION IF EXISTS public.guard_duplicate_links_truncate();

DROP TRIGGER IF EXISTS trg_guard_duplicate_links_update_delete ON public.complaint_duplicate_links;
DROP FUNCTION IF EXISTS public.guard_duplicate_links_update_delete();

DROP TABLE IF EXISTS public.complaint_duplicate_links;

COMMIT;
