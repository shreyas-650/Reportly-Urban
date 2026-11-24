import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  MapPin,
  Calendar,
  Clock,
  Building,
  ShieldAlert,
  CheckCircle,
  Share2,
  AlertCircle,
  RefreshCw,
  Tag,
  ShieldCheck,
} from 'lucide-react';
import StatusBadge from '../components/common/StatusBadge';
import ComplaintTimeline from '../components/issues/ComplaintTimeline';
import ComplaintLocationMap from '../components/maps/ComplaintLocationMap';
import Button from '../components/common/Button';
import { useAuth } from '../context/AuthContext';
import { fetchComplaintDetails } from '../services/complaintService';
import { formatDate, formatDateTime, formatStatusLabel } from '../utils/formatters';

const DEFAULT_IMAGE_FALLBACK =
  'https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&w=800&q=80';

export default function IssueDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, isAuthenticated, loading: authLoading } = useAuth();

  const [complaint, setComplaint] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copiedShare, setCopiedShare] = useState(false);

  const loadDetails = useCallback(async () => {
    if (!id) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchComplaintDetails({ identifier: id });

      if (result.error) {
        setError(result.error.message || 'Failed to retrieve complaint details.');
        setComplaint(null);
      } else {
        setComplaint(result.data || null);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'An unexpected error occurred while loading complaint details.'
      );
      setComplaint(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!authLoading) {
      loadDetails();
    }
  }, [authLoading, loadDetails]);

  const handleShare = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href);
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 2500);
    }
  };

  // ---------------------------------------------------------------------------
  // Loading Skeleton State
  // ---------------------------------------------------------------------------
  if (loading || authLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-16 animate-pulse space-y-6">
        <div className="h-6 bg-slate-200 rounded w-24" />
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="lg:col-span-7 space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-8 space-y-4">
              <div className="flex justify-between">
                <div className="h-6 bg-slate-200 rounded w-32" />
                <div className="h-6 bg-slate-200 rounded w-24" />
              </div>
              <div className="h-8 bg-slate-200 rounded w-3/4" />
              <div className="h-4 bg-slate-200 rounded w-1/2" />
              <div className="h-72 bg-slate-200 rounded-xl" />
              <div className="h-20 bg-slate-200 rounded-xl" />
            </div>
          </div>
          <div className="lg:col-span-5 space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 p-7 h-96" />
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Not Found / Access Restricted State (Enforces RLS & Cross-Citizen Privacy)
  // ---------------------------------------------------------------------------
  if (!complaint && !error) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <div className="w-16 h-16 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-4 border border-amber-200">
          <ShieldAlert className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">
          Complaint Not Found or Access Restricted
        </h2>
        <p className="text-xs text-slate-600 mb-6 max-w-md mx-auto leading-relaxed">
          The reference ID <span className="font-mono font-semibold text-slate-900">{id}</span> does not exist in your authorized municipal records or belongs to another citizen account.
        </p>
        <div className="flex justify-center gap-3">
          <Link to="/dashboard">
            <Button variant="primary" size="md" icon={ArrowLeft}>
              Back to My Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error State with Retry
  // ---------------------------------------------------------------------------
  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16 text-center">
        <div className="w-16 h-16 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-4 border border-rose-200">
          <AlertCircle className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">Error Loading Complaint</h2>
        <p className="text-xs text-rose-700 mb-6 max-w-md mx-auto">{error}</p>
        <div className="flex justify-center gap-3">
          <Button variant="primary" size="md" onClick={loadDetails} icon={RefreshCw}>
            Retry Request
          </Button>
          <Link to="/dashboard">
            <Button variant="outline" size="md">
              Return to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Full Complaint Details & Audit Timeline View
  // ---------------------------------------------------------------------------
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-16">
      {/* Navigation & Action Bar */}
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
            <Share2 className="w-3.5 h-3.5" />
            {copiedShare ? 'Copied to Clipboard!' : 'Share Record'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: Complaint Details & Photographic Media */}
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-xs">
            {/* Header info */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <span className="font-mono text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md border border-blue-200/60">
                {complaint.complaint_number || complaint.id}
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
                Reported {formatDateTime(complaint.created_at)}
              </span>
            </div>

            {/* Primary Incident Photograph (Signed Private Storage URL with Fallback) */}
            <div className="mb-6 rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
              <div className="p-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700 flex justify-between items-center">
                <span>Citizen Incident Evidence</span>
                <span className="text-[11px] text-slate-400 font-normal">Original Submission</span>
              </div>
              <img
                src={complaint.imageUrl || DEFAULT_IMAGE_FALLBACK}
                alt={complaint.title}
                className="w-full h-80 object-cover bg-slate-100"
                onError={(e) => {
                  e.target.onerror = null;
                  e.target.src = DEFAULT_IMAGE_FALLBACK;
                }}
              />
            </div>

            {/* Municipal Completion Proof (if resolved with completion photograph) */}
            {complaint.completionImageUrl && (
              <div className="mb-6 rounded-xl overflow-hidden border border-emerald-200 bg-emerald-50/30">
                <div className="p-2.5 bg-emerald-100/60 border-b border-emerald-200 text-xs font-semibold text-emerald-800 flex justify-between items-center">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-600" /> Municipal Completion Proof
                  </span>
                  <span className="text-[11px] text-emerald-700 font-mono">Work Verified</span>
                </div>
                <img
                  src={complaint.completionImageUrl}
                  alt="Remediation completed proof"
                  className="w-full h-72 object-cover"
                  onError={(e) => {
                    e.target.onerror = null;
                    e.target.src = DEFAULT_IMAGE_FALLBACK;
                  }}
                />
              </div>
            )}

            {/* Official Resolution Summary (if resolved) */}
            {complaint.resolution_description && (
              <div className="mb-6 p-4 rounded-xl border border-emerald-200 bg-emerald-50/50">
                <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-800 mb-1.5 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" />
                  Official Municipal Resolution Statement
                </h3>
                <p className="text-sm text-emerald-950 leading-relaxed font-medium">
                  {complaint.resolution_description}
                </p>
              </div>
            )}

            {/* Problem Description */}
            <div>
              <h3 className="text-sm font-bold text-slate-900 mb-2">
                Problem Description & Citizen Statement
              </h3>
              <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-100">
                {complaint.description}
              </p>
            </div>
          </div>

          {/* Department Responsibility & Priority Card */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
            <h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
              <Building className="w-4 h-4 text-blue-600" />
              Administrative Routing & Classification
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-100">
                <span className="text-slate-400 block mb-1">Responsible Municipal Department</span>
                <span className="font-semibold text-slate-800 text-sm">
                  {complaint.departmentName || 'Awaiting Department Assignment'}
                </span>
              </div>
              <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-100">
                <span className="text-slate-400 block mb-1">Civic Category & Priority</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-semibold text-slate-800 text-sm capitalize">
                    {complaint.category?.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[11px] font-medium uppercase px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                    {complaint.priority || 'Normal'} Priority
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Incident Geospatial Location & Navigation */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
            <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
              <MapPin className="w-4 h-4 text-blue-600" />
              Incident Geospatial Location
            </h3>
            <ComplaintLocationMap
              latitude={complaint.latitude}
              longitude={complaint.longitude}
              locationName={complaint.location}
              ward={complaint.ward}
              complaintNumber={complaint.complaint_number}
              showDirections={true}
            />
          </div>
        </div>

        {/* Right Column: Progress Timeline */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs">
            <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-100">
              <div>
                <h3 className="text-base font-bold text-slate-900">Resolution Progress</h3>
                <p className="text-xs text-slate-500 mt-0.5">Real-time municipal audit trail</p>
              </div>
              <StatusBadge status={complaint.status} size="sm" />
            </div>

            {/* Citizen-Safe Real-time Audit Timeline */}
            <ComplaintTimeline
              timeline={complaint.timeline || []}
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
              Complaints submitted via ReportlyUrban are bound to municipal service level agreements. If triage or field action is delayed, the complaint is automatically flagged for administrative review.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
