import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ShieldCheck, Info, Camera, CheckSquare, Clock } from 'lucide-react';
import ReportForm, { clearPendingSubmission } from '../components/forms/ReportForm';

export default function ReportIssuePage() {
  const location = useLocation();
  const freshToken = location.state?.fresh ?? null;
  const prevFreshRef = useRef(freshToken);
  const [formInstanceKey, setFormInstanceKey] = useState(0);

  useEffect(() => {
    if (freshToken && prevFreshRef.current !== freshToken) {
      prevFreshRef.current = freshToken;
      clearPendingSubmission();
      setFormInstanceKey((prev) => prev + 1);
    }
  }, [freshToken]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-16">
      
      {/* Header */}
      <div className="max-w-3xl mb-8">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 border border-blue-200/80 text-blue-700 text-xs font-semibold mb-3">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Municipal Citizen Grievance Portal</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-900 tracking-tight">
          Report a Civic Grievance
        </h1>
        <p className="text-sm text-slate-600 mt-2 leading-relaxed">
          Provide accurate details about the problem. Verified submissions are indexed with an SLA clock and assigned to designated ward officers.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* Main Form Column */}
        <div className="lg:col-span-8">
          <ReportForm
            key={formInstanceKey}
            onStartFresh={() => setFormInstanceKey((prev) => prev + 1)}
          />
        </div>

        {/* Informational Sidebar Column */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* Submission Guidelines */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-2xs">
            <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
              <CheckSquare className="w-4 h-4 text-blue-600" />
              Submission Guidelines
            </h3>
            <ul className="space-y-3 text-xs text-slate-600">
              <li className="flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                <span><strong>Clear Photograph:</strong> Capture the issue in daylight with surrounding landmarks visible.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                <span><strong>Precise Location:</strong> Mention nearby road junctions, house numbers, or prominent shops.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0" />
                <span><strong>Safety Risk:</strong> Highlight if the damage poses immediate danger to pedestrians or two-wheelers.</span>
              </li>
            </ul>
          </div>

          {/* SLA Turnaround Benchmarks */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-2xs">
            <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
              <Clock className="w-4 h-4 text-emerald-600" />
              Municipal SLA Benchmarks
            </h3>
            <div className="space-y-2 text-xs text-slate-600">
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span>Water Supply Leaks</span>
                <span className="font-semibold text-slate-900">18 - 24 Hours</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span>Garbage & Overflowing Bins</span>
                <span className="font-semibold text-slate-900">24 Hours</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-100">
                <span>Streetlight Failures</span>
                <span className="font-semibold text-slate-900">36 Hours</span>
              </div>
              <div className="flex justify-between py-1">
                <span>Pothole Repair & Asphalt</span>
                <span className="font-semibold text-slate-900">48 Hours</span>
              </div>
            </div>
          </div>

          {/* Emergency Escalation */}
          <div className="bg-slate-900 text-white rounded-2xl p-6">
            <h4 className="text-sm font-bold mb-1">Critical Hazards?</h4>
            <p className="text-xs text-slate-300 leading-relaxed mb-3">
              For open live electric cables, major gas leaks, or collapsing storm culverts, contact the 24x7 emergency helpline directly.
            </p>
            <div className="text-xs font-mono font-bold text-amber-400 bg-slate-800 px-3 py-1.5 rounded-lg inline-block">
              Emergency Desk: 1912
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
