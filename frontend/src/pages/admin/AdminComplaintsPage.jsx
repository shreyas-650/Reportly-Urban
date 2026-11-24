import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText,
  Search,
  Filter,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Flame,
  User,
  Building,
  Eye,
  AlertCircle,
  X,
  Clock,
} from 'lucide-react';
import { fetchAdminComplaints, fetchAdminDepartments, isComplaintOverdue } from '../../services/adminService';
import StatusBadge from '../../components/common/StatusBadge';
import PriorityBadge from '../../components/common/PriorityBadge';
import { formatDateTime, formatDate } from '../../utils/formatters';

export default function AdminComplaintsPage() {
  const [complaints, setComplaints] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Filters & Search State
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [priority, setPriority] = useState('all');
  const [departmentId, setDepartmentId] = useState('all');
  const [ward, setWard] = useState('all');
  const [assigned, setAssigned] = useState('all'); // 'all', 'assigned', 'unassigned'
  const [overdue, setOverdue] = useState(false);

  // Pagination State
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Debounce search input
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // reset to page 1 on new search
    }, 400);
    return () => clearTimeout(handler);
  }, [search]);

  // Load departments once for filter dropdown
  useEffect(() => {
    async function loadDepts() {
      const { data } = await fetchAdminDepartments();
      if (data) setDepartments(data);
    }
    loadDepts();
  }, []);

  // Main data loader
  const loadComplaints = useCallback(async () => {
    setLoading(true);
    setError(null);

    const res = await fetchAdminComplaints({
      search: debouncedSearch,
      status,
      priority,
      departmentId,
      ward,
      assigned,
      overdue,
      page,
      pageSize,
    });

    if (res.error) {
      setError(res.error.message || 'Failed to load complaints.');
    } else {
      setComplaints(res.data);
      setTotalCount(res.count);
      setTotalPages(res.totalPages);
    }
    setLoading(false);
  }, [debouncedSearch, status, priority, departmentId, ward, assigned, overdue, page, pageSize]);

  useEffect(() => {
    loadComplaints();
  }, [loadComplaints]);

  const resetFilters = () => {
    setSearch('');
    setStatus('all');
    setPriority('all');
    setDepartmentId('all');
    setWard('all');
    setAssigned('all');
    setOverdue(false);
    setPage(1);
  };

  const hasActiveFilters =
    search ||
    status !== 'all' ||
    priority !== 'all' ||
    departmentId !== 'all' ||
    ward !== 'all' ||
    assigned !== 'all' ||
    overdue;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">
            Administrative Complaint Management & Triage
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Dispatch, department routing, and live SLA monitoring across all municipal wards.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadComplaints}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 shadow-2xs transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Filter and Search Panel */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-xs space-y-4">
        {/* Search bar */}
        <div className="flex flex-col sm:flex-row items-center gap-3">
          <div className="relative flex-1 w-full">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by complaint number (e.g. RU-2026-0001) or title..."
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              onClick={() => {
                setOverdue(!overdue);
                setPage(1);
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition ${
                overdue
                  ? 'bg-red-50 text-red-700 border-red-300 shadow-xs'
                  : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
              }`}
            >
              <Flame className="w-3.5 h-3.5 text-red-600" />
              <span>Overdue Only</span>
            </button>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1 px-2.5 py-2 text-xs text-slate-500 hover:text-rose-600 font-medium transition"
              >
                <X className="w-3.5 h-3.5" /> Clear All
              </button>
            )}
          </div>
        </div>

        {/* Filter Dropdowns Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-3 border-t border-slate-100 text-xs">
          {/* Status Filter */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="w-full py-1.5 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-medium focus:bg-white focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Statuses</option>
              <option value="submitted">Submitted</option>
              <option value="under_review">Under Review</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {/* Priority Filter */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Priority</label>
            <select
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value);
                setPage(1);
              }}
              className="w-full py-1.5 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-medium focus:bg-white focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Priorities</option>
              <option value="emergency">Emergency</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>

          {/* Department Filter */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Department</label>
            <select
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value);
                setPage(1);
              }}
              className="w-full py-1.5 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-medium focus:bg-white focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Departments</option>
              <option value="none">Unassigned Department</option>
              {departments.map((dept) => (
                <option key={dept.id} value={dept.id}>
                  {dept.name}
                </option>
              ))}
            </select>
          </div>

          {/* Assignment State */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Officer Assignment</label>
            <select
              value={assigned}
              onChange={(e) => {
                setAssigned(e.target.value);
                setPage(1);
              }}
              className="w-full py-1.5 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-medium focus:bg-white focus:ring-1 focus:ring-blue-500"
            >
              <option value="all">All Officers</option>
              <option value="assigned">Assigned</option>
              <option value="unassigned">Unassigned (Pending)</option>
            </select>
          </div>

          {/* Ward Filter */}
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Municipal Ward</label>
            <input
              type="text"
              value={ward === 'all' ? '' : ward}
              onChange={(e) => {
                const val = e.target.value.trim();
                setWard(val ? val : 'all');
                setPage(1);
              }}
              placeholder="e.g. Ward 12"
              className="w-full py-1.5 px-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-medium placeholder:text-slate-400 focus:bg-white focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Complaints Table Container */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-xs text-slate-500 space-y-3">
            <RefreshCw className="w-6 h-6 animate-spin text-blue-600 mx-auto" />
            <p>Loading grievances from Supabase...</p>
          </div>
        ) : error ? (
          <div className="p-12 text-center text-xs space-y-3">
            <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
            <p className="font-bold text-slate-800">Error loading complaints</p>
            <p className="text-slate-500 max-w-md mx-auto">{error}</p>
            <button
              type="button"
              onClick={loadComplaints}
              className="px-4 py-1.5 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition"
            >
              Try Again
            </button>
          </div>
        ) : complaints.length === 0 ? (
          <div className="p-12 text-center text-xs space-y-3">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 mx-auto">
              <FileText className="w-6 h-6" />
            </div>
            <p className="font-bold text-slate-800">No Complaints Match Your Criteria</p>
            <p className="text-slate-500 max-w-sm mx-auto">
              {hasActiveFilters
                ? 'Try adjusting your search query, status, or department filters.'
                : 'No complaints have been submitted yet.'}
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="px-3.5 py-1.5 bg-slate-100 text-slate-700 rounded-lg font-semibold hover:bg-slate-200 transition"
              >
                Clear Filters
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider">
                  <tr>
                    <th className="py-3.5 px-4">Complaint #</th>
                    <th className="py-3.5 px-4">Title & Category</th>
                    <th className="py-3.5 px-4">Citizen</th>
                    <th className="py-3.5 px-4">Department & Officer</th>
                    <th className="py-3.5 px-4">Ward</th>
                    <th className="py-3.5 px-4">Status</th>
                    <th className="py-3.5 px-4">Priority</th>
                    <th className="py-3.5 px-4">SLA Deadline</th>
                    <th className="py-3.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {complaints.map((c) => {
                    const overdueItem = isComplaintOverdue(c);
                    return (
                      <tr
                        key={c.id}
                        className={`hover:bg-slate-50/80 transition-colors ${
                          overdueItem ? 'bg-red-50/20' : ''
                        }`}
                      >
                        {/* ID */}
                        <td className="py-3.5 px-4 font-mono font-bold text-blue-600 whitespace-nowrap">
                          {c.complaint_number}
                        </td>

                        {/* Title & Category */}
                        <td className="py-3.5 px-4 max-w-[220px]">
                          <div className="font-semibold text-slate-900 truncate" title={c.title}>
                            {c.title}
                          </div>
                          <div className="text-[11px] text-slate-400 capitalize">
                            {c.category?.replace('_', ' ')}
                          </div>
                        </td>

                        {/* Citizen Info */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <div className="text-slate-800 font-medium">
                            {c.citizen?.full_name || 'Anonymous Citizen'}
                          </div>
                          {c.citizen?.phone_number && (
                            <div className="text-[11px] text-slate-400 font-mono">
                              {c.citizen.phone_number}
                            </div>
                          )}
                        </td>

                        {/* Department & Officer */}
                        <td className="py-3.5 px-4">
                          <div className="font-medium text-slate-800">
                            {c.department?.name || (
                              <span className="text-amber-600 font-semibold">Unassigned Dept</span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {c.assigned_officer?.official_name ? (
                              <span className="text-slate-600">
                                {c.assigned_officer.official_name}
                              </span>
                            ) : (
                              <span className="text-slate-400 italic">No Officer Assigned</span>
                            )}
                          </div>
                        </td>

                        {/* Ward */}
                        <td className="py-3.5 px-4 text-slate-600 whitespace-nowrap">{c.ward}</td>

                        {/* Status */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <StatusBadge status={c.status} size="sm" />
                        </td>

                        {/* Priority */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <PriorityBadge priority={c.priority} size="sm" />
                        </td>

                        {/* SLA Deadline */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {c.sla_deadline ? (
                            <div className={overdueItem ? 'text-red-600 font-bold' : 'text-slate-600'}>
                              {formatDateTime(c.sla_deadline)}
                              {overdueItem && (
                                <span className="ml-1.5 inline-flex items-center text-[10px] px-1.5 py-0.2 rounded bg-red-100 text-red-700">
                                  OVERDUE
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-400">Not set</span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          <Link
                            to={`/admin/complaints/${c.id}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-600 hover:text-white font-semibold transition"
                          >
                            <Eye className="w-3.5 h-3.5" /> Triage
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div className="p-4 border-t border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600">
              <div>
                Showing <span className="font-semibold text-slate-900">{complaints.length}</span> of{' '}
                <span className="font-semibold text-slate-900">{totalCount}</span> total grievances
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(p - 1, 1))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Previous
                </button>
                <span className="px-2 font-mono font-semibold text-slate-800">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
