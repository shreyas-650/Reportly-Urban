-- =============================================================================
-- Migration: 20261212_phase10_citizen_rewards.sql
-- Module: Phase 10 — Citizen Rewards, Badges, Community Challenges & Leaderboards
-- Safety Rules:
--   * Strictly ADDITIVE only. Zero edits to Phase 1–9 tables or functions.
--   * Reuses Phase 8.3/8.4 complaint_resolution_verifications and Phase 9.4/9.5/9.6 flags.
--   * Rewards default OFF (phase10_rewards_settings.is_enabled = FALSE).
--   * first_enabled_at is set ONCE on first enable and never overwritten (Amendment E).
--   * Awards apply ONLY to verifications created at/after first_enabled_at (Amendment K).
--   * Phase 8/9 table triggers NEVER fail or block original actions (Amendments A, I).
--   * All SECURITY DEFINER functions use SET search_path = '', zero RECORD variables,
--     and bare COALESCE / LEAST / GREATEST.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Prerequisite Guards
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT := NULL;
BEGIN
  SELECT string_agg(req.item, ', ')
  INTO v_missing
  FROM (
    SELECT 'table public.complaints' AS item WHERE to_regclass('public.complaints') IS NULL
    UNION ALL
    SELECT 'table public.profiles' WHERE to_regclass('public.profiles') IS NULL
    UNION ALL
    SELECT 'table public.complaint_resolution_verifications' WHERE to_regclass('public.complaint_resolution_verifications') IS NULL
    UNION ALL
    SELECT 'table public.complaint_dispute_cases' WHERE to_regclass('public.complaint_dispute_cases') IS NULL
    UNION ALL
    SELECT 'table public.complaint_duplicate_links' WHERE to_regclass('public.complaint_duplicate_links') IS NULL
    UNION ALL
    SELECT 'table public.complaint_screening_reviews' WHERE to_regclass('public.complaint_screening_reviews') IS NULL
    UNION ALL
    SELECT 'table public.complaint_review_appeal_decisions' WHERE to_regclass('public.complaint_review_appeal_decisions') IS NULL
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
-- 1. Feature Settings Table (Default OFF; first_enabled_at set once)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.phase10_rewards_settings (
  feature_key TEXT PRIMARY KEY,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  first_enabled_at TIMESTAMPTZ NULL,
  updated_by UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

INSERT INTO public.phase10_rewards_settings (feature_key, is_enabled, first_enabled_at)
VALUES ('citizen_rewards', FALSE, NULL)
ON CONFLICT (feature_key) DO NOTHING;

ALTER TABLE public.phase10_rewards_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase10_rewards_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read phase10 rewards settings" ON public.phase10_rewards_settings;
CREATE POLICY "Admins can read phase10 rewards settings"
  ON public.phase10_rewards_settings
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

GRANT SELECT ON TABLE public.phase10_rewards_settings TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Citizen Reward Accounts (Random Anonymous Handle — Never Derived from PII/Ward)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.citizen_reward_accounts (
  citizen_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
  anonymous_handle TEXT NOT NULL UNIQUE CHECK (
    anonymous_handle ~ '^Civic-Member-[A-Z0-9]{6}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.citizen_reward_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.citizen_reward_accounts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Citizens can read own reward account" ON public.citizen_reward_accounts;
CREATE POLICY "Citizens can read own reward account"
  ON public.citizen_reward_accounts
  FOR SELECT
  TO authenticated
  USING (citizen_id = auth.uid() OR (SELECT public.is_admin()));

GRANT SELECT ON TABLE public.citizen_reward_accounts TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Immutable Badge Definitions (Seed Fixed Non-Challenge Milestone Badges Only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reward_badge_definitions (
  badge_code TEXT PRIMARY KEY CHECK (badge_code ~ '^[a-z0-9_]{3,64}$'),
  title TEXT NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(title)) BETWEEN 3 AND 80),
  description TEXT NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(description)) BETWEEN 5 AND 240),
  badge_kind TEXT NOT NULL CHECK (badge_kind IN ('milestone', 'challenge')),
  required_verified_reports INT NULL CHECK (required_verified_reports IS NULL OR required_verified_reports > 0),
  required_points INT NULL CHECK (required_points IS NULL OR required_points > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Amendment D: Only fixed non-challenge milestone badges are seeded.
INSERT INTO public.reward_badge_definitions (
  badge_code, title, description, badge_kind, required_verified_reports, required_points, is_active
) VALUES
  ('first_verified_report', 'First Verified Report', 'Earned after your first resolution verification.', 'milestone', 1, NULL, TRUE),
  ('verified_contributor_5', 'Trusted Civic Reporter', 'Earned after 5 verified complaint resolutions.', 'milestone', 5, NULL, TRUE),
  ('verified_champion_10', 'Neighborhood Guardian', 'Earned after 10 verified complaint resolutions.', 'milestone', 10, NULL, TRUE),
  ('civic_points_250', 'Civic Builder 250', 'Earned after reaching 250 active reward points.', 'milestone', NULL, 250, TRUE)
ON CONFLICT (badge_code) DO NOTHING;

ALTER TABLE public.reward_badge_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_badge_definitions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read badge definitions" ON public.reward_badge_definitions;
CREATE POLICY "Authenticated users can read badge definitions"
  ON public.reward_badge_definitions
  FOR SELECT
  TO authenticated
  USING (TRUE);

GRANT SELECT ON TABLE public.reward_badge_definitions TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Community Challenges Table (Linked 1:1 to Admin-Created Challenge Badge)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.community_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(title)) BETWEEN 3 AND 120),
  description TEXT NOT NULL CHECK (pg_catalog.char_length(pg_catalog.btrim(description)) BETWEEN 10 AND 500),
  target_ward TEXT NULL,
  target_category VARCHAR(50) NULL CHECK (
    target_category IS NULL
    OR target_category IN (
      'potholes',
      'garbage',
      'streetlights',
      'water_leakage',
      'drainage',
      'public_infrastructure'
    )
  ),
  required_verified_reports INT NOT NULL CHECK (required_verified_reports BETWEEN 1 AND 100),
  bonus_points INT NOT NULL CHECK (bonus_points BETWEEN 5 AND 200),
  badge_code TEXT NOT NULL UNIQUE REFERENCES public.reward_badge_definitions(badge_code) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT chk_challenge_window CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_community_challenges_active_window
  ON public.community_challenges (is_active, starts_at, ends_at);

ALTER TABLE public.community_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_challenges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read active challenges" ON public.community_challenges;
CREATE POLICY "Authenticated users can read active challenges"
  ON public.community_challenges
  FOR SELECT
  TO authenticated
  USING (is_active = TRUE OR (SELECT public.is_admin()));

GRANT SELECT ON TABLE public.community_challenges TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Append-Only Citizen Reward Ledger (Audit Trail of Positive & Reversal Deltas)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.citizen_reward_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  complaint_id UUID NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  verification_id UUID NULL REFERENCES public.complaint_resolution_verifications(id) ON DELETE RESTRICT,
  challenge_id UUID NULL REFERENCES public.community_challenges(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'verified_award',
      'duplicate_reversal',
      'screening_reversal',
      'admin_bonus',
      'admin_reversal',
      'challenge_bonus'
    )
  ),
  points_delta INT NOT NULL CHECK (points_delta <> 0),
  submission_ward TEXT NULL,
  reason_note TEXT NULL,
  created_by UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_reward_ledger_citizen_created
  ON public.citizen_reward_ledger (citizen_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_reward_ledger_complaint
  ON public.citizen_reward_ledger (complaint_id, created_at DESC)
  WHERE complaint_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reward_ledger_ward_active
  ON public.citizen_reward_ledger (submission_ward, citizen_id)
  WHERE submission_ward IS NOT NULL;

-- Guarantees a complaint can earn verified_award at most once ever
CREATE UNIQUE INDEX IF NOT EXISTS uidx_reward_ledger_verified_award_per_complaint
  ON public.citizen_reward_ledger (complaint_id)
  WHERE event_type = 'verified_award' AND complaint_id IS NOT NULL;

-- Guarantees a citizen can claim a community challenge bonus at most once
CREATE UNIQUE INDEX IF NOT EXISTS uidx_reward_ledger_challenge_bonus_per_citizen
  ON public.citizen_reward_ledger (citizen_id, challenge_id)
  WHERE event_type = 'challenge_bonus' AND challenge_id IS NOT NULL;

ALTER TABLE public.citizen_reward_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.citizen_reward_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Citizens can read own reward ledger" ON public.citizen_reward_ledger;
CREATE POLICY "Citizens can read own reward ledger"
  ON public.citizen_reward_ledger
  FOR SELECT
  TO authenticated
  USING (citizen_id = auth.uid() OR (SELECT public.is_admin()));

GRANT SELECT ON TABLE public.citizen_reward_ledger TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_immutable_reward_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'citizen_reward_ledger is append-only; updates, deletes, and truncates are forbidden.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_reward_ledger() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_reward_ledger() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_immutable_reward_ledger ON public.citizen_reward_ledger;
CREATE TRIGGER trg_guard_immutable_reward_ledger
  BEFORE UPDATE OR DELETE ON public.citizen_reward_ledger
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_reward_ledger();

DROP TRIGGER IF EXISTS trg_guard_immutable_reward_ledger_truncate ON public.citizen_reward_ledger;
CREATE TRIGGER trg_guard_immutable_reward_ledger_truncate
  BEFORE TRUNCATE ON public.citizen_reward_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_reward_ledger();

-- -----------------------------------------------------------------------------
-- 6. Append-Only Citizen Badge Events
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.citizen_badge_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  badge_code TEXT NOT NULL REFERENCES public.reward_badge_definitions(badge_code) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('granted', 'revoked')),
  complaint_id UUID NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  challenge_id UUID NULL REFERENCES public.community_challenges(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_citizen_badge_events_citizen_badge
  ON public.citizen_badge_events (citizen_id, badge_code, created_at DESC, id DESC);

ALTER TABLE public.citizen_badge_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.citizen_badge_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Citizens can read own badge events" ON public.citizen_badge_events;
CREATE POLICY "Citizens can read own badge events"
  ON public.citizen_badge_events
  FOR SELECT
  TO authenticated
  USING (citizen_id = auth.uid() OR (SELECT public.is_admin()));

GRANT SELECT ON TABLE public.citizen_badge_events TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_immutable_badge_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'citizen_badge_events is append-only; updates, deletes, and truncates are forbidden.'
    USING ERRCODE = '42501';
END;
$$;

ALTER FUNCTION public.guard_immutable_badge_events() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_immutable_badge_events() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_immutable_badge_events ON public.citizen_badge_events;
CREATE TRIGGER trg_guard_immutable_badge_events
  BEFORE UPDATE OR DELETE ON public.citizen_badge_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_immutable_badge_events();

DROP TRIGGER IF EXISTS trg_guard_immutable_badge_events_truncate ON public.citizen_badge_events;
CREATE TRIGGER trg_guard_immutable_badge_events_truncate
  BEFORE TRUNCATE ON public.citizen_badge_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_immutable_badge_events();

-- -----------------------------------------------------------------------------
-- 7. Strictly Admin-Only Reward Evaluations Audit Log (Amendments A, F, G, I, P)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.citizen_reward_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id UUID NULL REFERENCES public.complaints(id) ON DELETE RESTRICT,
  citizen_id UUID NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  verification_id UUID NULL,
  source_table TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'awarded',
      'reversed',
      'pending_flag_hold',
      'blocked_duplicate',
      'blocked_screening',
      'ineligible_pre_enable',
      'ineligible_not_owner',
      'ineligible_disputed',
      'skipped_daily_count_cap',
      'skipped_daily_points_cap',
      'skipped_weekly_count_cap',
      'skipped_weekly_points_cap',
      'reversal_noop',
      'feature_disabled',
      'award_failed',
      'already_awarded'
    )
  ),
  points_delta INT NOT NULL DEFAULT 0,
  detail TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS idx_reward_evaluations_created
  ON public.citizen_reward_evaluations (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_reward_evaluations_outcome_created
  ON public.citizen_reward_evaluations (outcome, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reward_evaluations_complaint
  ON public.citizen_reward_evaluations (complaint_id, created_at DESC)
  WHERE complaint_id IS NOT NULL;

ALTER TABLE public.citizen_reward_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.citizen_reward_evaluations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read reward evaluations" ON public.citizen_reward_evaluations;
CREATE POLICY "Admins can read reward evaluations"
  ON public.citizen_reward_evaluations
  FOR SELECT
  TO authenticated
  USING ((SELECT public.is_admin()));

GRANT SELECT ON TABLE public.citizen_reward_evaluations TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. Internal Helper: Ensure Random Anonymous Handle Exists for Citizen
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_citizen_reward_handle(
  p_citizen_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_handle TEXT := NULL;
  v_candidate TEXT := NULL;
  v_attempt INT := 0;
BEGIN
  IF p_citizen_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT a.anonymous_handle
  INTO v_handle
  FROM public.citizen_reward_accounts a
  WHERE a.citizen_id = p_citizen_id;

  IF v_handle IS NOT NULL THEN
    RETURN v_handle;
  END IF;

  -- Generate strictly random handle unrelated to PII, ward, or citizen_id
  WHILE v_attempt < 10 LOOP
    v_attempt := v_attempt + 1;
    v_candidate := 'Civic-Member-' || pg_catalog.upper(
      pg_catalog.substr(
        pg_catalog.md5(pg_catalog.gen_random_uuid()::text || pg_catalog.clock_timestamp()::text || pg_catalog.random()::text),
        1,
        6
      )
    );

    BEGIN
      INSERT INTO public.citizen_reward_accounts (citizen_id, anonymous_handle)
      VALUES (p_citizen_id, v_candidate)
      ON CONFLICT (citizen_id) DO NOTHING;

      SELECT a.anonymous_handle
      INTO v_handle
      FROM public.citizen_reward_accounts a
      WHERE a.citizen_id = p_citizen_id;

      IF v_handle IS NOT NULL THEN
        RETURN v_handle;
      END IF;
    EXCEPTION
      WHEN unique_violation THEN
        v_handle := NULL;
    END;
  END LOOP;

  RAISE EXCEPTION 'Unable to allocate unique anonymous reward handle for citizen.'
    USING ERRCODE = 'P0001';
END;
$$;

ALTER FUNCTION public.ensure_citizen_reward_handle(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ensure_citizen_reward_handle(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 9. Internal Helper: Sync Milestone Badges & Community Challenge Bonuses
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_citizen_badges_and_challenges(
  p_citizen_id UUID,
  p_complaint_id UUID DEFAULT NULL,
  p_now TIMESTAMPTZ DEFAULT pg_catalog.now()
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := COALESCE(p_now, pg_catalog.now());
  v_total_points INT := 0;
  v_verified_count INT := 0;

  v_badge_code TEXT;
  v_req_reports INT;
  v_req_points INT;
  v_current_event TEXT;
  v_should_hold BOOLEAN;

  v_ch_id UUID;
  v_ch_badge TEXT;
  v_ch_ward TEXT;
  v_ch_cat VARCHAR(50);
  v_ch_req INT;
  v_ch_bonus INT;
  v_ch_start TIMESTAMPTZ;
  v_ch_end TIMESTAMPTZ;
  v_ch_progress INT;
  v_ch_awarded BOOLEAN;
  v_ch_badge_held BOOLEAN;
BEGIN
  IF p_citizen_id IS NULL THEN
    RETURN;
  END IF;

  -- Active net points (never negative for threshold comparisons)
  SELECT GREATEST(0, COALESCE(pg_catalog.sum(l.points_delta), 0)::int)
  INTO v_total_points
  FROM public.citizen_reward_ledger l
  WHERE l.citizen_id = p_citizen_id;

  -- Distinct complaints whose verified_award currently stands (positive net complaint reward)
  SELECT COALESCE(pg_catalog.count(*)::int, 0)
  INTO v_verified_count
  FROM (
    SELECT l.complaint_id
    FROM public.citizen_reward_ledger l
    WHERE l.citizen_id = p_citizen_id
      AND l.complaint_id IS NOT NULL
      AND l.event_type IN ('verified_award', 'duplicate_reversal', 'screening_reversal')
    GROUP BY l.complaint_id
    HAVING COALESCE(pg_catalog.sum(l.points_delta), 0) > 0
  ) active_verified;

  -- Milestone badges: evaluate cleanly in order (zero RECORD variables)
  FOR v_badge_code, v_req_reports, v_req_points IN
    SELECT d.badge_code, d.required_verified_reports, d.required_points
    FROM public.reward_badge_definitions d
    WHERE d.badge_kind = 'milestone'
      AND d.is_active = TRUE
    ORDER BY d.created_at ASC, d.badge_code ASC
  LOOP
    v_should_hold := TRUE;
    IF v_req_reports IS NOT NULL AND v_verified_count < v_req_reports THEN
      v_should_hold := FALSE;
    END IF;
    IF v_req_points IS NOT NULL AND v_total_points < v_req_points THEN
      v_should_hold := FALSE;
    END IF;

    v_current_event := NULL;
    SELECT e.event_type
    INTO v_current_event
    FROM public.citizen_badge_events e
    WHERE e.citizen_id = p_citizen_id
      AND e.badge_code = v_badge_code
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 1;

    IF v_should_hold AND COALESCE(v_current_event, 'revoked') <> 'granted' THEN
      INSERT INTO public.citizen_badge_events (
        citizen_id, badge_code, event_type, complaint_id, created_at
      ) VALUES (
        p_citizen_id, v_badge_code, 'granted', p_complaint_id, v_now
      );
    ELSIF NOT v_should_hold AND v_current_event = 'granted' THEN
      INSERT INTO public.citizen_badge_events (
        citizen_id, badge_code, event_type, complaint_id, created_at
      ) VALUES (
        p_citizen_id, v_badge_code, 'revoked', p_complaint_id, v_now
      );
    END IF;
  END LOOP;

  -- Active community challenges
  FOR v_ch_id, v_ch_badge, v_ch_ward, v_ch_cat, v_ch_req, v_ch_bonus, v_ch_start, v_ch_end IN
    SELECT
      ch.id, ch.badge_code, ch.target_ward, ch.target_category,
      ch.required_verified_reports, ch.bonus_points, ch.starts_at, ch.ends_at
    FROM public.community_challenges ch
    WHERE ch.is_active = TRUE
      AND ch.starts_at <= v_now
      AND ch.ends_at >= v_now
    ORDER BY ch.starts_at ASC, ch.id ASC
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM public.citizen_reward_ledger l
      WHERE l.citizen_id = p_citizen_id
        AND l.challenge_id = v_ch_id
        AND l.event_type = 'challenge_bonus'
    ) INTO v_ch_awarded;

    IF NOT v_ch_awarded THEN
      SELECT COALESCE(pg_catalog.count(*)::int, 0)
      INTO v_ch_progress
      FROM (
        SELECT l.complaint_id
        FROM public.citizen_reward_ledger l
        JOIN public.complaints c ON c.id = l.complaint_id
        WHERE l.citizen_id = p_citizen_id
          AND l.complaint_id IS NOT NULL
          AND l.event_type IN ('verified_award', 'duplicate_reversal', 'screening_reversal')
          AND c.created_at >= v_ch_start
          AND c.created_at <= v_ch_end
          AND (
            v_ch_ward IS NULL
            OR pg_catalog.lower(pg_catalog.btrim(COALESCE(l.submission_ward, c.ward))) = pg_catalog.lower(pg_catalog.btrim(v_ch_ward))
          )
          AND (v_ch_cat IS NULL OR c.category = v_ch_cat)
        GROUP BY l.complaint_id
        HAVING COALESCE(pg_catalog.sum(l.points_delta), 0) > 0
      ) ch_verified;

      IF v_ch_progress >= v_ch_req THEN
        INSERT INTO public.citizen_reward_ledger (
          citizen_id, complaint_id, challenge_id, event_type,
          points_delta, submission_ward, reason_note, created_at
        ) VALUES (
          p_citizen_id,
          NULL,
          v_ch_id,
          'challenge_bonus',
          v_ch_bonus,
          NULLIF(pg_catalog.btrim(COALESCE(v_ch_ward, '')), ''),
          'Community challenge milestone achieved',
          v_now
        )
        ON CONFLICT DO NOTHING;

        SELECT EXISTS (
          SELECT 1
          FROM public.citizen_badge_events e
          WHERE e.citizen_id = p_citizen_id
            AND e.badge_code = v_ch_badge
            AND e.event_type = 'granted'
        ) INTO v_ch_badge_held;

        IF NOT v_ch_badge_held THEN
          INSERT INTO public.citizen_badge_events (
            citizen_id, badge_code, event_type, challenge_id, created_at
          ) VALUES (
            p_citizen_id, v_ch_badge, 'granted', v_ch_id, v_now
          );
        END IF;
      END IF;
    END IF;
  END LOOP;
END;
$$;

ALTER FUNCTION public.sync_citizen_badges_and_challenges(UUID, UUID, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_citizen_badges_and_challenges(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 10. Core Lifecycle Function (Idempotent, Cap-Enforced, Flag-Aware)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_complaint_reward_lifecycle(
  p_complaint_id UUID,
  p_source_table TEXT DEFAULT 'manual',
  p_verification_id UUID DEFAULT NULL,
  p_verification_created_at TIMESTAMPTZ DEFAULT NULL,
  p_points_per_verified INT DEFAULT 50,
  p_daily_max_points INT DEFAULT 150,
  p_daily_max_awards INT DEFAULT 3,
  p_weekly_max_points INT DEFAULT 500,
  p_weekly_max_awards INT DEFAULT 10,
  p_timezone TEXT DEFAULT 'Asia/Kolkata'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_source TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_source_table), ''), 'manual');
  v_pts INT := GREATEST(1, COALESCE(p_points_per_verified, 50));
  v_daily_pts_cap INT := GREATEST(1, COALESCE(p_daily_max_points, 150));
  v_daily_cnt_cap INT := GREATEST(1, COALESCE(p_daily_max_awards, 3));
  v_weekly_pts_cap INT := GREATEST(1, COALESCE(p_weekly_max_points, 500));
  v_weekly_cnt_cap INT := GREATEST(1, COALESCE(p_weekly_max_awards, 10));
  v_tz TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_timezone), ''), 'Asia/Kolkata');

  v_enabled BOOLEAN := FALSE;
  v_first_enabled_at TIMESTAMPTZ := NULL;

  v_comp_found BOOLEAN := FALSE;
  v_citizen_id UUID := NULL;
  v_ward TEXT := NULL;
  v_status public.complaint_status := NULL;

  v_verif_id UUID := NULL;
  v_verif_citizen_id UUID := NULL;
  v_verif_created_at TIMESTAMPTZ := NULL;
  v_latest_decision TEXT := NULL;
  v_is_disputed BOOLEAN := FALSE;

  v_dup_confirmed BOOLEAN := FALSE;
  v_dup_suspected BOOLEAN := FALSE;

  v_sr_status TEXT := NULL;
  v_sr_admin_dec TEXT := NULL;
  v_appeal_outcome TEXT := NULL;
  v_scr_blocked BOOLEAN := FALSE;
  v_scr_held BOOLEAN := FALSE;

  v_complaint_net_points INT := 0;
  v_has_verified_award BOOLEAN := FALSE;

  v_day_start TIMESTAMPTZ := NULL;
  v_week_start TIMESTAMPTZ := NULL;
  v_daily_award_count INT := 0;
  v_daily_points_used INT := 0;
  v_weekly_award_count INT := 0;
  v_weekly_points_used INT := 0;

  v_handle TEXT := NULL;
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'noop_null_complaint');
  END IF;

  -- Check feature switch + first_enabled_at (Amendments E, K)
  SELECT s.is_enabled, s.first_enabled_at
  INTO v_enabled, v_first_enabled_at
  FROM public.phase10_rewards_settings s
  WHERE s.feature_key = 'citizen_rewards';

  IF COALESCE(v_enabled, FALSE) = FALSE OR v_first_enabled_at IS NULL THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, p_verification_id, v_source, 'feature_disabled', 0,
      'Rewards feature is disabled.'
    );
    RETURN jsonb_build_object('outcome', 'feature_disabled');
  END IF;

  -- Lock complaint row (share) to read owner, ward snapshot, and current status
  SELECT c.citizen_id, pg_catalog.btrim(COALESCE(c.ward, '')), c.status
  INTO v_citizen_id, v_ward, v_status
  FROM public.complaints c
  WHERE c.id = p_complaint_id
  FOR SHARE;
  v_comp_found := FOUND;

  IF NOT v_comp_found OR v_citizen_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'complaint_not_found');
  END IF;

  -- Serialize all reward ledger mutations per citizen (cap & double-award safety)
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('phase10_rewards_citizen:' || v_citizen_id::text)
  );

  -- Determine net reward already recorded for this complaint
  SELECT
    COALESCE(pg_catalog.sum(l.points_delta), 0)::int,
    EXISTS (
      SELECT 1
      FROM public.citizen_reward_ledger lx
      WHERE lx.complaint_id = p_complaint_id
        AND lx.event_type = 'verified_award'
    )
  INTO v_complaint_net_points, v_has_verified_award
  FROM public.citizen_reward_ledger l
  WHERE l.complaint_id = p_complaint_id
    AND l.citizen_id = v_citizen_id
    AND l.event_type IN ('verified_award', 'duplicate_reversal', 'screening_reversal', 'admin_reversal');

  -- Read Phase 9.4 duplicate status (both directions)
  SELECT
    EXISTS (
      SELECT 1 FROM public.complaint_duplicate_links dl
      WHERE (dl.complaint_id = p_complaint_id OR dl.candidate_complaint_id = p_complaint_id)
        AND dl.status = 'confirmed_duplicate'
    ),
    EXISTS (
      SELECT 1 FROM public.complaint_duplicate_links dl
      WHERE (dl.complaint_id = p_complaint_id OR dl.candidate_complaint_id = p_complaint_id)
        AND dl.status = 'suspected'
    )
  INTO v_dup_confirmed, v_dup_suspected;

  -- Read Phase 9.5 screening + Phase 9.6 latest appeal outcome
  SELECT sr.review_status, sr.admin_decision
  INTO v_sr_status, v_sr_admin_dec
  FROM public.complaint_screening_reviews sr
  WHERE sr.complaint_id = p_complaint_id
  ORDER BY sr.updated_at DESC, sr.id DESC
  LIMIT 1;

  SELECT ad.outcome
  INTO v_appeal_outcome
  FROM public.complaint_review_appeal_decisions ad
  WHERE ad.complaint_id = p_complaint_id
  ORDER BY ad.decided_at DESC, ad.id DESC
  LIMIT 1;

  v_scr_blocked := (
    v_status = 'rejected'::public.complaint_status
    OR v_sr_status = 'confirmed_suspicious'
    OR v_sr_admin_dec = 'confirmed_suspicious'
    OR v_appeal_outcome = 'upheld'
  );

  IF v_appeal_outcome = 'released' THEN
    -- Appeal released overrides screening hold unless complaint itself was rejected or confirmed suspicious later
    IF v_status <> 'rejected'::public.complaint_status
       AND COALESCE(v_sr_admin_dec, 'none') <> 'confirmed_suspicious' THEN
      v_scr_blocked := FALSE;
    END IF;
    v_scr_held := FALSE;
  ELSE
    v_scr_held := (
      NOT v_scr_blocked
      AND v_sr_status IN ('needs_review', 'priority_review', 'reverted')
      AND COALESCE(v_sr_admin_dec, 'none') NOT IN ('false_alarm', 'needs_info_resolved')
    );
  END IF;

  -- Check confirmed blocks first -> reverse if net > 0, else log no-op / block (Amendment G)
  IF v_dup_confirmed THEN
    IF v_complaint_net_points > 0 THEN
      INSERT INTO public.citizen_reward_ledger (
        citizen_id, complaint_id, event_type, points_delta, submission_ward, reason_note, created_at
      ) VALUES (
        v_citizen_id, p_complaint_id, 'duplicate_reversal', -v_complaint_net_points,
        NULLIF(v_ward, ''), 'Eligibility adjustment', v_now
      );

      INSERT INTO public.citizen_reward_evaluations (
        complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
      ) VALUES (
        p_complaint_id, v_citizen_id, p_verification_id, v_source, 'reversed', -v_complaint_net_points,
        'Reversed after Phase 9.4 confirmed_duplicate.'
      );

      PERFORM public.sync_citizen_badges_and_challenges(v_citizen_id, p_complaint_id, v_now);
      RETURN jsonb_build_object('outcome', 'reversed', 'points_delta', -v_complaint_net_points);
    ELSE
      INSERT INTO public.citizen_reward_evaluations (
        complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
      ) VALUES (
        p_complaint_id, v_citizen_id, p_verification_id, v_source,
        CASE
          WHEN v_source IN ('complaint_duplicate_links', 'complaint_screening_reviews', 'complaint_review_appeal_decisions')
            THEN 'reversal_noop'
          ELSE 'blocked_duplicate'
        END,
        0,
        'No active award to reverse; blocked by Phase 9.4 confirmed_duplicate.'
      );
      RETURN jsonb_build_object('outcome', 'blocked_duplicate');
    END IF;
  END IF;

  IF v_scr_blocked THEN
    IF v_complaint_net_points > 0 THEN
      INSERT INTO public.citizen_reward_ledger (
        citizen_id, complaint_id, event_type, points_delta, submission_ward, reason_note, created_at
      ) VALUES (
        v_citizen_id, p_complaint_id, 'screening_reversal', -v_complaint_net_points,
        NULLIF(v_ward, ''), 'Eligibility adjustment', v_now
      );

      INSERT INTO public.citizen_reward_evaluations (
        complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
      ) VALUES (
        p_complaint_id, v_citizen_id, p_verification_id, v_source, 'reversed', -v_complaint_net_points,
        'Reversed after Phase 9.5/9.6 confirmed suspicious, upheld appeal, or rejected complaint.'
      );

      PERFORM public.sync_citizen_badges_and_challenges(v_citizen_id, p_complaint_id, v_now);
      RETURN jsonb_build_object('outcome', 'reversed', 'points_delta', -v_complaint_net_points);
    ELSE
      INSERT INTO public.citizen_reward_evaluations (
        complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
      ) VALUES (
        p_complaint_id, v_citizen_id, p_verification_id, v_source,
        CASE
          WHEN v_source IN ('complaint_duplicate_links', 'complaint_screening_reviews', 'complaint_review_appeal_decisions')
            THEN 'reversal_noop'
          ELSE 'blocked_screening'
        END,
        0,
        'No active award to reverse; blocked by Phase 9.5/9.6 screening decision.'
      );
      RETURN jsonb_build_object('outcome', 'blocked_screening');
    END IF;
  END IF;

  -- Hold newly pending awards if Phase 9.4 suspected or Phase 9.5 held
  IF v_dup_suspected OR v_scr_held THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, p_verification_id, v_source, 'pending_flag_hold', 0,
      CASE
        WHEN v_dup_suspected AND v_scr_held THEN 'Held pending Phase 9.4 duplicate and Phase 9.5 screening reviews.'
        WHEN v_dup_suspected THEN 'Held pending Phase 9.4 suspected duplicate review.'
        ELSE 'Held pending Phase 9.5 screening review.'
      END
    );
    RETURN jsonb_build_object('outcome', 'pending_flag_hold');
  END IF;

  -- Already awarded earlier and not blocked -> idempotent noop
  IF v_has_verified_award THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, p_verification_id, v_source, 'already_awarded', 0,
      'Complaint verified_award already granted previously.'
    );
    RETURN jsonb_build_object('outcome', 'already_awarded');
  END IF;

  -- Check active dispute state (Amendment C)
  SELECT v.decision
  INTO v_latest_decision
  FROM public.complaint_resolution_verifications v
  WHERE v.complaint_id = p_complaint_id
  ORDER BY v.created_at DESC, v.id DESC
  LIMIT 1;

  v_is_disputed := (
    v_status <> 'resolved'::public.complaint_status
    OR v_latest_decision = 'disputed'
    OR EXISTS (
      SELECT 1
      FROM public.complaint_dispute_cases dc
      WHERE dc.complaint_id = p_complaint_id
        AND dc.dispute_state IN ('open_dispute', 'reopened', 'escalated_to_admin')
    )
  );

  IF v_is_disputed THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, p_verification_id, v_source, 'ineligible_disputed', 0,
      'Complaint is currently disputed or reopened.'
    );
    RETURN jsonb_build_object('outcome', 'ineligible_disputed');
  END IF;

  -- Locate latest verified verification row (must belong to complaint owner — Amendment C)
  SELECT v.id, v.citizen_id, v.created_at
  INTO v_verif_id, v_verif_citizen_id, v_verif_created_at
  FROM public.complaint_resolution_verifications v
  WHERE v.complaint_id = p_complaint_id
    AND v.decision = 'verified'
  ORDER BY v.created_at DESC, v.id DESC
  LIMIT 1;

  IF v_verif_id IS NULL THEN
    -- No citizen 'verified' row exists yet (e.g., screening cleared before verification)
    RETURN jsonb_build_object('outcome', 'no_verified_event');
  END IF;

  IF v_verif_citizen_id IS DISTINCT FROM v_citizen_id THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, v_verif_id, v_source, 'ineligible_not_owner', 0,
      'Verifier is not the complaint owner.'
    );
    RETURN jsonb_build_object('outcome', 'ineligible_not_owner');
  END IF;

  -- Amendment K: Check verification's created_at timestamp against first_enabled_at (NEVER processing time)
  v_verif_created_at := COALESCE(p_verification_created_at, v_verif_created_at);
  IF v_verif_created_at < v_first_enabled_at THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, v_verif_id, v_source, 'ineligible_pre_enable', 0,
      'Verification occurred before rewards feature was first enabled.'
    );
    RETURN jsonb_build_object('outcome', 'ineligible_pre_enable');
  END IF;

  -- Amendments F & L: Daily & weekly caps in REWARDS_TIMEZONE (positive verified_award entries only; reversals never restore caps)
  v_day_start := ((v_now AT TIME ZONE v_tz)::date)::timestamp AT TIME ZONE v_tz;
  v_week_start := (pg_catalog.date_trunc('week', v_now AT TIME ZONE v_tz))::timestamp AT TIME ZONE v_tz;

  SELECT
    COALESCE(pg_catalog.count(*)::int, 0),
    COALESCE(pg_catalog.sum(l.points_delta), 0)::int
  INTO v_daily_award_count, v_daily_points_used
  FROM public.citizen_reward_ledger l
  WHERE l.citizen_id = v_citizen_id
    AND l.event_type = 'verified_award'
    AND l.points_delta > 0
    AND l.created_at >= v_day_start;

  SELECT
    COALESCE(pg_catalog.count(*)::int, 0),
    COALESCE(pg_catalog.sum(l.points_delta), 0)::int
  INTO v_weekly_award_count, v_weekly_points_used
  FROM public.citizen_reward_ledger l
  WHERE l.citizen_id = v_citizen_id
    AND l.event_type = 'verified_award'
    AND l.points_delta > 0
    AND l.created_at >= v_week_start;

  IF v_daily_award_count >= v_daily_cnt_cap THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, v_verif_id, v_source, 'skipped_daily_count_cap', 0,
      'Daily award count cap reached.'
    );
    RETURN jsonb_build_object('outcome', 'skipped_daily_count_cap');
  END IF;

  IF (v_daily_points_used + v_pts) > v_daily_pts_cap THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, v_verif_id, v_source, 'skipped_daily_points_cap', 0,
      'Daily points cap reached.'
    );
    RETURN jsonb_build_object('outcome', 'skipped_daily_points_cap');
  END IF;

  IF v_weekly_award_count >= v_weekly_cnt_cap THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, v_verif_id, v_source, 'skipped_weekly_count_cap', 0,
      'Weekly award count cap reached.'
    );
    RETURN jsonb_build_object('outcome', 'skipped_weekly_count_cap');
  END IF;

  IF (v_weekly_points_used + v_pts) > v_weekly_pts_cap THEN
    INSERT INTO public.citizen_reward_evaluations (
      complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
    ) VALUES (
      p_complaint_id, v_citizen_id, v_verif_id, v_source, 'skipped_weekly_points_cap', 0,
      'Weekly points cap reached.'
    );
    RETURN jsonb_build_object('outcome', 'skipped_weekly_points_cap');
  END IF;

  -- Allocate anonymous handle & record verified_award with snapshotted submission_ward
  v_handle := public.ensure_citizen_reward_handle(v_citizen_id);

  INSERT INTO public.citizen_reward_ledger (
    citizen_id, complaint_id, verification_id, event_type,
    points_delta, submission_ward, reason_note, created_at
  ) VALUES (
    v_citizen_id, p_complaint_id, v_verif_id, 'verified_award',
    v_pts, NULLIF(v_ward, ''), 'Verified complaint resolution reward', v_now
  );

  INSERT INTO public.citizen_reward_evaluations (
    complaint_id, citizen_id, verification_id, source_table, outcome, points_delta, detail
  ) VALUES (
    p_complaint_id, v_citizen_id, v_verif_id, v_source, 'awarded', v_pts,
    'Awarded points for verified complaint resolution.'
  );

  PERFORM public.sync_citizen_badges_and_challenges(v_citizen_id, p_complaint_id, v_now);

  RETURN jsonb_build_object(
    'outcome', 'awarded',
    'points_delta', v_pts,
    'anonymous_handle', v_handle
  );
