import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  History,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  fetchCitizenResolutionVerification,
  submitCitizenDisputeResolution,
  submitCitizenVerifyResolution,
} from '../../services/slaApiService';
import { formatDateTime } from '../../utils/formatters';

export default function CitizenResolutionVerificationPanel({
  complaintId,
  complaintStatus,
  beforeImageUrl = null,
  afterImageUrl = null,
  onDecisionSubmitted = null,
  api = null,
}) {
  const fetchStatusFn = api?.fetchStatus || fetchCitizenResolutionVerification;
  const verifyFn = api?.verify || submitCitizenVerifyResolution;
  const disputeFn = api?.dispute || submitCitizenDisputeResolution;

  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [actionNotice, setActionNotice] = useState(null);
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [disputeReason, setDisputeReason] = useState('');

  const loadVerification = useCallback(async () => {
    if (!complaintId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchStatusFn(complaintId);
      setState(res);
    } catch (err) {
      setLoadError(err?.message || 'Unable to load resolution verification state.');
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [complaintId, fetchStatusFn]);

  useEffect(() => {
    loadVerification();
  }, [loadVerification, complaintStatus]);

  const handleVerify = async () => {
    if (submitting || !state?.can_verify) return;
    setSubmitting(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await verifyFn(complaintId, {
        evidence_id: state.latest_evidence_id || undefined,
      });
      setShowDisputeForm(false);
      setDisputeReason('');
      setActionNotice('Thank you. Your verification has been recorded.');
      await loadVerification();
      if (typeof onDecisionSubmitted === 'function') {
        await onDecisionSubmitted('verified');
      }
    } catch (err) {
      setActionError(err?.message || 'Unable to record your verification right now.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisputeSubmit = async (e) => {
    e.preventDefault();
    if (submitting || !state?.can_verify) return;
    const trimmed = disputeReason.trim();
    if (!trimmed) {
      setActionError('Please describe why the issue is not resolved before disputing.');
      return;
    }
    if (trimmed.length > 1000) {
      setActionError('Dispute reason must not exceed 1000 characters.');
      return;
    }

    setSubmitting(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await disputeFn(complaintId, {
        evidence_id: state.latest_evidence_id || undefined,
        reason: trimmed,
      });
      setShowDisputeForm(false);
      setDisputeReason('');
      setActionNotice(
        res?.message ||
          (res?.escalated_to_admin
            ? 'Maximum automatic reopens reached. An administrator will review your dispute.'
            : 'Resolution disputed. The complaint has been reopened and escalated for action.')
      );
      await loadVerification();
      if (typeof onDecisionSubmitted === 'function') {
        await onDecisionSubmitted(res?.escalated_to_admin ? 'escalated_to_admin' : 'disputed');
      }
    } catch (err) {
      setActionError(err?.message || 'Unable to submit dispute right now.');
    } finally {
      setSubmitting(false);
    }
  };

  const history = Array.isArray(state?.history) ? state.history : [];
  const isResolved = (state?.complaint_status || complaintStatus) === 'resolved';

  if (!loading && !loadError && !isResolved && history.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Resolution Verification"
      className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-xs space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
        <div>
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-teal-600" />
            Citizen Resolution Verification
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Compare the before and after photographs and confirm whether the issue was resolved.
          </p>
        </div>
      </div>

      {isResolved && (beforeImageUrl || afterImageUrl) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
          <div className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50">
            <div className="px-3 py-2 bg-slate-100 border-b border-slate-200 font-semibold text-slate-700">
              Before (Submitted Photo)
            </div>
            {beforeImageUrl ? (
              <img
                src={beforeImageUrl}
                alt="Before resolution"
                className="w-full h-44 object-cover"
              />
            ) : (
              <div className="h-44 flex items-center justify-center text-slate-400">
                No original photo attached
              </div>
            )}
          </div>
          <div className="rounded-xl border border-emerald-200 overflow-hidden bg-emerald-50/30">
            <div className="px-3 py-2 bg-emerald-100/70 border-b border-emerald-200 font-semibold text-emerald-900">
              After (Completion Photo)
            </div>
            {afterImageUrl ? (
              <img
                src={afterImageUrl}
                alt="After completion"
                className="w-full h-44 object-cover"
              />
            ) : (
              <div className="h-44 flex items-center justify-center text-slate-400">
                No completion photo available
              </div>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div role="status" className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-teal-600" />
          <span>Loading verification status...</span>
        </div>
      ) : loadError ? (
        <div role="alert" className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{loadError}</span>
          </div>
          <button
            type="button"
            onClick={loadVerification}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {actionNotice && (
            <div role="status" className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{actionNotice}</span>
            </div>
          )}

          {actionError && (
            <div role="alert" className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{actionError}</span>
            </div>
          )}

          {state?.current_decision && (
            <div
              className={`p-4 rounded-xl border text-xs space-y-1 ${
                state.current_decision.decision === 'verified'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-amber-50 border-amber-200 text-amber-900'
              }`}
            >
              <div className="font-bold flex items-center gap-1.5">
                {state.current_decision.decision === 'verified' ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    Your Decision: Verified Fixed
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4 text-amber-700" />
                    Your Decision: Disputed
                  </>
                )}
              </div>
              {state.current_decision.reason && (
                <p className="text-slate-700">{state.current_decision.reason}</p>
              )}
              <p className="text-[11px] opacity-80">
                Recorded {formatDateTime(state.current_decision.created_at)}
              </p>
            </div>
          )}

          {state?.can_verify && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleVerify}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-50 transition"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {submitting ? 'Submitting...' : 'Verify Resolution'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActionError(null);
                    setShowDisputeForm((prev) => !prev);
                  }}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-bold disabled:opacity-50 transition"
                >
                  <XCircle className="w-4 h-4" />
                  Dispute Resolution
                </button>
              </div>

              {showDisputeForm && (
                <form onSubmit={handleDisputeSubmit} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3 text-xs">
                  <label htmlFor="citizen-dispute-reason" className="block font-semibold text-slate-800">
                    Reason for Dispute (Required) *
                  </label>
                  <textarea
                    id="citizen-dispute-reason"
                    rows={3}
                    maxLength={1000}
                    value={disputeReason}
                    onChange={(e) => setDisputeReason(e.target.value)}
                    disabled={submitting}
                    placeholder="Explain what remains unresolved at the site..."
                    className="w-full p-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-500">
                      {disputeReason.trim().length}/1000 characters
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setShowDisputeForm(false)}
                        disabled={submitting}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-50"
                      >
                        {submitting ? 'Reopening...' : 'Submit Dispute & Reopen'}
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          )}

          {history.length > 0 && (
            <div className="pt-3 border-t border-slate-100 space-y-2 text-xs">
              <h3 className="font-bold text-slate-700 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-teal-600" />
                Your Verification History
              </h3>
              <ul className="space-y-2">
                {history.map((item) => (
                  <li
                    key={item.id}
                    className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                  >
                    <div className="space-y-0.5">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                          item.decision === 'verified'
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            : 'bg-rose-50 text-rose-800 border-rose-200'
                        }`}
                      >
                        {item.decision === 'verified' ? 'Verified' : 'Disputed'}
                      </span>
                      {item.reason && (
                        <p className="text-slate-700 mt-1">{item.reason}</p>
                      )}
                    </div>
                    <span className="text-[11px] font-mono text-slate-500 shrink-0">
                      {formatDateTime(item.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
