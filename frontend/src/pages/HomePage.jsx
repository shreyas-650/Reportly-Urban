import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PlusCircle, Search, ArrowRight, ShieldCheck, CheckCircle2, Clock, MapPin, Users, Award } from 'lucide-react';
import Button from '../components/common/Button';
import StatisticsCard from '../components/dashboard/StatisticsCard';
import IssueCategoryCard from '../components/issues/IssueCategoryCard';
import IssueCard from '../components/issues/IssueCard';
import { ISSUE_CATEGORIES } from '../data/categories';
import { useComplaints } from '../context/ComplaintContext';

export default function HomePage() {
  const { complaints, stats } = useComplaints();
  const navigate = useNavigate();

  const recentComplaints = complaints.slice(0, 3);

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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          <StatisticsCard
            title="Total Reports"
            value={(stats.total + 12480).toLocaleString()}
            subtitle="Citizen reports filed citywide"
            icon={ShieldCheck}
            colorScheme="blue"
          />
          <StatisticsCard
            title="Issues Resolved"
            value={(stats.resolved + 10115).toLocaleString()}
            subtitle="Verified work completed"
            icon={CheckCircle2}
            colorScheme="emerald"
            trend="82% Success"
          />
          <StatisticsCard
            title="Active In Progress"
            value={(stats.inProgress + stats.pending + 2365).toLocaleString()}
            subtitle="Under active remediation"
            icon={Clock}
            colorScheme="amber"
          />
          <StatisticsCard
            title="Avg. Resolution"
            value="34 Hours"
            subtitle="Municipal target SLA adherence"
            icon={Clock}
            colorScheme="slate"
          />
        </div>
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
              Live civic grievances currently registered by residents across all city wards.
            </p>
          </div>
          <Link
            to="/issues"
            className="text-xs font-semibold text-blue-600 hover:text-blue-700 inline-flex items-center gap-1"
          >
            View All Reports ({complaints.length}) <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {recentComplaints.map((complaint) => (
            <IssueCard key={complaint.id} complaint={complaint} />
          ))}
        </div>
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
