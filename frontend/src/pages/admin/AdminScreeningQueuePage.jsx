import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Inbox,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import {
  confirmAdminComplaintScreening,
  dismissAdminComplaintScreening,
  fetchAdminScreeningQueue,
} from '../../services/slaApiService';
import StatusBadge from '../../components/common/StatusBadge';
import { formatDateTime } from '../../utils/formatters';

export default function AdminScreeningQueuePage({ api = null }) {
  const fetchQueueFn = api?.fetchQueue || fetchAdminScreeningQueue;
  const dismissFn = api?.dismissScreening || dismissAdminComplaintScreening;
  const confirmFn = api?.confirmScreening || confirmAdminComplaintScreening;

  const [screeningMode, setScreeningMode] = useState('shadow');
  const [items, setItems] = useState([]);
  const [statusFilter, setStatusFilter] = useState('needs_review');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState(null);
  const [error, setError] = useState(null);
  const requestSeqRef = useRef(0);

  const loadQueue = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchQueueFn({
        status: statusFilter,
        page,
        page_size: 20,
      });
      if (seq !== requestSeqRef.current) return;
      setScreeningMode(String(res?.screening_mode || 'shadow'));
      setItems(Array.isArray(res?.items) ? res.items : []);
      setTotal(Number(res?.total || 0));
      setTotalPages(Math.max(1, Number(res?.total_pages || 1)));
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError(err?.message || 'Unable to load AI screening queue.');
      setItems([]);
      setTotal(0);
      setTotalPages(1);
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [fetchQueueFn, statusFilter, page]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const handleDecision = async (complaintId, action) => {
    if (!complaintId || submittingId) return;
    setSubmittingId(complaintId);
    setError(null);
    try {
      if (action === 'dismiss') {
        await dismissFn(complaintId);
      } else {
        await confirmFn(complaintId);
      }
      await loadQueue();
    } catch (err) {
      setError(err?.message || 'Failed to update screening flag.');
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-blue-600" />
            AI Claim Screening Review Queue
            {screeningMode === 'shadow' && (
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-300">
                Shadow Mode
              </span>
            )}
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Review borderline or flagged complaints and audit AI-advanced submissions. Complaints are never auto-rejected or hidden.
          </p>
        </div>

        <button
          type="button"
          onClick={loadQueue}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3 text-xs">
          <span className="font-semibold text-slate-700">
            {loading ? 'Loading screening queue...' : `Showing ${items.length} of ${total} record(s)`}
          </span>

          <div className="flex items-center gap-2">
            <label htmlFor="admin-screening-filter" className="font-semibold text-slate-700">
              Queue Filter:
            </label>
            <select
              id="admin-screening-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-900"
            >
              <option value="needs_review">Needs Review (All Open)</option>
              <option value="priority_review">High Risk Priority</option>
              <option value="ai_advanced">Advanced by AI</option>
              <option value="dismissed">Dismissed</option>
              <option value="confirmed_suspicious">Confirmed Suspicious</option>
              <option value="reverted">Reverted Advancements</option>
              <option value="all">All Screened</option>
            </select>
          </div>
        </div>

        {error && (
          <div role="alert" className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div role="status" className="p-8 text-center text-xs text-slate-500">
            Loading screening records...
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center space-y-2 text-slate-500">
            <Inbox className="w-8 h-8 mx-auto text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">No complaints match this screening filter.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => {
              const isBusy = submittingId === item.complaint_id;
              const isOpenFlag =
                item.review_status === 'needs_review' || item.review_status === 'priority_review';
              return (
                <div
                  key={item.review_id}
                  className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2 text-xs"
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
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold border capitalize ${
                          item.risk_level === 'high'
                            ? 'bg-rose-50 text-rose-800 border-rose-200'
                            : item.risk_level === 'medium'
                            ? 'bg-amber-50 text-amber-800 border-amber-200'
                            : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                        }`}
                      >
                        {item.risk_level} risk
                      </span>
                      {item.mode === 'shadow' && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-300">
                          Shadow
                        </span>
                      )}
                    </div>

                    <span className="text-[11px] text-slate-400">
                      {formatDateTime(item.created_at)}
                    </span>
                  </div>

                  <p className="font-bold text-slate-900 text-sm">{item.complaint_title}</p>

                  {Array.isArray(item.reason_codes) && item.reason_codes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {item.reason_codes.map((rc) => (
                        <span
                          key={rc}
                          className="px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-900 font-medium"
                        >
                          {rc}
                        </span>
                      ))}
                    </div>
                  )}

                  {isOpenFlag && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => handleDecision(item.complaint_id, 'dismiss')}
                        disabled={Boolean(submittingId)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold disabled:opacity-50"
                      >
                        <Check className="w-3.5 h-3.5" />
                        {isBusy ? 'Saving...' : 'Dismiss Flag'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDecision(item.complaint_id, 'confirm')}
                        disabled={Boolean(submittingId)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold disabled:opacity-50"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Confirm Suspicious
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-50"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Previous
            </button>
            <span className="font-semibold text-slate-600">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-50"
            >
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
