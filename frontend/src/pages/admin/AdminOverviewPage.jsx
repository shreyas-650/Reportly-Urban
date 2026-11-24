import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Flame,
  Building,
  ArrowRight,
  RefreshCw,
  TrendingUp,
  Inbox,
  AlertCircle,
  ShieldCheck,
  Eye,
} from 'lucide-react';
import { fetchAdminOverviewStats } from '../../services/adminService';
import StatusBadge from '../../components/common/StatusBadge';
import PriorityBadge from '../../components/common/PriorityBadge';
import { formatDateTime } from '../../utils/formatters';

export default function AdminOverviewPage() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadStats = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await fetchAdminOverviewStats();
    if (err) {
      setError(err.message || 'Failed to load administrative overview statistics.');
    } else {
      setStats(data);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadStats();
  }, []);

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-slate-200 rounded w-1/3 mb-2" />
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {[...Array(7)].map((_, i) => (
            <div key={i} className="h-24 bg-slate-200 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="h-64 bg-slate-200 rounded-2xl lg:col-span-2" />
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white border border-rose-200 rounded-2xl p-8 text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-slate-900">Unable to Load Overview Statistics</h2>
        <p className="text-xs text-slate-600 max-w-md mx-auto">{error}</p>
        <button
          type="button"
          onClick={loadStats}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Retry
        </button>
      </div>
    );
  }

  const counts = stats?.counts || {};
  const priority = stats?.priority || {};
  const departments = stats?.by_department || [];
  const recentComplaints = stats?.recent_complaints || [];

  const statCards = [
    {
      label: 'Total Grievances',
      value: counts.total || 0,
      icon: FileText,
      color: 'text-slate-900 bg-slate-100 border-slate-200',
    },
    {
      label: 'Newly Submitted',
      value: counts.submitted || 0,
      icon: Inbox,
      color: 'text-amber-700 bg-amber-50 border-amber-200',
    },
    {
      label: 'Under Review',
      value: counts.under_review || 0,
      icon: Clock,
      color: 'text-purple-700 bg-purple-50 border-purple-200',
    },
    {
      label: 'In Progress',
      value: counts.in_progress || 0,
      icon: TrendingUp,
      color: 'text-blue-700 bg-blue-50 border-blue-200',
    },
    {
      label: 'Resolved',
      value: counts.resolved || 0,
      icon: CheckCircle2,
      color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    },
    {
      label: 'Rejected',
      value: counts.rejected || 0,
      icon: AlertTriangle,
      color: 'text-rose-700 bg-rose-50 border-rose-200',
    },
    {
      label: 'Overdue (SLA)',
      value: counts.overdue || 0,
      icon: Flame,
      color: 'text-red-700 bg-red-50 border-red-200 font-bold',
      alert: counts.overdue > 0,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">
            Municipal Administrative Dashboard
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Real-time urban grievance intelligence, service level agreement monitoring, and department workload.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadStats}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 shadow-2xs transition"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh Live Data
          </button>
          <Link
            to="/admin/complaints"
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 shadow-xs transition"
          >
            Complaint Triage <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      {/* Primary KPI Status Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {statCards.map((card, idx) => {
          const Icon = card.icon;
          return (
            <div
              key={idx}
              className={`p-4 rounded-xl border ${card.color} flex flex-col justify-between`}
            >
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-semibold text-slate-600 line-clamp-1">{card.label}</span>
                <Icon className="w-4 h-4 opacity-80 shrink-0" />
              </div>
              <div className="text-2xl font-extrabold tracking-tight">{card.value}</div>
            </div>
          );
        })}
      </div>

      {/* Workload Breakdown: Priority & Department Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Department Workload */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Building className="w-4 h-4 text-blue-600" />
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                Departmental Case Volumes
              </h2>
            </div>
            <Link
              to="/admin/departments"
              className="text-xs font-semibold text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
            >
              Manage Divisions <ArrowRight className="w-3 h-3" />
            </Link>
          </div>

          {departments.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">No department activity recorded yet.</p>
          ) : (
            <div className="space-y-3">
              {departments.map((dept) => {
                const total = counts.total || 1;
                const pct = Math.round(((dept.complaint_count || 0) / total) * 100);
                return (
                  <div key={dept.department_id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-800">{dept.department_name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500 font-mono">
                          {dept.active_complaint_count || 0} active / {dept.complaint_count} total
                        </span>
                        <span className="font-bold text-slate-700 w-9 text-right">{pct}%</span>
                      </div>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Priority Breakdown */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <Flame className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                Priority Distribution
              </h2>
            </div>

            <div className="space-y-2.5">
              {[
                { key: 'emergency', label: 'Emergency', count: priority.emergency || 0, badge: 'emergency' },
                { key: 'high', label: 'High Priority', count: priority.high || 0, badge: 'high' },
                { key: 'medium', label: 'Medium Priority', count: priority.medium || 0, badge: 'medium' },
                { key: 'normal', label: 'Normal', count: priority.normal || 0, badge: 'normal' },
                { key: 'low', label: 'Low', count: priority.low || 0, badge: 'low' },
              ].map((item) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200/70"
                >
                  <PriorityBadge priority={item.badge} size="sm" />
                  <span className="font-mono text-xs font-bold text-slate-800">{item.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500">
            Emergency issues trigger immediate automated supervisor escalations.
          </div>
        </div>
      </div>

      {/* Recent Live Complaints Table */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-900">Recent Complaints</h2>
            <p className="text-xs text-slate-500 mt-0.5">Most recent citizen grievances submitted to the platform.</p>
          </div>
          <Link
            to="/admin/complaints"
            className="text-xs font-semibold text-blue-600 hover:text-blue-800 inline-flex items-center gap-1"
          >
            View Full Queue <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {recentComplaints.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            No complaints currently logged in the system.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4">Complaint #</th>
                  <th className="py-3 px-4">Title</th>
                  <th className="py-3 px-4">Department</th>
                  <th className="py-3 px-4">Ward</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Priority</th>
                  <th className="py-3 px-4">Logged</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentComplaints.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-blue-600">{c.complaint_number}</td>
                    <td className="py-3 px-4 font-medium text-slate-900 max-w-[200px] truncate">{c.title}</td>
                    <td className="py-3 px-4 text-slate-600">{c.department_name || 'Unassigned'}</td>
                    <td className="py-3 px-4 text-slate-600">{c.ward}</td>
                    <td className="py-3 px-4">
                      <StatusBadge status={c.status} size="sm" />
                    </td>
                    <td className="py-3 px-4">
                      <PriorityBadge priority={c.priority} size="sm" />
                    </td>
                    <td className="py-3 px-4 text-slate-500">{formatDateTime(c.created_at)}</td>
                    <td className="py-3 px-4 text-right">
                      <Link
                        to={`/admin/complaints/${c.id}`}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800"
                      >
                        <Eye className="w-3.5 h-3.5" /> Inspect
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
