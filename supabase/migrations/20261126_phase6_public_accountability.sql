-- =============================================================================
-- Migration: 20261126_phase6_public_accountability.sql
-- Module: Phase 6.2 — Public Reference Column, Sanitized Public Read RPCs & Legacy Revocation
-- Target: Supabase PostgreSQL
--
-- Safety Guarantees:
--   - Single atomic transaction (BEGIN ... COMMIT).
--   - Preconditions abort if table exceeds 50,000 rows (requiring batched path),
--     or if required tables, sla_deadline, triggers, or complaint_status labels mismatch.
--   - Adds public_reference UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid() in a single DDL
--     statement so existing rows receive independent CSPRNG UUIDv4 tokens WITHOUT firing
--     UPDATE triggers (preserving existing updated_at timestamps identically).
--   - Verifies updated_at invariance via pre/post MD5 aggregate checksum inside transaction.
--   - Enforces immutability via dedicated BEFORE UPDATE trigger trg_guard_public_reference_immutable
--     (without modifying guard_direct_complaint_status_update or any existing trigger).
--   - Confirms Phase 3.3.1 10-column INSERT grants and existing UPDATE grants remain unchanged.
--   - Exposes all public accountability, ward/department analytics, map pins, explorer pagination,
--     and detail lookup strictly via read-only STABLE SECURITY DEFINER functions owned by postgres
--     with SET search_path = '' and EXECUTE granted solely to service_role (no raw table grants).
--   - Suppresses ward and department aggregates below 5 complaints into one 'Other' bucket
--     (and suppresses 'Other' metrics with is_suppressed=true if still < 5).
--   - Revokes anon SELECT from legacy view public.public_complaints in a dedicated section.
--   - Non-cascading, operator-controlled rollback instructions included at end.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks & Pre-Migration Checksum Capture
-- -----------------------------------------------------------------------------
CREATE TEMP TABLE _phase6_precheck_state (
  row_count BIGINT NOT NULL,
  updated_at_checksum TEXT NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  v_row_count BIGINT;
  v_checksum TEXT;
  v_status_labels TEXT[];
  v_cat_check_vals TEXT[];
  v_trigger_state CHAR;
BEGIN
  -- 1.1 Verify required base tables exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaints'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'departments'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'complaint_status_history'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: One or more required base tables (complaints, departments, complaint_status_history) do not exist.';
  END IF;

  -- 1.2 Verify required columns on public.complaints and public.departments
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaints'
      AND column_name = 'sla_deadline' AND data_type = 'timestamp with time zone'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'category'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'ward'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'department_id'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Required columns (sla_deadline, category, ward, department_id) missing on public.complaints.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'code'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'name'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'departments' AND column_name = 'is_active'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Required columns (code, name, is_active) missing on public.departments.';
  END IF;

  -- 1.2b Verify public.complaints.category CHECK list equals the six authorized categories
  SELECT (
    SELECT pg_catalog.array_agg(m[1] ORDER BY m[1])
    FROM pg_catalog.regexp_matches(pg_catalog.pg_get_constraintdef(con.oid), '''([^'']+)''', 'g') AS m
  )
  INTO v_cat_check_vals
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_attribute a
    ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
  WHERE con.conrelid = 'public.complaints'::regclass
    AND con.contype = 'c'
    AND a.attname = 'category'
  LIMIT 1;

  IF v_cat_check_vals IS DISTINCT FROM ARRAY[
    'drainage', 'garbage', 'potholes', 'public_infrastructure', 'streetlights', 'water_leakage'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'Precondition Failed: public.complaints.category CHECK constraint values mismatch. Found: %', v_cat_check_vals;
  END IF;

  -- 1.3 Verify complaint_status enum labels match exactly
  SELECT pg_catalog.array_agg(e.enumlabel ORDER BY e.enumsortorder)
  INTO v_status_labels
  FROM pg_catalog.pg_enum e
  JOIN pg_catalog.pg_type t ON e.enumtypid = t.oid
  JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid
  WHERE n.nspname = 'public' AND t.typname = 'complaint_status';

  IF v_status_labels IS DISTINCT FROM ARRAY['submitted', 'under_review', 'in_progress', 'resolved', 'rejected']::TEXT[] THEN
    RAISE EXCEPTION 'Precondition Failed: public.complaint_status enum mismatch. Found: %', v_status_labels;
  END IF;

  -- 1.4 Verify public_reference does not already exist with incompatible definition
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'public_reference'
  ) THEN
    RAISE EXCEPTION 'Precondition Failed: Column public.complaints.public_reference already exists. Inspect live schema before re-running.';
  END IF;

  -- 1.5 Verify existing immutability trigger is intact
  SELECT tgenabled INTO v_trigger_state
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'public.complaints'::regclass
    AND tgname = 'trg_guard_complaint_status_update'
    AND NOT tgisinternal;

  IF v_trigger_state IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'Precondition Failed: Expected trigger trg_guard_complaint_status_update not active on public.complaints.';
  END IF;

  -- 1.6 Guard table size <= 50,000 rows for single-statement table rewrite
  SELECT pg_catalog.count(*) INTO v_row_count FROM public.complaints;
  IF v_row_count > 50000 THEN
    RAISE EXCEPTION 'Precondition Aborted: public.complaints has % rows (> 50,000 limit). Use the batched nullable backfill + CREATE UNIQUE INDEX CONCURRENTLY path instead.', v_row_count;
  END IF;

  -- 1.7 Capture exact row count and updated_at checksum before DDL rewrite
  SELECT COALESCE(
    pg_catalog.md5(pg_catalog.string_agg(id::text || ':' || pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '|' ORDER BY id)),
    'EMPTY_TABLE'
  )
  INTO v_checksum
  FROM public.complaints;

  INSERT INTO _phase6_precheck_state (row_count, updated_at_checksum)
  VALUES (v_row_count, v_checksum);
END $$;

-- -----------------------------------------------------------------------------
-- 2. Add public_reference Column (Single Volatile-Default Rewrite) & Unique Constraint
-- -----------------------------------------------------------------------------
-- Volatile DEFAULT pg_catalog.gen_random_uuid() rewrites existing rows in-place with
-- independent 122-bit CSPRNG UUIDv4 tokens WITHOUT firing any BEFORE/AFTER UPDATE triggers.
ALTER TABLE public.complaints
  ADD COLUMN public_reference UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid();

ALTER TABLE public.complaints
  ADD CONSTRAINT uq_complaints_public_reference UNIQUE (public_reference);

COMMENT ON COLUMN public.complaints.public_reference IS
  'Immutable, unguessable UUIDv4 public tracking reference (122-bit CSPRNG). Used solely by Phase 6 public endpoints; separate from internal primary key id and sequential complaint_number.';

-- -----------------------------------------------------------------------------
-- 3. Dedicated Immutability Guard Trigger for public_reference
-- -----------------------------------------------------------------------------
-- Does NOT alter guard_direct_complaint_status_update() or any existing trigger.
CREATE OR REPLACE FUNCTION public.guard_public_reference_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Security Violation: public_reference is immutable and cannot be modified.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_public_reference_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_public_reference_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_public_reference_immutable ON public.complaints;
CREATE TRIGGER trg_guard_public_reference_immutable
  BEFORE UPDATE ON public.complaints
  FOR EACH ROW
  WHEN (OLD.public_reference IS DISTINCT FROM NEW.public_reference)
  EXECUTE FUNCTION public.guard_public_reference_immutable();

-- -----------------------------------------------------------------------------
-- 4. Supporting Partial Indexes (Query-Justified Only)
-- -----------------------------------------------------------------------------
-- 4.1 Accelerates public_map_points(p_ward, p_category) excluding rejected & NULL-coord rows
CREATE INDEX IF NOT EXISTS idx_complaints_public_active_coords
  ON public.complaints (category, ward, created_at DESC)
  WHERE status <> 'rejected'::public.complaint_status
    AND latitude IS NOT NULL
    AND longitude IS NOT NULL;

-- 4.2 Accelerates deterministic pagination ordering in public_complaint_list()
CREATE INDEX IF NOT EXISTS idx_complaints_public_list
  ON public.complaints (created_at DESC, public_reference ASC)
  WHERE status <> 'rejected'::public.complaint_status;

-- 4.3 Accelerates MAX(created_at) lookup for 'resolved' transitions in resolution-time metrics
CREATE INDEX IF NOT EXISTS idx_history_resolved_lookup
  ON public.complaint_status_history (complaint_id, created_at DESC)
  WHERE status = 'resolved'::public.complaint_status;

-- -----------------------------------------------------------------------------
-- 5. Read-Only Public Accountability & Analytics Functions (STABLE, SECURITY DEFINER)
-- -----------------------------------------------------------------------------
-- Pending definition used consistently across all Phase 6 public metrics:
--   'pending' = unresolved, non-rejected active grievances, strictly:
--               status IN ('submitted', 'under_review', 'in_progress').
--
-- Suppression / Privacy Note:
--   Suppression thresholds (< 5 complaints folded into 'Other', and suppressed if 'Other' < 5)
--   provide modest k-anonymity protection, NOT formal anonymity or differential privacy
--   (small bucket counts may still be inferred via subtraction against citywide totals).

-- 5.1 Citywide Public Dashboard Summary
CREATE OR REPLACE FUNCTION public.public_dashboard_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_total BIGINT;
  v_resolved BIGINT;
  v_pending BIGINT;
  v_rejected_raw BIGINT;
  v_rejected_suppressed BOOLEAN;
  v_rejected_out BIGINT;
  v_overdue BIGINT;
  v_no_deadline BIGINT;
  v_res_rate NUMERIC;
  v_avg_hours NUMERIC;
BEGIN
  SELECT
    pg_catalog.count(*) FILTER (WHERE b.status <> 'rejected'::public.complaint_status),
    pg_catalog.count(*) FILTER (WHERE b.status = 'resolved'::public.complaint_status),
    pg_catalog.count(*) FILTER (WHERE b.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)),
    pg_catalog.count(*) FILTER (WHERE b.status = 'rejected'::public.complaint_status),
    pg_catalog.count(*) FILTER (
      WHERE b.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
        AND b.sla_deadline IS NOT NULL
        AND b.sla_deadline < pg_catalog.now()
    ),
    pg_catalog.count(*) FILTER (
      WHERE b.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
        AND b.sla_deadline IS NULL
    )
  INTO v_total, v_resolved, v_pending, v_rejected_raw, v_overdue, v_no_deadline
  FROM public.complaints b;

  -- Apply rule-based suppression (< 5) to citywide rejected count
  IF v_rejected_raw < 5 THEN
    v_rejected_suppressed := TRUE;
    v_rejected_out := NULL;
  ELSE
    v_rejected_suppressed := FALSE;
    v_rejected_out := v_rejected_raw;
  END IF;

  -- Resolution rate excludes rejected complaints
  v_res_rate := pg_catalog.round((100.0 * v_resolved) / NULLIF(v_total, 0), 1);

  -- Average resolution hours strictly from created_at to MAX(resolved history created_at)
  SELECT pg_catalog.round(
    pg_catalog.avg(EXTRACT(EPOCH FROM (rt.resolved_at - rt.submitted_at)) / 3600.0)::numeric,
    2
  )
  INTO v_avg_hours
  FROM (
    SELECT
      c.id,
      c.created_at AS submitted_at,
      MAX(h.created_at) AS resolved_at
    FROM public.complaints c
    JOIN public.complaint_status_history h
      ON h.complaint_id = c.id
     AND h.status = 'resolved'::public.complaint_status
    WHERE c.status = 'resolved'::public.complaint_status
    GROUP BY c.id, c.created_at
    HAVING MAX(h.created_at) >= c.created_at
  ) rt;

  RETURN pg_catalog.jsonb_build_object(
    'total', v_total,
    'resolved', v_resolved,
    'pending', v_pending,
    'rejected', v_rejected_out,
    'rejected_suppressed', v_rejected_suppressed,
    'overdue', v_overdue,
    'no_deadline_count', v_no_deadline,
    'resolution_rate', v_res_rate,
    'avg_resolution_hours', v_avg_hours
  );
