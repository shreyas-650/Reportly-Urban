import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  PlusCircle,
  Award,
  CheckCircle,
  Clock,
  AlertCircle,
  FileText,
  ArrowRight,
  UserCheck,
  RefreshCw,
  XCircle,
  Inbox,
} from 'lucide-react';
import Button from '../components/common/Button';
import StatisticsCard from '../components/dashboard/StatisticsCard';
import StatusBadge from '../components/common/StatusBadge';
import CitizenRewardsSummaryCard from '../components/citizen/CitizenRewardsSummaryCard';
import { useAuth } from '../context/AuthContext';
import { fetchCitizenComplaints } from '../services/complaintService';
import { fetchCitizenRewardsSummary } from '../services/slaApiService';
import { formatDate } from '../utils/formatters';

const DEFAULT_IMAGE_FALLBACK =
  'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=800&q=80';

export default function CitizenDashboard() {
  const { user, citizenInfo, isAuthenticated } = useAuth();

  const [complaints, setComplaints] = useState([]);
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    inProgress: 0,
    resolved: 0,
    rejected: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterTab, setFilterTab] = useState('all');
  const [rewardsSummary, setRewardsSummary] = useState(null);

  const loadComplaints = useCallback(async () => {
    if (!user?.id) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [result, rewardsRes] = await Promise.all([
        fetchCitizenComplaints(),
        fetchCitizenRewardsSummary().catch(() => null),
      ]);
      setRewardsSummary(rewardsRes && rewardsRes.feature_enabled === true ? rewardsRes : null);

      if (result.error) {
        setError(result.error.message || 'Failed to retrieve your complaints. Please try again.');
        setComplaints([]);
        setStats({ total: 0, pending: 0, inProgress: 0, resolved: 0, rejected: 0 });
      } else {
        setComplaints(result.data || []);
        setStats(
          result.stats || {
            total: 0,
            pending: 0,
            inProgress: 0,
            resolved: 0,
            rejected: 0,
          }
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred while loading complaints.');
      setComplaints([]);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    loadComplaints();
  }, [loadComplaints]);

  // Status filter matching adhering strictly to database enum values
  const displayedComplaints = complaints.filter((c) => {
    if (filterTab === 'all') return true;
    if (filterTab === 'pending') {
      return c.status === 'submitted' || c.status === 'under_review';
    }
    if (filterTab === 'in progress') {
      return c.status === 'in_progress';
    }
    if (filterTab === 'resolved') {
      return c.status === 'resolved';
    }
    if (filterTab === 'rejected') {
      return c.status === 'rejected';
    }
    return true;
  });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-16 space-y-10">
      {/* Citizen Profile Banner */}
      <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-blue-600 text-white flex items-center justify-center font-bold text-2xl shadow-sm shadow-blue-500/20">
            {citizenInfo.fullName?.charAt(0)?.toUpperCase() || 'C'}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
                Welcome back, {citizenInfo.fullName}
              </h1>
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full">
                <UserCheck className="w-3 h-3" /> Verified Citizen
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {citizenInfo.ward} • {citizenInfo.email}
            </p>
            {rewardsSummary?.feature_enabled === true && (
              <div className="flex items-center gap-3 mt-3">
                <Link
                  to="/rewards"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg hover:bg-blue-100"
                >
                  <Award className="w-3.5 h-3.5" />
                  {rewardsSummary.badges?.[0]?.title || `${rewardsSummary.badges?.length || 0} Badges`}
                </Link>
                <span className="text-xs font-medium text-slate-600">
                  Civic Rewards: <strong>{rewardsSummary.total_points} pts</strong>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2.5 w-full md:w-auto">
          <Link to="/report">
            <Button variant="primary" size="md" className="w-full sm:w-auto" icon={PlusCircle}>
              Report New Issue
            </Button>
          </Link>
          <Button
            variant="outline"
            size="md"
            className="w-full sm:w-auto text-slate-600"
            icon={RefreshCw}
            disabled={loading}
            onClick={loadComplaints}
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Phase 10 Citizen Rewards Summary (Rendered ONLY when rewards feature is enabled) */}
      <CitizenRewardsSummaryCard summary={rewardsSummary} />

      {/* KPI Cards */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <StatisticsCard
          title="My Reports"
          value={loading ? '...' : stats.total}
          subtitle="Grievances submitted by you"
          icon={FileText}
          colorScheme="blue"
        />
        <StatisticsCard
          title="Resolved"
          value={loading ? '...' : stats.resolved}
          subtitle="Fixed & verified by municipal crew"
          icon={CheckCircle}
          colorScheme="emerald"
        />
        <StatisticsCard
          title="In Progress"
          value={loading ? '...' : stats.inProgress}
          subtitle="Assigned & being repaired"
          icon={Clock}
          colorScheme="amber"
        />
        <StatisticsCard
          title="Pending Queue"
          value={loading ? '...' : stats.pending}
          subtitle="Submitted or under municipal review"
          icon={AlertCircle}
          colorScheme="slate"
        />
      </section>

      {/* Error Notice Banner */}
      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
            <div>
              <p className="text-sm font-bold text-rose-900">Failed to load grievance data</p>
              <p className="text-xs text-rose-700 mt-0.5">{error}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={loadComplaints} icon={RefreshCw}>
            Retry
          </Button>
        </div>
      )}

      {/* My Reports Table / List */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        {/* Table Header & Tabs */}
        <div className="p-5 sm:p-6 border-b border-slate-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">My Submitted Grievances</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Track real-time progress and inspection milestones of your reports
            </p>
          </div>

          {/* Status Filter Tabs (including Rejected) */}
          <div className="flex flex-wrap items-center gap-1 bg-slate-100 p-1 rounded-xl">
            {['all', 'pending', 'in progress', 'resolved', 'rejected'].map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilterTab(tab)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg capitalize transition-colors ${
                  filterTab === tab
                    ? 'bg-white text-slate-900 shadow-2xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* Complaints List States */}
        {loading ? (
          /* Loading State Skeleton */
          <div className="p-6 divide-y divide-slate-100 space-y-4">
            {[1, 2, 3].map((n) => (
              <div key={n} className="pt-4 first:pt-0 flex items-start gap-4 animate-pulse">
                <div className="w-16 h-16 bg-slate-200 rounded-xl shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-slate-200 rounded w-1/4" />
                  <div className="h-3 bg-slate-200 rounded w-1/2" />
                  <div className="h-3 bg-slate-200 rounded w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : displayedComplaints.length > 0 ? (
          <div className="divide-y divide-slate-100">
            {displayedComplaints.map((item) => (
              <div
                key={item.id}
                className="p-5 sm:p-6 hover:bg-slate-50/70 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
              >
                <div className="flex items-start gap-4">
                  <img
                    src={item.imageUrl || DEFAULT_IMAGE_FALLBACK}
                    alt={item.title}
                    className="w-16 h-16 rounded-xl object-cover border border-slate-200 shrink-0 bg-slate-100"
                    onError={(e) => {
                      e.target.onerror = null;
                      e.target.src = DEFAULT_IMAGE_FALLBACK;
                    }}
                  />
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                        {item.complaint_number || item.id}
                      </span>
                      <StatusBadge status={item.status} size="sm" />
                    </div>
                    <h3 className="text-sm font-bold text-slate-900 line-clamp-1">
                      {item.title}
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">
                      {item.location} • Reported on {formatDate(item.created_at)}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Responsible:{' '}
                      <strong className="text-slate-600">
                        {item.departmentName || 'Awaiting Department Assignment'}
                      </strong>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                  <Link to={`/dashboard/issues/${item.complaint_number || item.id}`} className="w-full sm:w-auto">
                    <Button variant="outline" size="sm" className="w-full sm:w-auto">
                      View Audit Trail <ArrowRight className="w-3 h-3 ml-1" />
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : complaints.length === 0 ? (
          /* Empty State: No complaints ever filed by citizen */
          <div className="p-12 text-center max-w-md mx-auto">
            <div className="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto mb-4">
              <Inbox className="w-7 h-7" />
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">
              No complaints submitted yet
            </h3>
            <p className="text-xs text-slate-500 mb-6 leading-relaxed">
              You haven't filed any civic grievances. Report an issue in your locality with a photograph to notify municipal authorities.
            </p>
            <Link to="/report">
              <Button variant="primary" size="sm" icon={PlusCircle}>
                File Your First Complaint
              </Button>
            </Link>
          </div>
        ) : (
          /* Filtered Empty State: Complaints exist, but none in selected tab */
          <div className="p-12 text-center">
            <div className="w-12 h-12 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
              <XCircle className="w-6 h-6" />
            </div>
            <p className="text-sm font-medium text-slate-600 mb-1">
              No reports found in the <span className="font-semibold text-slate-900 capitalize">{filterTab}</span> filter.
            </p>
            <p className="text-xs text-slate-400 mb-4">
              You currently have no grievances matching this status category.
            </p>
            <button
              type="button"
              onClick={() => setFilterTab('all')}
              className="text-xs font-semibold text-blue-600 hover:text-blue-800 underline"
            >
              View All Submitted Reports
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
