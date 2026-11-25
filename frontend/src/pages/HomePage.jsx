import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PlusCircle, Search, ArrowRight, ShieldCheck, CheckCircle2, Clock, MapPin, Users, Award, AlertTriangle, AlertCircle, RefreshCw } from 'lucide-react';
import Button from '../components/common/Button';
import StatisticsCard from '../components/dashboard/StatisticsCard';
import IssueCategoryCard from '../components/issues/IssueCategoryCard';
import IssueCard from '../components/issues/IssueCard';
import { ISSUE_CATEGORIES } from '../data/categories';
import {
  fetchPublicComplaints,
  fetchPublicStats,
  formatResolutionDuration,
  formatResolutionRate,
} from '../services/publicService';

export default function HomePage() {
  const navigate = useNavigate();

  const [publicStats, setPublicStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');
  const statsAbortRef = useRef(null);

  const [recentComplaints, setRecentComplaints] = useState([]);
  const [recentLoading, setRecentLoading] = useState(true);
  const [recentError, setRecentError] = useState('');
  const recentAbortRef = useRef(null);

  const loadStats = useCallback(async () => {
    if (statsAbortRef.current) {
      statsAbortRef.current.abort();
    }
    const controller = new AbortController();
    statsAbortRef.current = controller;

    setStatsLoading(true);
    setStatsError('');
    try {
      const data = await fetchPublicStats({ signal: controller.signal });
      if (!controller.signal.aborted) {
        setPublicStats(data);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      setStatsError(err.message || 'Unable to load citywide accountability metrics.');
    } finally {
      if (!controller.signal.aborted) {
        setStatsLoading(false);
      }
    }
  }, []);

  const loadRecentComplaints = useCallback(async () => {
    if (recentAbortRef.current) {
      recentAbortRef.current.abort();
    }
    const controller = new AbortController();
    recentAbortRef.current = controller;

    setRecentLoading(true);
    setRecentError('');
    try {
      const data = await fetchPublicComplaints(
        { page: 1, pageSize: 3 },
        { signal: controller.signal }
      );
      if (!controller.signal.aborted) {
        setRecentComplaints(Array.isArray(data?.items) ? data.items.slice(0, 3) : []);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (err.status === 429) {
        setRecentError('Too many requests, try again shortly.');
      } else if (err.status === 503) {
        setRecentError('Public complaints service is temporarily unavailable. Please try again shortly.');
      } else {
        setRecentError(err.message || 'Unable to load recent public complaints.');
      }
    } finally {
      if (!controller.signal.aborted) {
        setRecentLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadRecentComplaints();
    return () => {
      if (statsAbortRef.current) {
        statsAbortRef.current.abort();
      }
      if (recentAbortRef.current) {
        recentAbortRef.current.abort();
      }
    };
  }, [loadStats, loadRecentComplaints]);

  const handleCategorySelect = (categoryId) => {
    navigate(`/issues?category=${categoryId}`);
  };

  return (
    <div className="space-y-16 lg:space-y-24 pb-16">
      
      {/* Hero Section */}
      <section className="relative pt-12 pb-16 lg:pt-20 lg:pb-24 border-b border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-3xl mx-auto">
            
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200/80 text-blue-700 text-xs font-semibold mb-6">
              <ShieldCheck className="w-4 h-4 text-blue-600" />
              <span>Civic Accountability & Transparent Governance</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-slate-900 tracking-tight leading-[1.15] mb-6">
              Your City. Your Voice.{' '}
              <span className="text-blue-600">Your Responsibility.</span>
            </h1>

            <p className="text-base sm:text-lg text-slate-600 leading-relaxed mb-8 max-w-2xl mx-auto">
              Reportly Urban bridges citizens with municipal departments. Snap a photo of potholes, trash accumulation, broken lights, or drainage failures and track resolution with timestamped audits.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3.5">
              <Link to="/report" className="w-full sm:w-auto">
                <Button variant="primary" size="lg" className="w-full sm:w-auto px-7" icon={PlusCircle}>
                  Report an Issue
                </Button>
              </Link>
              <Link to="/issues" className="w-full sm:w-auto">
                <Button variant="outline" size="lg" className="w-full sm:w-auto px-7" icon={Search}>
                  Explore Reported Issues
                </Button>
              </Link>
            </div>

            <div className="mt-10 flex flex-wrap items-center justify-center gap-6 text-xs text-slate-500 font-medium">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Direct Municipal Routing
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-blue-600" /> Enforced SLA Deadlines
              </span>
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-slate-600" /> Photographic Verification
              </span>
            </div>

          </div>
        </div>
      </section>

      {/* Statistics Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-8 sm:-mt-12">
        {statsLoading && !publicStats ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6" aria-busy="true">
            {[...Array(4)].map((_, idx) => (
              <div
                key={idx}
                className="bg-white rounded-2xl border border-slate-200/90 p-5 h-32 animate-pulse"
              >
                <div className="h-3 w-24 bg-slate-200 rounded mb-4" />
                <div className="h-7 w-16 bg-slate-200 rounded mb-2" />
                <div className="h-3 w-32 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        ) : statsError && !publicStats ? (
          <div className="bg-white rounded-2xl border border-rose-200 p-5 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Citywide statistics temporarily unavailable
                </p>
                <p className="text-xs text-slate-500 mt-0.5">{statsError}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={loadStats}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
              <StatisticsCard
                title="Total Reports"
                value={Number(publicStats?.total ?? 0).toLocaleString()}
                subtitle="Non-rejected public reports"
                icon={ShieldCheck}
                colorScheme="blue"
              />
              <StatisticsCard
                title="Issues Resolved"
                value={Number(publicStats?.resolved ?? 0).toLocaleString()}
                subtitle="Verified work completed"
                icon={CheckCircle2}
                colorScheme="emerald"
                trend={
                  publicStats?.resolution_rate !== null &&
                  publicStats?.resolution_rate !== undefined
                    ? `${formatResolutionRate(publicStats.resolution_rate)} Rate`
                    : undefined
                }
              />
              <StatisticsCard
                title="Active In Progress"
                value={Number(publicStats?.pending ?? 0).toLocaleString()}
                subtitle={`${Number(publicStats?.overdue ?? 0).toLocaleString()} overdue (${Number(
                  publicStats?.no_deadline_count ?? 0
                ).toLocaleString()} no deadline)`}
                icon={Clock}
                colorScheme="amber"
              />
              <StatisticsCard
                title="Avg. Resolution"
                value={formatResolutionDuration(publicStats?.avg_resolution_hours)}
                subtitle="From submission to resolved"
                icon={Clock}
                colorScheme="slate"
              />
            </div>
            <div className="flex justify-end">
              <Link
                to="/accountability"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 transition-colors"
              >
                <span>View Ward & Department Accountability Dashboard</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          </div>
        )}
      </section>

      {/* How It Works Section */}
      <section id="how-it-works" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 scroll-mt-20">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
            Simple 3-Step Process
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-2 tracking-tight">
            How Reportly Urban Works
          </h2>
          <p className="text-sm text-slate-600 mt-2">
            A frictionless workflow designed to bring civic issues from citizen notice to physical resolution.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          
          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs relative">
            <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-lg mb-5 border border-blue-100">
              01
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">1. Report an Issue</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Capture a photograph of the road damage, garbage, or water leakage, choose the category and tag your ward location.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs relative">
            <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-lg mb-5 border border-blue-100">
              02
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">2. Track Its Progress</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Receive a tracking complaint ID. View real-time status as the issue is verified, assigned to ward engineers, and remediated.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs relative">
            <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-lg mb-5 border border-blue-100">
              03
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">3. See Your City Improve</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Review completion photos uploaded by the municipal team. Confirm the repair, rate the speed, and earn citizen recognition badges.
            </p>
          </div>

        </div>
      </section>

      {/* Issue Categories Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-8 gap-4">
          <div>
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
              Municipal Services
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-1 tracking-tight">
              Reportable Civic Categories
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 mt-1">
              Select any issue category to view existing reports or file a fresh complaint.
            </p>
          </div>
          <Link
            to="/report"
            className="text-xs font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
          >
            File Custom Report <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {ISSUE_CATEGORIES.map((category) => (
            <IssueCategoryCard
              key={category.id}
              category={category}
              onClick={handleCategorySelect}
            />
          ))}
        </div>
      </section>

      {/* Recent Issues Section */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-8 gap-4">
          <div>
            <span className="text-xs font-semibold text-blue-600 uppercase tracking-wider">
              Civic Activity Feed
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-1 tracking-tight">
              Recently Reported Issues
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 mt-1">
              Recent non-rejected civic records across city wards. Locations are shown at ward level only.
            </p>
          </div>
          <Link
            to="/issues"
            className="text-xs font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
          >
            View All Public Reports <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {recentLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6" aria-busy="true">
            {[...Array(3)].map((_, idx) => (
              <div
                key={idx}
                className="bg-white rounded-xl border border-slate-200 p-5 h-44 animate-pulse space-y-3"
              >
                <div className="flex justify-between">
                  <div className="h-4 w-24 bg-slate-200 rounded" />
                  <div className="h-5 w-20 bg-slate-200 rounded-full" />
                </div>
                <div className="h-5 w-3/4 bg-slate-200 rounded" />
                <div className="h-4 w-1/2 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        ) : recentError ? (
          <div
            role="alert"
            className="bg-rose-50 border border-rose-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-rose-950">
                  Unable to load recent public complaints
                </p>
                <p className="text-xs text-rose-800 mt-0.5">{recentError}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" icon={RefreshCw} onClick={loadRecentComplaints}>
              Retry
            </Button>
          </div>
        ) : recentComplaints.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-2">
            <AlertCircle className="w-6 h-6 text-slate-500 mx-auto" />
            <p className="text-sm font-semibold text-slate-900">
              No public complaints recorded yet
            </p>
            <p className="text-xs text-slate-500">
              Verified public civic reports will appear here as they are logged.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {recentComplaints.map((complaint) => (
              <IssueCard key={complaint.public_reference} complaint={complaint} />
            ))}
          </div>
        )}
      </section>

      {/* Civic Action Banner */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-slate-900 rounded-3xl p-8 sm:p-12 text-white relative overflow-hidden flex flex-col md:flex-row items-center justify-between gap-8">
          <div className="max-w-xl space-y-3 text-center md:text-left">
            <h3 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Spotted a problem in your neighborhood?
            </h3>
            <p className="text-sm text-slate-300 leading-relaxed">
              It takes less than 60 seconds to file a report. Every verified report helps municipal crews prioritize repair work in your ward.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 w-full md:w-auto">
            <Link to="/report">
              <Button variant="primary" size="lg" className="w-full sm:w-auto bg-blue-500 hover:bg-blue-600" icon={PlusCircle}>
                Report an Issue Now
              </Button>
            </Link>
            <Link to="/dashboard">
              <Button variant="secondary" size="lg" className="w-full sm:w-auto bg-slate-800 hover:bg-slate-700 text-white border border-slate-700">
                Citizen Dashboard
              </Button>
            </Link>
          </div>
        </div>
      </section>

    </div>
  );
}
