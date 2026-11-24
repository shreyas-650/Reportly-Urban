-- =============================================================================
-- Migration: 20261125_phase5_ai_usage_tracking.sql
-- Module: Phase 5.2 — AI Analysis Usage Tracking & Database Rate Limiting (Hardened v3)
-- Target: Supabase PostgreSQL
--
-- Safety Guarantees:
--   - Single atomic transaction (BEGIN ... COMMIT).
--   - Precondition checks validating public.profiles and public.ai_usage_status enum compatibility.
--   - Foreign key uses ON DELETE RESTRICT matching ReportlyUrban schema standards.
--   - Timezone-safe UTC midnight calculation via explicit AT TIME ZONE conversions.
--   - Global advisory lock key generated from UTC timestamp without session timezone conversion.
--   - Lease-based reservation accounting with 45-second lease window (15s Gemini timeout + 30s buffer).
--   - Expired reservations continue counting toward rolling 24-hour and global daily quotas.
--   - NEVER automatically refunds expired reservations; late successful responses can still finalize.
--   - Hardcoded user limit of exactly 10 analyses per rolling 24-hour window (c_user_limit = 10).
--   - Single canonical 2-parameter reservation signature: reserve_ai_analysis_quota(UUID, INT).
--   - Strict input validation on citizen_id (P0400) and global_daily_cap (P0401).
--   - Standardized application SQLSTATE codes: P0429 (User limit) and P0430 (Global cap).
--   - Finalize and refund functions return explicit BOOLEAN status indicating actual row modification.
--   - Prevents refunds from overwriting succeeded reservations or double refunds.
--   - Concurrency-safe quota reservation via transactional advisory locks in consistent order.
--   - Zero direct table access for client roles OR service_role (service_role only gets EXECUTE on RPCs).
--   - Exhaustive privilege verification for all 7 privileges across anon, authenticated, and service_role.
--   - Functions owned by postgres, executed with SECURITY DEFINER and fixed empty search_path.
--   - Robust regex check for search_path = '' stored representation in pg_proc.proconfig.
--   - Operator-controlled, non-cascading rollback documentation.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks: Profiles Table & Usage Status Enum
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_enum_labels TEXT[];
BEGIN
  -- 1.1 Verify public.profiles table exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'profiles'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Required table public.profiles does not exist.';
  END IF;

  -- 1.2 Verify or create public.ai_usage_status enum
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'ai_usage_status'
  ) THEN
    SELECT pg_catalog.array_agg(e.enumlabel ORDER BY e.enumsortorder)
    INTO v_enum_labels
    FROM pg_catalog.pg_enum e
    JOIN pg_catalog.pg_type t ON e.enumtypid = t.oid
    JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid
    WHERE n.nspname = 'public' AND t.typname = 'ai_usage_status';

    IF v_enum_labels IS DISTINCT FROM ARRAY['reserved', 'succeeded', 'refunded']::TEXT[] THEN
      RAISE EXCEPTION 'Precondition Failed: Existing enum public.ai_usage_status is incompatible. Found labels: %', v_enum_labels;
    END IF;
  ELSE
    CREATE TYPE public.ai_usage_status AS ENUM ('reserved', 'succeeded', 'refunded');
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Create or Validate public.ai_analysis_usage Table
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_pk_count INT;
  v_fk_count INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
  ) THEN
    -- Verify id column (UUID NOT NULL)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
        AND column_name = 'id' AND data_type = 'uuid' AND is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage.id must be UUID NOT NULL.';
    END IF;

    -- Verify citizen_id column (UUID NOT NULL)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
        AND column_name = 'citizen_id' AND data_type = 'uuid' AND is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage.citizen_id must be UUID NOT NULL.';
    END IF;

    -- Verify status column (public.ai_usage_status NOT NULL)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
        AND column_name = 'status' AND udt_name = 'ai_usage_status' AND is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage.status must be public.ai_usage_status NOT NULL.';
    END IF;

    -- Verify created_at column (TIMESTAMPTZ NOT NULL)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
        AND column_name = 'created_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage.created_at must be TIMESTAMPTZ NOT NULL.';
    END IF;

    -- Verify or add lease_expires_at column (TIMESTAMPTZ NOT NULL)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
        AND column_name = 'lease_expires_at'
    ) THEN
      ALTER TABLE public.ai_analysis_usage
        ADD COLUMN lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (pg_catalog.now() + INTERVAL '45 seconds');
    ELSIF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
        AND column_name = 'lease_expires_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO'
    ) THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage.lease_expires_at must be TIMESTAMPTZ NOT NULL.';
    END IF;

    -- Verify finalized_at column (TIMESTAMPTZ NULL)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
        AND column_name = 'finalized_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage.finalized_at must be TIMESTAMPTZ NULL.';
    END IF;

    -- Verify error_reason column (TEXT NULL)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage'
        AND column_name = 'error_reason' AND data_type = 'text' AND is_nullable = 'YES'
    ) THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage.error_reason must be TEXT NULL.';
    END IF;

    -- Verify Primary Key
    SELECT pg_catalog.count(*) INTO v_pk_count
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON con.conrelid = c.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_analysis_usage'
      AND con.contype = 'p';

    IF v_pk_count = 0 THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage must have a PRIMARY KEY defined.';
    END IF;

    -- Verify Foreign Key to public.profiles(id)
    SELECT pg_catalog.count(*) INTO v_fk_count
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON con.conrelid = c.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_class fc ON con.confrelid = fc.oid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_analysis_usage'
      AND fn.nspname = 'public' AND fc.relname = 'profiles'
      AND con.contype = 'f';

    IF v_fk_count = 0 THEN
      RAISE EXCEPTION 'Precondition Failed: public.ai_analysis_usage.citizen_id must reference public.profiles(id).';
    END IF;
  ELSE
    -- Uses ON DELETE RESTRICT matching all other profile references in ReportlyUrban
    CREATE TABLE public.ai_analysis_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      citizen_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
      status public.ai_usage_status NOT NULL DEFAULT 'reserved',
      created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
      lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (pg_catalog.now() + INTERVAL '45 seconds'),
      finalized_at TIMESTAMPTZ NULL,
      error_reason TEXT NULL
    );
  END IF;
