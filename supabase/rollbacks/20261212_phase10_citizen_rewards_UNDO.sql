-- =============================================================================
-- UNDO Rollback Script: 20261212_phase10_citizen_rewards_UNDO.sql
-- Safety Rule: Drops ONLY newly introduced Phase 10 triggers, RLS policies,
-- and functions. Preserves historical rewards tables
-- (phase10_rewards_settings, citizen_reward_accounts, reward_badge_definitions,
--  community_challenges, citizen_reward_ledger, citizen_badge_events,
--  citizen_reward_evaluations) so financial/point audit records are never lost.
-- =============================================================================

BEGIN;

-- Disable rewards feature cleanly if settings table exists
UPDATE public.phase10_rewards_settings
SET is_enabled = FALSE,
    updated_at = pg_catalog.now()
WHERE feature_key = 'citizen_rewards';

-- Drop Phase 10 triggers on Phase 8/9 tables and Phase 10 immutability triggers
DROP TRIGGER IF EXISTS trg_phase10_rewards_on_verification ON public.complaint_resolution_verifications;
DROP TRIGGER IF EXISTS trg_phase10_rewards_on_duplicate_link ON public.complaint_duplicate_links;
DROP TRIGGER IF EXISTS trg_phase10_rewards_on_screening_review ON public.complaint_screening_reviews;
DROP TRIGGER IF EXISTS trg_phase10_rewards_on_appeal_decision ON public.complaint_review_appeal_decisions;

DROP TRIGGER IF EXISTS trg_guard_immutable_reward_ledger ON public.citizen_reward_ledger;
DROP TRIGGER IF EXISTS trg_guard_immutable_reward_ledger_truncate ON public.citizen_reward_ledger;
DROP TRIGGER IF EXISTS trg_guard_immutable_badge_events ON public.citizen_badge_events;
DROP TRIGGER IF EXISTS trg_guard_immutable_badge_events_truncate ON public.citizen_badge_events;

-- Drop Phase 10 RLS policies
DROP POLICY IF EXISTS "Admins can read phase10 rewards settings" ON public.phase10_rewards_settings;
DROP POLICY IF EXISTS "Citizens can read own reward account" ON public.citizen_reward_accounts;
DROP POLICY IF EXISTS "Authenticated users can read badge definitions" ON public.reward_badge_definitions;
DROP POLICY IF EXISTS "Authenticated users can read active challenges" ON public.community_challenges;
DROP POLICY IF EXISTS "Citizens can read own reward ledger" ON public.citizen_reward_ledger;
DROP POLICY IF EXISTS "Citizens can read own badge events" ON public.citizen_badge_events;
DROP POLICY IF EXISTS "Admins can read reward evaluations" ON public.citizen_reward_evaluations;

-- Drop Phase 10 functions
DROP FUNCTION IF EXISTS public.admin_get_citizen_rewards_audit(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.admin_adjust_citizen_rewards(UUID, INT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.create_admin_community_challenge(TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.admin_set_rewards_feature_enabled(BOOLEAN);
DROP FUNCTION IF EXISTS public.get_citizen_rewards_leaderboard(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.get_citizen_rewards_summary(INT, INT, INT, INT, TEXT);
DROP FUNCTION IF EXISTS public.handle_phase10_appeal_decision_trigger();
DROP FUNCTION IF EXISTS public.handle_phase10_screening_review_trigger();
DROP FUNCTION IF EXISTS public.handle_phase10_duplicate_link_trigger();
DROP FUNCTION IF EXISTS public.handle_phase10_verification_trigger();
DROP FUNCTION IF EXISTS public.safe_run_reward_trigger(UUID, TEXT, UUID, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.process_complaint_reward_lifecycle(UUID, TEXT, UUID, TIMESTAMPTZ, INT, INT, INT, INT, INT, TEXT);
DROP FUNCTION IF EXISTS public.sync_citizen_badges_and_challenges(UUID, UUID, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.ensure_citizen_reward_handle(UUID);
DROP FUNCTION IF EXISTS public.guard_immutable_badge_events();
DROP FUNCTION IF EXISTS public.guard_immutable_reward_ledger();

COMMIT;

-- =============================================================================
-- MANUAL DATA REMOVAL (Optional — ONLY run intentionally by operator)
-- =============================================================================
-- DROP TABLE IF EXISTS public.citizen_reward_evaluations;
-- DROP TABLE IF EXISTS public.citizen_badge_events;
-- DROP TABLE IF EXISTS public.citizen_reward_ledger;
-- DROP TABLE IF EXISTS public.community_challenges;
-- DROP TABLE IF EXISTS public.reward_badge_definitions;
-- DROP TABLE IF EXISTS public.citizen_reward_accounts;
-- DROP TABLE IF EXISTS public.phase10_rewards_settings;
