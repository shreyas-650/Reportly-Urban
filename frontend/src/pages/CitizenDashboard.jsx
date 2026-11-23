import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { PlusCircle, Award, CheckCircle, Clock, AlertCircle, FileText, ArrowRight, UserCheck, RotateCcw } from 'lucide-react';
import Button from '../components/common/Button';
import StatisticsCard from '../components/dashboard/StatisticsCard';
import StatusBadge from '../components/common/StatusBadge';
import { useComplaints } from '../context/ComplaintContext';
import { MOCK_CITIZEN_PROFILE } from '../data/mockStats';
import { formatDate } from '../utils/formatters';

export default function CitizenDashboard() {
  const { complaints, stats, resetToSampleData } = useComplaints();
  const [filterTab, setFilterTab] = useState('all');

  const userComplaints = complaints.filter((c) => c.isUserReport);

  const displayedComplaints = userComplaints.filter((c) => {
    if (filterTab === 'all') return true;
    return c.status.toLowerCase() === filterTab.toLowerCase();
  });

  const userStats = {
    total: userComplaints.length,
    resolved: userComplaints.filter((c) => c.status.toLowerCase() === 'resolved').length,
    inProgress: userComplaints.filter((c) => c.status.toLowerCase() === 'in progress').length,
    pending: userComplaints.filter((c) => c.status.toLowerCase() === 'pending').length,
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-16 space-y-10">
      
      {/* Welcome Citizen Profile Banner */}
      <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-blue-600 text-white flex items-center justify-center font-bold text-2xl shadow-sm shadow-blue-500/20">
            {MOCK_CITIZEN_PROFILE.name.charAt(0)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-extrabold text-slate-900 tracking-tight">
                Welcome back, {MOCK_CITIZEN_PROFILE.name}
              </h1>
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-full">
                <UserCheck className="w-3 h-3" /> Verified Citizen
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {MOCK_CITIZEN_PROFILE.ward} • {MOCK_CITIZEN_PROFILE.email}
            </p>
            <div className="flex items-center gap-3 mt-3">
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg">
                <Award className="w-3.5 h-3.5" /> {MOCK_CITIZEN_PROFILE.level}
              </span>
              <span className="text-xs font-medium text-slate-600">
                Civic Score: <strong>{MOCK_CITIZEN_PROFILE.civicPoints} pts</strong>
              </span>
            </div>
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
            icon={RotateCcw}
            onClick={() => {
              if (window.confirm('Reset local demo complaints to sample data?')) {
                resetToSampleData();
              }
            }}
          >
            Reset Demo Data
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <StatisticsCard
          title="My Reports"
          value={userStats.total}
          subtitle="Grievances submitted by you"
          icon={FileText}
          colorScheme="blue"
        />
        <StatisticsCard
          title="Resolved"
          value={userStats.resolved}
          subtitle="Fixed & verified by municipal crew"
          icon={CheckCircle}
          colorScheme="emerald"
        />
        <StatisticsCard
          title="In Progress"
          value={userStats.inProgress}
          subtitle="Assigned & being repaired"
          icon={Clock}
          colorScheme="amber"
        />
        <StatisticsCard
          title="Pending Queue"
          value={userStats.pending}
          subtitle="Awaiting triage & inspector roster"
          icon={AlertCircle}
          colorScheme="slate"
        />
      </section>

      {/* My Reports Table / List */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        
        {/* Table Header & Tabs */}
        <div className="p-5 sm:p-6 border-b border-slate-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              My Submitted Grievances
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Track real-time progress and inspection milestones of your reports
            </p>
          </div>

          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
            {['all', 'in progress', 'resolved', 'pending'].map((tab) => (
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

        {/* Complaints List */}
        {displayedComplaints.length > 0 ? (
          <div className="divide-y divide-slate-100">
            {displayedComplaints.map((item) => (
              <div
                key={item.id}
                className="p-5 sm:p-6 hover:bg-slate-50/70 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
              >
                <div className="flex items-start gap-4">
                  <img
                    src={item.image}
                    alt={item.title}
                    className="w-16 h-16 rounded-xl object-cover border border-slate-200 shrink-0"
                    onError={(e) => {
                      e.target.onerror = null;
                      e.target.src = 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=800&q=80';
                    }}
                  />
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                        {item.id}
                      </span>
                      <StatusBadge status={item.status} size="sm" />
                    </div>
                    <h3 className="text-sm font-bold text-slate-900 line-clamp-1">
                      {item.title}
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">
                      {item.location} • Reported on {formatDate(item.reportedDate)}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Responsible: <strong>{item.department}</strong>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                  <Link to={`/issues/${item.id}`} className="w-full sm:w-auto">
                    <Button variant="outline" size="sm" className="w-full sm:w-auto">
                      View Audit Trail <ArrowRight className="w-3 h-3 ml-1" />
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-12 text-center">
            <p className="text-sm text-slate-500 mb-4">
              No reports found in the <span className="font-semibold">{filterTab}</span> filter.
            </p>
            <Link to="/report">
              <Button variant="primary" size="sm" icon={PlusCircle}>
                File a Complaint
              </Button>
            </Link>
          </div>
        )}

      </section>

    </div>
  );
}
