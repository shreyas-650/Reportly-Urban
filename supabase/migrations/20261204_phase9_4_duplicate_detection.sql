-- =============================================================================
-- Migration: 20261204_phase9_4_duplicate_detection.sql
-- Module: Phase 9.4 — Duplicate Detection (Flag & Link Only)
-- Target: Supabase PostgreSQL
--
-- Purpose:
--   1. Creates public.complaint_duplicate_links to flag and link potential
--      duplicate complaints via rule-based geospatial/category matching and
--      optional Gemini comparison (stored in existing public.ai_decisions).
--   2. Prevents self-links (CHECK complaint_id <> candidate_complaint_id) and
--      prevents symmetric duplicate pairs via functional unique index on
--      (LEAST(complaint_id, candidate_complaint_id), GREATEST(...)).
--   3. Enforces FORCE ROW LEVEL SECURITY: only admins (public.is_admin()) can
--      read or review duplicate links. Citizens and officers see nothing.
--   4. Strictly read-only / non-destructive with respect to public.complaints:
--      flagging or confirming a duplicate NEVER rejects, merges, closes, hides,
--      reassigns, or alters SLA on any complaint.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Precondition Checks
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT pg_catalog.string_agg(req.label, ', ')
  INTO v_missing
  FROM (
    SELECT 'table public.complaints' AS label WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'complaints'
    )
    UNION ALL
    SELECT 'column public.complaints.latitude' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'latitude'
    )
    UNION ALL
    SELECT 'column public.complaints.longitude' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'complaints' AND column_name = 'longitude'
    )
    UNION ALL
    SELECT 'table public.ai_decisions' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'ai_decisions'
    )
    UNION ALL
    SELECT 'table public.profiles' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'profiles'
    )
    UNION ALL
    SELECT 'function public.is_admin()' WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin' AND p.pronargs = 0
    )
  ) req;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition Failed: Missing required prerequisite(s): %', v_missing;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Duplicate Links Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.complaint_duplicate_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  candidate_complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  similarity_score DOUBLE PRECISION NOT NULL CHECK (
    similarity_score >= 0.0
    AND similarity_score <= 1.0
    AND similarity_score <> 'NaN'::double precision
    AND similarity_score <> 'Infinity'::double precision
    AND similarity_score <> '-Infinity'::double precision
  ),
  reason TEXT NOT NULL CHECK (
    pg_catalog.char_length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500
  ),
  method TEXT NOT NULL CHECK (method IN ('rule', 'ai')),
  ai_decision_id UUID NULL REFERENCES public.ai_decisions(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'suspected' CHECK (
    status IN ('suspected', 'confirmed_duplicate', 'not_duplicate')
  ),
  decided_by UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decided_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT chk_no_self_duplicate_link CHECK (complaint_id <> candidate_complaint_id),
  CONSTRAINT chk_duplicate_link_decision_consistency CHECK (
    (
      status = 'suspected'
      AND decided_by IS NULL
      AND decided_at IS NULL
    ) OR (
      status IN ('confirmed_duplicate', 'not_duplicate')
      AND decided_by IS NOT NULL
      AND decided_at IS NOT NULL
    )
  )
);

COMMENT ON TABLE public.complaint_duplicate_links IS
  'Potential and admin-reviewed duplicate complaint pairs. Never rejects, merges, hides, or closes complaints; visible strictly to admins.';

-- -----------------------------------------------------------------------------
-- 3. Indexes & Symmetric Uniqueness
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uidx_complaint_duplicate_pair_symmetric
  ON public.complaint_duplicate_links (
    (LEAST(complaint_id, candidate_complaint_id)),
    (GREATEST(complaint_id, candidate_complaint_id))
  );

