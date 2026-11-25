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
  Image as ImageIcon,
  ExternalLink,
  CheckCircle2,
} from 'lucide-react';
import {
  fetchOfficerComplaintDetail,
  registerOfficerResolutionPhoto,
  resolveOfficerComplaint,
  uploadOfficerResolutionPhoto,
} from '../../services/slaApiService';
import { transitionComplaintStatus, isComplaintOverdue } from '../../services/adminService';
import { validateImageFile } from '../../services/storageService';
import { useAuth } from '../../context/AuthContext';
import StatusBadge from '../../components/common/StatusBadge';
import PriorityBadge from '../../components/common/PriorityBadge';
import ComplaintTimeline from '../../components/issues/ComplaintTimeline';
import ComplaintLocationMap from '../../components/maps/ComplaintLocationMap';

const INITIAL_PHOTO_STATE = {
  status: 'idle', // 'idle' | 'uploading' | 'registration_failed' | 'completed' | 'error'
  fileName: '',
  previewUrl: '',
  storagePath: null,
  width: null,
  height: null,
  errorMessage: null,
};

function createSafePreviewUrl(file) {
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      return URL.createObjectURL(file);
    } catch {
      return '';
    }
  }
  return '';
}

function revokeSafePreviewUrl(url) {
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore cleanup errors
    }
  }
}