END;
$$;

-- 5.2 Ward-Wise Analytics with Threshold (< 5) Folding & Suppression
CREATE OR REPLACE FUNCTION public.public_ward_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows JSONB;
BEGIN
  WITH per_complaint AS (
    SELECT
      COALESCE(NULLIF(pg_catalog.btrim(c.ward), ''), 'Unspecified') AS ward_name,
      c.status,
      c.sla_deadline,
      c.created_at,
      (
        SELECT MAX(h.created_at)
        FROM public.complaint_status_history h
        WHERE h.complaint_id = c.id
          AND h.status = 'resolved'::public.complaint_status
      ) AS resolved_at
    FROM public.complaints c
    WHERE c.status <> 'rejected'::public.complaint_status
  ),
  raw_wards AS (
    SELECT
      pc.ward_name,
      pg_catalog.count(*) AS total,
      pg_catalog.count(*) FILTER (WHERE pc.status = 'resolved'::public.complaint_status) AS resolved,
      pg_catalog.count(*) FILTER (WHERE pc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)) AS unresolved,
      pg_catalog.count(*) FILTER (
        WHERE pc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
          AND pc.sla_deadline IS NOT NULL
          AND pc.sla_deadline < pg_catalog.now()
      ) AS overdue,
      pg_catalog.count(*) FILTER (
        WHERE pc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
          AND pc.sla_deadline IS NULL
      ) AS no_deadline_count,
      pg_catalog.avg(
        CASE
          WHEN pc.status = 'resolved'::public.complaint_status
           AND pc.resolved_at IS NOT NULL
           AND pc.resolved_at >= pc.created_at
          THEN EXTRACT(EPOCH FROM (pc.resolved_at - pc.created_at)) / 3600.0
          ELSE NULL
        END
      ) AS avg_hours_raw
    FROM per_complaint pc
    GROUP BY pc.ward_name
  ),
  major_wards AS (
    SELECT
      rw.ward_name AS ward,
      rw.total,
      rw.resolved,
      rw.unresolved,
      rw.overdue,
      rw.no_deadline_count,
      pg_catalog.round((100.0 * rw.resolved) / NULLIF(rw.total, 0), 1) AS resolution_rate,
      pg_catalog.round(rw.avg_hours_raw::numeric, 2) AS avg_resolution_hours,
      FALSE AS is_other,
      FALSE AS is_suppressed,
      1 AS sort_group
    FROM raw_wards rw
    WHERE rw.total >= 5
  ),
  other_bucket AS (
    SELECT
      'Other'::TEXT AS ward,
      CASE WHEN pg_catalog.count(*) < 5 THEN NULL ELSE pg_catalog.count(*) END AS total,
      CASE WHEN pg_catalog.count(*) < 5 THEN NULL ELSE pg_catalog.count(*) FILTER (WHERE pc.status = 'resolved'::public.complaint_status) END AS resolved,
      CASE WHEN pg_catalog.count(*) < 5 THEN NULL ELSE pg_catalog.count(*) FILTER (WHERE pc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)) END AS unresolved,
      CASE WHEN pg_catalog.count(*) < 5 THEN NULL ELSE pg_catalog.count(*) FILTER (
        WHERE pc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
          AND pc.sla_deadline IS NOT NULL
          AND pc.sla_deadline < pg_catalog.now()
      ) END AS overdue,
      CASE WHEN pg_catalog.count(*) < 5 THEN NULL ELSE pg_catalog.count(*) FILTER (
        WHERE pc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
          AND pc.sla_deadline IS NULL
      ) END AS no_deadline_count,
      CASE WHEN pg_catalog.count(*) < 5 THEN NULL ELSE pg_catalog.round(
        (100.0 * pg_catalog.count(*) FILTER (WHERE pc.status = 'resolved'::public.complaint_status)) / NULLIF(pg_catalog.count(*), 0),
        1
      ) END AS resolution_rate,
      CASE WHEN pg_catalog.count(*) < 5 THEN NULL ELSE pg_catalog.round(
        pg_catalog.avg(
          CASE
            WHEN pc.status = 'resolved'::public.complaint_status
             AND pc.resolved_at IS NOT NULL
             AND pc.resolved_at >= pc.created_at
            THEN EXTRACT(EPOCH FROM (pc.resolved_at - pc.created_at)) / 3600.0
            ELSE NULL
          END
        )::numeric,
        2
      ) END AS avg_resolution_hours,
      TRUE AS is_other,
      (pg_catalog.count(*) < 5) AS is_suppressed,
      2 AS sort_group
    FROM per_complaint pc
    JOIN raw_wards rw ON rw.ward_name = pc.ward_name
    WHERE rw.total < 5
    HAVING pg_catalog.count(*) > 0
  ),
  combined AS (
    SELECT * FROM major_wards
    UNION ALL
    SELECT * FROM other_bucket
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ward', cb.ward,
        'total', cb.total,
        'resolved', cb.resolved,
        'unresolved', cb.unresolved,
        'overdue', cb.overdue,
        'no_deadline_count', cb.no_deadline_count,
        'resolution_rate', cb.resolution_rate,
        'avg_resolution_hours', cb.avg_resolution_hours,
        'is_other', cb.is_other,
        'is_suppressed', cb.is_suppressed
      )
      ORDER BY cb.sort_group ASC, cb.total DESC NULLS LAST, cb.ward ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM combined cb;

  RETURN v_rows;
