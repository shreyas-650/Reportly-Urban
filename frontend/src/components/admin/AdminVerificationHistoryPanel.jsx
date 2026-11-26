import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  History,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  fetchAdminComplaintVerifications,
  submitAdminDisputeDecision,
} from '../../services/slaApiService';
import { formatDateTime } from '../../utils/formatters';

const DISPUTE_STATE_LABELS = {
  open_dispute: 'Open Dispute',
  reopened: 'Reopened',
  escalated_to_admin: 'Escalated to Admin',
  admin_resolved: 'Admin Reviewed',
  closed_unconfirmed: 'Closed (Not Confirmed)',
};

const EVENT_TYPE_LABELS = {
  ai_suggestion: 'AI Suggestion (Advisory)',
  citizen_verified: 'Citizen Confirmed',
  citizen_disputed: 'Citizen Disputed',
  auto_closed_unconfirmed: 'Auto-Closed (Non-Response)',
  admin_decision: 'Admin Decision',
};

export default function AdminVerificationHistoryPanel({
  complaintId,
  complaintStatus,
  isAdmin,
  onDisputeDecided = null,
  api = null,
}) {
  const fetchFn = api?.fetchVerifications || fetchAdminComplaintVerifications;
  const decideFn = api?.decideDispute || submitAdminDisputeDecision;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [decisionAction, setDecisionAction] = useState('reopen');
  const [decisionNote, setDecisionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState(null);
  const [decisionNotice, setDecisionNotice] = useState(null);

  const loadHistory = useCallback(async () => {
    if (!isAdmin || !complaintId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFn(complaintId);
      setData(res);
    } catch (err) {
      setError(err?.message || 'Unable to load citizen verification history.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, complaintId, fetchFn]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory, complaintStatus]);

  if (!isAdmin) {
    return null;
  }

  const history = Array.isArray(data?.history) ? data.history : [];
  const events = Array.isArray(data?.events) ? data.events : [];
  const latestDecision = data?.latest_decision || null;
  const disputeState = data?.dispute_state || null;
  const canAdminDecide = Boolean(
    disputeState && ['open_dispute', 'reopened', 'escalated_to_admin'].includes(disputeState)
  );

  const handleAdminDecisionSubmit = async (e) => {
    e.preventDefault();
    if (submitting || !canAdminDecide) return;
    const trimmed = decisionNote.trim();
    if (trimmed.length < 5) {
      setDecisionError('Please enter an administrative review note (at least 5 characters).');
      return;
    }
    setSubmitting(true);
    setDecisionError(null);
    setDecisionNotice(null);
    try {
      await decideFn(complaintId, { action: decisionAction, note: trimmed });
      setDecisionNote('');
      setDecisionNotice('Administrative dispute decision recorded.');
      await loadHistory();
      if (typeof onDisputeDecided === 'function') {
        await onDisputeDecided();
      }
    } catch (err) {
      setDecisionError(err?.message || 'Unable to record administrative dispute decision.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      aria-label="Citizen Verification History"
      className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4 text-xs"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-teal-600 shrink-0" />
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
            Verification &amp; Dispute History
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {disputeState && (
            <span className="inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-800 border border-slate-300">
              {DISPUTE_STATE_LABELS[disputeState] || disputeState}
              {typeof data?.reopen_count === 'number' ? ` • Reopens: ${data.reopen_count}` : ''}
            </span>
          )}
          {latestDecision ? (
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${
                latestDecision === 'verified'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-rose-50 text-rose-800 border-rose-200'
              }`}
            >
              {latestDecision === 'verified' ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" /> Latest: Verified
                </>
              ) : (
                <>
                  <XCircle className="w-3.5 h-3.5" /> Latest: Disputed
                </>
              )}
            </span>
          ) : (
            <span className="text-[11px] font-semibold text-slate-400">
              No citizen decision yet
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div role="status" className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-teal-600" />
          <span>Loading verification history...</span>
        </div>
      ) : error ? (
        <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={loadHistory}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {decisionNotice && (
            <div role="status" className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 font-semibold">
              {decisionNotice}
            </div>
          )}

          {history.length === 0 && events.length === 0 ? (
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 text-slate-500 flex items-center gap-2">
              <History className="w-4 h-4 text-slate-400 shrink-0" />
              <span>No verification or dispute checks have been recorded yet.</span>
            </div>
          ) : null}

          {history.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Citizen Decisions
              </h3>
              <ul className="space-y-2">
                {history.map((item) => (
                  <li
                    key={item.id}
                    className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                            item.decision === 'verified'
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                              : 'bg-rose-50 text-rose-800 border-rose-200'
                          }`}
                        >
                          {item.decision === 'verified' ? 'Verified' : 'Disputed'}
                        </span>
                        <span className="font-semibold text-slate-900">
                          {item.citizen_display_name || 'Reporting Citizen'}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-500">
                        {formatDateTime(item.created_at)}
                      </span>
                    </div>
                    {item.reason && (
                      <p className="text-slate-700 bg-white p-2.5 rounded-lg border border-slate-200/80 leading-relaxed">
                        {item.reason}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {events.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-slate-100">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Full Verification Audit Log
              </h3>
              <ul className="space-y-2">
                {events.map((ev) => (
                  <li
                    key={ev.id}
                    className="p-3 rounded-xl bg-white border border-slate-200 space-y-1"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-800 font-bold text-[11px]">
                          {EVENT_TYPE_LABELS[ev.event_type] || ev.event_type}
                        </span>
                        <span className="text-slate-600">
                          Actor: <strong className="capitalize">{ev.actor_type}</strong> ({ev.actor_display_name})
                        </span>
                        <span className="font-mono text-[11px] text-teal-800 bg-teal-50 px-1.5 py-0.5 rounded border border-teal-200">
                          {ev.result}
                        </span>
                      </div>
                      <span className="text-[11px] font-mono text-slate-500">
                        {formatDateTime(ev.created_at)}
                      </span>
                    </div>
                    {ev.details && <p className="text-slate-700">{ev.details}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canAdminDecide && (
            <form
              onSubmit={handleAdminDecisionSubmit}
              className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3 pt-3"
            >
              <h3 className="text-xs font-bold text-slate-900">
                Administrative Dispute Review
              </h3>
              {decisionError && (
                <p role="alert" className="text-rose-700 font-semibold">
                  {decisionError}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="admin-dispute-action" className="block font-semibold text-slate-700 mb-1">
                    Decision Action
                  </label>
                  <select
                    id="admin-dispute-action"
                    value={decisionAction}
                    onChange={(e) => setDecisionAction(e.target.value)}
                    disabled={submitting}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-900"
                  >
                    <option value="reopen">Reopen &amp; Restart SLA</option>
                    <option value="keep_resolved">Uphold Resolution</option>
                    <option value="close_unconfirmed">Close (Not Confirmed by Citizen)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="admin-dispute-note" className="block font-semibold text-slate-700 mb-1">
                    Admin Review Note *
                  </label>
                  <input
                    id="admin-dispute-note"
                    type="text"
                    maxLength={1000}
                    value={decisionNote}
                    onChange={(e) => setDecisionNote(e.target.value)}
                    disabled={submitting}
                    placeholder="Record reason for admin decision..."
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-slate-900"
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold disabled:opacity-50"
              >
                {submitting ? 'Saving Decision...' : 'Record Admin Decision'}
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
