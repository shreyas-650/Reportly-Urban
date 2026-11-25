import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Info,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import {
  fetchAdminAiResolutionCheck,
  rerunAdminAiResolutionCheck,
} from '../../services/slaApiService';
import { formatDateTime } from '../../utils/formatters';

const VERDICT_META = {
  appears_fixed: {
    label: 'Appears fixed (visual changes look consistent with the issue being addressed)',
    badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    Icon: CheckCircle2,
  },
  appears_not_fixed: {
    label: 'Does not appear fixed (visible evidence looks inconsistent with repair)',
    badgeClass: 'bg-rose-50 text-rose-800 border-rose-200',
    Icon: AlertTriangle,
  },
  unclear: {
    label: 'Unclear (different angles, poor lighting, blur, or insufficient visual evidence)',
    badgeClass: 'bg-amber-50 text-amber-800 border-amber-200',
    Icon: HelpCircle,
  },
};

function classifyErrorState(err) {
  if (!err) return 'unavailable';
  if (err.isTimeout || err.name === 'AbortError' || err.status === undefined) {
    return 'network_error';
  }
  return 'unavailable';
}

export default function AdminAiResolutionPanel({
  complaintId,
  complaintStatus,
  isAdmin,
  api = null,
}) {
  const fetchFn = api?.fetchCheck || fetchAdminAiResolutionCheck;
  const rerunFn = api?.rerunCheck || rerunAdminAiResolutionCheck;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [loadErrorKind, setLoadErrorKind] = useState(null); // 'network_error' | 'unavailable' | null
  const [errorMessage, setErrorMessage] = useState(null);
  const rerunLockRef = useRef(false);

  const loadCheck = useCallback(async () => {
    if (!isAdmin || !complaintId || complaintStatus !== 'resolved') return;
    setLoading(true);
    setLoadErrorKind(null);
    setErrorMessage(null);
    try {
      const res = await fetchFn(complaintId);
      setData(res);
    } catch (err) {
      setLoadErrorKind(classifyErrorState(err));
      setErrorMessage(err?.message || 'Unable to load AI comparison results.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, complaintId, complaintStatus, fetchFn]);

  useEffect(() => {
    loadCheck();
  }, [loadCheck]);

  // Never render for non-admins (frontend defense-in-depth alongside backend require_admin)
  if (!isAdmin) {
    return null;
  }

  const handleRerun = async () => {
    if (
      rerunLockRef.current ||
      rerunning ||
      !data?.feature_enabled ||
      complaintStatus !== 'resolved' ||
      data?.latest?.status === 'pending'
    ) {
      return;
    }

    rerunLockRef.current = true;
    setRerunning(true);
    setErrorMessage(null);
    setLoadErrorKind(null);
    try {
      await rerunFn(complaintId);
      // Reload explicitly from server so no stale cached result is treated as latest
      const refreshed = await fetchFn(complaintId);
      setData(refreshed);
    } catch (err) {
      setLoadErrorKind(classifyErrorState(err));
      setErrorMessage(err?.message || 'AI comparison re-run could not be completed.');
    } finally {
      rerunLockRef.current = false;
      setRerunning(false);
    }
  };

  const featureEnabled = Boolean(data?.feature_enabled);
  const latest = data?.latest || null;
  const isResolved = complaintStatus === 'resolved';
  const rerunDisabled =
    !isResolved || !featureEnabled || loading || rerunning || latest?.status === 'pending';

  const verdictInfo = latest?.verdict ? VERDICT_META[latest.verdict] || VERDICT_META.unclear : null;

  return (
    <section
      aria-label="AI before/after comparison (suggestion only)"
      className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4 text-xs"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-teal-600 shrink-0" />
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
            AI before/after comparison (suggestion only)
          </h2>
        </div>

        <button
          type="button"
          onClick={handleRerun}
          disabled={rerunDisabled}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${rerunning ? 'animate-spin' : ''}`} />
          {rerunning ? 'Running Comparison...' : 'Re-run AI Comparison'}
        </button>
      </div>

      {/* Permanent Mandatory Advisory Disclaimer */}
      <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 flex items-start gap-2">
        <Info className="w-4 h-4 text-teal-600 shrink-0 mt-0.5" />
        <span className="font-semibold">
          {data?.advisory_notice ||
            'This is an AI suggestion. It does not confirm that the work is complete.'}
        </span>
      </div>

      {!isResolved ? (
        <p className="text-slate-500">
          AI before-and-after comparison is available only after this complaint is marked resolved with a verified completion photo.
        </p>
      ) : loading && !data ? (
        <div role="status" className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-teal-600" />
          <span>Loading advisory comparison state...</span>
        </div>
      ) : (
        <div className="space-y-3">
          {!featureEnabled && (
            <div role="status" className="p-3 rounded-xl bg-slate-100 border border-slate-200 text-slate-700">
              AI before-and-after comparison is currently turned off (feature disabled). Re-run is disabled.
            </div>
          )}

          {loadErrorKind === 'network_error' && (
            <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">Network error reaching AI comparison service</p>
                <p>{errorMessage}</p>
              </div>
            </div>
          )}

          {loadErrorKind === 'unavailable' && (
            <div role="alert" className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">AI comparison service unavailable</p>
                <p>{errorMessage}</p>
              </div>
            </div>
          )}

          {!latest && !loadErrorKind && featureEnabled && (
            <p className="text-slate-500">
              No AI comparison has been recorded for this resolution yet. You can trigger one using Re-run AI Comparison.
            </p>
          )}

          {latest?.status === 'pending' && (
            <div role="status" className="p-3 rounded-xl bg-teal-50 border border-teal-200 text-teal-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-600 shrink-0" />
              <span>AI comparison is currently pending in background processing.</span>
            </div>
          )}

          {latest?.status === 'failed' && (
            <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 space-y-1">
              <p className="font-bold flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 shrink-0" />
                Comparison Attempt Failed
              </p>
              <p>
                Reason code:{' '}
                <span className="font-mono font-semibold">{latest.failure_category || 'unavailable'}</span>
              </p>
            </div>
          )}

          {latest?.status === 'completed' && verdictInfo && (
            <div className="space-y-3">
              <div className={`p-3 rounded-xl border flex items-start gap-2 ${verdictInfo.badgeClass}`}>
                <verdictInfo.Icon className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block">Suggested Verdict:</span>
                  <span>{verdictInfo.label}</span>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="font-bold text-slate-700 block">Visual Summary (Plain Text):</span>
                <p className="text-slate-800 leading-relaxed">{latest.summary || 'No summary provided.'}</p>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-700">Estimated Confidence</span>
                  <span className="font-mono font-bold text-slate-900">
                    {typeof latest.confidence === 'number'
                      ? `${Math.round(latest.confidence * 100)}% (${latest.confidence.toFixed(2)})`
                      : 'N/A'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500">
                  {data?.confidence_note || 'Model-estimated visual confidence, not proof the work is complete'}
                </p>
              </div>
            </div>
          )}

          {latest && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-slate-100 text-[11px] text-slate-600">
              <div>
                <span className="font-semibold text-slate-500">Model &amp; Prompt:</span>{' '}
                <span className="font-mono">{latest.model_name}</span> /{' '}
                <span className="font-mono">{latest.prompt_version}</span>
              </div>
              <div>
                <span className="font-semibold text-slate-500">Attempt Source:</span>{' '}
                <span>
                  {latest.trigger_source === 'manual' || latest.triggered_by_admin
                    ? 'Manual re-run by Admin'
                    : 'Automatic post-resolution check'}
                </span>
              </div>
              <div className="sm:col-span-2">
                <span className="font-semibold text-slate-500">Timestamp:</span>{' '}
                <span className="font-mono">
                  {formatDateTime(latest.completed_at || latest.created_at)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
