import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Edit3,
  EyeOff,
  Info,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { VALID_CIVIC_CATEGORIES } from '../../services/complaintService';
import {
  acceptAdminComplaintAiSuggestion,
  fetchAdminComplaintAiSuggestion,
  ignoreAdminComplaintAiSuggestion,
  overrideAdminComplaintAiSuggestion,
} from '../../services/slaApiService';
import PriorityBadge from '../common/PriorityBadge';
import { formatDateTime } from '../../utils/formatters';

const CATEGORY_LABELS = {
  potholes: 'Potholes & Damaged Roads',
  garbage: 'Garbage & Waste',
  streetlights: 'Broken Streetlights',
  water_leakage: 'Water Supply & Leakage',
  drainage: 'Drainage & Sewage',
  public_infrastructure: 'Public Infrastructure',
};

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'emergency', label: 'Emergency' },
];

const TERMINAL_STATUSES = new Set(['resolved', 'rejected', 'not_confirmed_by_citizen']);

function formatCategoryLabel(cat) {
  if (!cat) return 'N/A';
  return CATEGORY_LABELS[cat] || cat.replace(/_/g, ' ');
}

export default function AdminAiSuggestionPanel({
  complaintId,
  complaintCategory,
  complaintPriority,
  complaintStatus,
  expectedUpdatedAt,
  isAdmin,
  onDecisionSaved = null,
  api = null,
}) {
  const fetchFn = api?.fetchSuggestion || fetchAdminComplaintAiSuggestion;
  const acceptFn = api?.acceptSuggestion || acceptAdminComplaintAiSuggestion;
  const overrideFn = api?.overrideSuggestion || overrideAdminComplaintAiSuggestion;
  const ignoreFn = api?.ignoreSuggestion || ignoreAdminComplaintAiSuggestion;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideCategory, setOverrideCategory] = useState(complaintCategory || 'potholes');
  const [overridePriority, setOverridePriority] = useState(complaintPriority || 'normal');

  const loadSuggestion = useCallback(async () => {
    if (!isAdmin || !complaintId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchFn(complaintId);
      setData(res);
    } catch (err) {
      setLoadError(err?.message || 'Unable to load AI suggestion.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, complaintId, fetchFn]);

  useEffect(() => {
    loadSuggestion();
  }, [loadSuggestion]);

  useEffect(() => {
    if (complaintCategory) setOverrideCategory(complaintCategory);
    if (complaintPriority) setOverridePriority(complaintPriority);
  }, [complaintCategory, complaintPriority]);

  // Strictly admin-only (citizens and officers must never see AI shadow suggestions)
  if (!isAdmin) {
    return null;
  }

  const featureEnabled = Boolean(data?.feature_enabled);
  const latest = data?.latest || null;
  const isTerminal = TERMINAL_STATUSES.has(complaintStatus);
  const canDecideCompleted =
    Boolean(latest) && latest.status === 'completed' && latest.admin_decision === 'pending';

  const handleAccept = async () => {
    if (submitting || !canDecideCompleted || isTerminal) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await acceptFn(complaintId, {
        expected_updated_at: expectedUpdatedAt || null,
      });
      setOverrideOpen(false);
      await loadSuggestion();
      if (typeof onDecisionSaved === 'function') {
        await onDecisionSaved();
      }
    } catch (err) {
      setActionError(err?.message || 'Failed to accept AI suggestion.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOverrideSubmit = async (e) => {
    e.preventDefault();
    if (submitting || !canDecideCompleted || isTerminal) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await overrideFn(complaintId, {
        category: overrideCategory,
        priority: overridePriority,
        expected_updated_at: expectedUpdatedAt || null,
      });
      setOverrideOpen(false);
      await loadSuggestion();
      if (typeof onDecisionSaved === 'function') {
        await onDecisionSaved();
      }
    } catch (err) {
      setActionError(err?.message || 'Failed to override AI suggestion.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleIgnore = async () => {
    if (submitting || !latest || latest.admin_decision !== 'pending') return;
    setSubmitting(true);
    setActionError(null);
    try {
      await ignoreFn(complaintId, {
        expected_updated_at: expectedUpdatedAt || null,
      });
      setOverrideOpen(false);
      await loadSuggestion();
    } catch (err) {
      setActionError(err?.message || 'Failed to ignore AI suggestion.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      aria-label="AI suggestion"
      className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-blue-600 shrink-0" />
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
            AI suggestion
          </h2>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
            Shadow Mode
          </span>
        </div>

        <button
          type="button"
          onClick={loadSuggestion}
          disabled={loading || submitting}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold disabled:opacity-50 transition"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 flex items-start gap-2">
        <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
        <span>
          Shadow-mode category and priority classification. Complaints are never changed automatically unless an admin chooses Accept or Override.
        </span>
      </div>

      {loading && !data ? (
        <div role="status" className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
          <span>Loading AI suggestion...</span>
        </div>
      ) : loadError ? (
        <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      ) : (
        <div className="space-y-3">
          {!featureEnabled && (
            <div role="status" className="p-3 rounded-xl bg-slate-100 border border-slate-200 text-slate-700 font-medium">
              AI is off. Category and priority suggestions are currently disabled.
            </div>
          )}

          {featureEnabled && !latest && (
            <div role="status" className="p-3 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-slate-600">
              No suggestion available for this complaint yet.
            </div>
          )}

          {actionError && (
            <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{actionError}</span>
            </div>
          )}

          {latest?.status === 'pending' && (
            <div role="status" className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-blue-600 shrink-0" />
              <span>AI suggestion is currently being generated in the background.</span>
            </div>
          )}

          {latest?.status === 'failed' && (
            <div role="alert" className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 space-y-1">
              <p className="font-bold flex items-center gap-1.5">
                <XCircle className="w-4 h-4 shrink-0" />
                AI suggestion unavailable (failed attempt)
              </p>
              {latest.error_message && (
                <p className="text-[11px] font-mono text-amber-800">{latest.error_message}</p>
              )}
            </div>
          )}

          {latest?.status === 'completed' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block">
                    Suggested Category
                  </span>
                  <span className="font-bold text-slate-900 block">
                    {formatCategoryLabel(latest.suggested_category)}
                  </span>
                  <span className="text-[11px] text-slate-500 block">
                    Current: {formatCategoryLabel(complaintCategory)}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block">
                    Suggested Priority
                  </span>
                  <div>
                    <PriorityBadge priority={latest.suggested_priority} size="sm" />
                  </div>
                  <span className="text-[11px] text-slate-500 block capitalize">
                    Current: {complaintPriority || 'normal'}
                  </span>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block">
                    Confidence Score
                  </span>
                  <span className="font-mono text-sm font-bold text-slate-900 block">
                    {typeof latest.confidence === 'number'
                      ? `${Math.round(latest.confidence * 100)}% (${latest.confidence.toFixed(2)})`
                      : 'N/A'}
                  </span>
                  <span className="text-[11px] text-slate-500 block font-mono">
                    {latest.model_name}
                  </span>
                </div>
              </div>

              {latest.admin_decision === 'pending' ? (
                <div className="space-y-3">
                  {isTerminal && (
                    <div className="p-2.5 rounded-xl bg-slate-100 border border-slate-200 text-slate-600 text-[11px]">
                      Accept and Override are disabled because this complaint is in a terminal state ({complaintStatus.replace(/_/g, ' ')}).
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAccept}
                      disabled={submitting || isTerminal}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Accept
                    </button>

                    <button
                      type="button"
                      onClick={() => setOverrideOpen((prev) => !prev)}
                      disabled={submitting || isTerminal}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      Override
                    </button>

                    <button
                      type="button"
                      onClick={handleIgnore}
                      disabled={submitting}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold disabled:opacity-50 transition"
                    >
                      <EyeOff className="w-3.5 h-3.5" />
                      Ignore
                    </button>
                  </div>

                  {overrideOpen && (
                    <form
                      onSubmit={handleOverrideSubmit}
                      className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3"
                    >
                      <p className="font-bold text-slate-800">
                        Override with Admin Classification
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label
                            htmlFor="ai-override-category"
                            className="block font-semibold text-slate-700 mb-1"
                          >
                            Final Category
                          </label>
                          <select
                            id="ai-override-category"
                            value={overrideCategory}
                            onChange={(e) => setOverrideCategory(e.target.value)}
                            className="w-full py-2 px-3 bg-white border border-slate-200 rounded-xl text-slate-900 font-medium"
                          >
                            {VALID_CIVIC_CATEGORIES.map((cat) => (
                              <option key={cat} value={cat}>
                                {formatCategoryLabel(cat)}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label
                            htmlFor="ai-override-priority"
                            className="block font-semibold text-slate-700 mb-1"
                          >
                            Final Priority
                          </label>
                          <select
                            id="ai-override-priority"
                            value={overridePriority}
                            onChange={(e) => setOverridePriority(e.target.value)}
                            className="w-full py-2 px-3 bg-white border border-slate-200 rounded-xl text-slate-900 font-medium"
                          >
                            {PRIORITY_OPTIONS.map((p) => (
                              <option key={p.value} value={p.value}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setOverrideOpen(false)}
                          disabled={submitting}
                          className="px-3 py-1.5 rounded-lg bg-slate-200 text-slate-700 font-semibold"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={submitting}
                          className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50"
                        >
                          {submitting ? 'Saving...' : 'Save Override'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span className="font-bold capitalize">
                      Outcome: {latest.admin_decision}
                    </span>
                    {latest.admin_decision !== 'ignored' && (
                      <span>
                        — Final: {formatCategoryLabel(latest.final_category)} /{' '}
                        <span className="capitalize font-semibold">{latest.final_priority}</span>
                      </span>
                    )}
                  </div>
                  {latest.decided_at && (
                    <span className="text-[11px] font-mono text-emerald-700">
                      {formatDateTime(latest.decided_at)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {latest && (
            <div className="text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100">
              <span>Recorded: {formatDateTime(latest.created_at)}</span>
              <span>Prompt: {latest.prompt_version}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