END;
$$;

ALTER FUNCTION public.process_complaint_reward_lifecycle(
  UUID, TEXT, UUID, TIMESTAMPTZ, INT, INT, INT, INT, INT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.process_complaint_reward_lifecycle(
  UUID, TEXT, UUID, TIMESTAMPTZ, INT, INT, INT, INT, INT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 11. Exception-Isolated Trigger Wrapper & Phase 8/9 Additive Triggers (Amendments A, B, I)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.safe_run_reward_trigger(
  p_complaint_id UUID,
  p_source_table TEXT,
  p_verification_id UUID DEFAULT NULL,
  p_verification_created_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_complaint_id IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    PERFORM public.process_complaint_reward_lifecycle(
      p_complaint_id,
      p_source_table,
      p_verification_id,
      p_verification_created_at
    );
  EXCEPTION
    WHEN OTHERS THEN
      -- Amendment I: nested handler so even evaluation logging failure never blocks original action
      BEGIN
        INSERT INTO public.citizen_reward_evaluations (
          complaint_id, verification_id, source_table, outcome, points_delta, detail
        ) VALUES (
          p_complaint_id,
          p_verification_id,
          COALESCE(NULLIF(pg_catalog.btrim(p_source_table), ''), 'trigger'),
          'award_failed',
          0,
          pg_catalog.left(SQLSTATE || ': ' || SQLERRM, 500)
        );
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
  END;
END;
$$;

ALTER FUNCTION public.safe_run_reward_trigger(UUID, TEXT, UUID, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.safe_run_reward_trigger(UUID, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;

-- Trigger 1: AFTER INSERT on complaint_resolution_verifications
CREATE OR REPLACE FUNCTION public.handle_phase10_verification_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.safe_run_reward_trigger(
    NEW.complaint_id,
    'complaint_resolution_verifications',
    NEW.id,
    NEW.created_at
  );
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_phase10_verification_trigger() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_phase10_verification_trigger() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_phase10_rewards_on_verification ON public.complaint_resolution_verifications;
CREATE TRIGGER trg_phase10_rewards_on_verification
  AFTER INSERT ON public.complaint_resolution_verifications
  FOR EACH ROW EXECUTE FUNCTION public.handle_phase10_verification_trigger();

-- Trigger 2: AFTER INSERT OR UPDATE OF status on complaint_duplicate_links
CREATE OR REPLACE FUNCTION public.handle_phase10_duplicate_link_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.safe_run_reward_trigger(NEW.complaint_id, 'complaint_duplicate_links', NULL, NULL);
  IF NEW.candidate_complaint_id IS DISTINCT FROM NEW.complaint_id THEN
    PERFORM public.safe_run_reward_trigger(NEW.candidate_complaint_id, 'complaint_duplicate_links', NULL, NULL);
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_phase10_duplicate_link_trigger() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_phase10_duplicate_link_trigger() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_phase10_rewards_on_duplicate_link ON public.complaint_duplicate_links;
CREATE TRIGGER trg_phase10_rewards_on_duplicate_link
  AFTER INSERT OR UPDATE OF status ON public.complaint_duplicate_links
  FOR EACH ROW EXECUTE FUNCTION public.handle_phase10_duplicate_link_trigger();

-- Trigger 3: AFTER INSERT OR UPDATE OF review_status, admin_decision on complaint_screening_reviews
CREATE OR REPLACE FUNCTION public.handle_phase10_screening_review_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.safe_run_reward_trigger(NEW.complaint_id, 'complaint_screening_reviews', NULL, NULL);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_phase10_screening_review_trigger() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_phase10_screening_review_trigger() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_phase10_rewards_on_screening_review ON public.complaint_screening_reviews;
CREATE TRIGGER trg_phase10_rewards_on_screening_review
  AFTER INSERT OR UPDATE OF review_status, admin_decision ON public.complaint_screening_reviews
  FOR EACH ROW EXECUTE FUNCTION public.handle_phase10_screening_review_trigger();

-- Trigger 4: AFTER INSERT on complaint_review_appeal_decisions
CREATE OR REPLACE FUNCTION public.handle_phase10_appeal_decision_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.safe_run_reward_trigger(NEW.complaint_id, 'complaint_review_appeal_decisions', NULL, NULL);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_phase10_appeal_decision_trigger() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_phase10_appeal_decision_trigger() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_phase10_rewards_on_appeal_decision ON public.complaint_review_appeal_decisions;
CREATE TRIGGER trg_phase10_rewards_on_appeal_decision
  AFTER INSERT ON public.complaint_review_appeal_decisions
  FOR EACH ROW EXECUTE FUNCTION public.handle_phase10_appeal_decision_trigger();

-- -----------------------------------------------------------------------------
-- 12. Citizen Summary & Leaderboard RPCs (Privacy + Neutrality + Suppression)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_citizen_rewards_summary(
  p_daily_max_points INT DEFAULT 150,
  p_daily_max_awards INT DEFAULT 3,
  p_weekly_max_points INT DEFAULT 500,
  p_weekly_max_awards INT DEFAULT 10,
  p_timezone TEXT DEFAULT 'Asia/Kolkata'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_tz TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_timezone), ''), 'Asia/Kolkata');
  v_daily_pts_cap INT := GREATEST(1, COALESCE(p_daily_max_points, 150));
  v_daily_cnt_cap INT := GREATEST(1, COALESCE(p_daily_max_awards, 3));
  v_weekly_pts_cap INT := GREATEST(1, COALESCE(p_weekly_max_points, 500));
  v_weekly_cnt_cap INT := GREATEST(1, COALESCE(p_weekly_max_awards, 10));

  v_enabled BOOLEAN := FALSE;
  v_first_enabled_at TIMESTAMPTZ := NULL;
  v_handle TEXT := NULL;

  v_total_points INT := 0;
  v_verified_count INT := 0;
  v_day_start TIMESTAMPTZ := NULL;
  v_week_start TIMESTAMPTZ := NULL;
  v_daily_pts_used INT := 0;
  v_daily_cnt_used INT := 0;
  v_weekly_pts_used INT := 0;
  v_weekly_cnt_used INT := 0;

  v_badges JSONB := '[]'::jsonb;
  v_ledger JSONB := '[]'::jsonb;
  v_challenges JSONB := '[]'::jsonb;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: Authentication required.' USING ERRCODE = '42501';
  END IF;

  SELECT s.is_enabled, s.first_enabled_at
  INTO v_enabled, v_first_enabled_at
  FROM public.phase10_rewards_settings s
  WHERE s.feature_key = 'citizen_rewards';

  IF COALESCE(v_enabled, FALSE) = FALSE THEN
    RETURN jsonb_build_object(
      'feature_enabled', FALSE,
      'anonymous_handle', NULL,
      'total_points', 0,
      'verified_reports_count', 0,
      'daily_points_used', 0,
      'daily_points_limit', v_daily_pts_cap,
      'daily_awards_used', 0,
      'daily_awards_limit', v_daily_cnt_cap,
      'weekly_points_used', 0,
      'weekly_points_limit', v_weekly_pts_cap,
      'weekly_awards_used', 0,
      'weekly_awards_limit', v_weekly_cnt_cap,
      'badges', '[]'::jsonb,
      'recent_ledger', '[]'::jsonb,
      'active_challenges', '[]'::jsonb
    );
  END IF;

  v_handle := public.ensure_citizen_reward_handle(v_caller_id);

  SELECT GREATEST(0, COALESCE(pg_catalog.sum(l.points_delta), 0)::int)
  INTO v_total_points
  FROM public.citizen_reward_ledger l
  WHERE l.citizen_id = v_caller_id;

  SELECT COALESCE(pg_catalog.count(*)::int, 0)
  INTO v_verified_count
  FROM (
    SELECT l.complaint_id
    FROM public.citizen_reward_ledger l
    WHERE l.citizen_id = v_caller_id
      AND l.complaint_id IS NOT NULL
      AND l.event_type IN ('verified_award', 'duplicate_reversal', 'screening_reversal')
    GROUP BY l.complaint_id
    HAVING COALESCE(pg_catalog.sum(l.points_delta), 0) > 0
  ) active_verified;

  v_day_start := ((v_now AT TIME ZONE v_tz)::date)::timestamp AT TIME ZONE v_tz;
  v_week_start := (pg_catalog.date_trunc('week', v_now AT TIME ZONE v_tz))::timestamp AT TIME ZONE v_tz;

  SELECT
    COALESCE(pg_catalog.count(*)::int, 0),
    COALESCE(pg_catalog.sum(l.points_delta), 0)::int
  INTO v_daily_cnt_used, v_daily_pts_used
  FROM public.citizen_reward_ledger l
  WHERE l.citizen_id = v_caller_id
    AND l.event_type = 'verified_award'
    AND l.points_delta > 0
    AND l.created_at >= v_day_start;

  SELECT
    COALESCE(pg_catalog.count(*)::int, 0),
    COALESCE(pg_catalog.sum(l.points_delta), 0)::int
  INTO v_weekly_cnt_used, v_weekly_pts_used
  FROM public.citizen_reward_ledger l
  WHERE l.citizen_id = v_caller_id
    AND l.event_type = 'verified_award'
    AND l.points_delta > 0
    AND l.created_at >= v_week_start;

  -- Earned active badges (latest event = 'granted')
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      jsonb_build_object(
        'badge_code', b.badge_code,
        'title', b.title,
        'description', b.description,
        'badge_kind', b.badge_kind,
        'earned_at', b.earned_at
      )
      ORDER BY b.earned_at DESC, b.badge_code ASC
    ),
    '[]'::jsonb
  )
  INTO v_badges
  FROM (
    SELECT DISTINCT ON (e.badge_code)
      e.badge_code,
      d.title,
      d.description,
      d.badge_kind,
      e.event_type,
      e.created_at AS earned_at
    FROM public.citizen_badge_events e
    JOIN public.reward_badge_definitions d ON d.badge_code = e.badge_code
    WHERE e.citizen_id = v_caller_id
    ORDER BY e.badge_code, e.created_at DESC, e.id DESC
  ) b
  WHERE b.event_type = 'granted';

  -- Neutralized recent ledger (Amendment P: zero screening/duplicate/hold reasons exposed)
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'complaint_number', r.complaint_number,
        'points_delta', r.points_delta,
        'summary_label', r.summary_label,
        'created_at', r.created_at
      )
      ORDER BY r.created_at DESC, r.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_ledger
  FROM (
    SELECT
      l.id,
      c.complaint_number,
      l.points_delta,
      CASE
        WHEN l.event_type = 'verified_award' THEN 'Verified complaint reward'
        WHEN l.event_type = 'challenge_bonus' THEN 'Community challenge bonus'
        WHEN l.event_type = 'admin_bonus' THEN 'Administrative bonus'
        ELSE 'Eligibility adjustment'
      END AS summary_label,
      l.created_at
    FROM public.citizen_reward_ledger l
    LEFT JOIN public.complaints c ON c.id = l.complaint_id
    WHERE l.citizen_id = v_caller_id
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 20
  ) r;

  -- Active community challenges with citizen's progress
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      jsonb_build_object(
        'id', ch.id,
        'title', ch.title,
        'description', ch.description,
        'target_ward', ch.target_ward,
        'target_category', ch.target_category,
        'required_verified_reports', ch.required_verified_reports,
        'bonus_points', ch.bonus_points,
        'badge_code', ch.badge_code,
        'starts_at', ch.starts_at,
        'ends_at', ch.ends_at,
        'progress_count', ch.progress_count,
        'completed', ch.completed
      )
      ORDER BY ch.ends_at ASC, ch.id ASC
    ),
    '[]'::jsonb
  )
  INTO v_challenges
  FROM (
    SELECT
      ch.id,
      ch.title,
      ch.description,
      ch.target_ward,
      ch.target_category,
      ch.required_verified_reports,
      ch.bonus_points,
      ch.badge_code,
      ch.starts_at,
      ch.ends_at,
      (
        SELECT COALESCE(pg_catalog.count(*)::int, 0)
        FROM (
          SELECT l.complaint_id
          FROM public.citizen_reward_ledger l
          JOIN public.complaints c ON c.id = l.complaint_id
          WHERE l.citizen_id = v_caller_id
            AND l.complaint_id IS NOT NULL
            AND l.event_type IN ('verified_award', 'duplicate_reversal', 'screening_reversal')
            AND c.created_at >= ch.starts_at
            AND c.created_at <= ch.ends_at
            AND (
              ch.target_ward IS NULL
              OR pg_catalog.lower(pg_catalog.btrim(COALESCE(l.submission_ward, c.ward))) = pg_catalog.lower(pg_catalog.btrim(ch.target_ward))
            )
            AND (ch.target_category IS NULL OR c.category = ch.target_category)
          GROUP BY l.complaint_id
          HAVING COALESCE(pg_catalog.sum(l.points_delta), 0) > 0
        ) q
      ) AS progress_count,
      EXISTS (
        SELECT 1
        FROM public.citizen_reward_ledger lb
        WHERE lb.citizen_id = v_caller_id
          AND lb.challenge_id = ch.id
          AND lb.event_type = 'challenge_bonus'
      ) AS completed
    FROM public.community_challenges ch
    WHERE ch.is_active = TRUE
      AND ch.starts_at <= v_now
      AND ch.ends_at >= v_now
  ) ch;

  RETURN jsonb_build_object(
    'feature_enabled', TRUE,
    'anonymous_handle', v_handle,
    'total_points', v_total_points,
    'verified_reports_count', v_verified_count,
    'daily_points_used', v_daily_pts_used,
    'daily_points_limit', v_daily_pts_cap,
    'daily_awards_used', v_daily_cnt_used,
    'daily_awards_limit', v_daily_cnt_cap,
    'weekly_points_used', v_weekly_pts_used,
    'weekly_points_limit', v_weekly_pts_cap,
    'weekly_awards_used', v_weekly_cnt_used,
    'weekly_awards_limit', v_weekly_cnt_cap,
    'badges', v_badges,
    'recent_ledger', v_ledger,
    'active_challenges', v_challenges
  );
