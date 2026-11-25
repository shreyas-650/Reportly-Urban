import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Building,
  Clock,
  MapPin,
  AlertTriangle,
  ShieldAlert,
  RefreshCw,
  History,
  AlertCircle,
  Check,
  Lock,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { fetchOfficerComplaintDetail } from '../../services/slaApiService';
import { transitionComplaintStatus, isComplaintOverdue } from '../../services/adminService';
import { uploadResolutionImage, validateImageFile } from '../../services/storageService';
import { useAuth } from '../../context/AuthContext';
import StatusBadge from '../../components/common/StatusBadge';
import PriorityBadge from '../../components/common/PriorityBadge';
import ComplaintTimeline from '../../components/issues/ComplaintTimeline';
import ComplaintLocationMap from '../../components/maps/ComplaintLocationMap';

export default function OfficerComplaintDetailsPage({ fetcher = null }) {
  const { id } = useParams();
  const { officerRecord } = useAuth();

  const [complaint, setComplaint] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [transitionModalOpen, setTransitionModalOpen] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState(null);
  const [publicDescription, setPublicDescription] = useState('');
  const [resolutionFile, setResolutionFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [transitionError, setTransitionError] = useState(null);

  const loadDetailFn = fetcher || fetchOfficerComplaintDetail;

  const loadDetails = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await loadDetailFn(id);
      setComplaint(data);
    } catch (err) {
      setError(err?.message || 'Unable to load complaint details.');
      setComplaint(null);
    } finally {
      setLoading(false);
    }
  }, [id, loadDetailFn]);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  const isAssignedOfficer = Boolean(
    officerRecord?.id && complaint?.assigned_officer_id && officerRecord.id === complaint.assigned_officer_id
  );

  const handleOpenTransition = (target) => {
    setTransitionTarget(target);
    setPublicDescription('');
    setResolutionFile(null);
    setTransitionError(null);
    setTransitionModalOpen(true);
  };

  const handleSubmitTransition = async (e) => {
    e.preventDefault();
    if (!complaint || !transitionTarget || submitting) return;
    setSubmitting(true);
    setTransitionError(null);

    try {
      let uploadedPath = null;
      if (transitionTarget === 'resolved') {
        if (!publicDescription || publicDescription.trim().length < 10) {
          throw new Error('A public resolution summary of at least 10 characters is required.');
        }
        if (!resolutionFile) {
          throw new Error('A completion photograph is required to resolve this complaint.');
        }
        const validation = validateImageFile(resolutionFile);
        if (!validation.valid) {
          throw new Error(validation.error);
        }
        const uploadRes = await uploadResolutionImage({
          file: resolutionFile,
          complaintId: complaint.id,
        });
        if (uploadRes.error) {
          throw new Error(uploadRes.error.message || 'Failed to upload completion image.');
        }
        uploadedPath = uploadRes.data.path;
      }

      const { error: rpcErr } = await transitionComplaintStatus({
        complaintId: complaint.id,
        newStatus: transitionTarget,
        expectedUpdatedAt: complaint.updated_at,
        publicDescription: publicDescription.trim() || null,
        internalNote: null,
        resolutionImagePath: uploadedPath,
      });

      if (rpcErr) {
        throw new Error(rpcErr.message || 'Status transition failed.');
      }

      setTransitionModalOpen(false);
      await loadDetails();
    } catch (err) {
      setTransitionError(err?.message || 'Failed to update complaint status.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4 animate-pulse">
        <div className="h-6 bg-slate-200 rounded w-40" />
        <div className="h-64 bg-slate-200 rounded-2xl" />
      </div>
    );
  }

  if (error || !complaint) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="bg-white border border-rose-200 rounded-2xl p-8 text-center space-y-4">
          <AlertCircle className="w-8 h-8 text-rose-600 mx-auto" />
          <h1 className="text-lg font-bold text-slate-900">
            {error || 'Complaint not found or access denied.'}
          </h1>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={loadDetails}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
            <Link
              to="/officer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back to Officer Alerts
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const overdue = isComplaintOverdue(complaint);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <Link
          to="/officer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600 rounded"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Officer Alerts
        </Link>

        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-xs font-bold text-teal-800 bg-teal-50 px-3 py-1 rounded-lg border border-teal-200">
            {complaint.complaint_reference}
          </span>
          <StatusBadge status={complaint.status} size="sm" />
          <PriorityBadge priority={complaint.priority} size="sm" />
          {overdue && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">
              <AlertTriangle className="w-3.5 h-3.5" /> Overdue
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                {String(complaint.category || '').replace(/_/g, ' ')}
              </div>
              <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 mt-1">
                {complaint.title}
              </h1>
              <div className="text-xs text-slate-600 mt-2 flex flex-wrap gap-3">
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-teal-600" />
                  {complaint.location} ({complaint.ward})
                </span>
                {complaint.department_name && (
                  <span className="inline-flex items-center gap-1">
                    <Building className="w-3.5 h-3.5 text-slate-500" />
                    {complaint.department_name}
                  </span>
                )}
              </div>
            </div>

            <p className="text-sm text-slate-700 bg-slate-50 p-4 rounded-xl border border-slate-100 leading-relaxed">
              {complaint.description}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <span className="text-slate-500 block">SLA Deadline</span>
                <span className="font-semibold text-slate-900">
                  {complaint.sla_deadline
                    ? new Date(complaint.sla_deadline).toLocaleString()
                    : 'Not scheduled'}
                </span>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                <span className="text-slate-500 block">Escalation Level</span>
                <span className="font-semibold text-slate-900">
                  Level {complaint.current_level || 0}
                </span>
              </div>
            </div>

            <ComplaintLocationMap
              latitude={complaint.latitude}
              longitude={complaint.longitude}
              locationName={complaint.location}
              ward={complaint.ward}
              complaintNumber={complaint.complaint_reference}
              showDirections={true}
            />
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
              <History className="w-4 h-4 text-teal-600" />
              Sanitized Status Progress
            </h2>
            <ComplaintTimeline
              timeline={complaint.timeline || []}
              currentStatus={complaint.status}
            />
          </div>
        </div>

        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <Clock className="w-4 h-4 text-teal-600" />
                Officer Field Actions
              </h2>
              <StatusBadge status={complaint.status} size="sm" />
            </div>

            {complaint.status === 'resolved' || complaint.status === 'rejected' ? (
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 flex items-center gap-2">
                <Lock className="w-4 h-4 text-slate-400 shrink-0" />
                This complaint is in a terminal state ({complaint.status}).
              </div>
            ) : !isAssignedOfficer ? (
              <p className="text-xs text-slate-500">
                Status actions are restricted to the currently assigned field officer.
              </p>
            ) : complaint.status === 'under_review' ? (
              <button
                type="button"
                onClick={() => handleOpenTransition('in_progress')}
                className="w-full py-2.5 px-4 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold flex items-center justify-center gap-2"
              >
                <Check className="w-4 h-4" /> Commence Fieldwork (In Progress)
              </button>
            ) : complaint.status === 'in_progress' ? (
              <button
                type="button"
                onClick={() => handleOpenTransition('resolved')}
                className="w-full py-2.5 px-4 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold flex items-center justify-center gap-2"
              >
                <ShieldCheck className="w-4 h-4" /> Upload Completion Proof &amp; Resolve
              </button>
            ) : (
              <p className="text-xs text-slate-500">
                Awaiting administrative triage review before fieldwork begins.
              </p>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-3">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-teal-600" />
              Escalations for This Case
            </h2>
            {!complaint.escalations || complaint.escalations.length === 0 ? (
              <p className="text-xs text-slate-500">No escalation records on this case.</p>
            ) : (
              <ul className="space-y-2.5 text-xs">
                {complaint.escalations.map((esc) => (
                  <li key={esc.id} className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                    <div className="flex items-center justify-between font-bold text-slate-900">
                      <span>Level {esc.from_level} &rarr; Level {esc.to_level}</span>
                      <span className="text-[11px] font-normal text-slate-500">
                        {new Date(esc.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-slate-700">{esc.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {transitionModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
        >
          <form
            onSubmit={handleSubmitTransition}
            className="bg-white rounded-2xl border border-slate-200 max-w-md w-full p-6 shadow-xl space-y-4 text-xs"
          >
            <h3 className="text-base font-bold text-slate-900">
              {transitionTarget === 'resolved'
                ? 'Submit Resolution Evidence'
                : 'Commence Fieldwork'}
            </h3>

            {transitionError && (
              <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800">
                {transitionError}
              </div>
            )}

            <div>
              <label htmlFor="officer-public-desc" className="block font-semibold text-slate-700 mb-1">
                Public Progress Note {transitionTarget === 'resolved' ? '*' : '(Optional)'}
              </label>
              <textarea
                id="officer-public-desc"
                rows={3}
                value={publicDescription}
                onChange={(e) => setPublicDescription(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900"
              />
            </div>

            {transitionTarget === 'resolved' && (
              <div>
                <label htmlFor="officer-proof-file" className="block font-semibold text-slate-700 mb-1">
                  Completion Photograph *
                </label>
                <div className="flex items-center gap-2">
                  <Upload className="w-4 h-4 text-teal-600" />
                  <input
                    id="officer-proof-file"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => setResolutionFile(e.target.files?.[0] || null)}
                    className="w-full"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setTransitionModalOpen(false)}
                disabled={submitting}
                className="px-3.5 py-2 rounded-xl border border-slate-300 font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-xl bg-teal-600 text-white font-semibold hover:bg-teal-700 disabled:opacity-50"
              >
                {submitting ? 'Submitting...' : 'Confirm'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