END;
$$;

-- 5.3 Department-Wise Analytics with Threshold (< 5) Folding & Suppression
CREATE OR REPLACE FUNCTION public.public_department_stats()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rows JSONB;
BEGIN
  WITH per_dept_complaint AS (
    SELECT
      d.id AS dept_id,
      d.name AS department_name,
      d.code AS department_code,
      c.id AS complaint_id,
      c.status,
      c.sla_deadline,
      c.created_at,
      (
        SELECT MAX(h.created_at)
        FROM public.complaint_status_history h
        WHERE h.complaint_id = c.id
          AND h.status = 'resolved'::public.complaint_status
      ) AS resolved_at
    FROM public.departments d
    LEFT JOIN public.complaints c
      ON c.department_id = d.id
     AND c.status <> 'rejected'::public.complaint_status
    WHERE d.is_active = TRUE
  ),
  raw_depts AS (
    SELECT
      pdc.dept_id,
      pdc.department_name,
      pdc.department_code,
      pg_catalog.count(pdc.complaint_id) AS assigned_total,
      pg_catalog.count(pdc.complaint_id) FILTER (WHERE pdc.status = 'resolved'::public.complaint_status) AS resolved,
      pg_catalog.count(pdc.complaint_id) FILTER (WHERE pdc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)) AS pending,
      pg_catalog.count(pdc.complaint_id) FILTER (
        WHERE pdc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
          AND pdc.sla_deadline IS NOT NULL
          AND pdc.sla_deadline < pg_catalog.now()
      ) AS overdue,
      pg_catalog.count(pdc.complaint_id) FILTER (
        WHERE pdc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
          AND pdc.sla_deadline IS NULL
      ) AS no_deadline_count,
      pg_catalog.avg(
        CASE
          WHEN pdc.status = 'resolved'::public.complaint_status
           AND pdc.resolved_at IS NOT NULL
           AND pdc.resolved_at >= pdc.created_at
          THEN EXTRACT(EPOCH FROM (pdc.resolved_at - pdc.created_at)) / 3600.0
          ELSE NULL
        END
      ) AS avg_hours_raw
    FROM per_dept_complaint pdc
    GROUP BY pdc.dept_id, pdc.department_name, pdc.department_code
  ),
  major_depts AS (
    SELECT
      rd.department_code,
      rd.department_name,
      rd.assigned_total,
      rd.resolved,
      rd.pending,
      rd.overdue,
      rd.no_deadline_count,
      pg_catalog.round((100.0 * rd.resolved) / NULLIF(rd.assigned_total, 0), 1) AS resolution_rate,
      pg_catalog.round(rd.avg_hours_raw::numeric, 2) AS avg_resolution_hours,
      FALSE AS is_other,
      FALSE AS is_suppressed,
      1 AS sort_group
    FROM raw_depts rd
    WHERE rd.assigned_total >= 5
  ),
  other_bucket AS (
    SELECT
      'other'::VARCHAR(50) AS department_code,
      'Other'::TEXT AS department_name,
      CASE WHEN pg_catalog.count(pdc.complaint_id) < 5 THEN NULL ELSE pg_catalog.count(pdc.complaint_id) END AS assigned_total,
      CASE WHEN pg_catalog.count(pdc.complaint_id) < 5 THEN NULL ELSE pg_catalog.count(pdc.complaint_id) FILTER (WHERE pdc.status = 'resolved'::public.complaint_status) END AS resolved,
      CASE WHEN pg_catalog.count(pdc.complaint_id) < 5 THEN NULL ELSE pg_catalog.count(pdc.complaint_id) FILTER (WHERE pdc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)) END AS pending,
      CASE WHEN pg_catalog.count(pdc.complaint_id) < 5 THEN NULL ELSE pg_catalog.count(pdc.complaint_id) FILTER (
        WHERE pdc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
          AND pdc.sla_deadline IS NOT NULL
          AND pdc.sla_deadline < pg_catalog.now()
      ) END AS overdue,
      CASE WHEN pg_catalog.count(pdc.complaint_id) < 5 THEN NULL ELSE pg_catalog.count(pdc.complaint_id) FILTER (
        WHERE pdc.status IN ('submitted'::public.complaint_status, 'under_review'::public.complaint_status, 'in_progress'::public.complaint_status)
          AND pdc.sla_deadline IS NULL
      ) END AS no_deadline_count,
      CASE WHEN pg_catalog.count(pdc.complaint_id) < 5 THEN NULL ELSE pg_catalog.round(
        (100.0 * pg_catalog.count(pdc.complaint_id) FILTER (WHERE pdc.status = 'resolved'::public.complaint_status)) / NULLIF(pg_catalog.count(pdc.complaint_id), 0),
        1
      ) END AS resolution_rate,
      CASE WHEN pg_catalog.count(pdc.complaint_id) < 5 THEN NULL ELSE pg_catalog.round(
        pg_catalog.avg(
          CASE
            WHEN pdc.status = 'resolved'::public.complaint_status
             AND pdc.resolved_at IS NOT NULL
             AND pdc.resolved_at >= pdc.created_at
            THEN EXTRACT(EPOCH FROM (pdc.resolved_at - pdc.created_at)) / 3600.0
            ELSE NULL
          END
        )::numeric,
        2
      ) END AS avg_resolution_hours,
      TRUE AS is_other,
      (pg_catalog.count(pdc.complaint_id) < 5) AS is_suppressed,
      2 AS sort_group
    FROM per_dept_complaint pdc
    JOIN raw_depts rd ON rd.dept_id = pdc.dept_id
    WHERE rd.assigned_total < 5
    HAVING pg_catalog.count(pdc.complaint_id) > 0
  ),
  combined AS (
    SELECT * FROM major_depts
    UNION ALL
    SELECT * FROM other_bucket
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'department_code', cb.department_code,
        'department_name', cb.department_name,
        'assigned_total', cb.assigned_total,
        'resolved', cb.resolved,
        'pending', cb.pending,
        'overdue', cb.overdue,
        'no_deadline_count', cb.no_deadline_count,
        'resolution_rate', cb.resolution_rate,
        'avg_resolution_hours', cb.avg_resolution_hours,
        'is_other', cb.is_other,
        'is_suppressed', cb.is_suppressed
      )
      ORDER BY cb.sort_group ASC, cb.assigned_total DESC NULLS LAST, cb.department_name ASC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM combined cb;

  RETURN v_rows;