CREATE INDEX IF NOT EXISTS idx_dup_links_complaint_status
  ON public.complaint_duplicate_links (complaint_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dup_links_candidate
  ON public.complaint_duplicate_links (candidate_complaint_id);

CREATE INDEX IF NOT EXISTS idx_dup_links_status_created
  ON public.complaint_duplicate_links (status, created_at DESC);

-- -----------------------------------------------------------------------------
-- 4. Immutability & Governance Triggers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_duplicate_links_update_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role public.user_role;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Duplicate link audit records cannot be deleted.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.complaint_id <> OLD.complaint_id
     OR NEW.candidate_complaint_id <> OLD.candidate_complaint_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Duplicate link identity and provenance fields are immutable.'
      USING ERRCODE = '42501';
  END IF;

  -- Case A: Enrich suspected rule link with AI evaluation while still suspected
  IF OLD.status = 'suspected' AND NEW.status = 'suspected' THEN
    IF NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'Suspected duplicate links cannot set decision metadata.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Case B: Admin review transition (suspected -> confirmed_duplicate | not_duplicate)
  IF OLD.status = 'suspected' AND NEW.status IN ('confirmed_duplicate', 'not_duplicate') THEN
    IF NEW.decided_by IS NULL OR NEW.decided_at IS NULL THEN
      RAISE EXCEPTION 'Duplicate link review requires decided_by and decided_at.'
        USING ERRCODE = '22023';
    END IF;

    SELECT role INTO v_role FROM public.profiles WHERE id = NEW.decided_by;
    IF v_role IS DISTINCT FROM 'admin'::public.user_role THEN
      RAISE EXCEPTION 'Only verified administrators can confirm or dismiss duplicate links.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.similarity_score IS DISTINCT FROM OLD.similarity_score
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.method IS DISTINCT FROM OLD.method
       OR NEW.ai_decision_id IS DISTINCT FROM OLD.ai_decision_id THEN
      RAISE EXCEPTION 'Original duplicate detection evidence is immutable during admin review.'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Reviewed duplicate link rows are immutable and cannot be modified.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_duplicate_links_update_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_duplicate_links_update_delete() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_duplicate_links_update_delete ON public.complaint_duplicate_links;
CREATE TRIGGER trg_guard_duplicate_links_update_delete
  BEFORE UPDATE OR DELETE ON public.complaint_duplicate_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_duplicate_links_update_delete();

CREATE OR REPLACE FUNCTION public.guard_duplicate_links_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Truncating duplicate link history is prohibited.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_duplicate_links_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_duplicate_links_truncate() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_duplicate_links_truncate ON public.complaint_duplicate_links;
CREATE TRIGGER trg_guard_duplicate_links_truncate
  BEFORE TRUNCATE ON public.complaint_duplicate_links
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_duplicate_links_truncate();

-- -----------------------------------------------------------------------------
-- 5. Row Level Security & Privileges (Admin SELECT only; Zero direct writes)
-- -----------------------------------------------------------------------------
ALTER TABLE public.complaint_duplicate_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_duplicate_links FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.complaint_duplicate_links FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.complaint_duplicate_links TO authenticated;

DROP POLICY IF EXISTS "Admins can read duplicate links" ON public.complaint_duplicate_links;
CREATE POLICY "Admins can read duplicate links"
  ON public.complaint_duplicate_links
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

COMMENT ON POLICY "Admins can read duplicate links" ON public.complaint_duplicate_links IS
  'Restricts duplicate complaint link visibility strictly to administrators; citizens and officers receive 0 rows.';

-- -----------------------------------------------------------------------------
-- 6. Server-Only Rule Candidate Search & Link Persistence RPCs (service_role)
-- -----------------------------------------------------------------------------
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

  -- Strictly omit citizen_id, street location, name, phone, and email
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

CREATE OR REPLACE FUNCTION public.record_duplicate_link(
  p_complaint_id UUID,
  p_candidate_complaint_id UUID,
  p_similarity_score DOUBLE PRECISION,
  p_reason TEXT,
  p_method TEXT,
  p_ai_decision_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing RECORD;
  v_reason_clean TEXT;
  v_link_id UUID;
BEGIN
  IF p_complaint_id IS NULL OR p_candidate_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: complaint IDs are required.' USING ERRCODE = '22023';
  END IF;

  IF p_complaint_id = p_candidate_complaint_id THEN
    RAISE EXCEPTION 'Invalid Parameter: a complaint cannot be linked as a duplicate of itself.'
      USING ERRCODE = '22023';
  END IF;

  IF p_similarity_score IS NULL
     OR p_similarity_score = 'NaN'::double precision
     OR p_similarity_score = 'Infinity'::double precision
     OR p_similarity_score = '-Infinity'::double precision
     OR p_similarity_score < 0.0
     OR p_similarity_score > 1.0 THEN
    RAISE EXCEPTION 'Invalid Parameter: similarity_score must be finite in [0.0, 1.0].'
      USING ERRCODE = '22023';
  END IF;

  IF p_method IS NULL OR p_method NOT IN ('rule', 'ai') THEN
    RAISE EXCEPTION 'Invalid Parameter: method must be rule or ai.'
      USING ERRCODE = '22023';
  END IF;

  v_reason_clean := pg_catalog.left(pg_catalog.btrim(COALESCE(p_reason, '')), 500);
  IF pg_catalog.char_length(v_reason_clean) < 1 THEN
    RAISE EXCEPTION 'Invalid Parameter: reason is required.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.complaints WHERE id = p_complaint_id)
     OR NOT EXISTS (SELECT 1 FROM public.complaints WHERE id = p_candidate_complaint_id) THEN
    RAISE EXCEPTION 'Complaint reference not found.' USING ERRCODE = '23503';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(
      'dup_pair_' || LEAST(p_complaint_id, p_candidate_complaint_id)::text || '_' || GREATEST(p_complaint_id, p_candidate_complaint_id)::text
    )
  );

  SELECT id, status, method
  INTO v_existing
  FROM public.complaint_duplicate_links
  WHERE LEAST(complaint_id, candidate_complaint_id) = LEAST(p_complaint_id, p_candidate_complaint_id)
    AND GREATEST(complaint_id, candidate_complaint_id) = GREATEST(p_complaint_id, p_candidate_complaint_id)
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'suspected' AND p_method = 'ai' AND v_existing.method = 'rule' THEN
      UPDATE public.complaint_duplicate_links
      SET similarity_score = p_similarity_score,
          reason = v_reason_clean,
          method = 'ai',
          ai_decision_id = p_ai_decision_id,
          updated_at = pg_catalog.now()
      WHERE id = v_existing.id;
    END IF;
    RETURN v_existing.id;
  END IF;

  INSERT INTO public.complaint_duplicate_links (
    complaint_id,
    candidate_complaint_id,
    similarity_score,
    reason,
    method,
    ai_decision_id,
    status
  ) VALUES (
    p_complaint_id,
    p_candidate_complaint_id,
    p_similarity_score,
    v_reason_clean,
    p_method,
    p_ai_decision_id,
    'suspected'
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_link_id;

  IF v_link_id IS NULL THEN
    SELECT id INTO v_link_id
    FROM public.complaint_duplicate_links
    WHERE LEAST(complaint_id, candidate_complaint_id) = LEAST(p_complaint_id, p_candidate_complaint_id)
      AND GREATEST(complaint_id, candidate_complaint_id) = GREATEST(p_complaint_id, p_candidate_complaint_id);
  END IF;

  RETURN v_link_id;
END;
$$;

ALTER FUNCTION public.record_duplicate_link(UUID, UUID, DOUBLE PRECISION, TEXT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_duplicate_link(UUID, UUID, DOUBLE PRECISION, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_duplicate_link(UUID, UUID, DOUBLE PRECISION, TEXT, TEXT, UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- 7. Admin Duplicate Read & Review RPCs (authenticated + public.is_admin())
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_complaint_duplicates(
  p_complaint_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
DECLARE
  v_links JSONB;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Only municipal administrators can view duplicate links.'
      USING ERRCODE = '42501';
  END IF;

  IF p_complaint_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_complaint_id is required.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.complaints WHERE id = p_complaint_id) THEN
    RAISE EXCEPTION 'Complaint % not found.', p_complaint_id USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(lnk)), '[]'::jsonb)
  INTO v_links
  FROM (
    SELECT
      dl.id,
      dl.complaint_id,
      dl.candidate_complaint_id,
      dl.similarity_score,
      dl.reason,
      dl.method,
      dl.status,
      dl.decided_by,
      dl.decided_at,
      dl.created_at,
      CASE WHEN dl.complaint_id = p_complaint_id THEN c2.id ELSE c1.id END AS linked_complaint_id,
      CASE WHEN dl.complaint_id = p_complaint_id THEN c2.complaint_number ELSE c1.complaint_number END AS linked_complaint_number,
      CASE WHEN dl.complaint_id = p_complaint_id THEN c2.title ELSE c1.title END AS linked_title,
      CASE WHEN dl.complaint_id = p_complaint_id THEN c2.category ELSE c1.category END AS linked_category,
      CASE WHEN dl.complaint_id = p_complaint_id THEN c2.ward ELSE c1.ward END AS linked_ward,
      CASE WHEN dl.complaint_id = p_complaint_id THEN c2.status::text ELSE c1.status::text END AS linked_status,
      CASE WHEN dl.complaint_id = p_complaint_id THEN c2.priority::text ELSE c1.priority::text END AS linked_priority,
      CASE WHEN dl.complaint_id = p_complaint_id THEN c2.created_at ELSE c1.created_at END AS linked_created_at
    FROM public.complaint_duplicate_links dl
    JOIN public.complaints c1 ON c1.id = dl.complaint_id
    JOIN public.complaints c2 ON c2.id = dl.candidate_complaint_id
    WHERE dl.complaint_id = p_complaint_id
       OR dl.candidate_complaint_id = p_complaint_id
    ORDER BY
      CASE WHEN dl.status = 'suspected' THEN 0 ELSE 1 END,
      dl.similarity_score DESC,
      dl.created_at DESC
  ) lnk;

  RETURN v_links;
END;
$$;

ALTER FUNCTION public.get_admin_complaint_duplicates(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_admin_complaint_duplicates(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_complaint_duplicates(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_admin_suspected_duplicates(
  p_status TEXT DEFAULT 'suspected',
  p_page INT DEFAULT 1,
  p_page_size INT DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
DECLARE
  v_status TEXT;
  v_page INT;
  v_size INT;
  v_offset INT;
  v_total INT;
  v_items JSONB;
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Only municipal administrators can list duplicate links.'
      USING ERRCODE = '42501';
  END IF;

  v_status := COALESCE(NULLIF(pg_catalog.btrim(p_status), ''), 'suspected');
  IF v_status NOT IN ('all', 'suspected', 'confirmed_duplicate', 'not_duplicate') THEN
    RAISE EXCEPTION 'Invalid Parameter: unsupported duplicate status filter.' USING ERRCODE = '22023';
  END IF;

  v_page := GREATEST(1, COALESCE(p_page, 1));
  v_size := GREATEST(1, LEAST(COALESCE(p_page_size, 20), 100));
  v_offset := (v_page - 1) * v_size;

  SELECT pg_catalog.count(*)::int
  INTO v_total
  FROM public.complaint_duplicate_links dl
  WHERE v_status = 'all' OR dl.status = v_status;

  SELECT COALESCE(jsonb_agg(row_to_json(rows)), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      dl.id,
      dl.complaint_id,
      dl.candidate_complaint_id,
      dl.similarity_score,
      dl.reason,
      dl.method,
      dl.status,
      dl.decided_at,
      dl.created_at,
      c1.complaint_number AS complaint_number,
      c1.title AS complaint_title,
      c1.category AS complaint_category,
      c1.ward AS complaint_ward,
      c1.status::text AS complaint_status,
      c2.complaint_number AS candidate_complaint_number,
      c2.title AS candidate_title,
      c2.ward AS candidate_ward,
      c2.status::text AS candidate_status
    FROM public.complaint_duplicate_links dl
    JOIN public.complaints c1 ON c1.id = dl.complaint_id
    JOIN public.complaints c2 ON c2.id = dl.candidate_complaint_id
    WHERE v_status = 'all' OR dl.status = v_status
    ORDER BY
      CASE WHEN dl.status = 'suspected' THEN 0 ELSE 1 END,
      dl.created_at DESC
    LIMIT v_size OFFSET v_offset
  ) rows;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'page', v_page,
    'page_size', v_size,
    'total_pages', GREATEST(1, pg_catalog.ceil(v_total::numeric / v_size)::int)
  );
END;
$$;

ALTER FUNCTION public.list_admin_suspected_duplicates(TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_admin_suspected_duplicates(TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_admin_suspected_duplicates(TEXT, INT, INT) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_duplicate_link(
  p_link_id UUID,
  p_decision TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID;
  v_row RECORD;
  v_now TIMESTAMPTZ := pg_catalog.now();
BEGIN
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'Security Violation: Only municipal administrators can decide duplicate links.'
      USING ERRCODE = '42501';
  END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Security Violation: Missing authenticated actor.' USING ERRCODE = '42501';
  END IF;

  IF p_link_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: p_link_id is required.' USING ERRCODE = '22023';
  END IF;

  IF p_decision IS NULL OR p_decision NOT IN ('confirmed_duplicate', 'not_duplicate') THEN
    RAISE EXCEPTION 'Invalid Parameter: p_decision must be confirmed_duplicate or not_duplicate.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_row
  FROM public.complaint_duplicate_links
  WHERE id = p_link_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Duplicate link % not found.', p_link_id USING ERRCODE = 'P0002';
  END IF;

  IF v_row.status <> 'suspected' THEN
    RAISE EXCEPTION 'Duplicate link has already been reviewed (%).', v_row.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Strictly records the link review; NEVER closes, merges, rejects, or modifies complaints
  UPDATE public.complaint_duplicate_links
  SET status = p_decision,
      decided_by = v_actor_id,
      decided_at = v_now,
      updated_at = v_now
  WHERE id = p_link_id;

  RETURN jsonb_build_object(
    'success', true,
    'link_id', p_link_id,
    'complaint_id', v_row.complaint_id,
    'candidate_complaint_id', v_row.candidate_complaint_id,
    'status', p_decision,
    'decided_at', v_now
  );
END;
$$;

ALTER FUNCTION public.decide_duplicate_link(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.decide_duplicate_link(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_duplicate_link(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Final Privilege & RLS Audit Block
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_relacl aclitem[];
  v_fn RECORD;
BEGIN
  SELECT c.relacl
  INTO v_relacl
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'complaint_duplicate_links'
    AND c.relrowsecurity = TRUE
    AND c.relforcerowsecurity = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audit Failed: RLS and FORCE ROW LEVEL SECURITY must be enabled on public.complaint_duplicate_links.';
  END IF;

  IF (
    v_relacl IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(v_relacl) a WHERE a.grantee = 0
    )
  )
     OR pg_catalog.has_table_privilege('anon', 'public.complaint_duplicate_links', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.complaint_duplicate_links', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_duplicate_links', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_duplicate_links', 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_duplicate_links', 'DELETE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.complaint_duplicate_links', 'TRUNCATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_duplicate_links', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_duplicate_links', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_duplicate_links', 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', 'public.complaint_duplicate_links', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Audit Failed: Unauthorized privileges detected on public.complaint_duplicate_links.';
  END IF;

  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'guard_duplicate_links_update_delete',
        'guard_duplicate_links_truncate',
        'find_duplicate_complaint_candidates',
        'record_duplicate_link'
      )
  ) LOOP
    IF v_fn.proacl IS NULL
       OR EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(v_fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Function public.%() exposes EXECUTE to PUBLIC, anon, or authenticated.', v_fn.proname;
    END IF;
  END LOOP;

  FOR v_fn IN (
    SELECT p.oid, p.proname, p.proacl
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_admin_complaint_duplicates',
        'list_admin_suspected_duplicates',
        'decide_duplicate_link'
      )
  ) LOOP
    IF v_fn.proacl IS NULL
       OR EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(v_fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Audit Failed: Function public.%() exposes EXECUTE to PUBLIC or anon.', v_fn.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
