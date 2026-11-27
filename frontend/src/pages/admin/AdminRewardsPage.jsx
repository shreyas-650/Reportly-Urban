import React, { useState, useEffect, useCallback } from 'react';
import {
  Trophy,
  PlusCircle,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ShieldAlert,
  Sliders,
} from 'lucide-react';
import Button from '../../components/common/Button';
import {
  fetchAdminRewardsAudit,
  toggleAdminRewardsFeature,
  createAdminCommunityChallenge,
  adjustAdminCitizenRewards,
} from '../../services/slaApiService';
import { formatDate } from '../../utils/formatters';

const OUTCOME_FILTERS = [
  { value: '', label: 'All Outcomes' },
  { value: 'awarded', label: 'Awarded' },
  { value: 'reversed', label: 'Reversed' },
  { value: 'pending_flag_hold', label: 'Pending Flag Hold' },
  { value: 'blocked_duplicate', label: 'Blocked (Duplicate)' },
  { value: 'blocked_screening', label: 'Blocked (Screening)' },
  { value: 'ineligible_pre_enable', label: 'Pre-Enable Verification' },
  { value: 'skipped_daily_count_cap', label: 'Skipped: Daily Count Cap' },
  { value: 'skipped_daily_points_cap', label: 'Skipped: Daily Points Cap' },
  { value: 'skipped_weekly_count_cap', label: 'Skipped: Weekly Count Cap' },
  { value: 'skipped_weekly_points_cap', label: 'Skipped: Weekly Points Cap' },
  { value: 'reversal_noop', label: 'Reversal No-op' },
  { value: 'award_failed', label: 'Trigger Failed' },
];

