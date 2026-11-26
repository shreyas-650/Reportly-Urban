import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Info,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import {
  confirmAdminDuplicateLink,
  dismissAdminDuplicateLink,
  fetchAdminComplaintDuplicates,
} from '../../services/slaApiService';
import StatusBadge from '../common/StatusBadge';
import { formatDateTime } from '../../utils/formatters';

export default function AdminDuplicateLinksPanel({
  complaintId,
  isAdmin,
  api = null,
}) {
  const fetchFn = api?.fetchDuplicates || fetchAdminComplaintDuplicates;
  const confirmFn = api?.confirmDuplicate || confirmAdminDuplicateLink;
  const dismissFn = api?.dismissDuplicate || dismissAdminDuplicateLink;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submittingId, setSubmittingId] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const loadDuplicates = useCallback(async () => {
    if (!isAdmin || !complaintId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchFn(complaintId);
      setData(res);
    } catch (err) {
      setLoadError(err?.message || 'Unable to load possible duplicates.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, complaintId, fetchFn]);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  // Strictly admin-only (citizens and officers see nothing)
  if (!isAdmin) {
    return null;
  }

  const featureEnabled = Boolean(data?.feature_enabled);
  const items = Array.isArray(data?.items) ? data.items : [];

  const handleDecision = async (linkId, action) => {
    if (!linkId || submittingId) return;
    setSubmittingId(linkId);
    setActionError(null);
    try {
      if (action === 'confirm') {
        await confirmFn(linkId);
      } else {
        await dismissFn(linkId);
      }
      await loadDuplicates();
    } catch (err) {
      setActionError(err?.message || 'Failed to update duplicate link review.');
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <section
      aria-label="Possible duplicates"
      className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <Copy className="w-4 h-4 text-blue-600 shrink-0" />
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
            Possible duplicates
          </h2>
          {items.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
              {items.length} linked
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={loadDuplicates}
          disabled={loading || Boolean(submittingId)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold disabled:opacity-50 transition"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 flex items-start gap-2">
        <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
        <span>
          Suspected duplicates are flagged and linked for review only. Confirming records the link and never closes, merges, or hides either complaint.
        </span>
      </div>

      {loading && !data ? (
        <div role="status" className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
          <span>Loading possible duplicates...</span>
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
              AI is off. Rule-based nearby candidate checks still run without Gemini.
            </div>
          )}

          {actionError && (
            <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{actionError}</span>
            </div>
          )}

          {items.length === 0 ? (
            <div className="p-4 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-slate-500 text-center">
              No possible duplicate links found for this complaint.
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((link) => {
                const isBusy = submittingId === link.id;
                const scorePct = Math.round(Number(link.similarity_score || 0) * 100);
                return (
                  <div
                    key={link.id}
                    className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to={`/admin/complaints/${link.linked_complaint_id}`}
                          className="font-mono font-bold text-blue-700 hover:underline inline-flex items-center gap-1"
                        >
                          {link.linked_complaint_number}
                          <ExternalLink className="w-3 h-3" />
                        </Link>
                        <StatusBadge status={link.linked_status} size="sm" />
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white border border-slate-200 text-slate-700">
                          {scorePct}% similarity ({link.method === 'ai' ? 'AI' : 'Rule'})
                        </span>
                      </div>

                      {link.status === 'confirmed_duplicate' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                          <CheckCircle2 className="w-3 h-3" /> Confirmed Duplicate
                        </span>
                      )}
                      {link.status === 'not_duplicate' && (
                        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-700 border border-slate-300">
                          <XCircle className="w-3 h-3" /> Not a duplicate
                        </span>
                      )}
                      {link.status === 'suspected' && (
                        <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                          Suspected
                        </span>
                      )}
                    </div>

                    <div>
                      <p className="font-bold text-slate-900">{link.linked_title}</p>
                      <p className="text-[11px] text-slate-500">
                        Ward: {link.linked_ward} · Logged {formatDateTime(link.linked_created_at)}
                      </p>
                    </div>

                    <p className="text-slate-700 bg-white p-2.5 rounded-lg border border-slate-200/80">
                      <span className="font-semibold text-slate-600">Reason: </span>
                      {link.reason}
                    </p>

                    {link.status === 'suspected' ? (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => handleDecision(link.id, 'confirm')}
                          disabled={Boolean(submittingId)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50 transition"
                        >
                          <Check className="w-3.5 h-3.5" />
                          {isBusy ? 'Saving...' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDecision(link.id, 'dismiss')}
                          disabled={Boolean(submittingId)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold disabled:opacity-50 transition"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Not a duplicate
                        </button>
                      </div>
                    ) : link.decided_at ? (
                      <p className="text-[11px] font-mono text-slate-400">
                        Reviewed: {formatDateTime(link.decided_at)}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
