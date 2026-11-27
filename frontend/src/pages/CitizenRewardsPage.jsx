import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Award,
  Trophy,
  Target,
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
} from 'lucide-react';
import Button from '../components/common/Button';
import {
  fetchCitizenRewardsSummary,
  fetchCitizenRewardsLeaderboard,
} from '../services/slaApiService';
import { formatDate } from '../utils/formatters';

export default function CitizenRewardsPage() {
  const [summary, setSummary] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [selectedWard, setSelectedWard] = useState('');
  const [loading, setLoading] = useState(true);
  const [boardLoading, setBoardLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadData = useCallback(async (wardFilter = '') => {
    setLoading(true);
    setError(null);
    try {
      const [sumData, boardData] = await Promise.all([
        fetchCitizenRewardsSummary(),
        fetchCitizenRewardsLeaderboard(wardFilter ? { ward: wardFilter } : {}),
      ]);
      setSummary(sumData);
      setLeaderboard(boardData);
    } catch (err) {
      setError(err?.message || 'Unable to load citizen rewards right now.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData('');
  }, [loadData]);

  const handleWardChange = async (wardValue) => {
    setSelectedWard(wardValue);
    setBoardLoading(true);
    try {
      const boardData = await fetchCitizenRewardsLeaderboard(
        wardValue ? { ward: wardValue } : {}
      );
      setLeaderboard(boardData);
    } catch (err) {
      setError(err?.message || 'Unable to filter leaderboard by ward.');
    } finally {
      setBoardLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-white rounded-3xl border border-slate-200 p-10 text-center text-sm text-slate-500">
          Loading citizen rewards and leaderboard...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-4">
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-6 flex items-center gap-3 text-rose-800 text-sm">
          <AlertCircle className="w-5 h-5 shrink-0 text-rose-600" />
          <span>{error}</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => loadData(selectedWard)}>
          Try Again
        </Button>
      </div>
    );
  }

  const featureEnabled = summary?.feature_enabled === true;
  const availableWards = Array.isArray(leaderboard?.available_wards)
    ? leaderboard.available_wards
    : [];

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Citizen Dashboard
          </Link>
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">
            Citizen Rewards &amp; Leaderboard
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Points and badges are earned from confirmed, citizen-verified civic resolutions.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          icon={RefreshCw}
          onClick={() => loadData(selectedWard)}
        >
          Refresh
        </Button>
      </div>

      {!featureEnabled ? (
        <div className="bg-white rounded-3xl border border-slate-200 p-10 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-500 flex items-center justify-center mx-auto">
            <Trophy className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-bold text-slate-900">Citizen Rewards Program Paused</h2>
          <p className="text-sm text-slate-600 max-w-md mx-auto">
            Citizen rewards, badges, and leaderboards are currently disabled by municipal
            administrators.
          </p>
        </div>
      ) : (
        <>
          {/* Points & Cap Summary */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
              <p className="text-xs font-medium text-slate-500">Anonymous Leaderboard Handle</p>
              <p className="text-base font-bold font-mono text-slate-900 mt-1">
                {summary.anonymous_handle}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                Protects your personal identity on leaderboards
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
              <p className="text-xs font-medium text-slate-500">Active Points</p>
              <p className="text-2xl font-extrabold text-slate-900 mt-1">
                {summary.total_points} pts
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                {summary.verified_reports_count} verified reports
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
              <p className="text-xs font-medium text-slate-500">Today&apos;s Cap</p>
              <p className="text-xl font-bold text-slate-900 mt-1">
                {summary.daily_points_used} / {summary.daily_points_limit} pts
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                {summary.daily_awards_used} / {summary.daily_awards_limit} verified awards
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs">
              <p className="text-xs font-medium text-slate-500">This Week&apos;s Cap</p>
              <p className="text-xl font-bold text-slate-900 mt-1">
                {summary.weekly_points_used} / {summary.weekly_points_limit} pts
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                {summary.weekly_awards_used} / {summary.weekly_awards_limit} verified awards
              </p>
            </div>
          </div>

          {/* Badges & Active Challenges */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-4">
              <div className="flex items-center gap-2">
                <Award className="w-5 h-5 text-blue-600" />
                <h2 className="text-lg font-bold text-slate-900">Your Badges</h2>
              </div>

              {summary.badges?.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {summary.badges.map((badge) => (
                    <div
                      key={badge.badge_code}
                      className="rounded-2xl border border-blue-200 bg-blue-50/50 p-4 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-slate-900">{badge.title}</span>
                        <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-white text-blue-700 border border-blue-200">
                          {badge.badge_kind}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600">{badge.description}</p>
                      <p className="text-[11px] text-slate-400">
                        Earned {formatDate(badge.earned_at)}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  No badges earned yet. Confirm a resolved issue you reported to earn your first
                  badge.
                </p>
              )}
            </section>

            <section className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-4">
              <div className="flex items-center gap-2">
                <Target className="w-5 h-5 text-emerald-600" />
                <h2 className="text-lg font-bold text-slate-900">Community Challenges</h2>
              </div>

              {summary.active_challenges?.length > 0 ? (
                <div className="space-y-3">
                  {summary.active_challenges.map((challenge) => (
                    <div
                      key={challenge.id}
                      className="rounded-2xl border border-slate-200 p-4 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-bold text-slate-900">{challenge.title}</h3>
                          <p className="text-xs text-slate-600 mt-0.5">{challenge.description}</p>
                        </div>
                        <span className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full shrink-0">
                          +{challenge.bonus_points} pts
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between text-xs text-slate-500 pt-1">
                        <span>
                          Progress: <strong>{challenge.progress_count}</strong> /{' '}
                          {challenge.required_verified_reports} verified reports
                          {challenge.target_ward ? ` in ${challenge.target_ward}` : ''}
                        </span>
                        {challenge.completed ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Completed
                          </span>
                        ) : (
                          <span>Ends {formatDate(challenge.ends_at)}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  No active community challenges right now.
                </p>
              )}
            </section>
          </div>

          {/* Privacy-Safe Leaderboard */}
          <section className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  All-Time Civic Contributors Leaderboard
                </h2>
                <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
                  Boards appear only when at least {leaderboard?.min_group_size || 20} active
                  contributors participate in that view.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="ward-leaderboard-select" className="text-xs font-semibold text-slate-600">
                  Scope:
                </label>
                <select
                  id="ward-leaderboard-select"
                  value={selectedWard}
                  onChange={(e) => handleWardChange(e.target.value)}
                  disabled={boardLoading}
                  className="text-sm border border-slate-200 rounded-xl px-3 py-1.5 bg-white text-slate-800"
                >
                  <option value="">Citywide</option>
                  {availableWards.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {leaderboard?.enough_data ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                      <th className="py-2.5 px-3">Rank</th>
                      <th className="py-2.5 px-3">Contributor Handle</th>
                      <th className="py-2.5 px-3">Verified Reports</th>
                      <th className="py-2.5 px-3 text-right">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {leaderboard.entries.map((row) => (
                      <tr
                        key={`${row.rank}-${row.anonymous_handle}`}
                        className={row.is_self ? 'bg-blue-50/70 font-semibold' : ''}
                      >
                        <td className="py-2.5 px-3 text-slate-700">#{row.rank}</td>
                        <td className="py-2.5 px-3 font-mono text-slate-900">
                          {row.anonymous_handle}{' '}
                          {row.is_self && (
                            <span className="ml-1.5 text-[11px] font-sans font-semibold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">
                              You
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {row.verified_reports_count}
                        </td>
                        <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                          {row.points} pts
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-2xl bg-slate-50 border border-slate-200 p-6 text-center text-sm text-slate-600">
                Not enough participants yet in this view to publish a privacy-preserving
                leaderboard (minimum {leaderboard?.min_group_size || 20} active contributors
                required).
              </div>
            )}
          </section>

          {/* Recent Neutral Points Activity */}
          <section className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-4">
            <h2 className="text-lg font-bold text-slate-900">Recent Points Activity</h2>
            {summary.recent_ledger?.length > 0 ? (
              <div className="divide-y divide-slate-100">
                {summary.recent_ledger.map((item) => (
                  <div
                    key={item.id}
                    className="py-3 flex items-center justify-between gap-4 text-sm"
                  >
                    <div>
                      <p className="font-medium text-slate-900">{item.summary_label}</p>
                      <p className="text-xs text-slate-500">
                        {item.complaint_number ? `${item.complaint_number} • ` : ''}
                        {formatDate(item.created_at)}
                      </p>
                    </div>
                    <span
                      className={`font-bold ${
                        item.points_delta >= 0 ? 'text-emerald-700' : 'text-slate-600'
                      }`}
                    >
                      {item.points_delta >= 0 ? `+${item.points_delta}` : item.points_delta} pts
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">No reward activity recorded yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