END;
$$;

ALTER FUNCTION public.get_citizen_rewards_summary(INT, INT, INT, INT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_citizen_rewards_summary(INT, INT, INT, INT, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_citizen_rewards_summary(INT, INT, INT, INT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_citizen_rewards_leaderboard(
  p_ward TEXT DEFAULT NULL,
  p_min_group_size INT DEFAULT 20,
  p_limit INT DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_enabled BOOLEAN := FALSE;
  v_clean_ward TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_ward, '')), '');
  -- Decision 3 & Amendment N: enforce hard floor 5 in SQL, default 20, one fixed window all_time
  v_min_group INT := GREATEST(5, COALESCE(p_min_group_size, 20));
  v_limit INT := LEAST(50, GREATEST(5, COALESCE(p_limit, 25)));

  v_eligible_count INT := 0;
  v_entries JSONB := '[]'::jsonb;
  v_available_wards JSONB := '[]'::jsonb;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: Authentication required.' USING ERRCODE = '42501';
  END IF;

  SELECT s.is_enabled
  INTO v_enabled
  FROM public.phase10_rewards_settings s
  WHERE s.feature_key = 'citizen_rewards';

  IF COALESCE(v_enabled, FALSE) = FALSE THEN
    RETURN jsonb_build_object(
      'feature_enabled', FALSE,
      'window', 'all_time',
      'scope', CASE WHEN v_clean_ward IS NULL THEN 'citywide' ELSE 'ward' END,
      'ward', v_clean_ward,
      'min_group_size', v_min_group,
      'enough_data', FALSE,
      'entries', '[]'::jsonb,
      'available_wards', '[]'::jsonb
    );
  END IF;

  -- Available wards list: ONLY wards individually meeting min_group_size (no hidden counts, no Other bucket)
  SELECT COALESCE(
    pg_catalog.jsonb_agg(w.ward_label ORDER BY w.ward_label ASC),
    '[]'::jsonb
  )
  INTO v_available_wards
  FROM (
    SELECT pg_catalog.min(wc.ward_raw) AS ward_label
    FROM (
      SELECT
        pg_catalog.lower(pg_catalog.btrim(l.submission_ward)) AS ward_key,
        pg_catalog.min(pg_catalog.btrim(l.submission_ward)) AS ward_raw,
        l.citizen_id,
        pg_catalog.sum(l.points_delta) AS ward_points
      FROM public.citizen_reward_ledger l
      WHERE NULLIF(pg_catalog.btrim(COALESCE(l.submission_ward, '')), '') IS NOT NULL
      GROUP BY pg_catalog.lower(pg_catalog.btrim(l.submission_ward)), l.citizen_id
      HAVING pg_catalog.sum(l.points_delta) > 0
    ) wc
    GROUP BY wc.ward_key
    HAVING pg_catalog.count(DISTINCT wc.citizen_id) >= v_min_group
  ) w;

  -- Compute eligible citizens for selected scope (citywide vs single ward)
  IF v_clean_ward IS NULL THEN
    SELECT COALESCE(pg_catalog.count(*)::int, 0)
    INTO v_eligible_count
    FROM (
      SELECT l.citizen_id
      FROM public.citizen_reward_ledger l
      JOIN public.citizen_reward_accounts a ON a.citizen_id = l.citizen_id
      GROUP BY l.citizen_id
      HAVING COALESCE(pg_catalog.sum(l.points_delta), 0) > 0
    ) ct;
  ELSE
    SELECT COALESCE(pg_catalog.count(*)::int, 0)
    INTO v_eligible_count
    FROM (
      SELECT l.citizen_id
      FROM public.citizen_reward_ledger l
      JOIN public.citizen_reward_accounts a ON a.citizen_id = l.citizen_id
      WHERE pg_catalog.lower(pg_catalog.btrim(COALESCE(l.submission_ward, ''))) = pg_catalog.lower(v_clean_ward)
      GROUP BY l.citizen_id
      HAVING COALESCE(pg_catalog.sum(l.points_delta), 0) > 0
    ) wt;
  END IF;

  -- Suppress leaderboard if group has fewer than v_min_group citizens (omit counts, residual, totals)
  IF v_eligible_count < v_min_group THEN
    RETURN jsonb_build_object(
      'feature_enabled', TRUE,
      'window', 'all_time',
      'scope', CASE WHEN v_clean_ward IS NULL THEN 'citywide' ELSE 'ward' END,
      'ward', v_clean_ward,
      'min_group_size', v_min_group,
      'enough_data', FALSE,
      'entries', '[]'::jsonb,
      'available_wards', v_available_wards
    );
  END IF;

  IF v_clean_ward IS NULL THEN
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        jsonb_build_object(
          'rank', r.rn,
          'anonymous_handle', r.anonymous_handle,
          'points', r.points,
          'verified_reports_count', r.verified_reports_count,
          'is_self', r.is_self
        )
        ORDER BY r.rn ASC
      ),
      '[]'::jsonb
    )
    INTO v_entries
    FROM (
      SELECT
        pg_catalog.row_number() OVER (
          ORDER BY pg_catalog.sum(l.points_delta) DESC, pg_catalog.min(l.created_at) ASC, a.anonymous_handle ASC
        )::int AS rn,
        a.anonymous_handle,
        pg_catalog.sum(l.points_delta)::int AS points,
        COALESCE(
          (
            SELECT pg_catalog.count(*)::int
            FROM (
              SELECT lx.complaint_id
              FROM public.citizen_reward_ledger lx
              WHERE lx.citizen_id = l.citizen_id
                AND lx.complaint_id IS NOT NULL
                AND lx.event_type IN ('verified_award', 'duplicate_reversal', 'screening_reversal')
              GROUP BY lx.complaint_id
              HAVING COALESCE(pg_catalog.sum(lx.points_delta), 0) > 0
            ) vc
          ),
          0
        ) AS verified_reports_count,
        (l.citizen_id = v_caller_id) AS is_self
      FROM public.citizen_reward_ledger l
      JOIN public.citizen_reward_accounts a ON a.citizen_id = l.citizen_id
      GROUP BY l.citizen_id, a.anonymous_handle
      HAVING COALESCE(pg_catalog.sum(l.points_delta), 0) > 0
      ORDER BY pg_catalog.sum(l.points_delta) DESC, pg_catalog.min(l.created_at) ASC, a.anonymous_handle ASC
      LIMIT v_limit
    ) r;
  ELSE
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        jsonb_build_object(
          'rank', r.rn,
          'anonymous_handle', r.anonymous_handle,
          'points', r.points,
          'verified_reports_count', r.verified_reports_count,
          'is_self', r.is_self
        )
        ORDER BY r.rn ASC
      ),
      '[]'::jsonb
    )
    INTO v_entries
    FROM (
      SELECT
        pg_catalog.row_number() OVER (
          ORDER BY pg_catalog.sum(l.points_delta) DESC, pg_catalog.min(l.created_at) ASC, a.anonymous_handle ASC
        )::int AS rn,
        a.anonymous_handle,
        pg_catalog.sum(l.points_delta)::int AS points,
        COALESCE(
          (
            SELECT pg_catalog.count(*)::int
            FROM (
              SELECT lx.complaint_id
              FROM public.citizen_reward_ledger lx
              WHERE lx.citizen_id = l.citizen_id
                AND lx.complaint_id IS NOT NULL
                AND lx.event_type IN ('verified_award', 'duplicate_reversal', 'screening_reversal')
                AND pg_catalog.lower(pg_catalog.btrim(COALESCE(lx.submission_ward, ''))) = pg_catalog.lower(v_clean_ward)
              GROUP BY lx.complaint_id
              HAVING COALESCE(pg_catalog.sum(lx.points_delta), 0) > 0
            ) vc
          ),
          0
        ) AS verified_reports_count,
        (l.citizen_id = v_caller_id) AS is_self
      FROM public.citizen_reward_ledger l
      JOIN public.citizen_reward_accounts a ON a.citizen_id = l.citizen_id
      WHERE pg_catalog.lower(pg_catalog.btrim(COALESCE(l.submission_ward, ''))) = pg_catalog.lower(v_clean_ward)
      GROUP BY l.citizen_id, a.anonymous_handle
      HAVING COALESCE(pg_catalog.sum(l.points_delta), 0) > 0
      ORDER BY pg_catalog.sum(l.points_delta) DESC, pg_catalog.min(l.created_at) ASC, a.anonymous_handle ASC
      LIMIT v_limit
    ) r;
  END IF;

  RETURN jsonb_build_object(
    'feature_enabled', TRUE,
    'window', 'all_time',
    'scope', CASE WHEN v_clean_ward IS NULL THEN 'citywide' ELSE 'ward' END,
    'ward', v_clean_ward,
    'min_group_size', v_min_group,
    'enough_data', TRUE,
    'entries', v_entries,
    'available_wards', v_available_wards
  );
