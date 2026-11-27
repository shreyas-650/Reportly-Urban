import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import {
  confirmAdminComplaintScreening,
  dismissAdminComplaintScreening,
  fetchAdminComplaintScreening,
  keepAdminScreeningAdvancement,
  revertAdminScreeningAdvancement,
} from '../../services/slaApiService';
import { formatDateTime } from '../../utils/formatters';

const REASON_LABELS = {
  duplicate_spam: 'Repeated near-identical submission',
  no_evidence: 'Missing or reused image evidence',
  gibberish: 'Incoherent / low-signal text',
  rate_abuse: 'Elevated submission frequency',
  needs_clarification: 'Needs more information / clarification',
};

const OPERATIONAL_LABELS = {
  duplicate_suspected: 'Duplicate gate hold (suspected link)',
  duplicate_confirmed: 'Duplicate gate hold (confirmed link)',
  duplicate_missing: 'Duplicate check unavailable (fail-closed)',
  outside_service_area: 'Outside service boundary',
  low_confidence: 'Confidence below advance threshold',
  insufficient_metrics: 'Accuracy metrics insufficient/stale',
  error: 'Screening encountered an operational error',
};

const RISK_STYLES = {
  low: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  medium: 'bg-amber-50 text-amber-800 border-amber-200',
  high: 'bg-rose-50 text-rose-800 border-rose-200',
};

