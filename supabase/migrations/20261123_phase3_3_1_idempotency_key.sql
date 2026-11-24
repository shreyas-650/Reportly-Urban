-- =============================================================================
-- Phase 3.3.1: Idempotency Key for Citizen Complaint Submissions
-- Migration: 20261123_phase3_3_1_idempotency_key.sql
--
-- Safety Guarantees:
--   - Wrapped in a single atomic transaction (BEGIN ... COMMIT).
--   - Uses pg_catalog.pg_trigger to verify trg_guard_complaint_status_update is
--     present and enabled (tgenabled = 'O') before any operations.
--   - Verifies no unexpected enabled UPDATE triggers exist on public.complaints
--     via pg_trigger.tgtype bitmask (16 = UPDATE) and tgenabled <> 'D'.
--   - Disables trg_guard_complaint_status_update during backfill to protect updated_at.
--   - Re-enables trg_guard_complaint_status_update after backfill.
--   - Sets DEFAULT gen_random_uuid() before enforcing NOT NULL.
--   - Grants INSERT on only the new column to authenticated (10th column).
--   - Post-migration assertion: Verifies authenticated has zero table-level INSERT
--     grants and exactly the ten permitted column-level INSERT columns.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: Pre-Execution Guard via pg_catalog.pg_trigger
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_expected_state CHAR;
  v_unexpected_triggers TEXT;
BEGIN
  -- Verify expected trigger exists and check its exact enabled state
  SELECT tgenabled
    INTO v_expected_state
    FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.complaints'::regclass
     AND tgname = 'trg_guard_complaint_status_update'
     AND NOT tgisinternal;

  IF v_expected_state IS NULL THEN
    RAISE EXCEPTION 'Migration aborted: Expected UPDATE trigger trg_guard_complaint_status_update not found on public.complaints';
  ELSIF v_expected_state <> 'O' THEN
    RAISE EXCEPTION 'Migration aborted: Expected trigger trg_guard_complaint_status_update is not in normal enabled state (tgenabled: %)', v_expected_state;
  END IF;

  -- Verify no unexpected enabled UPDATE triggers exist on public.complaints (bit 16 = UPDATE)
  SELECT string_agg(tgname, ', ')
    INTO v_unexpected_triggers
    FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.complaints'::regclass
     AND tgname <> 'trg_guard_complaint_status_update'
     AND (tgtype::int & 16) <> 0
     AND tgenabled <> 'D'
     AND NOT tgisinternal;

  IF v_unexpected_triggers IS NOT NULL THEN
    RAISE EXCEPTION 'Migration aborted: Unexpected enabled UPDATE trigger(s) found on public.complaints: %', v_unexpected_triggers;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Step 2: Add nullable idempotency_key column with DEFAULT gen_random_uuid()
-- ---------------------------------------------------------------------------
ALTER TABLE public.complaints
  ADD COLUMN IF NOT EXISTS idempotency_key UUID DEFAULT gen_random_uuid();

-- ---------------------------------------------------------------------------
-- Step 3: Create UNIQUE constraint
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'complaints'
       AND constraint_name = 'uq_complaints_idempotency_key'
  ) THEN
    ALTER TABLE public.complaints
      ADD CONSTRAINT uq_complaints_idempotency_key UNIQUE (idempotency_key);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Step 4: Grant INSERT on the new column to the authenticated role
-- ---------------------------------------------------------------------------
GRANT INSERT (idempotency_key) ON TABLE public.complaints TO authenticated;

-- ---------------------------------------------------------------------------
-- Step 5: Backfill existing rows with unique UUIDs
-- Disables trg_guard_complaint_status_update to protect updated_at timestamps.
-- ---------------------------------------------------------------------------
ALTER TABLE public.complaints DISABLE TRIGGER trg_guard_complaint_status_update;

UPDATE public.complaints
   SET idempotency_key = gen_random_uuid()
 WHERE idempotency_key IS NULL;

ALTER TABLE public.complaints ENABLE TRIGGER trg_guard_complaint_status_update;

-- ---------------------------------------------------------------------------
-- Step 6: Explicitly set DEFAULT gen_random_uuid() and enforce NOT NULL
-- ---------------------------------------------------------------------------
ALTER TABLE public.complaints
  ALTER COLUMN idempotency_key SET DEFAULT gen_random_uuid();

ALTER TABLE public.complaints
  ALTER COLUMN idempotency_key SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Step 7: Exact 10-Column Privilege Assertion
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_table_insert_count INT;
  v_granted_cols TEXT[];
  v_expected_cols TEXT[] := ARRAY[
    'category',
    'citizen_id',
    'description',
    'idempotency_key',
    'image_url',
    'latitude',
    'location',
    'longitude',
    'title',
    'ward'
  ];
BEGIN
  -- Verify NO table-level INSERT grant exists for authenticated
  SELECT COUNT(*)
    INTO v_table_insert_count
    FROM information_schema.table_privileges
   WHERE table_schema = 'public'
     AND table_name = 'complaints'
     AND grantee = 'authenticated'
     AND privilege_type = 'INSERT';

  IF v_table_insert_count > 0 THEN
    RAISE EXCEPTION 'Security assertion failed: Table-level INSERT privilege detected for authenticated on public.complaints';
  END IF;

  -- Verify EXACT array of permitted INSERT columns
  SELECT ARRAY_AGG(column_name ORDER BY column_name)
    INTO v_granted_cols
    FROM information_schema.column_privileges
   WHERE table_schema = 'public'
     AND table_name = 'complaints'
     AND grantee = 'authenticated'
     AND privilege_type = 'INSERT';

  IF v_granted_cols IS DISTINCT FROM v_expected_cols THEN
    RAISE EXCEPTION 'Security assertion failed: Permitted INSERT columns mismatch. Expected %, found %', v_expected_cols, v_granted_cols;
  END IF;
END $$;

COMMIT;
