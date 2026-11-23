import React from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, MapPin, Calendar, Clock, Building, UserCheck, ShieldAlert, CheckCircle, Share2 } from 'lucide-react';
import { useComplaints } from '../context/ComplaintContext';
import StatusBadge from '../components/common/StatusBadge';
import ComplaintTimeline from '../components/issues/ComplaintTimeline';
import Button from '../components/common/Button';
import { formatDate } from '../utils/formatters';

export default function IssueDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { getComplaintById } = useComplaints();

  const complaint = getComplaintById(id);

  if (!complaint) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-4 border border-amber-200">
          <ShieldAlert className="w-7 h-7" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">Complaint Not Found</h2>
        <p className="text-xs text-slate-600 mb-6">
          The reference ID <span className="font-mono font-semibold">{id}</span> does not exist in the municipal registry.
        </p>
        <Link to="/issues">
          <Button variant="primary" size="md" icon={ArrowLeft}>
            Back to Explore Issues
          </Button>
        </Link>
      </div>
    );
  }

  const handleShare = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href);
      alert('Grievance link copied to clipboard!');
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-16">
      
      {/* Back button & Action Header */}
      <div className="flex items-center justify-between mb-6">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleShare}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 bg-white border border-slate-200 rounded-lg shadow-2xs hover:bg-slate-50 transition-colors"
          >
            <Share2 className="w-3.5 h-3.5" /> Share Record
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* Left Column: Complaint Details & Media */}
        <div className="lg:col-span-7 space-y-6">
          
          {/* Main Card */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-xs">
            
            {/* Header info */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <span className="font-mono text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md border border-blue-200/60">
                {complaint.id}
              </span>
              <StatusBadge status={complaint.status} size="md" />
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight mb-3">
              {complaint.title}
            </h1>

            <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-xs text-slate-500 mb-6">
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-slate-400" />
                {complaint.location}
              </span>
              <span>•</span>
              <span className="font-medium text-slate-700">{complaint.ward}</span>
              <span>•</span>
              <span className="flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                Reported {formatDate(complaint.reportedDate)} at {complaint.reportedTime || '09:00 AM'}
              </span>
            </div>

            {/* Primary Photo */}
            <div className="mb-6 rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
              <div className="p-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700 flex justify-between items-center">
                <span>Citizen Incident Evidence</span>
                <span className="text-[11px] text-slate-400 font-normal">Original Submission</span>
              </div>
              <img
                src={complaint.image}
                alt={complaint.title}
                className="w-full h-80 object-cover"
                onError={(e) => {
                  e.target.onerror = null;
                  e.target.src = 'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=800&q=80';
                }}
              />
            </div>

            {/* Completion Photo if resolved */}
            {complaint.completionImage && (
              <div className="mb-6 rounded-xl overflow-hidden border border-emerald-200 bg-emerald-50/30">
                <div className="p-2.5 bg-emerald-100/60 border-b border-emerald-200 text-xs font-semibold text-emerald-800 flex justify-between items-center">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-600" /> Municipal Completion Proof
                  </span>
                  <span className="text-[11px] text-emerald-700 font-mono">Work Verified</span>
                </div>
                <img
                  src={complaint.completionImage}
                  alt="Remediation completed proof"
                  className="w-full h-72 object-cover"
                />
              </div>
            )}

            {/* Description */}
            <div>
              <h3 className="text-sm font-bold text-slate-900 mb-2">
                Problem Description & Citizen Statement
              </h3>
              <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">
                {complaint.description}
              </p>
            </div>

          </div>

          {/* Department Responsibility Card */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
            <h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
              <Building className="w-4 h-4 text-blue-600" />
              Administrative Routing
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <span className="text-slate-400 block mb-1">Responsible Municipal Department</span>
                <span className="font-semibold text-slate-800 text-sm">{complaint.department}</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <span className="text-slate-400 block mb-1">Assigned Field Engineer</span>
                <span className="font-semibold text-slate-800 text-sm">{complaint.assignedOfficer || 'Desk Assigned'}</span>
              </div>
            </div>
          </div>

        </div>

        {/* Right Column: Progress Timeline */}
        <div className="lg:col-span-5 space-y-6">
          
          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs">
            <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-100">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Resolution Progress
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Real-time municipal audit trail
                </p>
              </div>
              <StatusBadge status={complaint.status} size="sm" />
            </div>

            <ComplaintTimeline
              timeline={complaint.timeline}
              currentStatus={complaint.status}
            />
          </div>

          {/* Civic SLA Notice */}
          <div className="bg-blue-50/70 border border-blue-200/80 rounded-2xl p-5 text-xs text-blue-900">
            <h4 className="font-bold flex items-center gap-1.5 mb-1.5 text-blue-950">
              <Clock className="w-4 h-4 text-blue-600" />
              Automated Escalation Policy
            </h4>
            <p className="leading-relaxed text-blue-800">
              If an assigned officer does not post an update or initiate work within the stipulated SLA timeframe, this complaint is automatically flagged in the Municipal Admin Escalation Queue.
            </p>
          </div>

        </div>

      </div>

    </div>
  );
}
