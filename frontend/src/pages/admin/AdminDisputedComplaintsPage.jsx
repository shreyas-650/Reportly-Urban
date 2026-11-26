import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Inbox,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { fetchAdminDisputes } from '../../services/slaApiService';
import StatusBadge from '../../components/common/StatusBadge';
import { formatDateTime } from '../../utils/formatters';

const DISPUTE_BADGES = {
  open_dispute: 'bg-amber-50 text-amber-800 border-amber-200',
  reopened: 'bg-blue-50 text-blue-800 border-blue-200',
  escalated_to_admin: 'bg-rose-50 text-rose-800 border-rose-200',
  admin_resolved: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  closed_unconfirmed: 'bg-slate-100 text-slate-700 border-slate-300',
};

const DISPUTE_LABELS = {
  open_dispute: 'Open Dispute',
  reopened: 'Reopened',
  escalated_to_admin: 'Escalated to Admin',
  admin_resolved: 'Admin Reviewed',
  closed_unconfirmed: 'Closed (Not Confirmed)',
};

export default function AdminDisputedComplaintsPage({ api = null }) {
  const fetchListFn = api?.fetchDisputes || fetchAdminDisputes;

  const [items, setItems] = useState([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadDisputes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchListFn({
        status: statusFilter,
        page,
        page_size: 20,
      });
      setItems(Array.isArray(res?.items) ? res.items : []);
      setTotal(Number(res?.total || 0));
      setTotalPages(Math.max(1, Number(res?.total_pages || 1)));
    } catch (err) {
      setError(err?.message || 'Unable to load disputed complaints.');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [fetchListFn, statusFilter, page]);

  useEffect(() => {
    loadDisputes();
  }, [loadDisputes]);

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-rose-600" />
            Disputed Complaints Queue
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Review citizen disputes, reopened complaints, and cases escalated after reaching maximum automatic reopens.
          </p>
        </div>

        <button
          type="button"
          onClick={loadDisputes}
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
            Showing {items.length} of {total} disputed complaint{total === 1 ? '' : 's'}
          </span>

          <div className="flex items-center gap-2">
            <label htmlFor="admin-dispute-filter" className="font-semibold text-slate-700">
              Dispute Status:
            </label>
            <select
              id="admin-dispute-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-900"
            >
              <option value="all">All Disputes</option>
              <option value="open_dispute">Open Dispute</option>
              <option value="reopened">Reopened</option>
              <option value="escalated_to_admin">Escalated to Admin</option>
              <option value="admin_resolved">Admin Reviewed</option>
              <option value="closed_unconfirmed">Closed (Not Confirmed)</option>
            </select>
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-slate-500 py-8 text-center">Loading disputed complaints...</p>
        ) : error ? (
          <div role="alert" className="p-6 text-center space-y-2 bg-rose-50/50 rounded-xl border border-rose-200">
            <AlertTriangle className="w-6 h-6 text-rose-600 mx-auto" />
            <p className="text-xs font-bold text-slate-900">Failed to load disputes</p>
            <p className="text-xs text-slate-600">{error}</p>
            <button
              type="button"
              onClick={loadDisputes}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center space-y-1.5 bg-slate-50 rounded-xl border border-slate-100">
            <Inbox className="w-7 h-7 text-slate-300 mx-auto" />
            <p className="text-xs font-semibold text-slate-700">No disputed complaints match this filter</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="py-2.5 pr-3">Reference</th>
                  <th className="py-2.5 pr-3">Complaint</th>
                  <th className="py-2.5 pr-3">Dispute State</th>
                  <th className="py-2.5 pr-3">Complaint Status</th>
                  <th className="py-2.5 pr-3">Reopens</th>
                  <th className="py-2.5 pr-3">Updated</th>
                  <th className="py-2.5 text-right">Inspect</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => (
                  <tr key={item.complaint_id} className="hover:bg-slate-50/70">
                    <td className="py-3 pr-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                      {item.complaint_reference}
                    </td>
                    <td className="py-3 pr-3 max-w-xs">
                      <div className="font-semibold text-slate-900 truncate">{item.title}</div>
                      <div className="text-[11px] text-slate-500 capitalize">
                        {String(item.category || '').replace(/_/g, ' ')} • {item.ward} • {item.citizen_display_name}
                      </div>
                      {item.latest_reason && (
                        <p className="text-[11px] text-slate-600 mt-1 line-clamp-2">{item.latest_reason}</p>
                      )}
                    </td>
                    <td className="py-3 pr-3 whitespace-nowrap">
                      <span
                        className={`inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${
                          DISPUTE_BADGES[item.dispute_state] || 'bg-slate-100 text-slate-700 border-slate-200'
                        }`}
                      >
                        {DISPUTE_LABELS[item.dispute_state] || item.dispute_state}
                      </span>
                    </td>
                    <td className="py-3 pr-3 whitespace-nowrap">
                      <StatusBadge status={item.complaint_status} size="sm" />
                    </td>
                    <td className="py-3 pr-3 font-mono text-slate-700 whitespace-nowrap">
                      {item.reopen_count}
                    </td>
                    <td className="py-3 pr-3 text-slate-600 whitespace-nowrap">
                      {formatDateTime(item.updated_at)}
                    </td>
                    <td className="py-3 text-right whitespace-nowrap">
                      <Link
                        to={`/admin/complaints/${item.complaint_id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
                      >
                        History &amp; Review <ExternalLink className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
            <span className="text-slate-500">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-lg border border-slate-300 text-slate-700 font-semibold disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-lg border border-slate-300 text-slate-700 font-semibold disabled:opacity-40"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