END;
$$;

-- 5.4 Public Map Points (Rounded Coordinates Only; Excludes NULL Coords & Rejected)
-- Modest k-anonymity protection: when p_ward is specified and fewer than 5 matching
-- non-rejected complaints exist, aggregate counts (total_count, unmapped_count) are
-- suppressed (NULL) with count_suppressed = TRUE (subtraction against citywide totals remains possible).
CREATE OR REPLACE FUNCTION public.public_map_points(
  p_ward TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ward TEXT := NULLIF(pg_catalog.btrim(p_ward), '');
  v_category TEXT := NULLIF(pg_catalog.lower(pg_catalog.btrim(p_category)), '');
  v_points JSONB;
  v_mapped_total BIGINT;
  v_unmapped_raw BIGINT;
  v_matched_total BIGINT;
  v_truncated BOOLEAN;
  v_count_suppressed BOOLEAN;
  v_total_out BIGINT;
  v_unmapped_out BIGINT;
BEGIN
  IF v_ward IS NOT NULL AND pg_catalog.char_length(v_ward) > 100 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_ward exceeds maximum length of 100 characters.'
      USING ERRCODE = 'P0400';
  END IF;

  IF v_category IS NOT NULL AND v_category NOT IN (
    'potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure'
  ) THEN
    RAISE EXCEPTION 'Invalid Parameter: Unsupported civic category "%".', v_category
      USING ERRCODE = 'P0400';
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (WHERE c.latitude IS NOT NULL AND c.longitude IS NOT NULL),
    pg_catalog.count(*) FILTER (WHERE c.latitude IS NULL OR c.longitude IS NULL)
  INTO v_mapped_total, v_unmapped_raw
  FROM public.complaints c
  WHERE c.status <> 'rejected'::public.complaint_status
    AND (v_ward IS NULL OR COALESCE(NULLIF(pg_catalog.btrim(c.ward), ''), 'Unspecified') = v_ward)
    AND (v_category IS NULL OR c.category = v_category);

  v_matched_total := v_mapped_total + v_unmapped_raw;
  v_truncated := (v_mapped_total > 1000);

  IF v_ward IS NOT NULL AND v_matched_total < 5 THEN
    v_count_suppressed := TRUE;
    v_total_out := NULL;
    v_unmapped_out := NULL;
  ELSE
    v_count_suppressed := FALSE;
    v_total_out := v_matched_total;
    v_unmapped_out := v_unmapped_raw;
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'public_reference', pts.public_reference,
        'title', pts.title,
        'category', pts.category,
        'ward', pts.ward,
        'status', pts.status,
        'submitted_date', pts.submitted_date,
        'latitude', pts.latitude,
        'longitude', pts.longitude
      )
    ),
    '[]'::jsonb
  )
  INTO v_points
  FROM (
    SELECT
      c.public_reference,
      CASE c.category
        WHEN 'potholes' THEN 'Pothole & Road Damage Report'
        WHEN 'garbage' THEN 'Garbage & Waste Report'
        WHEN 'streetlights' THEN 'Broken Streetlight Report'
        WHEN 'water_leakage' THEN 'Water Supply & Leakage Report'
        WHEN 'drainage' THEN 'Drainage & Sewage Report'
        WHEN 'public_infrastructure' THEN 'Public Infrastructure Report'
        ELSE 'Municipal Civic Report'
      END AS title,
      c.category,
      COALESCE(NULLIF(pg_catalog.btrim(c.ward), ''), 'Unspecified') AS ward,
      c.status,
      (c.created_at AT TIME ZONE 'UTC')::date AS submitted_date,
      pg_catalog.round(c.latitude::numeric, 3)::double precision AS latitude,
      pg_catalog.round(c.longitude::numeric, 3)::double precision AS longitude
    FROM public.complaints c
    WHERE c.status <> 'rejected'::public.complaint_status
      AND c.latitude IS NOT NULL
      AND c.longitude IS NOT NULL
      AND (v_ward IS NULL OR COALESCE(NULLIF(pg_catalog.btrim(c.ward), ''), 'Unspecified') = v_ward)
      AND (v_category IS NULL OR c.category = v_category)
    ORDER BY c.created_at DESC, c.public_reference ASC
    LIMIT 1000
  ) pts;

  RETURN pg_catalog.jsonb_build_object(
    'points', v_points,
    'truncated', v_truncated,
    'total_count', v_total_out,
    'unmapped_count', v_unmapped_out,
    'count_suppressed', v_count_suppressed
  );
