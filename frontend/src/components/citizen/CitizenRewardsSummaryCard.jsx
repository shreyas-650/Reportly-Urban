import React from 'react';
import { Link } from 'react-router-dom';
import { Award, Trophy, ArrowRight, ShieldCheck, Target } from 'lucide-react';

export default function CitizenRewardsSummaryCard({ summary }) {
  if (!summary || summary.feature_enabled !== true) {
    return null;
  }

  const badges = Array.isArray(summary.badges) ? summary.badges : [];
  const challenges = Array.isArray(summary.active_challenges) ? summary.active_challenges : [];

  return (
    <section
      aria-label="Citizen Rewards Summary"
      className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center">
            <Trophy className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">Citizen Rewards</h2>
            <p className="text-xs text-slate-500">
              Leaderboard Handle:{' '}
              <span className="font-mono font-semibold text-slate-700">
                {summary.anonymous_handle || 'Assigned on first reward'}
              </span>
            </p>
          </div>
        </div>

        <Link
          to="/rewards"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700"
        >
          View Badges &amp; Leaderboard <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl bg-slate-50 border border-slate-200/80 p-4">
          <p className="text-xs font-medium text-slate-500">Total Active Points</p>
          <p className="text-2xl font-extrabold text-slate-900 mt-1">{summary.total_points} pts</p>
          <p className="text-[11px] text-slate-500 mt-1">
            {summary.verified_reports_count} verified{' '}
            {summary.verified_reports_count === 1 ? 'report' : 'reports'}
          </p>
        </div>

        <div className="rounded-2xl bg-slate-50 border border-slate-200/80 p-4">
          <p className="text-xs font-medium text-slate-500">Daily Cap Usage</p>
          <p className="text-lg font-bold text-slate-900 mt-1">
            {summary.daily_points_used} / {summary.daily_points_limit} pts
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            {summary.daily_awards_used} / {summary.daily_awards_limit} verified awards today
          </p>
        </div>

        <div className="rounded-2xl bg-slate-50 border border-slate-200/80 p-4">
          <p className="text-xs font-medium text-slate-500">Weekly Cap Usage</p>
          <p className="text-lg font-bold text-slate-900 mt-1">
            {summary.weekly_points_used} / {summary.weekly_points_limit} pts
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            {summary.weekly_awards_used} / {summary.weekly_awards_limit} verified awards this week
          </p>
        </div>
      </div>

      {badges.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Earned Badges ({badges.length})
          </p>
          <div className="flex flex-wrap gap-2">
            {badges.map((badge) => (
              <span
                key={badge.badge_code}
                className="inline-flex items-center gap-1.5 text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 px-3 py-1 rounded-full"
              >
                <Award className="w-3.5 h-3.5" />
                {badge.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {challenges.length > 0 && (
        <div className="pt-2 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Target className="w-3.5 h-3.5 text-emerald-600" />
            {challenges.length} active community {challenges.length === 1 ? 'challenge' : 'challenges'}
          </span>
          <span className="inline-flex items-center gap-1 text-slate-500">
            <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
            Verified resolutions only
          </span>
        </div>
      )}
    </section>
  );
}
