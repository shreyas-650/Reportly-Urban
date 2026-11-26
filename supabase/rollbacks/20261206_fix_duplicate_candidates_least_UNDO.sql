-- =============================================================================
-- UNDO: 20261206_fix_duplicate_candidates_least_UNDO.sql
-- Reverts to the original function body from 20261204 (with pg_catalog.least).
-- Only needed if you want to restore the broken version for some reason.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.find_duplicate_complaint_candidates(
  p_complaint_id UUID,
  p_radius_meters DOUBLE PRECISION DEFAULT 250,
  p_window_days INT DEFAULT 14,
  p_limit INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_target RECORD;
  v_radius DOUBLE PRECISION;
  v_days INT;
  v_cap INT;
  v_candidates JSONB;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_radius := GREATEST(1.0, LEAST(COALESCE(p_radius_meters, 250.0), 50000.0));
  v_days := GREATEST(1, LEAST(COALESCE(p_window_days, 14), 365));
  v_cap := GREATEST(1, LEAST(COALESCE(p_limit, 5), 10));

  SELECT id, complaint_number, category, title, description, ward, latitude, longitude, status::text AS status, created_at
  INTO v_target
  FROM public.complaints
  WHERE id = p_complaint_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_target.latitude IS NULL OR v_target.longitude IS NULL THEN
    RETURN jsonb_build_object(
      'target', jsonb_build_object(
        'id', v_target.id,
        'complaint_number', v_target.complaint_number,
        'category', v_target.category,
        'title', v_target.title,
        'description', v_target.description,
        'ward', v_target.ward,
        'status', v_target.status,
        'has_coordinates', false,
        'created_at', v_target.created_at
      ),
      'candidates', '[]'::jsonb
    );
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(cand)), '[]'::jsonb)
  INTO v_candidates
  FROM (
    SELECT
      c.id,
      c.complaint_number,
      c.category,
      c.title,
      c.description,
      c.ward,
      c.status::text AS status,
      c.created_at,
      dist.distance_meters
    FROM public.complaints c
    CROSS JOIN LATERAL (
      SELECT (
        2.0 * 6371000.0 * pg_catalog.asin(
          pg_catalog.sqrt(
            pg_catalog.least(
              1.0::double precision,
              pg_catalog.power(pg_catalog.sin(pg_catalog.radians(c.latitude - v_target.latitude) / 2.0), 2)
              + pg_catalog.cos(pg_catalog.radians(v_target.latitude))
              * pg_catalog.cos(pg_catalog.radians(c.latitude))
              * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(c.longitude - v_target.longitude) / 2.0), 2)
            )
          )
        )
      ) AS distance_meters
    ) dist
    WHERE c.id <> v_target.id
      AND c.category = v_target.category
      AND c.status IN (
        'submitted'::public.complaint_status,
        'under_review'::public.complaint_status,
        'in_progress'::public.complaint_status
      )
      AND c.latitude IS NOT NULL
      AND c.longitude IS NOT NULL
      AND c.created_at >= (v_target.created_at - pg_catalog.make_interval(days => v_days))
      AND c.created_at <= (v_target.created_at + INTERVAL '5 minutes')
      AND dist.distance_meters <= v_radius
      AND NOT EXISTS (
        SELECT 1
        FROM public.complaint_duplicate_links dl
        WHERE (
          LEAST(dl.complaint_id, dl.candidate_complaint_id) = LEAST(v_target.id, c.id)
          AND GREATEST(dl.complaint_id, dl.candidate_complaint_id) = GREATEST(v_target.id, c.id)
          AND dl.status IN ('confirmed_duplicate', 'not_duplicate')
        )
      )
    ORDER BY dist.distance_meters ASC, c.created_at DESC
    LIMIT v_cap
  ) cand;

  RETURN jsonb_build_object(
    'target', jsonb_build_object(
      'id', v_target.id,
      'complaint_number', v_target.complaint_number,
      'category', v_target.category,
      'title', v_target.title,
      'description', v_target.description,
      'ward', v_target.ward,
      'status', v_target.status,
      'has_coordinates', true,
      'created_at', v_target.created_at
    ),
    'candidates', v_candidates
  );
END;
$$;

ALTER FUNCTION public.find_duplicate_complaint_candidates(UUID, DOUBLE PRECISION, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.find_duplicate_complaint_candidates(UUID, DOUBLE PRECISION, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_duplicate_complaint_candidates(UUID, DOUBLE PRECISION, INT, INT) TO service_role;

COMMIT;
