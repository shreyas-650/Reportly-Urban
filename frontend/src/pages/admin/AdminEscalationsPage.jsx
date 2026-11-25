import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ShieldAlert,
  RefreshCw,
  Filter,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  History,
  Send,
  Inbox,
  ExternalLink,
  X,
} from 'lucide-react';
import {
  fetchAdminEscalations,
  fetchAdminComplaintEscalations,
  submitManualEscalation,
  validateManualEscalationReason,
} from '../../services/slaApiService';

function formatCategory(cat) {
  return String(cat || '').replace(/_/g, ' ');
}

export default function AdminEscalationsPage({ api = null }) {
  const [searchParams, setSearchParams] = useSearchParams();

  const [items, setItems] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [level, setLevel] = useState('all');
  const [escStatus, setEscStatus] = useState('all');
  const [departmentId, setDepartmentId] = useState('all');
  const [ward, setWard] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedComplaintId, setSelectedComplaintId] = useState(
    () => searchParams.get('complaintId') || ''
  );
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(null);
  const [escalating, setEscalating] = useState(false);
  const [escalateError, setEscalateError] = useState(null);
  const [escalateSuccess, setEscalateSuccess] = useState('');
  const inFlightRef = useRef(false);

  const listFn = api?.fetchList || fetchAdminEscalations;
  const detailFn = api?.fetchHistory || fetchAdminComplaintEscalations;
  const escalateFn = api?.escalate || submitManualEscalation;

  const loadEscalations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listFn({
        level,
        status: escStatus,
        department_id: departmentId,
        ward: ward.trim() || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        page,
        page_size: pageSize,
      });
      setItems(Array.isArray(res?.items) ? res.items : []);
      setTotal(Number(res?.total || 0));
      setTotalPages(Number(res?.total_pages || 1));
      if (Array.isArray(res?.departments)) {
        setDepartments(res.departments);
      }
    } catch (err) {
      setError(err?.message || 'Unable to load escalations.');
    } finally {
      setLoading(false);
    }
  }, [listFn, level, escStatus, departmentId, ward, dateFrom, dateTo, page, pageSize]);

  useEffect(() => {
    loadEscalations();
  }, [loadEscalations]);

  const loadComplaintHistory = useCallback(
    async (complaintId) => {
      if (!complaintId) {
        setDetailData(null);
        return;
      }
      setDetailLoading(true);
      setDetailError(null);
      try {
        const res = await detailFn(complaintId);
        setDetailData(res);
      } catch (err) {
        setDetailError(err?.message || 'Failed to load escalation history.');
        setDetailData(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [detailFn]
  );

  useEffect(() => {
    if (selectedComplaintId) {
      loadComplaintHistory(selectedComplaintId);
    }
  }, [selectedComplaintId, loadComplaintHistory]);

  const openComplaintHistory = (complaintId) => {
    setSelectedComplaintId(complaintId);
    setReason('');
    setReasonError(null);
    setEscalateError(null);
    setEscalateSuccess('');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('complaintId', complaintId);
      return next;
    });
  };

  const closeComplaintHistory = () => {
    setSelectedComplaintId('');
    setDetailData(null);
    setDetailError(null);
    setReason('');
    setReasonError(null);
    setEscalateError(null);
    setEscalateSuccess('');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('complaintId');
      return next;
    });
  };

  const handleManualEscalate = async (e) => {
    e.preventDefault();
    if (!detailData?.complaint?.id || inFlightRef.current || escalating) return;

    setEscalateError(null);
    setEscalateSuccess('');
    const check = validateManualEscalationReason(reason);
    if (!check.valid) {
      setReasonError(check.error);
      return;
    }

    setReasonError(null);
    inFlightRef.current = true;
    setEscalating(true);
    try {
      const result = await escalateFn(detailData.complaint.id, {
        reason: check.trimmed,
        expectedUpdatedAt: detailData.complaint.updated_at || null,
      });
      setEscalateSuccess(
        `Complaint escalated from Level ${result.from_level} to Level ${result.to_level}.`
      );
      setReason('');
      await Promise.all([
        loadComplaintHistory(detailData.complaint.id),
        loadEscalations(),
      ]);
    } catch (err) {
      setEscalateError(err?.message || 'Manual escalation failed.');
    } finally {
      inFlightRef.current = false;
      setEscalating(false);
    }
  };

  const resetFilters = () => {
    setLevel('all');
    setEscStatus('all');
    setDepartmentId('all');
    setWard('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 flex items-center gap-2.5">
            <ShieldAlert className="w-6 h-6 text-teal-600" />
            Escalations &amp; History
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            Audit automatic and manual SLA escalations, review blocked escalations, and escalate active complaints by one level.
          </p>
        </div>

        <button
          type="button"
          onClick={loadEscalations}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <section
        aria-label="Escalation filters"
        className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs"
      >
        <div className="flex items-center justify-between mb-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-700">
            <Filter className="w-3.5 h-3.5 text-teal-600" />
            Filters
          </span>
          <button
            type="button"
            onClick={resetFilters}
            className="text-xs font-semibold text-teal-700 hover:text-teal-900"
          >
            Reset Filters
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 text-xs">
          <div>
            <label htmlFor="filter-level" className="block font-semibold text-slate-700 mb-1">
              Target Level
            </label>
            <select
              id="filter-level"
              value={level}
              onChange={(e) => {
                setLevel(e.target.value);
                setPage(1);
              }}
              className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-900"
            >
              <option value="all">All Levels</option>
              <option value="1">Level 1 (Officer)</option>
              <option value="2">Level 2 (Dept Head)</option>
              <option value="3">Level 3 (Admin)</option>
            </select>
          </div>

          <div>
            <label htmlFor="filter-status" className="block font-semibold text-slate-700 mb-1">
              Record Status
            </label>
            <select
              id="filter-status"
              value={escStatus}
              onChange={(e) => {
                setEscStatus(e.target.value);
                setPage(1);
              }}
              className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-900"
            >
              <option value="all">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>

          <div>
            <label htmlFor="filter-dept" className="block font-semibold text-slate-700 mb-1">
              Department
            </label>
            <select
              id="filter-dept"
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value);
                setPage(1);
              }}
              className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-900"
            >
              <option value="all">All Departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-ward" className="block font-semibold text-slate-700 mb-1">
              Ward
            </label>
            <input
              id="filter-ward"
              type="text"
              placeholder="Exact ward name"
              value={ward}
              onChange={(e) => {
                setWard(e.target.value);
                setPage(1);
              }}
              className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-900"
            />
          </div>

          <div>
            <label htmlFor="filter-date-from" className="block font-semibold text-slate-700 mb-1">
              From Date
            </label>
            <input
              id="filter-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-900"
            />
          </div>

          <div>
            <label htmlFor="filter-date-to" className="block font-semibold text-slate-700 mb-1">
              To Date
            </label>
            <input
              id="filter-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="w-full px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-900"
            />
          </div>
        </div>
      </section>

      {/* Main Content + Optional Side History Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className={selectedComplaintId ? 'lg:col-span-7' : 'lg:col-span-12'}>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
            {loading ? (
              <div className="p-8 text-center text-xs text-slate-500">
                Loading escalation records...
              </div>
            ) : error ? (
              <div className="p-8 text-center space-y-3">
                <AlertCircle className="w-7 h-7 text-rose-600 mx-auto" />
                <p className="text-xs font-semibold text-rose-700">{error}</p>
                <button
                  type="button"
                  onClick={loadEscalations}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Retry
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="p-10 text-center space-y-2">
                <Inbox className="w-7 h-7 text-slate-300 mx-auto" />
                <h2 className="text-sm font-bold text-slate-900">No Escalations Found</h2>
                <p className="text-xs text-slate-500">
                  No escalation records match the selected filters.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-900 text-white">
                      <th className="py-3 px-4 font-semibold">Reference</th>
                      <th className="py-3 px-4 font-semibold">Category &amp; Ward</th>
                      <th className="py-3 px-4 font-semibold">Status</th>
                      <th className="py-3 px-4 font-semibold">Level</th>
                      <th className="py-3 px-4 font-semibold">Recipient</th>
                      <th className="py-3 px-4 font-semibold">Reason</th>
                      <th className="py-3 px-4 font-semibold">Date</th>
                      <th className="py-3 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4 font-mono font-bold text-slate-900 whitespace-nowrap">
                          {item.complaint_reference}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900 capitalize">
                            {formatCategory(item.category)}
                          </div>
                          <div className="text-[11px] text-slate-500">{item.ward}</div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                              item.status === 'blocked'
                                ? 'bg-rose-50 text-rose-700 border-rose-200'
                                : 'bg-teal-50 text-teal-800 border-teal-200'
                            }`}
                          >
                            {item.status}
                          </span>
                          <div className="text-[10px] text-slate-500 mt-0.5 capitalize">
                            {formatCategory(item.complaint_status)}
                          </div>
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span className="font-bold text-slate-900">
                            L{item.current_level}
                          </span>
                          <div className="text-[10px] text-slate-500">
                            {item.from_level} &rarr; {item.to_level}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-slate-700">{item.recipient}</td>
                        <td className="py-3 px-4 text-slate-700 max-w-xs break-words">
                          {item.reason}
                        </td>
                        <td className="py-3 px-4 text-slate-500 whitespace-nowrap">
                          {new Date(item.created_at).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => openComplaintHistory(item.complaint_id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
                          >
                            <History className="w-3 h-3" />
                            History &amp; Escalate
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {!loading && !error && total > 0 && (
              <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs">
                <span className="text-slate-600">
                  Page <strong>{page}</strong> of <strong>{totalPages}</strong> ({total} total)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 font-semibold disabled:opacity-40"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <button
                    type="button"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 font-semibold disabled:opacity-40"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Per-complaint History & Manual Escalation Panel */}
        {selectedComplaintId && (
          <aside
            aria-label="Complaint escalation history and manual escalation"
            className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-5"
          >
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                  <History className="w-4 h-4 text-teal-600" />
                  Complaint Escalation History
                </h2>
                {detailData?.complaint && (
                  <p className="text-xs font-mono font-semibold text-teal-700 mt-0.5">
                    {detailData.complaint.complaint_reference}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={closeComplaintHistory}
                aria-label="Close history panel"
                className="text-slate-400 hover:text-slate-700 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {detailLoading ? (
              <p className="text-xs text-slate-500">Loading complaint escalation history...</p>
            ) : detailError ? (
              <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 space-y-2">
                <p>{detailError}</p>
                <button
                  type="button"
                  onClick={() => loadComplaintHistory(selectedComplaintId)}
                  className="px-3 py-1 rounded-lg bg-slate-900 text-white font-semibold"
                >
                  Retry
                </button>
              </div>
            ) : detailData?.complaint ? (
              <>
                <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900">
                      Current Escalation Level: Level {detailData.complaint.current_level}
                    </span>
                    <Link
                      to={`/admin/complaints/${detailData.complaint.id}`}
                      className="inline-flex items-center gap-1 text-teal-700 font-semibold hover:underline"
                    >
                      Open Complaint <ExternalLink className="w-3 h-3" />
                    </Link>
                  </div>
                  <div className="text-slate-600 capitalize">
                    Category: {formatCategory(detailData.complaint.category)} &bull; Ward:{' '}
                    {detailData.complaint.ward} &bull; Status:{' '}
                    {formatCategory(detailData.complaint.status)}
                  </div>
                  {detailData.complaint.department_name && (
                    <div className="text-slate-600">
                      Department: {detailData.complaint.department_name}
                    </div>
                  )}
                </div>

                {/* Manual Escalation Form */}
                <form
                  onSubmit={handleManualEscalate}
                  className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3 text-xs"
                >
                  <div>
                    <h3 className="font-bold text-slate-900">Manual Escalation</h3>
                    <p className="text-[11px] text-slate-600 mt-0.5">
                      Next escalation level (+1) and recipient authority are enforced automatically by server rules.
                    </p>
                  </div>

                  <div aria-live="polite" className="space-y-1.5">
                    {escalateSuccess && (
                      <div
                        role="status"
                        className="p-2.5 rounded-lg bg-teal-50 border border-teal-200 text-teal-900 flex items-center gap-1.5"
                      >
                        <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
                        <span>{escalateSuccess}</span>
                      </div>
                    )}
                    {escalateError && (
                      <div
                        role="alert"
                        className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 flex items-center gap-1.5"
                      >
                        <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                        <span>{escalateError}</span>
                      </div>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="manual-escalation-reason"
                      className="block font-semibold text-slate-700 mb-1"
                    >
                      Escalation Reason *
                    </label>
                    <textarea
                      id="manual-escalation-reason"
                      rows={3}
                      value={reason}
                      onChange={(e) => {
                        setReason(e.target.value);
                        if (reasonError) setReasonError(null);
                      }}
                      placeholder="Provide an operational justification (minimum 5 characters)..."
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    />
                    {reasonError && (
                      <p className="text-[11px] text-rose-700 mt-1">{reasonError}</p>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={escalating || detailData.complaint.current_level >= 3}
                    className="w-full inline-flex items-center justify-center gap-2 py-2 px-4 rounded-xl bg-teal-600 text-white font-semibold hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {escalating
                      ? 'Escalating...'
                      : detailData.complaint.current_level >= 3
                        ? 'Maximum Level 3 Reached'
                        : 'Escalate Complaint'}
                  </button>
                </form>

                {/* Chronological Escalation History */}
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">
                    Recorded History ({detailData.history?.length || 0})
                  </h3>
                  {!detailData.history || detailData.history.length === 0 ? (
                    <p className="text-xs text-slate-500 p-3 bg-slate-50 rounded-xl border border-slate-100">
                      No escalation entries recorded for this complaint yet.
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {detailData.history.map((entry) => (
                        <li
                          key={entry.id}
                          className="p-3 rounded-xl border border-slate-200 bg-white text-xs space-y-1"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-slate-900">
                              Level {entry.from_level} &rarr; Level {entry.to_level} ({entry.status})
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {new Date(entry.created_at).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-slate-700">{entry.reason}</p>
                          <div className="text-[11px] text-slate-500">
                            Recipient: {entry.recipient} &bull; Trigger: {entry.triggered_by}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : null}
          </aside>
        )}
      </div>
    </div>
  );
}
