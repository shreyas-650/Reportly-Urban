-- =============================================================================
-- SEED SCRIPT (TEST DATA ONLY — NOT PART OF MIGRATIONS):
-- Creates 2 active TEST officers per active department in public.officers:
--   1) One ward-assigned TEST officer using a real ward derived from complaints.
--   2) One NULL-ward fallback TEST officer (assigned_ward = NULL).
-- Safe to re-run. Use remove_phase9_3_test_officers.sql to clean up.
-- =============================================================================

BEGIN;

WITH target_ward AS (
  SELECT COALESCE(
    (
      SELECT ward
      FROM public.complaints
      WHERE ward IS NOT NULL
        AND pg_catalog.btrim(ward) <> ''
      GROUP BY ward
      ORDER BY pg_catalog.count(*) DESC, ward ASC
      LIMIT 1
    ),
    'Ward 1'
  ) AS ward_name
),
dept_rows AS (
  SELECT id AS department_id, name AS department_name
  FROM public.departments
  WHERE is_active = TRUE
)
INSERT INTO public.officers (
  profile_id,
  department_id,
  official_name,
  designation,
  assigned_ward,
  is_active,
  created_at
)
SELECT
  NULL,
  d.department_id,
  pair.officer_label || ' - ' || d.department_name,
  pair.designation,
  pair.ward_val,
  TRUE,
  pg_catalog.now()
FROM dept_rows d
CROSS JOIN target_ward tw
CROSS JOIN LATERAL (
  VALUES
    ('[TEST] Ward Officer 1', 'Junior Civic Engineer (TEST)', tw.ward_name),
    ('[TEST] Dept Fallback Officer 2', 'Senior Field Inspector (TEST)', NULL::varchar(100))
) AS pair(officer_label, designation, ward_val)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.officers existing
  WHERE existing.department_id = d.department_id
    AND existing.official_name = pair.officer_label || ' - ' || d.department_name
);

COMMIT;
