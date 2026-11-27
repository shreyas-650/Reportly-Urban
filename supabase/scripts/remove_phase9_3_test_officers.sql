-- =============================================================================
-- REMOVAL SCRIPT (TEST DATA ONLY):
-- Safely removes TEST officers created by seed_phase9_3_test_officers.sql.
-- Clears test-only references if any exist in Phase 9.3 tables, then deletes
-- officers whose official_name contains '[TEST]'.
-- =============================================================================

BEGIN;

DELETE FROM public.complaint_officer_triage_queue
WHERE proposed_officer_id IN (
  SELECT id FROM public.officers WHERE official_name LIKE '%[TEST]%'
);

DELETE FROM public.officers
WHERE official_name LIKE '%[TEST]%'
  AND NOT EXISTS (
    SELECT 1 FROM public.complaints c WHERE c.assigned_officer_id = public.officers.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.complaint_assignment_audit a
    WHERE a.new_officer_id = public.officers.id OR a.prev_officer_id = public.officers.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.officer_assignment_events e
    WHERE e.new_officer_id = public.officers.id
       OR e.prev_officer_id = public.officers.id
       OR e.proposed_officer_id = public.officers.id
  );

COMMIT;
