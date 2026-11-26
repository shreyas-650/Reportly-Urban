import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Inbox,
  RefreshCw,
} from 'lucide-react';
import { fetchAdminDuplicates } from '../../services/slaApiService';
import StatusBadge from '../../components/common/StatusBadge';
import { formatDateTime } from '../../utils/formatters';

const STATUS_BADGES = {
  suspected: 'bg-amber-50 text-amber-800 border-amber-200',
  confirmed_duplicate: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  not_duplicate: 'bg-slate-100 text-slate-700 border-slate-300',
};

const STATUS_LABELS = {
  suspected: 'Suspected',
  confirmed_duplicate: 'Confirmed Duplicate',
  not_duplicate: 'Not a Duplicate',
};

function groupLinksByComplaint(items) {
  const groups = [];
  const byComplaintId = new Map();
  for (const item of items) {
    const key = String(item.complaint_id || '');
    let group = byComplaintId.get(key);
    if (!group) {
      group = {
        complaint_id: item.complaint_id,
        complaint_number: item.complaint_number,
        complaint_title: item.complaint_title,
        complaint_category: item.complaint_category,
        complaint_ward: item.complaint_ward,
        complaint_status: item.complaint_status,
        links: [],
      };
      byComplaintId.set(key, group);
      groups.push(group);
    }
    group.links.push(item);
  }
  return groups;
}

export default function AdminDuplicatesPage({ api = null }) {
  const fetchListFn = api?.fetchDuplicates || fetchAdminDuplicates;

  const [featureEnabled, setFeatureEnabled] = useState(false);
  const [items, setItems] = useState([]);
  const [statusFilter, setStatusFilter] = useState('suspected');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const requestSeqRef = useRef(0);

  const loadDuplicates = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchListFn({
        status: statusFilter,
        page,
        page_size: 20,
      });
      if (seq !== requestSeqRef.current) return;
      setFeatureEnabled(Boolean(res?.feature_enabled));
      setItems(Array.isArray(res?.items) ? res.items : []);
      setTotal(Number(res?.total || 0));
      setTotalPages(Math.max(1, Number(res?.total_pages || 1)));
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError(err?.message || 'Unable to load suspected duplicates.');
      setItems([]);
      setTotal(0);
      setTotalPages(1);
    } finally {
      if (seq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [fetchListFn, statusFilter, page]);

  const groupedComplaints = useMemo(() => groupLinksByComplaint(items), [items]);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <Copy className="w-5 h-5 text-blue-600" />
            Suspected Duplicate Complaints
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Review linked potential duplicates flagged by geospatial rules and optional AI comparison. Flagged complaints retain normal workflow and SLAs.
          </p>
        </div>

        <button
          type="button"
          onClick={loadDuplicates}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {!loading && !error && !featureEnabled && (
        <div role="status" className="p-4 rounded-xl bg-slate-100 border border-slate-200 text-slate-700 text-xs font-medium">
          AI is off. Rule-based duplicate detection links close open complaints without calling Gemini.
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3 text-xs">
          <span className="font-semibold text-slate-700">
            {loading
              ? 'Loading duplicate links...'
              : `Showing ${items.length} of ${total} duplicate link${total === 1 ? '' : 's'} across ${groupedComplaints.length} complaint${groupedComplaints.length === 1 ? '' : 's'}`}
          </span>

          <div className="flex items-center gap-2">
            <label htmlFor="admin-duplicate-filter" className="font-semibold text-slate-700">
              Link Status:
            </label>
            <select
              id="admin-duplicate-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-900"
            >
              <option value="suspected">Suspected</option>
              <option value="confirmed_duplicate">Confirmed Duplicate</option>
              <option value="not_duplicate">Not a Duplicate</option>
              <option value="all">All Links</option>
            </select>
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-slate-500 py-8 text-center">Loading suspected duplicates...</p>
        ) : error ? (
          <div role="alert" className="p-6 text-center space-y-2 bg-rose-50/50 rounded-xl border border-rose-200">
            <AlertTriangle className="w-6 h-6 text-rose-600 mx-auto" />
            <p className="text-xs font-bold text-slate-900">Failed to load suspected duplicates</p>
            <p className="text-xs text-slate-600">{error}</p>
            <button
              type="button"
              onClick={loadDuplicates}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center space-y-1.5 bg-slate-50 rounded-xl border border-slate-100">
            <Inbox className="w-7 h-7 text-slate-300 mx-auto" />
            <p className="text-xs font-semibold text-slate-700">No duplicate links match this filter</p>
          </div>
        ) : (
          <div className="space-y-5">
            {groupedComplaints.map((group) => (
              <div
                key={group.complaint_id}
                className="border border-slate-200 rounded-xl overflow-hidden bg-white"
              >
                <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-bold text-slate-900">
                        {group.complaint_number}
                      </span>
                      <span className="font-semibold text-slate-800 truncate">
                        {group.complaint_title}
                      </span>
                      <StatusBadge status={group.complaint_status} size="sm" />
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-50 text-blue-800 border border-blue-200">
                        {group.links.length} linked candidate{group.links.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      {group.complaint_ward}
                    </p>
                  </div>

                  <Link
                    to={`/admin/complaints/${group.complaint_id}`}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 shrink-0 self-start sm:self-center"
                  >
                    Review <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-500 bg-white">
                        <th className="py-2.5 pl-4 pr-3">Linked Candidate</th>
                        <th className="py-2.5 pr-3">Similarity</th>
                        <th className="py-2.5 pr-3">Link Status</th>
                        <th className="py-2.5 pr-3">Reason</th>
                        <th className="py-2.5 pr-3">Detected</th>
                        <th className="py-2.5 pr-4 text-right">Candidate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {group.links.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50/70">
                          <td className="py-3 pl-4 pr-3 max-w-xs">
                            <Link
                              to={`/admin/complaints/${item.candidate_complaint_id}`}
                              className="font-mono font-bold text-blue-700 hover:underline"
                            >
                              {item.candidate_complaint_number}
                            </Link>
                            <p className="font-semibold text-slate-800 truncate">
                              {item.candidate_title}
                            </p>
                            <div className="flex items-center gap-1.5 mt-1">
                              <StatusBadge status={item.candidate_status} size="sm" />
                              <span className="text-[11px] text-slate-500">
                                {item.candidate_ward}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 pr-3 whitespace-nowrap">
                            <span className="font-mono font-bold text-slate-900">
                              {Math.round(Number(item.similarity_score || 0) * 100)}%
                            </span>
                            <span className="block text-[10px] text-slate-500 uppercase">
                              {item.method === 'ai' ? 'AI' : 'Rule'}
                            </span>
                          </td>
                          <td className="py-3 pr-3 whitespace-nowrap">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                                STATUS_BADGES[item.status] || STATUS_BADGES.suspected
                              }`}
                            >
                              {STATUS_LABELS[item.status] || item.status}
                            </span>
                          </td>
                          <td className="py-3 pr-3 max-w-xs text-slate-600">{item.reason}</td>
                          <td className="py-3 pr-3 whitespace-nowrap text-slate-500 font-mono text-[11px]">
                            {formatDateTime(item.created_at)}
                          </td>
                          <td className="py-3 pr-4 text-right whitespace-nowrap">
                            <Link
                              to={`/admin/complaints/${item.candidate_complaint_id}`}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-800 font-semibold hover:bg-slate-100"
                            >
                              View <ExternalLink className="w-3 h-3" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
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
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 disabled:opacity-50"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 disabled:opacity-50"
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
