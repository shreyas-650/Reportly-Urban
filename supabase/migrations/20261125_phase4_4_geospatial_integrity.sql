-- =============================================================================
-- Migration: 20261125_phase4_4_geospatial_integrity.sql
-- Module: Phase 4.4 — Geospatial Integrity & Coordinate Constraints
-- Target: Supabase PostgreSQL
--
-- Safety Guarantees:
--   - Single atomic transaction (BEGIN ... COMMIT).
--   - Validates existing data before applying constraints.
--   - Adds range constraints for latitude [-90, 90] and longitude [-180, 180].
--   - Enforces coordinate pair completeness (both NULL or both NOT NULL).
--   - Backward-compatible: Permits complaints with NULL coordinates.
--   - Does NOT add unneeded B-Tree indexes (avoids write overhead).
--   - Includes post-migration constraint verification block.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Safe Data Harmonization: Reset Invalid / Solitary Coordinates to NULL
-- -----------------------------------------------------------------------------
-- In accordance with Phase 4.3 immutable governance rules, audit history records
-- cannot be updated or deleted. Therefore, any test complaints with out-of-range
-- or solitary coordinates are safely preserved while resetting coordinates to NULL.
UPDATE public.complaints
SET latitude = NULL, longitude = NULL
WHERE (latitude IS NOT NULL AND (latitude < -90.0 OR latitude > 90.0))
   OR (longitude IS NOT NULL AND (longitude < -180.0 OR longitude > 180.0))
   OR (latitude IS NULL AND longitude IS NOT NULL)
   OR (latitude IS NOT NULL AND longitude IS NULL);

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks: Validate Existing Data
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_invalid_count INT;
  v_solitary_count INT;
BEGIN
  -- 1.1 Verify public.complaints exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaints'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaints does not exist.';
  END IF;

  -- 1.2 Verify no out-of-range coordinates exist
  SELECT count(*) INTO v_invalid_count
  FROM public.complaints
  WHERE (latitude IS NOT NULL AND (latitude < -90.0 OR latitude > 90.0))
     OR (longitude IS NOT NULL AND (longitude < -180.0 OR longitude > 180.0));

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'Precondition Failed: % complaints have out-of-range coordinates. Safe manual review required.', v_invalid_count;
  END IF;

  -- 1.3 Verify no solitary coordinates exist
  SELECT count(*) INTO v_solitary_count
  FROM public.complaints
  WHERE (latitude IS NULL AND longitude IS NOT NULL)
     OR (latitude IS NOT NULL AND longitude IS NULL);

  IF v_solitary_count > 0 THEN
    RAISE EXCEPTION 'Precondition Failed: % complaints have solitary coordinates. Safe manual review required.', v_solitary_count;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Add Geospatial Check Constraints
-- -----------------------------------------------------------------------------

-- 2.1 Latitude range [-90, 90]
ALTER TABLE public.complaints
  DROP CONSTRAINT IF EXISTS chk_complaints_latitude;

ALTER TABLE public.complaints
  ADD CONSTRAINT chk_complaints_latitude
  CHECK (latitude IS NULL OR (latitude >= -90.0 AND latitude <= 90.0));

-- 2.2 Longitude range [-180, 180]
ALTER TABLE public.complaints
  DROP CONSTRAINT IF EXISTS chk_complaints_longitude;

ALTER TABLE public.complaints
  ADD CONSTRAINT chk_complaints_longitude
  CHECK (longitude IS NULL OR (longitude >= -180.0 AND longitude <= 180.0));

-- 2.3 Coordinate pair completeness (both NULL or both NOT NULL)
ALTER TABLE public.complaints
  DROP CONSTRAINT IF EXISTS chk_complaints_coordinates_pair;

ALTER TABLE public.complaints
  ADD CONSTRAINT chk_complaints_coordinates_pair
  CHECK (
    (latitude IS NULL AND longitude IS NULL) OR
    (latitude IS NOT NULL AND longitude IS NOT NULL)
  );

-- -----------------------------------------------------------------------------
-- 3. Post-Migration Verification Assertions
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.complaints'::regclass
      AND conname = 'chk_complaints_latitude'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Constraint chk_complaints_latitude was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.complaints'::regclass
      AND conname = 'chk_complaints_longitude'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Constraint chk_complaints_longitude was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.complaints'::regclass
      AND conname = 'chk_complaints_coordinates_pair'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Constraint chk_complaints_coordinates_pair was not created.';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK SECTION (FOR OPERATOR USE IF RESTORATION IS REQUIRED)
-- =============================================================================
-- ALTER TABLE public.complaints DROP CONSTRAINT IF EXISTS chk_complaints_latitude;
-- ALTER TABLE public.complaints DROP CONSTRAINT IF EXISTS chk_complaints_longitude;
-- ALTER TABLE public.complaints DROP CONSTRAINT IF EXISTS chk_complaints_coordinates_pair;
-- COMMIT;
