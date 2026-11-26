-- =============================================================================
-- Migration 1 (Run BEFORE 20261202): 20261201_phase8_4_status_enum_extend.sql
-- Module: Phase 8.3/8.4 — Add 'not_confirmed_by_citizen' to public.complaint_status
--
-- Note: PostgreSQL requires ALTER TYPE ... ADD VALUE to be committed before the
-- new enum label can be referenced in functions, views, or queries. Run this file
-- first as a standalone statement before running 20261202.
-- =============================================================================

ALTER TYPE public.complaint_status ADD VALUE IF NOT EXISTS 'not_confirmed_by_citizen';