export default function AdminRewardsPage() {
  const [audit, setAudit] = useState(null);
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const [challengeForm, setChallengeForm] = useState({
    title: '',
    description: '',
    badge_code: '',
    badge_title: '',
    badge_description: '',
    required_verified_reports: 3,
    bonus_points: 50,
    target_ward: '',
    target_category: '',
    starts_at: '',
    ends_at: '',
  });
  const [creatingChallenge, setCreatingChallenge] = useState(false);

  const [adjustForm, setAdjustForm] = useState({
    citizen_id: '',
    points_delta: 25,
    reason: '',
    complaint_id: '',
  });
  const [adjusting, setAdjusting] = useState(false);

  const loadAudit = useCallback(async (selectedOutcome = '') => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminRewardsAudit(
        selectedOutcome ? { outcome: selectedOutcome } : {}
      );
      setAudit(data);
    } catch (err) {
      setError(err?.message || 'Unable to load rewards audit dashboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAudit(outcomeFilter);
  }, [loadAudit, outcomeFilter]);

  const handleToggleFeature = async () => {
    if (!audit) return;
    setToggling(true);
    setFeedback(null);
    setError(null);
    try {
      const nextState = !audit.feature_enabled;
      const res = await toggleAdminRewardsFeature(nextState);
      setFeedback(
        `Citizen rewards ${res.feature_enabled ? 'enabled' : 'disabled'} in database.`
      );
      await loadAudit(outcomeFilter);
    } catch (err) {
      setError(err?.message || 'Failed to update rewards setting.');
    } finally {
      setToggling(false);
    }
  };

  const handleCreateChallenge = async (e) => {
    e.preventDefault();
    setCreatingChallenge(true);
    setError(null);
    setFeedback(null);
    try {
      const payload = {
        ...challengeForm,
        required_verified_reports: Number(challengeForm.required_verified_reports),
        bonus_points: Number(challengeForm.bonus_points),
        target_ward: challengeForm.target_ward.trim() || null,
        target_category: challengeForm.target_category || null,
        starts_at: new Date(challengeForm.starts_at).toISOString(),
        ends_at: new Date(challengeForm.ends_at).toISOString(),
      };
      const created = await createAdminCommunityChallenge(payload);
      setFeedback(
        `Challenge "${created.title}" and badge "${created.badge_code}" created atomically.`
      );
      setChallengeForm({
        title: '',
        description: '',
        badge_code: '',
        badge_title: '',
        badge_description: '',
        required_verified_reports: 3,
        bonus_points: 50,
        target_ward: '',
        target_category: '',
        starts_at: '',
        ends_at: '',
      });
      await loadAudit(outcomeFilter);
    } catch (err) {
      setError(err?.message || 'Failed to create community challenge.');
    } finally {
      setCreatingChallenge(false);
    }
  };

  const handleAdjust = async (e) => {
    e.preventDefault();
    setAdjusting(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await adjustAdminCitizenRewards({
        citizen_id: adjustForm.citizen_id.trim(),
        points_delta: Number(adjustForm.points_delta),
        reason: adjustForm.reason.trim(),
        complaint_id: adjustForm.complaint_id.trim() || null,
      });
      setFeedback(
        `Adjusted ${res.anonymous_handle} by ${res.points_delta} pts (new balance: ${res.new_total_points} pts).`
      );
      setAdjustForm({ citizen_id: '', points_delta: 25, reason: '', complaint_id: '' });
      await loadAudit(outcomeFilter);
    } catch (err) {
      setError(err?.message || 'Failed to apply rewards adjustment.');
    } finally {
      setAdjusting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Citizen Rewards, Challenges &amp; Audit
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Manage reward activation, community challenges, and inspect cap/hold/trigger logs.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          icon={RefreshCw}
          disabled={loading}
          onClick={() => loadAudit(outcomeFilter)}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 flex items-center gap-3 text-sm text-rose-800">
          <AlertCircle className="w-5 h-5 shrink-0 text-rose-600" />
          <span>{error}</span>
        </div>
      )}

      {feedback && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 flex items-center gap-3 text-sm text-emerald-800">
          <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-600" />
          <span>{feedback}</span>
        </div>
      )}

      {audit && (
        <>
          {/* Feature Switch Banner */}
          <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-600" />
                <h2 className="text-base font-bold text-slate-900">
                  Citizen Rewards Feature Gate
                </h2>
                <span
                  className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                    audit.feature_enabled
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-slate-100 text-slate-600 border border-slate-200'
                  }`}
                >
                  DB: {audit.feature_enabled ? 'Enabled' : 'Disabled'}
                </span>
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                  API Env: {audit.backend_flag_enabled ? 'True' : 'False'}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                First Enabled At:{' '}
                <strong>
                  {audit.first_enabled_at ? formatDate(audit.first_enabled_at) : 'Not enabled yet'}
                </strong>{' '}
                (set once permanently; verifications before this timestamp never earn retroactive
                points).
              </p>
            </div>

            <Button
              variant={audit.feature_enabled ? 'outline' : 'primary'}
              size="sm"
              disabled={toggling}
              onClick={handleToggleFeature}
            >
              {toggling
                ? 'Updating...'
                : audit.feature_enabled
                  ? 'Disable Rewards in DB'
                  : 'Enable Rewards in DB'}
            </Button>
          </section>

          {/* Summary KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <p className="text-xs text-slate-500">Total Points Awarded</p>
              <p className="text-2xl font-extrabold text-slate-900 mt-1">
                {audit.summary.total_points_awarded}
              </p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <p className="text-xs text-slate-500">Total Points Reversed</p>
              <p className="text-2xl font-extrabold text-slate-900 mt-1">
                {audit.summary.total_points_reversed}
              </p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <p className="text-xs text-slate-500">Pending Flag Holds</p>
              <p className="text-2xl font-extrabold text-amber-700 mt-1">
                {audit.summary.pending_holds_logged}
              </p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <p className="text-xs text-slate-500">Cap Skips Logged</p>
              <p className="text-2xl font-extrabold text-slate-900 mt-1">
                {audit.summary.cap_skips_logged}
              </p>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <p className="text-xs text-slate-500">Trigger Failures Isolated</p>
              <p className="text-2xl font-extrabold text-rose-700 mt-1">
                {audit.summary.trigger_failures_logged}
              </p>
            </div>
          </div>

          {/* Admin Challenge Builder & Manual Adjustment */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <form
              onSubmit={handleCreateChallenge}
              className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4"
            >
              <div className="flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-blue-600" />
                <h2 className="text-base font-bold text-slate-900">Create Community Challenge</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <input
                  required
                  placeholder="Challenge Title"
                  value={challengeForm.title}
                  onChange={(e) => setChallengeForm({ ...challengeForm, title: e.target.value })}
                  className="border border-slate-200 rounded-xl px-3 py-2 sm:col-span-2"
                />
                <textarea
                  required
                  placeholder="Challenge Description"
                  value={challengeForm.description}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, description: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2 sm:col-span-2"
                  rows={2}
                />
                <input
                  required
                  placeholder="badge_code (e.g. monsoon_watch_2026)"
                  value={challengeForm.badge_code}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, badge_code: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2"
                />
                <input
                  required
                  placeholder="Badge Title"
                  value={challengeForm.badge_title}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, badge_title: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2"
                />
                <input
                  required
                  placeholder="Badge Description"
                  value={challengeForm.badge_description}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, badge_description: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2 sm:col-span-2"
                />
                <input
                  required
                  type="number"
                  min={1}
                  max={100}
                  placeholder="Required Reports"
                  value={challengeForm.required_verified_reports}
                  onChange={(e) =>
                    setChallengeForm({
                      ...challengeForm,
                      required_verified_reports: e.target.value,
                    })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2"
                />
                <input
                  required
                  type="number"
                  min={5}
                  max={200}
                  placeholder="Bonus Points"
                  value={challengeForm.bonus_points}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, bonus_points: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2"
                />
                <input
                  placeholder="Optional Target Ward"
                  value={challengeForm.target_ward}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, target_ward: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2"
                />
                <select
                  value={challengeForm.target_category}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, target_category: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2 bg-white"
                >
                  <option value="">Any Category</option>
                  <option value="potholes">Potholes</option>
                  <option value="garbage">Garbage</option>
                  <option value="streetlights">Streetlights</option>
                  <option value="water_leakage">Water Leakage</option>
                  <option value="drainage">Drainage</option>
                  <option value="public_infrastructure">Public Infrastructure</option>
                </select>
                <input
                  required
                  type="datetime-local"
                  aria-label="Challenge Start"
                  value={challengeForm.starts_at}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, starts_at: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2"
                />
                <input
                  required
                  type="datetime-local"
                  aria-label="Challenge End"
                  value={challengeForm.ends_at}
                  onChange={(e) =>
                    setChallengeForm({ ...challengeForm, ends_at: e.target.value })
                  }
                  className="border border-slate-200 rounded-xl px-3 py-2"
                />
              </div>

              <Button type="submit" variant="primary" size="sm" disabled={creatingChallenge}>
                {creatingChallenge ? 'Creating Challenge...' : 'Create Challenge & Badge'}
              </Button>
            </form>

            <form
              onSubmit={handleAdjust}
              className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4"
            >
              <div className="flex items-center gap-2">
                <Sliders className="w-5 h-5 text-slate-700" />
                <h2 className="text-base font-bold text-slate-900">
                  Manual Citizen Points Adjustment
                </h2>
              </div>

              <div className="space-y-3 text-sm">
                <input
                  required
                  placeholder="Citizen UUID"
                  value={adjustForm.citizen_id}
                  onChange={(e) => setAdjustForm({ ...adjustForm, citizen_id: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2"
                />
                <input
                  required
                  type="number"
                  min={-500}
                  max={500}
                  placeholder="Points Delta (-500 to 500)"
                  value={adjustForm.points_delta}
                  onChange={(e) => setAdjustForm({ ...adjustForm, points_delta: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2"
                />
                <input
                  placeholder="Optional Complaint UUID"
                  value={adjustForm.complaint_id}
                  onChange={(e) => setAdjustForm({ ...adjustForm, complaint_id: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2"
                />
                <textarea
                  required
                  minLength={5}
                  placeholder="Audit Reason (recorded in admin evaluations)"
                  value={adjustForm.reason}
                  onChange={(e) => setAdjustForm({ ...adjustForm, reason: e.target.value })}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2"
                  rows={2}
                />
              </div>

              <Button type="submit" variant="outline" size="sm" disabled={adjusting}>
                {adjusting ? 'Applying...' : 'Apply Adjustment'}
              </Button>
            </form>
          </div>

          {/* Evaluations Audit Table */}
          <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-slate-700" />
                <h2 className="text-base font-bold text-slate-900">
                  Reward Evaluation Audit Log (Admin Only)
                </h2>
              </div>

              <select
                aria-label="Filter evaluation outcome"
                value={outcomeFilter}
                onChange={(e) => setOutcomeFilter(e.target.value)}
                className="text-sm border border-slate-200 rounded-xl px-3 py-1.5 bg-white"
              >
                {OUTCOME_FILTERS.map((opt) => (
                  <option key={opt.value || 'all'} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {audit.evaluations.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 uppercase">
                      <th className="py-2 px-3">Timestamp</th>
                      <th className="py-2 px-3">Outcome</th>
                      <th className="py-2 px-3">Source</th>
                      <th className="py-2 px-3">Complaint</th>
                      <th className="py-2 px-3">Delta</th>
                      <th className="py-2 px-3">Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {audit.evaluations.map((ev) => (
                      <tr key={ev.id}>
                        <td className="py-2 px-3 text-slate-500 whitespace-nowrap">
                          {formatDate(ev.created_at)}
                        </td>
                        <td className="py-2 px-3 font-mono font-semibold text-slate-800">
                          {ev.outcome}
                        </td>
                        <td className="py-2 px-3 text-slate-600">{ev.source_table}</td>
                        <td className="py-2 px-3 text-slate-700">
                          {ev.complaint_number || ev.complaint_id || '—'}
                        </td>
                        <td className="py-2 px-3 font-bold text-slate-900">
                          {ev.points_delta > 0 ? `+${ev.points_delta}` : ev.points_delta}
                        </td>
                        <td className="py-2 px-3 text-slate-600">{ev.detail || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No reward evaluation entries recorded yet.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