END $$;

COMMENT ON TABLE public.ai_analysis_usage IS
  'AI Vision quota tracking table. Records reservations, success, and refunds. Access restricted strictly to RPC procedures.';

COMMENT ON COLUMN public.ai_analysis_usage.lease_expires_at IS
  'Informational lease timestamp (now + 45s). Expired reservations continue counting toward quota to prevent abuse; late successful responses are permitted to finalize.';

-- -----------------------------------------------------------------------------
-- 3. Dedicated Indexes for Quota Accounting and Active Leases
-- -----------------------------------------------------------------------------
-- Partial index supporting active reservation lookups
CREATE INDEX IF NOT EXISTS idx_ai_usage_citizen_active_reserved
  ON public.ai_analysis_usage (citizen_id, lease_expires_at)
  WHERE status = 'reserved';

-- Partial index supporting rolling 24-hour user quota calculations
CREATE INDEX IF NOT EXISTS idx_ai_usage_citizen_rolling
  ON public.ai_analysis_usage (citizen_id, created_at DESC)
  WHERE status IN ('reserved', 'succeeded');

-- Partial index supporting UTC global daily quota calculations
CREATE INDEX IF NOT EXISTS idx_ai_usage_global_day
  ON public.ai_analysis_usage (created_at DESC)
  WHERE status IN ('reserved', 'succeeded');

