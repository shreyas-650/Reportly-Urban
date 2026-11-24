-- ==============================================================================
-- Reportly Urban — Phase 2.1 Database Schema & Security Migration (Final)
-- Target: Supabase PostgreSQL
-- Note: This is an initial provisioning migration. CREATE TABLE IF NOT EXISTS
-- will not alter or reconcile existing columns/constraints if run against a dirty
-- database. For clean deployment, run in a fresh Supabase database instance.
-- ==============================================================================

-- Enable pgcrypto for UUID generation if not present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Revoke default CREATE privileges on public schema from client roles
REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 1. Enums & Custom Types
-- ------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'user_role' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.user_role AS ENUM ('citizen', 'officer', 'admin');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'complaint_status' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.complaint_status AS ENUM ('submitted', 'under_review', 'in_progress', 'resolved', 'rejected');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'complaint_priority' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public.complaint_priority AS ENUM ('low', 'normal', 'medium', 'high', 'emergency');
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 2. Base Tables
-- ------------------------------------------------------------------------------

-- Departments (Municipal Divisions)
CREATE TABLE IF NOT EXISTS public.departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  code VARCHAR(50) NOT NULL UNIQUE,
  default_sla_hours INT NOT NULL DEFAULT 48,
  contact_email TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Profiles (Private citizen and staff identity)
-- ON DELETE CASCADE allows removing empty/spam auth accounts with no civic activity.
-- Accounts with complaints or audit history remain protected by downstream RESTRICT constraints.
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  phone_number VARCHAR(20) NULL,
  ward VARCHAR(100) NOT NULL,
  role public.user_role NOT NULL DEFAULT 'citizen',
  civic_points INT NOT NULL DEFAULT 0,
  badge_level TEXT NOT NULL DEFAULT 'Civic Starter',
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Officers (Municipal engineers and inspectors)
-- Contains profile_id which links internal auth UUID. Never exposed directly to public.
CREATE TABLE IF NOT EXISTS public.officers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID UNIQUE NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  department_id UUID NOT NULL REFERENCES public.departments(id) ON DELETE RESTRICT,
  official_name TEXT NOT NULL,
  designation TEXT NOT NULL,
  assigned_ward VARCHAR(100) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Complaint Yearly Counters (Concurrency-safe sequence tracker)
CREATE TABLE IF NOT EXISTS public.complaint_yearly_counters (
  year INT PRIMARY KEY,
  last_value INT NOT NULL DEFAULT 0
);