export default function AdminScreeningPanel({
  complaintId,
  complaintStatus,
  isAdmin,
  onScreeningUpdated = null,
  onDataLoaded = null,
  api = null,
}) {
  const fetchFn = api?.fetchScreening || fetchAdminComplaintScreening;
  const dismissFn = api?.dismissScreening || dismissAdminComplaintScreening;
  const confirmFn = api?.confirmScreening || confirmAdminComplaintScreening;
  const keepFn = api?.keepAdvancement || keepAdminScreeningAdvancement;
  const revertFn = api?.revertAdvancement || revertAdminScreeningAdvancement;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertReason, setRevertReason] = useState('');

  const loadScreening = useCallback(async () => {
    if (!isAdmin || !complaintId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchFn(complaintId);
      setData(res);
      if (typeof onDataLoaded === 'function') {
        onDataLoaded(res);
      }
    } catch (err) {
      setLoadError(err?.message || 'Unable to load screening details.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, complaintId, fetchFn, onDataLoaded]);

  useEffect(() => {
    loadScreening();
  }, [loadScreening]);

  // Strictly admin-only (citizens and officers see nothing)
  if (!isAdmin) {
    return null;
  }

  const review = data?.review || null;
  const mode = review?.mode || data?.screening_mode || 'shadow';
  const isShadow = mode === 'shadow';
  const reasonCodes = Array.isArray(review?.reason_codes) ? review.reason_codes : [];
  const operationalFlags = Array.isArray(review?.operational_flags) ? review.operational_flags : [];

  const handleAction = async (actionType) => {
    if (!complaintId || submitting) return;
    setActionError(null);

    if (actionType === 'revert' && revertReason.trim().length < 5) {
      setActionError('Please enter a brief revert reason (at least 5 characters).');
      return;
    }

    setSubmitting(true);
    try {
      if (actionType === 'dismiss') {
        await dismissFn(complaintId);
      } else if (actionType === 'confirm') {
        await confirmFn(complaintId);
      } else if (actionType === 'keep') {
        await keepFn(complaintId);
      } else if (actionType === 'revert') {
        await revertFn(complaintId, revertReason.trim());
        setRevertOpen(false);
        setRevertReason('');
      }
      await loadScreening();
      if (typeof onScreeningUpdated === 'function') {
        await onScreeningUpdated();
      }
    } catch (err) {
      setActionError(err?.message || 'Failed to update screening decision.');
    } finally {
      setSubmitting(false);
    }
  };

  const canReviewFlag =
    review &&
    (review.review_status === 'needs_review' || review.review_status === 'priority_review');
  const canEvaluateAdvancement =
    review &&
    review.applied_advance === true &&
    complaintStatus === 'under_review' &&
    review.advancement_outcome === 'pending_review';

  return (
    <section
      aria-label="AI claim screening"
      className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-blue-600 shrink-0" />
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
            AI Screening & Workflow
          </h2>
          {isShadow && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-300">
              Shadow
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={loadScreening}
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
          {isShadow
            ? 'Shadow screening records advisory flags and workflow predictions without altering complaint status or blocking department/officer routing.'
            : 'Active screening advances verified low-risk complaints to Under Review and routes flagged reports to this queue. It never auto-rejects complaints.'}
        </span>
      </div>

      {loading && !data ? (
        <div role="status" className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
          <span>Loading screening record...</span>
        </div>
      ) : loadError ? (
        <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      ) : !review ? (
        <div className="p-4 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-slate-500 text-center">
          No screening evaluation recorded for this complaint yet.
        </div>
      ) : (
        <div className="space-y-3">
          {actionError && (
            <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{actionError}</span>
            </div>
          )}

          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border capitalize ${
                    RISK_STYLES[review.risk_level] || RISK_STYLES.medium
                  }`}
                >
                  {review.risk_level} risk
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white border border-slate-200 text-slate-700">
                  {Math.round(Number(review.confidence || 0) * 100)}% confidence
                </span>
                {review.would_advance && !review.applied_advance && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                    Would advance (Shadow/Gated)
                  </span>
                )}
              </div>

              {review.decided_at && (
                <span className="text-[11px] font-mono text-slate-400">
                  Reviewed: {formatDateTime(review.decided_at)}
                </span>
              )}
            </div>

            {reasonCodes.length > 0 && (
              <div className="space-y-1">
                <p className="font-semibold text-slate-700">Screening Signals:</p>
                <div className="flex flex-wrap gap-1.5">
                  {reasonCodes.map((code) => (
                    <span
                      key={code}
                      className="px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-900 font-medium"
                    >
                      {REASON_LABELS[code] || code}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {operationalFlags.length > 0 && (
              <div className="space-y-1">
                <p className="font-semibold text-slate-700">Operational Gate Checks:</p>
                <div className="flex flex-wrap gap-1.5">
                  {operationalFlags.map((flag) => (
                    <span
                      key={flag}
                      className="px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-slate-700 font-medium"
                    >
                      {OPERATIONAL_LABELS[flag] || flag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {canReviewFlag && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => handleAction('dismiss')}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50 transition"
                >
                  <Check className="w-3.5 h-3.5" />
                  Dismiss Flag (Clear)
                </button>
                <button
                  type="button"
                  onClick={() => handleAction('confirm')}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-50 transition"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Confirm Suspicious
                </button>
              </div>
            )}

            {canEvaluateAdvancement && (
              <div className="space-y-2 pt-2 border-t border-slate-200">
                <p className="font-semibold text-slate-700">
                  AI auto-advanced this complaint from Submitted to Under Review.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleAction('keep')}
                    disabled={submitting}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold disabled:opacity-50 transition"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Confirm Advancement Kept
                  </button>
                  <button
                    type="button"
                    onClick={() => setRevertOpen((v) => !v)}
                    disabled={submitting}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 font-semibold border border-amber-300 disabled:opacity-50 transition"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Revert / Flag Advancement
                  </button>
                </div>
                {revertOpen && (
                  <div className="space-y-2 p-3 rounded-lg bg-white border border-slate-200">
                    <label htmlFor="screening-revert-reason" className="block font-semibold text-slate-700">
                      Revert Reason (minimum 5 chars; logged as override without rolling status backward)
                    </label>
                    <input
                      id="screening-revert-reason"
                      type="text"
                      value={revertReason}
                      onChange={(e) => setRevertReason(e.target.value)}
                      placeholder="Explain why AI advancement should be flagged/reverted..."
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => handleAction('revert')}
                      disabled={submitting}
                      className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-50"
                    >
                      Submit Revert Decision
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
