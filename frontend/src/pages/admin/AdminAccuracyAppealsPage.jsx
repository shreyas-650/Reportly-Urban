import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  HelpCircle,
  Inbox,
  RefreshCw,
  Scale,
  XCircle,
} from 'lucide-react';
import {
  decideAdminReviewAppeal,
  fetchAdminAccuracyDashboard,
  fetchAdminReviewAppeals,
  fetchAdminWardFairness,
  toggleAdminAppealFeature,
} from '../../services/slaApiService';
import StatusBadge from '../../components/common/StatusBadge';
import { formatDate, formatDateTime } from '../../utils/formatters';

function formatPct(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '—';
  return `${(Number(val) * 100).toFixed(1)}%`;
}

export default function AdminAccuracyAppealsPage({ api = null }) {
  const fetchDashFn = api?.fetchDashboard || fetchAdminAccuracyDashboard;
  const fetchWardsFn = api?.fetchWards || fetchAdminWardFairness;
  const fetchAppealsFn = api?.fetchAppeals || fetchAdminReviewAppeals;
  const decideAppealFn = api?.decideAppeal || decideAdminReviewAppeal;
  const toggleFlagFn = api?.toggleFeature || toggleAdminAppealFeature;

  const [activeTab, setActiveTab] = useState('accuracy');
  const [windowFilter, setWindowFilter] = useState('30d');
  const [dashboard, setDashboard] = useState(null);
  const [wardFairness, setWardFairness] = useState(null);
  const [dashLoading, setDashLoading] = useState(true);
  const [dashError, setDashError] = useState(null);

  const [appealFilter, setAppealFilter] = useState('open');
  const [appealPage, setAppealPage] = useState(1);
  const [appealsData, setAppealsData] = useState(null);
  const [appealsLoading, setAppealsLoading] = useState(true);
  const [appealsError, setAppealsError] = useState(null);
  const [submittingId, setSubmittingId] = useState(null);
  const [decisionReason, setDecisionReason] = useState({});
  const [togglingFlag, setTogglingFlag] = useState(false);

  const loadAccuracy = useCallback(async () => {
    setDashLoading(true);
    setDashError(null);
    try {
      const [dashRes, wardsRes] = await Promise.all([
        fetchDashFn({ window: windowFilter }),
        fetchWardsFn(),
      ]);
      setDashboard(dashRes);
      setWardFairness(wardsRes);
    } catch (err) {
      setDashError(err?.message || 'Unable to load AI accuracy metrics.');
    } finally {
      setDashLoading(false);
    }
  }, [fetchDashFn, fetchWardsFn, windowFilter]);

  const loadAppeals = useCallback(async () => {
    setAppealsLoading(true);
    setAppealsError(null);
    try {
      const res = await fetchAppealsFn({
        status: appealFilter,
        page: appealPage,
        page_size: 20,
      });
      setAppealsData(res);
    } catch (err) {
      setAppealsError(err?.message || 'Unable to load citizen review appeals.');
    } finally {
      setAppealsLoading(false);
    }
  }, [fetchAppealsFn, appealFilter, appealPage]);

  useEffect(() => {
    loadAccuracy();
  }, [loadAccuracy]);

  useEffect(() => {
    loadAppeals();
  }, [loadAppeals]);

  const handleAppealDecision = async (appealId, outcome, isCorrection = false) => {
    if (!appealId || submittingId) return;
    setSubmittingId(appealId);
    setAppealsError(null);
    try {
      const reasonText = (decisionReason[appealId] || '').trim() || null;
      await decideAppealFn(appealId, {
        outcome,
        reason: reasonText,
        is_correction: isCorrection,
      });
      await Promise.all([loadAppeals(), loadAccuracy()]);
    } catch (err) {
      setAppealsError(err?.message || 'Failed to record appeal decision.');
    } finally {
      setSubmittingId(null);
    }
  };

  const handleToggleAppealSetting = async () => {
    if (togglingFlag || !appealsData) return;
    setTogglingFlag(true);
    setAppealsError(null);
    try {
      await toggleFlagFn(!appealsData.appeal_feature_enabled);
      await loadAppeals();
    } catch (err) {
      setAppealsError(err?.message || 'Failed to toggle appeal setting.');
    } finally {
      setTogglingFlag(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-blue-600" />
            AI Accuracy Dashboard & Review Appeals
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Independent per-feature accuracy against verified human outcomes, ward fairness monitoring, and citizen review appeals.
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('accuracy')}
            className={`px-3 py-2 rounded-xl font-bold transition ${
              activeTab === 'accuracy'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            Accuracy & Fairness
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('appeals')}
            className={`px-3 py-2 rounded-xl font-bold transition ${
              activeTab === 'appeals'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            Review Appeals ({appealsData?.total ?? 0})
          </button>
        </div>
      </div>

      {activeTab === 'accuracy' ? (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3 text-xs">
              <div>
                <span className="font-bold text-slate-800">Per-Feature Accuracy Cards</span>
                {dashboard?.date_from && dashboard?.date_to && (
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Window: {formatDate(dashboard.date_from)} to {formatDate(dashboard.date_to)} · Minimum sample size: {dashboard.min_samples}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="accuracy-window-select" className="font-semibold text-slate-700">
                  Window:
                </label>
                <select
                  id="accuracy-window-select"
                  value={windowFilter}
                  onChange={(e) => setWindowFilter(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-900"
                >
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="90d">Last 90 days</option>
                  <option value="all">All time</option>
                </select>
                <button
                  type="button"
                  onClick={loadAccuracy}
                  disabled={dashLoading}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${dashLoading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
              </div>
            </div>

            {dashError && (
              <div role="alert" className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{dashError}</span>
              </div>
            )}

            {dashLoading ? (
              <div role="status" className="p-6 text-center text-xs text-slate-500">
                Loading per-feature accuracy metrics...
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {(dashboard?.cards || []).map((card) => (
                  <div
                    key={card.feature}
                    className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="font-bold text-slate-900">{card.label}</h2>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white border border-slate-200 text-slate-700">
                        n = {card.sample_size}
                      </span>
                    </div>

                    {!card.enough_data ? (
                      <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 font-semibold">
                        Not enough data (requires ≥ {dashboard?.min_samples ?? 20} verified samples)
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="text-2xl font-extrabold text-slate-900">
                          {formatPct(card.agreement_rate)}
                        </div>
                        <p className="text-[11px] text-slate-600">
                          Agreed: {card.agreed_count} · Disagreed: {card.disagreed_count}
                        </p>
                        {card.override_rate !== null && card.override_rate !== undefined && (
                          <p className="text-[11px] text-slate-600">
                            Override rate: {formatPct(card.override_rate)}
                          </p>
                        )}
                        {card.false_positive_rate !== null && card.false_positive_rate !== undefined && (
                          <p className="text-[11px] text-slate-600">
                            False-positive rate: {formatPct(card.false_positive_rate)}
                          </p>
                        )}
                        {card.rejection_rate !== null && card.rejection_rate !== undefined && (
                          <p className="text-[11px] text-slate-600">
                            Rejection rate: {formatPct(card.rejection_rate)} ({card.rejected_count ?? 0})
                          </p>
                        )}
                      </div>
                    )}

                    <div className="pt-1 border-t border-slate-200/80 text-[11px] text-slate-500 flex flex-wrap justify-between gap-1">
                      <span>Excluded (unverified): {card.excluded_count}</span>
                      {card.corrected_decisions_count !== null && card.corrected_decisions_count !== undefined && (
                        <span>Corrected: {card.corrected_decisions_count}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Ward Fairness Monitoring (ONE Fixed Window, Informational Only) */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Scale className="w-4 h-4 text-blue-600" />
                  Ward Fairness Breakdown (Informational Only)
                </h2>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {wardFairness?.fairness_notice ||
                    'Fairness monitoring, informational only. Ward data never feeds any AI decision, threshold, or gate.'}
                </p>
              </div>
              <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-700 font-semibold text-[11px]">
                Fixed window: All time · Min per ward: {wardFairness?.ward_min_samples ?? 20}
              </span>
            </div>

            {!wardFairness?.enough_data || (wardFairness?.wards || []).length === 0 ? (
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 font-semibold text-center">
                Not enough data per ward to report fairness disparity without risking small-sample suppression leak.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 text-[11px] uppercase">
                      <th className="py-2 pr-4">Normalized Submission Ward</th>
                      <th className="py-2 pr-4">Sample Size</th>
                      <th className="py-2 pr-4">Agreement Rate</th>
                      <th className="py-2">Disparity vs Displayed Overall ({formatPct(wardFairness.displayed_overall_rate)})</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {wardFairness.wards.map((w) => (
                      <tr key={w.ward}>
                        <td className="py-2 pr-4 font-semibold text-slate-900 capitalize">
                          {w.ward}
                        </td>
                        <td className="py-2 pr-4 text-slate-700">{w.sample_size}</td>
                        <td className="py-2 pr-4 font-bold text-slate-900">{formatPct(w.agreement_rate)}</td>
                        <td className="py-2 text-slate-700">
                          {w.disparity_vs_overall === null || w.disparity_vs_overall === undefined
                            ? '—'
                            : `${w.disparity_vs_overall >= 0 ? '+' : ''}${(Number(w.disparity_vs_overall) * 100).toFixed(1)} pp`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4 text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-slate-800">Citizen Review Appeals Queue</span>
              <button
                type="button"
                onClick={handleToggleAppealSetting}
                disabled={togglingFlag || !appealsData}
                className={`px-2.5 py-1 rounded-lg font-bold border transition ${
                  appealsData?.appeal_feature_enabled
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                    : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
                }`}
              >
                DB Appeal Flag: {appealsData?.appeal_feature_enabled ? 'Enabled' : 'Disabled (Default Off)'}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <label htmlFor="admin-appeal-filter" className="font-semibold text-slate-700">
                Status:
              </label>
              <select
                id="admin-appeal-filter"
                value={appealFilter}
                onChange={(e) => {
                  setAppealFilter(e.target.value);
                  setAppealPage(1);
                }}
                className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-900"
              >
                <option value="open">Open</option>
                <option value="needs_more_info">Needs More Info (Admin Only)</option>
                <option value="released">Released Flag</option>
                <option value="upheld">Upheld Flag</option>
                <option value="reviewed">Reviewed (Unflagged)</option>
                <option value="all">All</option>
              </select>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600">
            Note: &ldquo;Needs More Info&rdquo; is an internal admin-side decision only; no citizen clarification flow exists in this phase. Citizen appeals never change complaint status automatically.
          </div>

          {appealsError && (
            <div role="alert" className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{appealsError}</span>
            </div>
          )}

          {appealsLoading ? (
            <div role="status" className="p-6 text-center text-slate-500">
              Loading review appeals...
            </div>
          ) : (appealsData?.items || []).length === 0 ? (
            <div className="p-8 text-center space-y-2 text-slate-500">
              <Inbox className="w-8 h-8 mx-auto text-slate-300" />
              <p className="text-sm font-semibold text-slate-700">No review appeals match this filter.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {appealsData.items.map((item) => {
                const isBusy = submittingId === item.appeal_id;
                const canDecide = item.appeal_status === 'open' || item.appeal_status === 'needs_more_info';
                const canCorrect = ['upheld', 'released', 'reviewed'].includes(item.appeal_status);

                return (
                  <div
                    key={item.appeal_id}
                    className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to={`/admin/complaints/${item.complaint_id}`}
                          className="font-mono font-bold text-blue-700 hover:underline inline-flex items-center gap-1"
                        >
                          {item.complaint_number}
                          <ExternalLink className="w-3 h-3" />
                        </Link>
                        <StatusBadge status={item.complaint_status} size="sm" />
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white border border-slate-200 text-slate-700 capitalize">
                          Appeal: {item.appeal_status.replace(/_/g, ' ')}
                        </span>
                        {item.had_active_flag ? (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 border border-amber-200 text-amber-900">
                            9.5 Flagged ({item.risk_level || 'held'})
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 border border-slate-200 text-slate-600">
                            Unflagged Plain Request
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-400">
                        {formatDateTime(item.created_at)}
                      </span>
                    </div>

                    <p className="font-bold text-slate-900 text-sm">{item.complaint_title}</p>

                    {/* Amendment E: Always render untrusted citizen appeal text as plain text */}
                    <p className="p-3 rounded-lg bg-white border border-slate-200 text-slate-800 whitespace-pre-wrap">
                      {item.appeal_text}
                    </p>

                    {(canDecide || canCorrect) && (
                      <div className="space-y-2 pt-1">
                        <input
                          type="text"
                          value={decisionReason[item.appeal_id] || ''}
                          onChange={(e) =>
                            setDecisionReason((prev) => ({
                              ...prev,
                              [item.appeal_id]: e.target.value,
                            }))
                          }
                          placeholder={
                            canCorrect
                              ? 'Correction reason (min 5 chars, creates new immutable decision row)...'
                              : 'Optional decision note (min 3 chars if entered)...'
                          }
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-900"
                        />

                        {canDecide ? (
                          <div className="flex flex-wrap items-center gap-2">
                            {item.had_active_flag ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleAppealDecision(item.appeal_id, 'released', false)}
                                  disabled={Boolean(submittingId)}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  {isBusy ? 'Saving...' : 'Release Flag'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleAppealDecision(item.appeal_id, 'upheld', false)}
                                  disabled={Boolean(submittingId)}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-50"
                                >
                                  <XCircle className="w-3.5 h-3.5" />
                                  Uphold Flag
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleAppealDecision(item.appeal_id, 'reviewed', false)}
                                disabled={Boolean(submittingId)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50"
                              >
                                <Check className="w-3.5 h-3.5" />
                                {isBusy ? 'Saving...' : 'Mark Reviewed'}
                              </button>
                            )}

                            {item.appeal_status !== 'needs_more_info' && (
                              <button
                                type="button"
                                onClick={() => handleAppealDecision(item.appeal_id, 'needs_more_info', false)}
                                disabled={Boolean(submittingId)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-semibold border border-amber-300 disabled:opacity-50"
                              >
                                <HelpCircle className="w-3.5 h-3.5" />
                                Needs More Info
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            {item.had_active_flag ? (
                              <button
                                type="button"
                                onClick={() =>
                                  handleAppealDecision(
                                    item.appeal_id,
                                    item.appeal_status === 'upheld' ? 'released' : 'upheld',
                                    true
                                  )
                                }
                                disabled={Boolean(submittingId)}
                                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 text-white font-semibold disabled:opacity-50"
                              >
                                Record Correction ({item.appeal_status === 'upheld' ? 'Release Flag' : 'Uphold Flag'})
                              </button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {(appealsData?.total_pages || 1) > 1 && (
            <div className="flex items-center justify-between pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setAppealPage((p) => Math.max(1, p - 1))}
                disabled={appealPage <= 1}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-50"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Previous
              </button>
              <span className="font-semibold text-slate-600">
                Page {appealPage} of {appealsData.total_pages}
              </span>
              <button
                type="button"
                onClick={() => setAppealPage((p) => Math.min(appealsData.total_pages, p + 1))}
                disabled={appealPage >= appealsData.total_pages}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-50"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