END;
$$;

ALTER FUNCTION public.get_citizen_rewards_leaderboard(TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_citizen_rewards_leaderboard(TEXT, INT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_citizen_rewards_leaderboard(TEXT, INT, INT) TO authenticated;

-- -----------------------------------------------------------------------------
-- 13. Admin RPCs: Feature Toggle (first_enabled_at once), Challenge Creation (atomic),
--     Manual Adjustment, and Admin Audit Feed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_rewards_feature_enabled(
  p_is_enabled BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_target BOOLEAN := COALESCE(p_is_enabled, FALSE);
  v_enabled BOOLEAN := FALSE;
  v_first_enabled_at TIMESTAMPTZ := NULL;
BEGIN
  IF v_actor_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  -- Amendment E: first_enabled_at is set ONCE on first enable and NEVER overwritten
  INSERT INTO public.phase10_rewards_settings (
    feature_key, is_enabled, first_enabled_at, updated_by, updated_at
  ) VALUES (
    'citizen_rewards',
    v_target,
    CASE WHEN v_target THEN v_now ELSE NULL END,
    v_actor_id,
    v_now
  )
  ON CONFLICT (feature_key) DO UPDATE
  SET is_enabled = EXCLUDED.is_enabled,
      first_enabled_at = CASE
        WHEN public.phase10_rewards_settings.first_enabled_at IS NOT NULL
          THEN public.phase10_rewards_settings.first_enabled_at
        WHEN EXCLUDED.is_enabled = TRUE
          THEN v_now
        ELSE NULL
      END,
      updated_by = v_actor_id,
      updated_at = v_now
  RETURNING is_enabled, first_enabled_at
  INTO v_enabled, v_first_enabled_at;

  RETURN jsonb_build_object(
    'feature_enabled', v_enabled,
    'first_enabled_at', v_first_enabled_at,
    'updated_at', v_now
  );
END;
$$;

ALTER FUNCTION public.admin_set_rewards_feature_enabled(BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_set_rewards_feature_enabled(BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_rewards_feature_enabled(BOOLEAN) TO authenticated;

-- Amendments D & M: Create challenge badge definition + challenge row atomically
CREATE OR REPLACE FUNCTION public.create_admin_community_challenge(
  p_title TEXT,
  p_description TEXT,
  p_badge_code TEXT,
  p_badge_title TEXT,
  p_badge_description TEXT,
  p_required_verified_reports INT,
  p_bonus_points INT,
  p_starts_at TIMESTAMPTZ,
  p_ends_at TIMESTAMPTZ,
  p_target_ward TEXT DEFAULT NULL,
  p_target_category TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_title TEXT := pg_catalog.btrim(COALESCE(p_title, ''));
  v_desc TEXT := pg_catalog.btrim(COALESCE(p_description, ''));
  v_badge_code TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_badge_code, '')));
  v_badge_title TEXT := pg_catalog.btrim(COALESCE(p_badge_title, ''));
  v_badge_desc TEXT := pg_catalog.btrim(COALESCE(p_badge_description, ''));
  v_ward TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_target_ward, '')), '');
  v_cat VARCHAR(50) := NULL;
  v_challenge_id UUID := NULL;
