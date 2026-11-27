-- =============================================================================
-- Migration: 20261213_india_geospatial_bounds.sql
-- Module: India-Only Geospatial Bounds Enforcement
-- Target: Supabase PostgreSQL
--
-- Design & Guarantees:
--   - Additive BEFORE INSERT OR UPDATE OF latitude, longitude trigger only;
--     never alters or deletes existing legacy complaint rows.
--   - Bounding box matches frontend validation (`indiaGeoBounds.js`):
--       latitude  IN [6.0, 37.6]
--       longitude IN [68.0, 97.6]
--   - Fires for every role (including service_role and postgres).
--   - On UPDATE, triggers only when latitude or longitude actually changes
--     (IS DISTINCT FROM), so status/admin/officer/SLA updates on legacy rows
--     with out-of-India coordinates are never blocked.
--   - Allows (NULL, NULL) coordinates for backward compatibility; rejects
--     single-NULL pairs and out-of-India coordinates with ERRCODE '22023' and
--     INDIA_BOUNDS_VIOLATION prefix so clients can map it consistently.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'complaints'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Table public.complaints does not exist.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_complaints_india_bounds()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.latitude IS NOT DISTINCT FROM OLD.latitude
       AND NEW.longitude IS NOT DISTINCT FROM OLD.longitude THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.latitude IS NULL AND NEW.longitude IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.latitude IS NULL OR NEW.longitude IS NULL THEN
    RAISE EXCEPTION
      'INDIA_BOUNDS_VIOLATION: Both latitude and longitude must be provided together (received lat=%, lng=%).',
      NEW.latitude,
      NEW.longitude
      USING ERRCODE = '22023';
  END IF;

  IF NEW.latitude < 6.0
     OR NEW.latitude > 37.6
     OR NEW.longitude < 68.0
     OR NEW.longitude > 97.6 THEN
    RAISE EXCEPTION
      'INDIA_BOUNDS_VIOLATION: Coordinates (lat=%, lng=%) must lie within India (latitude 6.0..37.6, longitude 68.0..97.6).',
      NEW.latitude,
      NEW.longitude
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_complaints_india_bounds() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_complaints_india_bounds() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guard_complaints_india_bounds() IS
  'Rejects new or modified complaint coordinates outside the India bounding box (lat 6.0..37.6, lng 68.0..97.6) while allowing both-NULL coordinates and leaving untouched legacy rows intact.';

DROP TRIGGER IF EXISTS trg_guard_complaints_india_bounds ON public.complaints;
CREATE TRIGGER trg_guard_complaints_india_bounds
  BEFORE INSERT OR UPDATE OF latitude, longitude ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.guard_complaints_india_bounds();

-- Post-Migration Verification Assertions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'complaints'
      AND t.tgname = 'trg_guard_complaints_india_bounds'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Trigger trg_guard_complaints_india_bounds was not created on public.complaints.';
  END IF;
END $$;

COMMIT;