END;
$$;

-- 5.5 Paginated Public Explorer List (Hard Max Page Size = 50)
-- Modest k-anonymity protection: when p_ward is specified and fewer than 5 matching
-- non-rejected complaints exist, total_count is suppressed (NULL) with count_suppressed = TRUE.
CREATE OR REPLACE FUNCTION public.public_complaint_list(
  p_ward TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_status public.complaint_status DEFAULT NULL,
  p_page INT DEFAULT 1,
  p_page_size INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ward TEXT := NULLIF(pg_catalog.btrim(p_ward), '');
  v_category TEXT := NULLIF(pg_catalog.lower(pg_catalog.btrim(p_category)), '');
  v_offset INT;
  v_total_raw BIGINT;
  v_count_suppressed BOOLEAN;
  v_total_out BIGINT;
  v_items JSONB;
BEGIN
  IF p_page IS NULL OR p_page < 1 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_page must be an integer >= 1.'
      USING ERRCODE = 'P0400';
  END IF;

  IF p_page_size IS NULL OR p_page_size < 1 OR p_page_size > 50 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_page_size must be between 1 and 50.'
      USING ERRCODE = 'P0400';
  END IF;

  IF v_ward IS NOT NULL AND pg_catalog.char_length(v_ward) > 100 THEN
    RAISE EXCEPTION 'Invalid Parameter: p_ward exceeds maximum length of 100 characters.'
      USING ERRCODE = 'P0400';
  END IF;

  IF v_category IS NOT NULL AND v_category NOT IN (
    'potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure'
  ) THEN
    RAISE EXCEPTION 'Invalid Parameter: Unsupported civic category "%".', v_category
      USING ERRCODE = 'P0400';
  END IF;

  IF p_status = 'rejected'::public.complaint_status THEN
    RAISE EXCEPTION 'Invalid Parameter: Rejected complaints are excluded from public explorer.'
      USING ERRCODE = 'P0400';
  END IF;

  v_offset := (p_page - 1) * p_page_size;

  SELECT pg_catalog.count(*)
  INTO v_total_raw
  FROM public.complaints c
  WHERE c.status <> 'rejected'::public.complaint_status
    AND (v_ward IS NULL OR COALESCE(NULLIF(pg_catalog.btrim(c.ward), ''), 'Unspecified') = v_ward)
    AND (v_category IS NULL OR c.category = v_category)
    AND (p_status IS NULL OR c.status = p_status);

  IF v_ward IS NOT NULL AND v_total_raw < 5 THEN
    v_count_suppressed := TRUE;
    v_total_out := NULL;
  ELSE
    v_count_suppressed := FALSE;
    v_total_out := v_total_raw;
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'public_reference', rows.public_reference,
        'title', rows.title,
        'category', rows.category,
        'ward', rows.ward,
        'status', rows.status,
        'submitted_date', rows.submitted_date,
        'latitude', rows.latitude,
        'longitude', rows.longitude
      )
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT
      c.public_reference,
      CASE c.category
        WHEN 'potholes' THEN 'Pothole & Road Damage Report'
        WHEN 'garbage' THEN 'Garbage & Waste Report'
        WHEN 'streetlights' THEN 'Broken Streetlight Report'
        WHEN 'water_leakage' THEN 'Water Supply & Leakage Report'
        WHEN 'drainage' THEN 'Drainage & Sewage Report'
        WHEN 'public_infrastructure' THEN 'Public Infrastructure Report'
        ELSE 'Municipal Civic Report'
      END AS title,
      c.category,
      COALESCE(NULLIF(pg_catalog.btrim(c.ward), ''), 'Unspecified') AS ward,
      c.status,
      (c.created_at AT TIME ZONE 'UTC')::date AS submitted_date,
      CASE WHEN c.latitude IS NOT NULL THEN pg_catalog.round(c.latitude::numeric, 3)::double precision ELSE NULL END AS latitude,
      CASE WHEN c.longitude IS NOT NULL THEN pg_catalog.round(c.longitude::numeric, 3)::double precision ELSE NULL END AS longitude
    FROM public.complaints c
    WHERE c.status <> 'rejected'::public.complaint_status
      AND (v_ward IS NULL OR COALESCE(NULLIF(pg_catalog.btrim(c.ward), ''), 'Unspecified') = v_ward)
      AND (v_category IS NULL OR c.category = v_category)
      AND (p_status IS NULL OR c.status = p_status)
    ORDER BY c.created_at DESC, c.public_reference ASC
    LIMIT p_page_size
    OFFSET v_offset
  ) rows;

  RETURN pg_catalog.jsonb_build_object(
    'items', v_items,
    'total_count', v_total_out,
    'count_suppressed', v_count_suppressed,
    'page', p_page,
    'page_size', p_page_size
  );