BEGIN
  IF v_actor_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  IF p_starts_at IS NULL OR p_ends_at IS NULL OR p_ends_at <= p_starts_at THEN
    RAISE EXCEPTION 'Invalid Parameter: ends_at must be strictly after starts_at.' USING ERRCODE = '22023';
  END IF;

  IF NULLIF(pg_catalog.btrim(COALESCE(p_target_category, '')), '') IS NOT NULL THEN
    v_cat := pg_catalog.lower(pg_catalog.btrim(p_target_category));
    IF v_cat NOT IN (
      'potholes',
      'garbage',
      'streetlights',
      'water_leakage',
      'drainage',
      'public_infrastructure'
    ) THEN
      RAISE EXCEPTION 'Invalid Parameter: unsupported complaint category "%".', v_cat
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Step 1: Create challenge-scoped badge definition inside the same transaction
  INSERT INTO public.reward_badge_definitions (
    badge_code, title, description, badge_kind,
    required_verified_reports, required_points, is_active, created_at
  ) VALUES (
    v_badge_code, v_badge_title, v_badge_desc, 'challenge',
    p_required_verified_reports, NULL, TRUE, v_now
  );

  -- Step 2: Create challenge row referencing that badge_code atomically
  INSERT INTO public.community_challenges (
    title, description, target_ward, target_category,
    required_verified_reports, bonus_points, badge_code,
    starts_at, ends_at, is_active, created_by, created_at
  ) VALUES (
    v_title, v_desc, v_ward, v_cat,
    p_required_verified_reports, p_bonus_points, v_badge_code,
    p_starts_at, p_ends_at, TRUE, v_actor_id, v_now
  )
  RETURNING id INTO v_challenge_id;

  RETURN jsonb_build_object(
    'id', v_challenge_id,
    'title', v_title,
    'badge_code', v_badge_code,
    'required_verified_reports', p_required_verified_reports,
    'bonus_points', p_bonus_points,
    'target_ward', v_ward,
    'target_category', v_cat,
    'starts_at', p_starts_at,
    'ends_at', p_ends_at,
    'is_active', TRUE
  );