-- Complaints (Core grievance table)
CREATE TABLE IF NOT EXISTS public.complaints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_number VARCHAR(30) UNIQUE NOT NULL,
  citizen_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(50) NOT NULL CHECK (category IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure')),
  description TEXT NOT NULL,
  location TEXT NOT NULL,
  ward VARCHAR(100) NOT NULL,
  latitude DOUBLE PRECISION NULL,
  longitude DOUBLE PRECISION NULL,
  status public.complaint_status NOT NULL DEFAULT 'submitted',
  priority public.complaint_priority NOT NULL DEFAULT 'normal',
  department_id UUID NULL REFERENCES public.departments(id) ON DELETE SET NULL,
  assigned_officer_id UUID NULL REFERENCES public.officers(id) ON DELETE SET NULL,
  image_url TEXT NOT NULL,
  completion_image_url TEXT NULL,
  sla_deadline TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Complaint Status History (Immutable audit log)
-- ON DELETE RESTRICT ensures neither complaints nor actor profiles can be deleted if history exists
CREATE TABLE IF NOT EXISTS public.complaint_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NOT NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  status public.complaint_status NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NULL,
  actor_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- ------------------------------------------------------------------------------
-- 3. Indexes
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_profiles_ward ON public.profiles(ward);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_officers_department ON public.officers(department_id);
CREATE INDEX IF NOT EXISTS idx_officers_profile ON public.officers(profile_id);
CREATE INDEX IF NOT EXISTS idx_complaints_citizen ON public.complaints(citizen_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON public.complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_category ON public.complaints(category);
CREATE INDEX IF NOT EXISTS idx_complaints_ward ON public.complaints(ward);
CREATE INDEX IF NOT EXISTS idx_complaints_created ON public.complaints(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaint_history_complaint ON public.complaint_status_history(complaint_id);
CREATE INDEX IF NOT EXISTS idx_complaint_history_complaint_created ON public.complaint_status_history(complaint_id, created_at ASC);

-- ------------------------------------------------------------------------------
-- 4. Secure Helper Functions (Hardened search_path = '')
-- ------------------------------------------------------------------------------

-- Check if current authenticated caller is an admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'::public.user_role
  );
$$;

ALTER FUNCTION public.is_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- Get current active officer record ID for the caller
CREATE OR REPLACE FUNCTION public.get_current_officer_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT id FROM public.officers
  WHERE profile_id = auth.uid() AND is_active = TRUE
  LIMIT 1;
$$;

ALTER FUNCTION public.get_current_officer_id() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_current_officer_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_officer_id() TO authenticated;

-- Atomic concurrency-safe complaint number generator
CREATE OR REPLACE FUNCTION public.generate_complaint_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_year INT;
  v_next_val INT;
BEGIN
  v_current_year := pg_catalog.date_part('year', pg_catalog.now())::INT;

  INSERT INTO public.complaint_yearly_counters (year, last_value)
  VALUES (v_current_year, 1)
  ON CONFLICT (year) DO UPDATE
  SET last_value = public.complaint_yearly_counters.last_value + 1
  RETURNING last_value INTO v_next_val;

  RETURN 'RU-' || v_current_year::TEXT || '-' || pg_catalog.lpad(v_next_val::TEXT, 4, '0');
END;
$$;

ALTER FUNCTION public.generate_complaint_number() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.generate_complaint_number() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 5. Status Transition Procedure (Atomic State Machine)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_complaint_status(
  p_complaint_id UUID,
  p_new_status public.complaint_status,
  p_notes TEXT DEFAULT NULL,
  p_completion_image_url TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID;
  v_officer_id UUID;
  v_is_admin BOOLEAN;
  v_current_status public.complaint_status;
  v_assigned_officer_id UUID;
  v_is_valid_transition BOOLEAN := FALSE;
  v_stage_title TEXT;
BEGIN
  -- Authenticate caller
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;

  v_is_admin := public.is_admin();
  v_officer_id := public.get_current_officer_id();

  -- Lock row and fetch current status
  SELECT status, assigned_officer_id
  INTO v_current_status, v_assigned_officer_id
  FROM public.complaints
  WHERE id = p_complaint_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Complaint with ID % not found.', p_complaint_id;
  END IF;

  -- Validate caller authority: only admin or assigned officer can change status
  IF NOT v_is_admin THEN
    IF v_officer_id IS NULL OR v_assigned_officer_id IS NULL OR v_officer_id <> v_assigned_officer_id THEN
      RAISE EXCEPTION 'Unauthorized: Caller is not the officer assigned to this complaint.' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Validate permitted transition
  IF (v_current_status = 'submitted'::public.complaint_status AND p_new_status IN ('under_review'::public.complaint_status, 'rejected'::public.complaint_status)) THEN
    v_is_valid_transition := TRUE;
  ELSIF (v_current_status = 'under_review'::public.complaint_status AND p_new_status IN ('in_progress'::public.complaint_status, 'rejected'::public.complaint_status)) THEN
    v_is_valid_transition := TRUE;
  ELSIF (v_current_status = 'in_progress'::public.complaint_status AND p_new_status IN ('resolved'::public.complaint_status, 'rejected'::public.complaint_status)) THEN
    v_is_valid_transition := TRUE;
  END IF;

  IF NOT v_is_valid_transition THEN
    RAISE EXCEPTION 'Illegal status transition from % to %.', v_current_status, p_new_status;
  END IF;

  -- Derive canonical history title from target status
  v_stage_title := CASE p_new_status
    WHEN 'under_review'::public.complaint_status THEN 'Under Municipal Review'
    WHEN 'in_progress'::public.complaint_status THEN 'Remediation In Progress'
    WHEN 'resolved'::public.complaint_status THEN 'Issue Resolved'
    WHEN 'rejected'::public.complaint_status THEN 'Report Rejected'
    ELSE 'Status Updated'
  END;

  -- 1. Update complaint status and optional completion image atomically
  UPDATE public.complaints
  SET status = p_new_status,
      completion_image_url = CASE 
        WHEN p_new_status = 'resolved'::public.complaint_status AND p_completion_image_url IS NOT NULL THEN p_completion_image_url
        ELSE completion_image_url
      END,
      updated_at = pg_catalog.now()
  WHERE id = p_complaint_id;

  -- 2. Insert audit history event atomically
  INSERT INTO public.complaint_status_history (
    complaint_id,
    status,
    title,
    notes,
    actor_id,
    created_at
  ) VALUES (
    p_complaint_id,
    p_new_status,
    v_stage_title,
    p_notes,
    v_caller_id,
    pg_catalog.now()
  );
END;
$$;

ALTER FUNCTION public.transition_complaint_status(UUID, public.complaint_status, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transition_complaint_status(UUID, public.complaint_status, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_complaint_status(UUID, public.complaint_status, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------------------------
-- 6. Database Triggers & Guard Functions
-- ------------------------------------------------------------------------------

-- Trigger Function: Automatic Profile Creation on Signup (Idempotent)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    full_name,
    phone_number,
    ward,
    role,
    civic_points,
    badge_level
  ) VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'Citizen User'),
    NEW.raw_user_meta_data->>'phone_number',
    COALESCE(NEW.raw_user_meta_data->>'ward', 'Unassigned Ward'),
    'citizen'::public.user_role,
    0,
    'Civic Starter'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Trigger Function: Profile Privilege Modification Guard
CREATE OR REPLACE FUNCTION public.guard_profile_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (NEW.role IS DISTINCT FROM OLD.role) OR
     (NEW.civic_points IS DISTINCT FROM OLD.civic_points) OR
     (NEW.badge_level IS DISTINCT FROM OLD.badge_level) THEN
    IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
      RAISE EXCEPTION 'Modifications to role, points, or badges require authorized backend service credentials.' USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_profile_updates() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_profile_updates() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_profile_updates ON public.profiles;
CREATE TRIGGER trg_guard_profile_updates
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_updates();

-- Trigger Function: Complaint Pre-Insert (Always generates complaint_number internally)
CREATE OR REPLACE FUNCTION public.handle_new_complaint_pre_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.complaint_number := public.generate_complaint_number();
  NEW.status := 'submitted'::public.complaint_status;
  NEW.created_at := pg_catalog.now();
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_complaint_pre_insert() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_new_complaint_pre_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_new_complaint_pre_insert ON public.complaints;
CREATE TRIGGER trg_new_complaint_pre_insert
  BEFORE INSERT ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_complaint_pre_insert();

-- Trigger Function: Complaint Post-Insert (Initial Audit Event)
CREATE OR REPLACE FUNCTION public.handle_new_complaint_post_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.complaint_status_history (
    complaint_id,
    status,
    title,
    notes,
    actor_id,
    created_at
  ) VALUES (
    NEW.id,
    'submitted'::public.complaint_status,
    'Report Registered',
    'Grievance logged with photographic evidence by citizen.',
    NEW.citizen_id,
    NEW.created_at
  );
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_complaint_post_insert() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_new_complaint_post_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_new_complaint_post_insert ON public.complaints;
CREATE TRIGGER trg_new_complaint_post_insert
  AFTER INSERT ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_complaint_post_insert();

-- Trigger Function: Complaint Metadata Immutability Guard
CREATE OR REPLACE FUNCTION public.guard_direct_complaint_status_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Prevent modification of immutable fields
  IF (NEW.citizen_id IS DISTINCT FROM OLD.citizen_id) OR
     (NEW.complaint_number IS DISTINCT FROM OLD.complaint_number) OR
     (NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'Core complaint metadata (citizen_id, complaint_number, created_at) cannot be mutated.';
  END IF;

  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_direct_complaint_status_update() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_direct_complaint_status_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_complaint_status_update ON public.complaints;
CREATE TRIGGER trg_guard_complaint_status_update
  BEFORE UPDATE ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.guard_direct_complaint_status_update();

-- Trigger Function: Immutable History Blocker (No UPDATE or DELETE allowed for any user)
CREATE OR REPLACE FUNCTION public.guard_immutable_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Complaint audit history records are strictly immutable and cannot be updated or deleted by any user.' USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_history() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_history ON public.complaint_status_history;
CREATE TRIGGER trg_guard_immutable_history
  BEFORE UPDATE OR DELETE ON public.complaint_status_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_history();

-- Trigger Function: Truncate History Blocker
CREATE OR REPLACE FUNCTION public.guard_immutable_history_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'Complaint audit history records are strictly immutable and truncating is prohibited.' USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_history_truncate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_history_truncate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_immutable_history_truncate ON public.complaint_status_history;
CREATE TRIGGER trg_guard_immutable_history_truncate
  BEFORE TRUNCATE ON public.complaint_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_history_truncate();

-- ------------------------------------------------------------------------------
-- 7. Sanitized Security Views (Standard Definier Views + Security Barrier)
-- Owned by postgres; exposes safe projections without leaking base table rows.
-- Note: public_profiles is deferred as public community leaderboards belong to a later phase.
-- ------------------------------------------------------------------------------

-- Public Officers View (Sanitized public view; profile_id auth UUID is omitted)
CREATE OR REPLACE VIEW public.public_officers
WITH (security_barrier = TRUE) AS
  SELECT
    o.id,
    o.department_id,
    d.name AS department_name,
    o.official_name,
    o.designation,
    o.assigned_ward
  FROM public.officers o
  JOIN public.departments d ON o.department_id = d.id
  WHERE o.is_active = TRUE;

ALTER VIEW public.public_officers OWNER TO postgres;

-- Public Complaints View (Sanitized view; raw citizen titles and unverified ward text are protected)
-- Note: Direct publication of citizen titles and raw ward strings is deferred until formal moderation and municipal ward reference tables are introduced.
CREATE OR REPLACE VIEW public.public_complaints
WITH (security_barrier = TRUE) AS
  SELECT
    c.id,
    c.complaint_number,
    CASE 
      WHEN c.status = 'submitted'::public.complaint_status THEN 'Grievance Under Review'
      WHEN c.status = 'rejected'::public.complaint_status THEN 'Report Rejected / Closed'
      WHEN c.category = 'potholes' THEN 'Civic Issue: Potholes & Damaged Roads'
      WHEN c.category = 'garbage' THEN 'Civic Issue: Garbage & Waste'
      WHEN c.category = 'streetlights' THEN 'Civic Issue: Broken Streetlights'
      WHEN c.category = 'water_leakage' THEN 'Civic Issue: Water Supply & Leakage'
      WHEN c.category = 'drainage' THEN 'Civic Issue: Drainage & Sewage'
      WHEN c.category = 'public_infrastructure' THEN 'Civic Issue: Public Infrastructure'
      ELSE 'Civic Issue: General Municipal Grievance'
    END AS title,
    CASE 
      WHEN c.category IN ('potholes', 'garbage', 'streetlights', 'water_leakage', 'drainage', 'public_infrastructure') THEN c.category
      ELSE 'unclassified'
    END AS category,
    NULL::VARCHAR(100) AS ward,
    c.status,
    c.priority,
    d.name AS department_name,
    o.official_name AS officer_name,
    o.designation AS officer_designation,
    c.created_at,
    c.sla_deadline
  FROM public.complaints c
  LEFT JOIN public.departments d ON c.department_id = d.id
  LEFT JOIN public.officers o ON c.assigned_officer_id = o.id;

ALTER VIEW public.public_complaints OWNER TO postgres;

-- Public Complaint History View (Exposes canonical stage titles; notes and actor_id are omitted)
CREATE OR REPLACE VIEW public.public_complaint_history
WITH (security_barrier = TRUE) AS
  SELECT
    h.id,
    h.complaint_id,
    h.status,
    CASE h.status
      WHEN 'submitted'::public.complaint_status THEN 'Report Registered'
      WHEN 'under_review'::public.complaint_status THEN 'Under Municipal Review'
      WHEN 'in_progress'::public.complaint_status THEN 'Remediation In Progress'
      WHEN 'resolved'::public.complaint_status THEN 'Issue Resolved'
      WHEN 'rejected'::public.complaint_status THEN 'Report Rejected'
      ELSE 'Status Updated'
    END AS stage_title,
    h.created_at
  FROM public.complaint_status_history h;

ALTER VIEW public.public_complaint_history OWNER TO postgres;

-- ------------------------------------------------------------------------------
-- 8. Row Level Security & Policies
-- ------------------------------------------------------------------------------

-- Enable RLS across all base tables
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.officers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_yearly_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaint_status_history ENABLE ROW LEVEL SECURITY;

-- 8.1 Departments Policies
DROP POLICY IF EXISTS "Public can view departments" ON public.departments;
CREATE POLICY "Public can view departments" ON public.departments
  FOR SELECT TO PUBLIC USING (TRUE);

DROP POLICY IF EXISTS "Admins can manage departments" ON public.departments;
CREATE POLICY "Admins can manage departments" ON public.departments
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 8.2 Profiles Policies
DROP POLICY IF EXISTS "Users can view their own profile" ON public.profiles;
CREATE POLICY "Users can view their own profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id OR public.is_admin());

DROP POLICY IF EXISTS "Users can update their own profile details" ON public.profiles;
CREATE POLICY "Users can update their own profile details" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id OR public.is_admin()) WITH CHECK (auth.uid() = id OR public.is_admin());

-- 8.3 Officers Policies
-- Base table restricted to admins and the officer themselves; public & ordinary citizens read public_officers view
DROP POLICY IF EXISTS "Officers and admins can view officers table" ON public.officers;
CREATE POLICY "Officers and admins can view officers table" ON public.officers
  FOR SELECT TO authenticated USING (profile_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "Admins can manage officers" ON public.officers;
CREATE POLICY "Admins can manage officers" ON public.officers
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 8.4 Complaints Policies (No DELETE policy exists for any role; deletion is prohibited)
DROP POLICY IF EXISTS "Complaints readable by owner, assigned officer, or admin" ON public.complaints;
CREATE POLICY "Complaints readable by owner, assigned officer, or admin" ON public.complaints
  FOR SELECT TO authenticated
  USING (
    citizen_id = auth.uid() OR
    assigned_officer_id = public.get_current_officer_id() OR
    public.is_admin()
  );

DROP POLICY IF EXISTS "Citizens can insert complaints" ON public.complaints;
CREATE POLICY "Citizens can insert complaints" ON public.complaints
  FOR INSERT TO authenticated
  WITH CHECK (
    citizen_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'citizen'::public.user_role
    )
  );

DROP POLICY IF EXISTS "Admins can update complaints" ON public.complaints;
CREATE POLICY "Admins can update complaints" ON public.complaints
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 8.5 Complaint Status History Policies (No UPDATE/DELETE policy exists)
DROP POLICY IF EXISTS "History readable by complaint owner, assigned officer, or admin" ON public.complaint_status_history;
CREATE POLICY "History readable by complaint owner, assigned officer, or admin" ON public.complaint_status_history
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_status_history.complaint_id
      AND (
        c.citizen_id = auth.uid() OR
        c.assigned_officer_id = public.get_current_officer_id() OR
        public.is_admin()
      )
    )
  );

-- ------------------------------------------------------------------------------
-- 9. Explicit Base Table Privileges & View Access
-- ------------------------------------------------------------------------------

-- Comprehensive baseline revocation across all base tables
REVOKE ALL ON TABLE public.departments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.officers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.complaints FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.complaint_status_history FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.complaint_yearly_counters FROM PUBLIC, anon, authenticated;

-- Table privileges for departments and officers (Governed by admin RLS policies)
GRANT SELECT ON TABLE public.departments TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.departments TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.officers TO authenticated;

-- Minimal explicit table privileges for authenticated users on core complaints
GRANT SELECT ON TABLE public.complaints TO authenticated;
GRANT INSERT (
  citizen_id,
  title,
  category,
  description,
  location,
  ward,
  latitude,
  longitude,
  image_url
) ON TABLE public.complaints TO authenticated;

GRANT SELECT ON TABLE public.complaint_status_history TO authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;

-- Column-level update grants: citizens can only update non-privileged profile columns
GRANT UPDATE (full_name, phone_number, ward) ON TABLE public.profiles TO authenticated;

-- Column-level update grants on complaints: status, complaint_number, citizen_id are explicitly excluded
GRANT UPDATE (title, description, location, ward, latitude, longitude, priority, department_id, assigned_officer_id, image_url, completion_image_url, sla_deadline) ON TABLE public.complaints TO authenticated;

-- Public sanitized views: accessible to both anonymous visitors and authenticated users
GRANT SELECT ON public.public_officers TO anon, authenticated;
GRANT SELECT ON public.public_complaints TO anon, authenticated;
GRANT SELECT ON public.public_complaint_history TO anon, authenticated;

-- ------------------------------------------------------------------------------
-- 10. Seed Data: Default Municipal Departments
-- ------------------------------------------------------------------------------
INSERT INTO public.departments (name, code, default_sla_hours, contact_email)
VALUES
  ('Roads & Infrastructure Department', 'roads_infrastructure', 48, 'roads@reportly.urban'),
  ('Solid Waste Management', 'solid_waste', 24, 'waste@reportly.urban'),
  ('Electrical & Lighting Board', 'electrical_lighting', 36, 'lighting@reportly.urban'),
  ('Water Supply & Sewerage Board', 'water_sewerage', 18, 'water@reportly.urban'),
  ('Stormwater & Drainage Division', 'stormwater_drainage', 24, 'drainage@reportly.urban'),
  ('Public Works Department (PWD)', 'pwd_infrastructure', 72, 'pwd@reportly.urban')
ON CONFLICT (code) DO NOTHING;