-- -----------------------------------------------------------------------------
-- 4. Stored Procedure: Atomic Quota Reservation (Canonical 2-Parameter Signature)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_ai_analysis_quota(
  p_citizen_id UUID,
  p_global_daily_cap INT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_user_limit CONSTANT INT := 10;
  c_lease_duration CONSTANT INTERVAL := INTERVAL '45 seconds';
  v_user_count INT;
  v_global_count INT;
  v_reservation_id UUID;
  v_today_utc_start TIMESTAMPTZ;
  v_today_utc_str TEXT;
BEGIN
  -- 1. Input Validation
  IF p_citizen_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Input: citizen_id must not be NULL'
      USING ERRCODE = 'P0400';
  END IF;

  IF p_global_daily_cap IS NULL OR p_global_daily_cap <= 0 THEN
    RAISE EXCEPTION 'Invalid Configuration: global_daily_cap must be a positive non-zero integer'
      USING ERRCODE = 'P0401';
  END IF;

  -- 2. Explicit Timezone-Safe UTC Day Boundary Calculation
  v_today_utc_start :=
    pg_catalog.date_trunc('day', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  -- 3. Form global lock key from UTC date without session timezone dependency
  v_today_utc_str :=
    pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');

  -- 4. Consistent Concurrency Control: Advisory Locks in Strict Ordering
  -- Always acquire citizen lock first, then global daily lock, preventing cross-transaction deadlocks
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ai_quota_' || p_citizen_id::text));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ai_quota_global_' || v_today_utc_str));

  -- 5. Check Per-User Rolling 24-Hour Limit (Hardcoded exactly 10 analyses)
  -- Note: Active and expired reservations count toward quota until explicitly refunded or 24h elapsed
  SELECT pg_catalog.count(*) INTO v_user_count
  FROM public.ai_analysis_usage
  WHERE citizen_id = p_citizen_id
    AND status IN ('reserved', 'succeeded')
    AND created_at > (pg_catalog.now() - INTERVAL '24 hours');

  IF v_user_count >= c_user_limit THEN
    RAISE EXCEPTION 'User daily AI analysis limit reached (10 analyses per 24 hours)'
      USING ERRCODE = 'P0429';
  END IF;

  -- 6. Check Global Daily Cap (Accounting strictly within current UTC calendar day)
  SELECT pg_catalog.count(*) INTO v_global_count
  FROM public.ai_analysis_usage
  WHERE status IN ('reserved', 'succeeded')
    AND created_at >= v_today_utc_start
    AND created_at < (v_today_utc_start + INTERVAL '1 day');

  IF v_global_count >= p_global_daily_cap THEN
    RAISE EXCEPTION 'Global daily AI quota reached (%)', p_global_daily_cap
      USING ERRCODE = 'P0430';
  END IF;

  -- 7. Atomically Insert Reservation with Explicit Lease Expiration
  -- Lease = current time + 15s Gemini timeout + 30s network buffer = 45 seconds
  INSERT INTO public.ai_analysis_usage (
    citizen_id,
    status,
    lease_expires_at
  )
  VALUES (
    p_citizen_id,
    'reserved',
    pg_catalog.now() + c_lease_duration
  )
  RETURNING id INTO v_reservation_id;

  RETURN v_reservation_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Stored Procedure: Finalize Quota Reservation (Returns Explicit BOOLEAN)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_ai_analysis_quota(
  p_reservation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Transition from 'reserved' to 'succeeded'
  -- Converted even if lease has expired, ensuring late successful responses are accounted for
  UPDATE public.ai_analysis_usage
  SET status = 'succeeded',
      finalized_at = pg_catalog.now()
  WHERE id = p_reservation_id
    AND status = 'reserved';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN (v_updated > 0);
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Stored Procedure: Refund Quota Reservation (Returns Explicit BOOLEAN)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_ai_analysis_quota(
  p_reservation_id UUID,
  p_error_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Strictly only refund if current status is 'reserved'
  -- Never overwrites 'succeeded', preventing double refunds or refunds on successful analyses
  UPDATE public.ai_analysis_usage
  SET status = 'refunded',
      finalized_at = pg_catalog.now(),
      error_reason = pg_catalog.substr(pg_catalog.coalesce(p_error_reason, 'Analysis failed'), 1, 500)
  WHERE id = p_reservation_id
    AND status = 'reserved';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN (v_updated > 0);
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Ownership, Row Level Security, and Privilege Hardening
-- -----------------------------------------------------------------------------
-- Ensure postgres owns the table and procedures
ALTER TABLE public.ai_analysis_usage OWNER TO postgres;
ALTER FUNCTION public.reserve_ai_analysis_quota(UUID, INT) OWNER TO postgres;
ALTER FUNCTION public.finalize_ai_analysis_quota(UUID) OWNER TO postgres;
ALTER FUNCTION public.refund_ai_analysis_quota(UUID, TEXT) OWNER TO postgres;

-- Enable Row Level Security on quota table
ALTER TABLE public.ai_analysis_usage ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke all direct table access from all client roles AND service_role
-- Backend operations must interact exclusively via the RPC interface
REVOKE ALL ON TABLE public.ai_analysis_usage FROM PUBLIC, anon, authenticated, service_role;

-- Revoke procedure execution from public and client roles
REVOKE ALL ON FUNCTION public.reserve_ai_analysis_quota(UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_ai_analysis_quota(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_ai_analysis_quota(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Grant EXECUTE exclusively to service_role (used only by trusted backend)
GRANT EXECUTE ON FUNCTION public.reserve_ai_analysis_quota(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_ai_analysis_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_ai_analysis_quota(UUID, TEXT) TO service_role;

-- -----------------------------------------------------------------------------
-- 8. Comprehensive Post-Migration Verification Queries
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_proc_rec RECORD;
  v_role TEXT;
  v_priv TEXT;
BEGIN
  -- 8.1 Verify table exists and has RLS enabled
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ai_analysis_usage'
      AND c.relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Table public.ai_analysis_usage does not exist or RLS is not enabled.';
  END IF;

  -- 8.2 Verify required columns including lease_expires_at
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_analysis_usage' AND column_name = 'lease_expires_at'
  ) THEN
    RAISE EXCEPTION 'Verification Failed: Column lease_expires_at missing from public.ai_analysis_usage.';
  END IF;

  -- 8.3 Verify exact function signatures via to_regprocedure
  IF to_regprocedure('public.reserve_ai_analysis_quota(uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'Verification Failed: Procedure reserve_ai_analysis_quota(uuid,integer) missing.';
  END IF;

  -- Verify no 3-parameter overload exists
  IF to_regprocedure('public.reserve_ai_analysis_quota(uuid,integer,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'Verification Failed: Unintended 3-parameter overload of reserve_ai_analysis_quota exists.';
  END IF;

  IF to_regprocedure('public.finalize_ai_analysis_quota(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Verification Failed: Procedure finalize_ai_analysis_quota(uuid) missing.';
  END IF;

  IF to_regprocedure('public.refund_ai_analysis_quota(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Verification Failed: Procedure refund_ai_analysis_quota(uuid,text) missing.';
  END IF;

  -- 8.4 Verify SECURITY DEFINER and fixed search_path = '' on all procedures
  FOR v_proc_rec IN
    SELECT p.proname, p.prosecdef, p.proconfig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('reserve_ai_analysis_quota', 'finalize_ai_analysis_quota', 'refund_ai_analysis_quota')
  LOOP
    IF NOT v_proc_rec.prosecdef THEN
      RAISE EXCEPTION 'Verification Failed: Procedure % is not SECURITY DEFINER.', v_proc_rec.proname;
    END IF;
    -- Robust regex matching both 'search_path=' and 'search_path=""'
    IF v_proc_rec.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_proc_rec.proconfig) cfg
      WHERE cfg ~ '^search_path=(|"")$'
    ) THEN
      RAISE EXCEPTION 'Verification Failed: Procedure % does not have a fixed empty search_path set.', v_proc_rec.proname;
    END IF;
  END LOOP;

  -- 8.5 Verify privileges: Zero direct table access for anon, authenticated, and service_role across ALL 7 privileges
  FOR v_role IN SELECT unnest(ARRAY['anon', 'authenticated', 'service_role']) LOOP
    FOR v_priv IN SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.ai_analysis_usage', v_priv) THEN
        RAISE EXCEPTION 'Verification Failed: % retained % on public.ai_analysis_usage.', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- 8.6 Verify execution privileges: service_role has EXECUTE; anon and authenticated do NOT
  IF pg_catalog.has_function_privilege('anon', 'public.reserve_ai_analysis_quota(uuid,integer)', 'EXECUTE') OR
     pg_catalog.has_function_privilege('authenticated', 'public.reserve_ai_analysis_quota(uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification Failed: Client roles retained EXECUTE on reserve_ai_analysis_quota.';
  END IF;

  IF NOT pg_catalog.has_function_privilege('service_role', 'public.reserve_ai_analysis_quota(uuid,integer)', 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('service_role', 'public.finalize_ai_analysis_quota(uuid)', 'EXECUTE') OR
     NOT pg_catalog.has_function_privilege('service_role', 'public.refund_ai_analysis_quota(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification Failed: service_role missing EXECUTE on quota management procedures.';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK SECTION (OPERATOR-CONTROLLED; NEVER RUN AUTOMATICALLY)
-- =============================================================================
-- Dependencies to verify before execution:
--   1. Ensure backend service has disabled AI quota tracking or transitioned to mock mode.
--   2. Check if any downstream analytics views depend on public.ai_analysis_usage.
--   3. Execute in an explicit transaction without CASCADE to prevent accidental dropped dependencies:
--
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.refund_ai_analysis_quota(UUID, TEXT) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.finalize_ai_analysis_quota(UUID) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.reserve_ai_analysis_quota(UUID, INT) FROM service_role;
-- DROP FUNCTION IF EXISTS public.refund_ai_analysis_quota(UUID, TEXT);
-- DROP FUNCTION IF EXISTS public.finalize_ai_analysis_quota(UUID);
-- DROP FUNCTION IF EXISTS public.reserve_ai_analysis_quota(UUID, INT);
-- DROP INDEX IF EXISTS public.idx_ai_usage_citizen_active_reserved;
-- DROP INDEX IF EXISTS public.idx_ai_usage_citizen_rolling;
-- DROP INDEX IF EXISTS public.idx_ai_usage_global_day;
-- DROP TABLE IF EXISTS public.ai_analysis_usage; -- No CASCADE
-- DROP TYPE IF EXISTS public.ai_usage_status;   -- No CASCADE
-- COMMIT;