END;
$$;

ALTER FUNCTION public.create_admin_community_challenge(
  TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.create_admin_community_challenge(
  TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_admin_community_challenge(
  TEXT, TEXT, TEXT, TEXT, TEXT, INT, INT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT
) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_adjust_citizen_rewards(
  p_citizen_id UUID,
  p_points_delta INT,
  p_reason TEXT,
  p_complaint_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_now TIMESTAMPTZ := pg_catalog.now();
  v_reason TEXT := pg_catalog.btrim(COALESCE(p_reason, ''));
  v_citizen_exists BOOLEAN := FALSE;
  v_handle TEXT := NULL;
  v_ward TEXT := NULL;
  v_event_type TEXT := NULL;
  v_ledger_id UUID := NULL;
  v_new_total INT := 0;
BEGIN
  IF v_actor_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  IF p_citizen_id IS NULL THEN
    RAISE EXCEPTION 'Invalid Parameter: citizen_id is required.' USING ERRCODE = '22023';
  END IF;

  IF p_points_delta IS NULL OR p_points_delta = 0 OR pg_catalog.abs(p_points_delta) > 500 THEN
    RAISE EXCEPTION 'Invalid Parameter: points_delta must be non-zero and between -500 and 500.' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.char_length(v_reason) < 5 OR pg_catalog.char_length(v_reason) > 300 THEN
    RAISE EXCEPTION 'Invalid Parameter: reason must be between 5 and 300 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_citizen_id)
  INTO v_citizen_exists;

  IF NOT v_citizen_exists THEN
    RAISE EXCEPTION 'Not Found: Citizen profile does not exist.' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('phase10_rewards_citizen:' || p_citizen_id::text)
  );

  IF p_complaint_id IS NOT NULL THEN
    SELECT NULLIF(pg_catalog.btrim(COALESCE(c.ward, '')), '')
    INTO v_ward
    FROM public.complaints c
    WHERE c.id = p_complaint_id;
  END IF;

  v_handle := public.ensure_citizen_reward_handle(p_citizen_id);
  v_event_type := CASE WHEN p_points_delta > 0 THEN 'admin_bonus' ELSE 'admin_reversal' END;

  INSERT INTO public.citizen_reward_ledger (
    citizen_id, complaint_id, event_type, points_delta,
    submission_ward, reason_note, created_by, created_at
  ) VALUES (
    p_citizen_id, p_complaint_id, v_event_type, p_points_delta,
    v_ward, 'Administrative adjustment', v_actor_id, v_now
  )
  RETURNING id INTO v_ledger_id;

  INSERT INTO public.citizen_reward_evaluations (
    complaint_id, citizen_id, source_table, outcome, points_delta, detail
  ) VALUES (
    p_complaint_id,
    p_citizen_id,
    'admin_manual',
    CASE WHEN p_points_delta > 0 THEN 'awarded' ELSE 'reversed' END,
    p_points_delta,
    v_reason
  );

  PERFORM public.sync_citizen_badges_and_challenges(p_citizen_id, p_complaint_id, v_now);

  SELECT GREATEST(0, COALESCE(pg_catalog.sum(l.points_delta), 0)::int)
  INTO v_new_total
  FROM public.citizen_reward_ledger l
  WHERE l.citizen_id = p_citizen_id;

  RETURN jsonb_build_object(
    'ledger_id', v_ledger_id,
    'citizen_id', p_citizen_id,
    'anonymous_handle', v_handle,
    'points_delta', p_points_delta,
    'new_total_points', v_new_total
  );
END;
$$;

ALTER FUNCTION public.admin_adjust_citizen_rewards(UUID, INT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_adjust_citizen_rewards(UUID, INT, TEXT, UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_adjust_citizen_rewards(UUID, INT, TEXT, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_get_citizen_rewards_audit(
  p_outcome TEXT DEFAULT NULL,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id UUID := auth.uid();
  v_outcome TEXT := NULLIF(pg_catalog.lower(pg_catalog.btrim(COALESCE(p_outcome, ''))), '');
  v_limit INT := LEAST(100, GREATEST(1, COALESCE(p_limit, 50)));
  v_offset INT := GREATEST(0, COALESCE(p_offset, 0));

  v_enabled BOOLEAN := FALSE;
  v_first_enabled_at TIMESTAMPTZ := NULL;
  v_updated_at TIMESTAMPTZ := NULL;

  v_total_awarded INT := 0;
  v_total_reversed INT := 0;
  v_holds_count INT := 0;
  v_cap_skips_count INT := 0;
  v_failed_count INT := 0;

  v_evaluations JSONB := '[]'::jsonb;
  v_challenges JSONB := '[]'::jsonb;
BEGIN
  IF v_actor_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Administrator privileges required.' USING ERRCODE = '42501';
  END IF;

  SELECT s.is_enabled, s.first_enabled_at, s.updated_at
  INTO v_enabled, v_first_enabled_at, v_updated_at
  FROM public.phase10_rewards_settings s
  WHERE s.feature_key = 'citizen_rewards';

  SELECT
    COALESCE(pg_catalog.sum(l.points_delta) FILTER (WHERE l.points_delta > 0), 0)::int,
    COALESCE(pg_catalog.abs(pg_catalog.sum(l.points_delta) FILTER (WHERE l.points_delta < 0)), 0)::int
  INTO v_total_awarded, v_total_reversed
  FROM public.citizen_reward_ledger l;

  SELECT
    COALESCE(pg_catalog.count(*) FILTER (WHERE e.outcome = 'pending_flag_hold')::int, 0),
    COALESCE(pg_catalog.count(*) FILTER (WHERE e.outcome LIKE 'skipped_%_cap')::int, 0),
    COALESCE(pg_catalog.count(*) FILTER (WHERE e.outcome = 'award_failed')::int, 0)
  INTO v_holds_count, v_cap_skips_count, v_failed_count
  FROM public.citizen_reward_evaluations e;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'complaint_id', r.complaint_id,
        'complaint_number', r.complaint_number,
        'citizen_id', r.citizen_id,
        'source_table', r.source_table,
        'outcome', r.outcome,
        'points_delta', r.points_delta,
        'detail', r.detail,
        'created_at', r.created_at
      )
      ORDER BY r.created_at DESC, r.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_evaluations
  FROM (
    SELECT
      e.id, e.complaint_id, c.complaint_number, e.citizen_id,
      e.source_table, e.outcome, e.points_delta, e.detail, e.created_at
    FROM public.citizen_reward_evaluations e
    LEFT JOIN public.complaints c ON c.id = e.complaint_id
    WHERE (v_outcome IS NULL OR e.outcome = v_outcome)
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT v_limit OFFSET v_offset
  ) r;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      jsonb_build_object(
        'id', ch.id,
        'title', ch.title,
        'description', ch.description,
        'target_ward', ch.target_ward,
        'target_category', ch.target_category,
        'required_verified_reports', ch.required_verified_reports,
        'bonus_points', ch.bonus_points,
        'badge_code', ch.badge_code,
        'starts_at', ch.starts_at,
        'ends_at', ch.ends_at,
        'is_active', ch.is_active,
        'created_at', ch.created_at
      )
      ORDER BY ch.created_at DESC, ch.id DESC
    ),
    '[]'::jsonb
  )
  INTO v_challenges
  FROM public.community_challenges ch;

  RETURN jsonb_build_object(
    'feature_enabled', COALESCE(v_enabled, FALSE),
    'first_enabled_at', v_first_enabled_at,
    'settings_updated_at', v_updated_at,
    'summary', jsonb_build_object(
      'total_points_awarded', v_total_awarded,
      'total_points_reversed', v_total_reversed,
      'pending_holds_logged', v_holds_count,
      'cap_skips_logged', v_cap_skips_count,
      'trigger_failures_logged', v_failed_count
    ),
    'evaluations', v_evaluations,
    'challenges', v_challenges
  );
END;
$$;

ALTER FUNCTION public.admin_get_citizen_rewards_audit(TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_get_citizen_rewards_audit(TEXT, INT, INT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_citizen_rewards_audit(TEXT, INT, INT) TO authenticated;