export default function OfficerComplaintDetailsPage({ fetcher = null, resolutionApi = null }) {
  const { id } = useParams();
  const { officerRecord } = useAuth();

  const [complaint, setComplaint] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pageNotice, setPageNotice] = useState(null);

  const [transitionModalOpen, setTransitionModalOpen] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState(null);
  const [publicDescription, setPublicDescription] = useState('');
  const [photoState, setPhotoState] = useState(INITIAL_PHOTO_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [timeoutChecking, setTimeoutChecking] = useState(false);
  const [statusCheckFailed, setStatusCheckFailed] = useState(false);
  const [transitionError, setTransitionError] = useState(null);

  const loadDetailFn = fetcher || fetchOfficerComplaintDetail;
  const uploadPhotoFn = resolutionApi?.uploadPhoto || uploadOfficerResolutionPhoto;
  const registerPhotoFn = resolutionApi?.registerPhoto || registerOfficerResolutionPhoto;
  const resolveFn = resolutionApi?.resolveComplaint || resolveOfficerComplaint;
  const transitionFn = resolutionApi?.transitionComplaint || transitionComplaintStatus;

  const resetPhotoState = useCallback(() => {
    setPhotoState((prev) => {
      revokeSafePreviewUrl(prev.previewUrl);
      return INITIAL_PHOTO_STATE;
    });
  }, []);

  useEffect(() => {
    return () => {
      revokeSafePreviewUrl(photoState.previewUrl);
    };
  }, [photoState.previewUrl]);

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
    resetPhotoState();
    setTransitionError(null);
    setStatusCheckFailed(false);
    setTimeoutChecking(false);
    setPageNotice(null);
    setTransitionModalOpen(true);
  };

  const handleCloseModal = () => {
    if (submitting || timeoutChecking) return;
    resetPhotoState();
    setTransitionError(null);
    setStatusCheckFailed(false);
    setTransitionModalOpen(false);
  };

  const handleResolutionFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !complaint) return;

    setTransitionError(null);
    setStatusCheckFailed(false);

    const validation = validateImageFile(file);
    if (!validation.valid) {
      resetPhotoState();
      setPhotoState({
        ...INITIAL_PHOTO_STATE,
        status: 'error',
        fileName: file.name || '',
        errorMessage: validation.error,
      });
      return;
    }

    const previewUrl = createSafePreviewUrl(file);
    setPhotoState((prev) => {
      revokeSafePreviewUrl(prev.previewUrl);
      return {
        status: 'uploading',
        fileName: file.name || 'completion-photo',
        previewUrl,
        storagePath: null,
        width: null,
        height: null,
        errorMessage: null,
      };
    });

    try {
      const uploaded = await uploadPhotoFn(complaint.id, file);
      setPhotoState((prev) => ({
        ...prev,
        status: 'completed',
        storagePath: uploaded.storage_path,
        width: uploaded.width || null,
        height: uploaded.height || null,
        errorMessage: null,
      }));
    } catch (err) {
      const pendingPath = err?.data?.registration_pending ? err?.data?.storage_path : null;
      if (pendingPath) {
        setPhotoState((prev) => ({
          ...prev,
          status: 'registration_failed',
          storagePath: pendingPath,
          errorMessage:
            err?.message ||
            'The photo was uploaded, but saving its completion record failed. Please retry saving the record.',
        }));
      } else {
        setPhotoState((prev) => ({
          ...prev,
          status: 'error',
          storagePath: null,
          errorMessage: err?.message || 'Unable to verify and upload completion photograph.',
        }));
      }
    }
  };

  const handleRetryRegistration = async () => {
    if (!complaint || !photoState.storagePath || photoState.status !== 'registration_failed') return;
    setTransitionError(null);
    setPhotoState((prev) => ({ ...prev, status: 'uploading', errorMessage: null }));

    try {
      const registered = await registerPhotoFn(complaint.id, photoState.storagePath);
      setPhotoState((prev) => ({
        ...prev,
        status: 'completed',
        storagePath: registered.storage_path,
        width: registered.width || null,
        height: registered.height || null,
        errorMessage: null,
      }));
    } catch (err) {
      setPhotoState((prev) => ({
        ...prev,
        status: 'registration_failed',
        errorMessage:
          err?.message || 'Still unable to save the completion photo record. Please try again.',
      }));
    }
  };

  const recheckRealStatusAfterTimeout = async () => {
    if (!id) return;
    setTimeoutChecking(true);
    setStatusCheckFailed(false);
    setTransitionError(null);
    try {
      const fresh = await loadDetailFn(id);
      if (!fresh) {
        throw new Error('Could not load updated complaint status.');
      }
      setComplaint(fresh);

      if (fresh.status === 'resolved') {
        resetPhotoState();
        setTransitionModalOpen(false);
        setPageNotice('Request timed out, and status check confirmed this complaint is already marked resolved.');
        return;
      }

      if (fresh.status !== 'in_progress') {
        setTransitionError(
          `Request timed out. Real status is now "${fresh.status}", so it can no longer be resolved here.`
        );
        return;
      }

      setTransitionError(
        'The resolve request timed out. Real status is still "in progress" — you can safely try marking it resolved again.'
      );
    } catch {
      setStatusCheckFailed(true);
      setTransitionError(
        'The resolve request timed out and checking the current status failed. Re-check the complaint status before retrying.'
      );
    } finally {
      setTimeoutChecking(false);
    }
  };

  const handleSubmitTransition = async (e) => {
    e.preventDefault();
    if (!complaint || !transitionTarget || submitting || timeoutChecking) return;

    if (transitionTarget === 'resolved') {
      if (statusCheckFailed) {
        setTransitionError('Re-check the complaint status before retrying resolution.');
        return;
      }
      if (photoState.status !== 'completed' || !photoState.storagePath) {
        setTransitionError('Attach and verify a completion photograph before marking resolved.');
        return;
      }
      if (!publicDescription || publicDescription.trim().length < 10) {
        setTransitionError('A public resolution summary of at least 10 characters is required.');
        return;
      }

      setSubmitting(true);
      setTransitionError(null);
      try {
        await resolveFn(complaint.id, {
          expectedUpdatedAt: complaint.updated_at,
          publicDescription: publicDescription.trim(),
          resolutionImagePath: photoState.storagePath,
        });
        resetPhotoState();
        setTransitionModalOpen(false);
        setPageNotice('Complaint marked resolved with verified completion photograph.');
        await loadDetails();
      } catch (err) {
        if (err?.isTimeout || err?.name === 'AbortError' || err?.status === 504) {
          setSubmitting(false);
          await recheckRealStatusAfterTimeout();
          return;
        }
        setTransitionError(err?.message || 'Failed to mark complaint resolved.');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    setSubmitting(true);
    setTransitionError(null);
    try {
      const { error: rpcErr } = await transitionFn({
        complaintId: complaint.id,
        newStatus: transitionTarget,
        expectedUpdatedAt: complaint.updated_at,
        publicDescription: publicDescription.trim() || null,
        internalNote: null,
        resolutionImagePath: null,
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

      {pageNotice && (
        <div
          role="status"
          className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800 flex items-center gap-2"
        >
          <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{pageNotice}</span>
        </div>
      )}

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

            {/* Problem Photograph */}
            <div className="space-y-2 text-xs pt-2 border-t border-slate-100">
              <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-teal-600" /> Problem Photograph
              </span>
              {complaint.signed_image_url ? (
                <div className="rounded-xl overflow-hidden border border-slate-200 max-h-96 bg-slate-900 flex items-center justify-center relative">
                  <img
                    src={complaint.signed_image_url}
                    alt="Problem Evidence"
                    className="max-h-96 w-full object-contain"
                  />
                  <a
                    href={complaint.signed_image_url}
                    target="_blank"
                    rel="noreferrer"
                    className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-black/70 hover:bg-black text-white text-xs rounded-lg backdrop-blur-xs transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Full Resolution
                  </a>
                </div>
              ) : (
                <div className="p-6 text-center bg-slate-50 rounded-xl border border-dashed border-slate-300 text-slate-500">
                  No problem photograph attached.
                </div>
              )}
            </div>

            {/* Completion Photograph if available */}
            {complaint.signed_completion_url && (
              <div className="space-y-2 text-xs pt-2 border-t border-slate-100">
                <span className="font-bold text-emerald-700 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Completion Photograph
                </span>
                <div className="rounded-xl overflow-hidden border border-emerald-200 max-h-96 bg-slate-900 flex items-center justify-center relative">
                  <img
                    src={complaint.signed_completion_url}
                    alt="Completion Evidence"
                    className="max-h-96 w-full object-contain"
                  />
                  <a
                    href={complaint.signed_completion_url}
                    target="_blank"
                    rel="noreferrer"
                    className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-black/70 hover:bg-black text-white text-xs rounded-lg backdrop-blur-xs transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Full Resolution
                  </a>
                </div>
              </div>
            )}

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
                ? 'Submit Verified Completion Photo & Resolve'
                : 'Commence Fieldwork'}
            </h3>

            {transitionTarget === 'resolved' && (
              <p className="text-slate-600 leading-relaxed">
                Attach a completion photograph (JPEG, PNG, or WebP up to 8 MB). Mark Resolved stays disabled until the photo is verified and saved. Location metadata (EXIF/GPS) is removed automatically before storage.
              </p>
            )}

            {timeoutChecking && (
              <div role="status" className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                <span>The resolve request timed out. Checking the complaint&apos;s real status before allowing another attempt...</span>
              </div>
            )}

            {transitionError && (
              <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 space-y-2">
                <p>{transitionError}</p>
                {statusCheckFailed && (
                  <button
                    type="button"
                    onClick={recheckRealStatusAfterTimeout}
                    disabled={timeoutChecking}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-700 text-white font-semibold hover:bg-rose-800 disabled:opacity-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Re-check Complaint Status
                  </button>
                )}
              </div>
            )}

            {transitionTarget === 'resolved' && (
              <div className="space-y-3">
                <label htmlFor="officer-proof-file" className="block font-semibold text-slate-700">
                  Completion Photograph *
                </label>
                <div className="border-2 border-dashed border-slate-300 rounded-xl p-4 bg-slate-50 space-y-3">
                  <div className="flex items-center gap-2">
                    <Upload className="w-4 h-4 text-teal-600 shrink-0" />
                    <input
                      id="officer-proof-file"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={submitting || timeoutChecking || photoState.status === 'uploading'}
                      onChange={handleResolutionFileChange}
                      className="w-full"
                    />
                  </div>

                  {photoState.previewUrl && (
                    <img
                      src={photoState.previewUrl}
                      alt="Completion photo preview"
                      className="max-h-40 mx-auto rounded-lg object-contain border border-slate-200 bg-white"
                    />
                  )}

                  {!photoState.previewUrl && photoState.fileName && photoState.status !== 'idle' && (
                    <div className="flex items-center justify-center gap-1.5 text-slate-600">
                      <ImageIcon className="w-4 h-4 text-slate-400" />
                      <span>{photoState.fileName}</span>
                    </div>
                  )}

                  {photoState.status === 'uploading' && (
                    <div role="status" className="p-2.5 rounded-lg bg-teal-50 border border-teal-200 text-teal-800 flex items-center gap-2">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                      <span>Uploading, verifying image integrity, and removing location metadata...</span>
                    </div>
                  )}

                  {photoState.status === 'completed' && (
                    <div role="status" className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center gap-2 font-semibold">
                      <Check className="w-3.5 h-3.5 shrink-0" />
                      <span>Completion photo verified and ready (location metadata removed): {photoState.fileName}</span>
                    </div>
                  )}

                  {photoState.status === 'registration_failed' && (
                    <div role="alert" className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 space-y-2">
                      <p>{photoState.errorMessage}</p>
                      <button
                        type="button"
                        onClick={handleRetryRegistration}
                        disabled={submitting || timeoutChecking}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-700 text-white font-semibold hover:bg-amber-800"
                      >
                        <RefreshCw className="w-3.5 h-3.5" /> Retry Saving Photo Record
                      </button>
                    </div>
                  )}

                  {photoState.status === 'error' && photoState.errorMessage && (
                    <div role="alert" className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800">
                      {photoState.errorMessage}
                    </div>
                  )}
                </div>
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
                placeholder={
                  transitionTarget === 'resolved'
                    ? 'Describe the repair or work completed (minimum 10 characters)...'
                    : 'Optional note about starting fieldwork...'
                }
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleCloseModal}
                disabled={submitting || timeoutChecking}
                className="px-3.5 py-2 rounded-xl border border-slate-300 font-semibold text-slate-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  submitting ||
                  timeoutChecking ||
                  statusCheckFailed ||
                  (transitionTarget === 'resolved' && photoState.status !== 'completed')
                }
                className="px-4 py-2 rounded-xl bg-teal-600 text-white font-semibold hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting
                  ? 'Submitting...'
                  : transitionTarget === 'resolved'
                  ? 'Mark Resolved'
                  : 'Confirm'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
