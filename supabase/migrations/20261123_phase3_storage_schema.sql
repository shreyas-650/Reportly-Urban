-- -------------------------------------------------------------
-- Reportly Urban - Phase 3.2: Storage Configuration & Policies
-- -------------------------------------------------------------

-- 1. Helper function: Authoritative check if authenticated caller is a citizen
CREATE OR REPLACE FUNCTION public.is_citizen()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'citizen'::public.user_role
  );
$$;

ALTER FUNCTION public.is_citizen() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_citizen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_citizen() TO authenticated;

-- 2. Create complaint-images private bucket if not exists
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'complaint-images',
    'complaint-images',
    false,
    8388608, -- 8MB
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = 8388608,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- 3. Storage RLS Policies on storage.objects

-- Citizen INSERT Policy:
-- Authenticated citizen can ONLY upload into their own folder: <auth.uid>/*
-- Requires authoritative 'citizen' database role via public.is_citizen()
DROP POLICY IF EXISTS "Citizens can upload complaint images to own folder" ON storage.objects;
CREATE POLICY "Citizens can upload complaint images to own folder"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
    bucket_id = 'complaint-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.is_citizen()
);

-- Citizen SELECT Policy:
-- Authenticated citizens can view only images within their own folder: <auth.uid>/*
DROP POLICY IF EXISTS "Citizens can view own uploaded images" ON storage.objects;
CREATE POLICY "Citizens can view own uploaded images"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'complaint-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- Admin SELECT Policy:
-- Municipal Admins can view any complaint image across the platform
DROP POLICY IF EXISTS "Admins can view all complaint images" ON storage.objects;
CREATE POLICY "Admins can view all complaint images"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'complaint-images'
    AND public.is_admin()
);

-- Officer SELECT Policy:
-- Officers can view images ONLY if the corresponding complaint is assigned to their active officer record
DROP POLICY IF EXISTS "Officers can view assigned complaint images" ON storage.objects;
CREATE POLICY "Officers can view assigned complaint images"
ON storage.objects
FOR SELECT
TO authenticated
USING (
    bucket_id = 'complaint-images'
    AND EXISTS (
        SELECT 1
        FROM public.complaints c
        WHERE c.image_url = storage.objects.name
          AND c.assigned_officer_id = public.get_current_officer_id()
    )
);

-- Note on Immutability:
-- No UPDATE or DELETE policies are defined on storage.objects.
-- This ensures civic evidence cannot be modified or purged by any user.