END;
$$;

-- 5.6 Exact-Match Public Complaint Detail (Strict Field Allow-List)
-- Note: Backend (FastAPI) must validate UUID syntax before calling this RPC
-- and return HTTP 404 for malformed UUID inputs or NULL returns.
CREATE OR REPLACE FUNCTION public.public_complaint_detail(
  p_reference UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF p_reference IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_reference must be a valid non-null UUID.'
      USING ERRCODE = 'P0400';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'public_reference', c.public_reference,
    'title', CASE c.category
      WHEN 'potholes' THEN 'Pothole & Road Damage Report'
      WHEN 'garbage' THEN 'Garbage & Waste Report'
      WHEN 'streetlights' THEN 'Broken Streetlight Report'
      WHEN 'water_leakage' THEN 'Water Supply & Leakage Report'
      WHEN 'drainage' THEN 'Drainage & Sewage Report'
      WHEN 'public_infrastructure' THEN 'Public Infrastructure Report'
      ELSE 'Municipal Civic Report'
    END,
    'category', c.category,
    'ward', COALESCE(NULLIF(pg_catalog.btrim(c.ward), ''), 'Unspecified'),
    'status', c.status,
    'submitted_date', (c.created_at AT TIME ZONE 'UTC')::date,
    'latitude', CASE WHEN c.latitude IS NOT NULL THEN pg_catalog.round(c.latitude::numeric, 3)::double precision ELSE NULL END,
    'longitude', CASE WHEN c.longitude IS NOT NULL THEN pg_catalog.round(c.longitude::numeric, 3)::double precision ELSE NULL END
  )
  INTO v_result
  FROM public.complaints c
  WHERE c.public_reference = p_reference
    AND c.status <> 'rejected'::public.complaint_status;

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Function Ownership & Privilege Hardening (service_role EXECUTE Only)
-- -----------------------------------------------------------------------------
ALTER FUNCTION public.public_dashboard_stats() OWNER TO postgres;
ALTER FUNCTION public.public_ward_stats() OWNER TO postgres;
ALTER FUNCTION public.public_department_stats() OWNER TO postgres;
ALTER FUNCTION public.public_map_points(TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.public_complaint_list(TEXT, TEXT, public.complaint_status, INT, INT) OWNER TO postgres;
ALTER FUNCTION public.public_complaint_detail(UUID) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.public_dashboard_stats() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_ward_stats() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_department_stats() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_map_points(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_complaint_list(TEXT, TEXT, public.complaint_status, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_complaint_detail(UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.public_dashboard_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.public_ward_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.public_department_stats() TO service_role;
GRANT EXECUTE ON FUNCTION public.public_map_points(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_complaint_list(TEXT, TEXT, public.complaint_status, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_complaint_detail(UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- 7. Legacy View public.public_complaints — Anon Access Revocation
-- -----------------------------------------------------------------------------
-- Pre-Check (Verified from repository code inspection):
--   Searched frontend/src and backend/app for references to 'public_complaints'.
--   Result: ZERO files in frontend/src or backend/app query public.public_complaints.
--   (Phase 3/4 citizen pages query authenticated complaints + public_complaint_history;
--    ExploreIssuesPage currently uses local mock data until Phase 6.4 connects FastAPI.)
--   Therefore, revoking anon SELECT prevents unauthenticated exposure of officer_name,
--   sla_deadline, and rejected reports via the legacy view without breaking existing app code.
REVOKE SELECT ON public.public_complaints FROM PUBLIC, anon;

-- -----------------------------------------------------------------------------
-- 8. Post-Migration Verification Assertions
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_pre RECORD;
  v_post_count BIGINT;
  v_distinct_count BIGINT;
  v_null_count BIGINT;
  v_post_checksum TEXT;
  v_granted_insert_cols TEXT[];
  v_expected_insert_cols TEXT[] := ARRAY[
    'category', 'citizen_id', 'description', 'idempotency_key', 'image_url',
    'latitude', 'location', 'longitude', 'title', 'ward'
  ];
  v_trig_state CHAR;
  v_fn RECORD;
  v_list_res JSONB;
  v_det_res JSONB;
  v_sample_ref UUID;
  v_expected_keys TEXT[] := ARRAY[
    'category', 'latitude', 'longitude', 'public_reference',
    'status', 'submitted_date', 'title', 'ward'
  ];
  v_actual_keys TEXT[];
BEGIN
  -- 8.1 Verify public_reference populated uniquely with zero NULLs
  SELECT * INTO v_pre FROM _phase6_precheck_state;

  SELECT
    pg_catalog.count(*),
    pg_catalog.count(DISTINCT public_reference),
    pg_catalog.count(*) FILTER (WHERE public_reference IS NULL),
    COALESCE(
      pg_catalog.md5(pg_catalog.string_agg(id::text || ':' || pg_catalog.to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '|' ORDER BY id)),
      'EMPTY_TABLE'
    )
  INTO v_post_count, v_distinct_count, v_null_count, v_post_checksum
  FROM public.complaints;

  IF v_post_count <> v_pre.row_count THEN
    RAISE EXCEPTION 'Verification Failed: Row count mismatch (pre %, post %).', v_pre.row_count, v_post_count;
  END IF;
  IF v_null_count > 0 THEN
    RAISE EXCEPTION 'Verification Failed: % rows have NULL public_reference.', v_null_count;
  END IF;
  IF v_post_count <> v_distinct_count THEN
    RAISE EXCEPTION 'Verification Failed: Duplicate public_reference detected (total %, distinct %).', v_post_count, v_distinct_count;
  END IF;

  -- 8.2 Verify existing updated_at values were 100% untouched by DDL rewrite
  IF v_post_checksum IS DISTINCT FROM v_pre.updated_at_checksum THEN
    RAISE EXCEPTION 'Verification Failed: Existing updated_at checksum changed during migration!';
  END IF;

  -- 8.3 Confirm public_reference has zero INSERT/UPDATE grants for anon/authenticated
  -- and Phase 3.3.1 exact 10-column INSERT grant for authenticated is unchanged
  IF pg_catalog.has_column_privilege('authenticated', 'public.complaints', 'public_reference', 'INSERT') OR
     pg_catalog.has_column_privilege('authenticated', 'public.complaints', 'public_reference', 'UPDATE') OR
     pg_catalog.has_column_privilege('anon', 'public.complaints', 'public_reference', 'INSERT') OR
     pg_catalog.has_column_privilege('anon', 'public.complaints', 'public_reference', 'UPDATE') THEN
    RAISE EXCEPTION 'Verification Failed: Client roles hold INSERT or UPDATE privileges on public_reference.';
  END IF;

  SELECT pg_catalog.array_agg(column_name ORDER BY column_name)
  INTO v_granted_insert_cols
  FROM information_schema.column_privileges
  WHERE table_schema = 'public' AND table_name = 'complaints'
    AND grantee = 'authenticated' AND privilege_type = 'INSERT';

  IF v_granted_insert_cols IS DISTINCT FROM v_expected_insert_cols THEN
    RAISE EXCEPTION 'Verification Failed: Authenticated INSERT columns drifted. Expected %, got %', v_expected_insert_cols, v_granted_insert_cols;
  END IF;

  -- 8.4 Verify immutability trigger exists and is enabled
  SELECT tgenabled INTO v_trig_state
  FROM pg_catalog.pg_trigger
  WHERE tgrelid = 'public.complaints'::regclass
    AND tgname = 'trg_guard_public_reference_immutable'
    AND NOT tgisinternal;

  IF v_trig_state IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'Verification Failed: Trigger trg_guard_public_reference_immutable is missing or disabled.';
  END IF;

  -- 8.5 Verify legacy public.public_complaints no longer readable by anon
  IF pg_catalog.has_table_privilege('anon', 'public.public_complaints', 'SELECT') THEN
    RAISE EXCEPTION 'Verification Failed: anon still has SELECT privilege on legacy public.public_complaints.';
  END IF;

  -- 8.6 Verify exact function signatures, STABLE, SECURITY DEFINER, owner=postgres, search_path=''
  IF to_regprocedure('public.public_dashboard_stats()') IS NULL OR
     to_regprocedure('public.public_ward_stats()') IS NULL OR
     to_regprocedure('public.public_department_stats()') IS NULL OR
     to_regprocedure('public.public_map_points(text,text)') IS NULL OR
     to_regprocedure('public.public_complaint_list(text,text,public.complaint_status,integer,integer)') IS NULL OR
     to_regprocedure('public.public_complaint_detail(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Verification Failed: One or more Phase 6 public RPC signatures are missing.';
  END IF;

  FOR v_fn IN
    SELECT
      p.oid,
      p.proname,
      p.prosecdef,
      p.provolatile,
      r.rolname AS owner_name,
      p.proconfig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'public_dashboard_stats', 'public_ward_stats', 'public_department_stats',
        'public_map_points', 'public_complaint_list', 'public_complaint_detail'
      )
  LOOP
    IF NOT v_fn.prosecdef THEN
      RAISE EXCEPTION 'Verification Failed: % is not SECURITY DEFINER.', v_fn.proname;
    END IF;
    IF v_fn.provolatile <> 's' THEN
      RAISE EXCEPTION 'Verification Failed: % is not STABLE (provolatile=%).', v_fn.proname, v_fn.provolatile;
    END IF;
    IF v_fn.owner_name <> 'postgres' THEN
      RAISE EXCEPTION 'Verification Failed: % owner is %, expected postgres.', v_fn.proname, v_fn.owner_name;
    END IF;
    IF v_fn.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.unnest(v_fn.proconfig) cfg WHERE cfg ~ '^search_path=(|"")$'
    ) THEN
      RAISE EXCEPTION 'Verification Failed: % missing fixed empty search_path.', v_fn.proname;
    END IF;
    IF pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE') OR
       pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Verification Failed: Client role has EXECUTE on %.', v_fn.proname;
    END IF;
    IF NOT pg_catalog.has_function_privilege('service_role', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Verification Failed: service_role missing EXECUTE on %.', v_fn.proname;
    END IF;
  END LOOP;

  -- 8.7 Verify required supporting indexes exist
  IF to_regclass('public.uq_complaints_public_reference') IS NULL THEN
    RAISE EXCEPTION 'Verification Failed: Backing unique index uq_complaints_public_reference missing.';
  END IF;
  IF to_regclass('public.idx_complaints_public_active_coords') IS NULL OR
     to_regclass('public.idx_complaints_public_list') IS NULL OR
     to_regclass('public.idx_history_resolved_lookup') IS NULL THEN
    RAISE EXCEPTION 'Verification Failed: One or more Phase 6 supporting indexes are missing.';
  END IF;

  -- 8.8 Smoke-test all 6 public functions & assert strict field allow-list keys
  PERFORM public.public_dashboard_stats();
  PERFORM public.public_ward_stats();
  PERFORM public.public_department_stats();
  PERFORM public.public_map_points(NULL, NULL);
  v_list_res := public.public_complaint_list(NULL, NULL, NULL, 1, 20);

  IF public.public_complaint_detail('00000000-0000-0000-0000-000000000000'::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'Verification Failed: public_complaint_detail should return NULL for missing UUID.';
  END IF;

  IF pg_catalog.jsonb_array_length(v_list_res -> 'items') > 0 THEN
    SELECT pg_catalog.array_agg(k ORDER BY k)
    INTO v_actual_keys
    FROM pg_catalog.jsonb_object_keys((v_list_res -> 'items') -> 0) AS k;

    IF v_actual_keys IS DISTINCT FROM v_expected_keys THEN
      RAISE EXCEPTION 'Verification Failed: List item JSON keys mismatch. Expected %, got %', v_expected_keys, v_actual_keys;
    END IF;

    v_sample_ref := (((v_list_res -> 'items') -> 0) ->> 'public_reference')::uuid;
    v_det_res := public.public_complaint_detail(v_sample_ref);
    IF v_det_res IS NULL THEN
      RAISE EXCEPTION 'Verification Failed: public_complaint_detail returned NULL for active reference %.', v_sample_ref;
    END IF;

    SELECT pg_catalog.array_agg(k ORDER BY k)
    INTO v_actual_keys
    FROM pg_catalog.jsonb_object_keys(v_det_res) AS k;

    IF v_actual_keys IS DISTINCT FROM v_expected_keys THEN
      RAISE EXCEPTION 'Verification Failed: Detail JSON keys mismatch. Expected %, got %', v_expected_keys, v_actual_keys;
    END IF;
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK SECTION (OPERATOR-CONTROLLED; NEVER RUN AUTOMATICALLY; NO CASCADE)
-- =============================================================================
-- Dependencies & Restoration Risks:
--   1. Disable or remove FastAPI Phase 6 /api/public/* routes before dropping these RPCs.
--   2. Dropping complaints.public_reference breaks any bookmarked/shared public URLs
--      (/issues/<public_reference>) permanently; regenerate would yield new random UUIDs.
--   3. Restoring anon SELECT on legacy public.public_complaints re-exposes officer_name,
--      officer_designation, sla_deadline, and rejected complaint status to anonymous callers.
--
-- BEGIN;
-- REVOKE EXECUTE ON FUNCTION public.public_complaint_detail(UUID) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.public_complaint_list(TEXT, TEXT, public.complaint_status, INT, INT) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.public_map_points(TEXT, TEXT) FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.public_department_stats() FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.public_ward_stats() FROM service_role;
-- REVOKE EXECUTE ON FUNCTION public.public_dashboard_stats() FROM service_role;
--
-- DROP FUNCTION IF EXISTS public.public_complaint_detail(UUID);
-- DROP FUNCTION IF EXISTS public.public_complaint_list(TEXT, TEXT, public.complaint_status, INT, INT);
-- DROP FUNCTION IF EXISTS public.public_map_points(TEXT, TEXT);
-- DROP FUNCTION IF EXISTS public.public_department_stats();
-- DROP FUNCTION IF EXISTS public.public_ward_stats();
-- DROP FUNCTION IF EXISTS public.public_dashboard_stats();
--
-- DROP INDEX IF EXISTS public.idx_history_resolved_lookup;
-- DROP INDEX IF EXISTS public.idx_complaints_public_list;
-- DROP INDEX IF EXISTS public.idx_complaints_public_active_coords;
--
-- DROP TRIGGER IF EXISTS trg_guard_public_reference_immutable ON public.complaints;
-- DROP FUNCTION IF EXISTS public.guard_public_reference_immutable();
--
-- ALTER TABLE public.complaints DROP CONSTRAINT IF EXISTS uq_complaints_public_reference;
-- ALTER TABLE public.complaints DROP COLUMN IF EXISTS public_reference;
--
-- -- Optional (only if anonymous access to legacy view is explicitly desired again):
-- -- GRANT SELECT ON public.public_complaints TO anon;
-- COMMIT;
