import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  History,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { fetchAdminComplaintVerifications } from '../../services/slaApiService';
import { formatDateTime } from '../../utils/formatters';

export default function AdminVerificationHistoryPanel({
  complaintId,
  complaintStatus,
  isAdmin,
  api = null,
}) {
  const fetchFn = api?.fetchVerifications || fetchAdminComplaintVerifications;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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
  const latestDecision = data?.latest_decision || null;

  return (
    <section
      aria-label="Citizen Verification History"
      className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4 text-xs"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-teal-600 shrink-0" />
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
            Citizen Verification History
          </h2>
        </div>

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

      {loading ? (
        <div role="status" className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-teal-600" />
          <span>Loading citizen verification history...</span>
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
      ) : history.length === 0 ? (
        <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 text-slate-500 flex items-center gap-2">
          <History className="w-4 h-4 text-slate-400 shrink-0" />
          <span>No citizen verification or dispute decisions have been submitted yet.</span>
        </div>
      ) : (
        <ul className="space-y-2.5">
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
      )}
    </section>
  );
}
