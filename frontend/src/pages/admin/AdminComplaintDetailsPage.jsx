import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Building,
  UserCheck,
  Calendar,
  Clock,
  MapPin,
  AlertTriangle,
  Flame,
  CheckCircle2,
  ShieldAlert,
  Save,
  RefreshCw,
  ExternalLink,
  History,
  AlertCircle,
  FileText,
  User,
  Phone,
  Upload,
  Image as ImageIcon,
  Check,
  XCircle,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import {
  fetchAdminComplaintDetails,
  fetchAdminDepartments,
  fetchActiveDepartmentOfficers,
  assignComplaintAdmin,
  transitionComplaintStatus,
  isComplaintOverdue,
} from '../../services/adminService';
import { uploadResolutionImage, validateImageFile } from '../../services/storageService';
import { useAuth } from '../../context/AuthContext';
import StatusBadge from '../../components/common/StatusBadge';
import PriorityBadge from '../../components/common/PriorityBadge';
import ComplaintLocationMap from '../../components/maps/ComplaintLocationMap';
import { formatDateTime } from '../../utils/formatters';

export default function AdminComplaintDetailsPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [complaint, setComplaint] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [departmentOfficers, setDepartmentOfficers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingOfficers, setLoadingOfficers] = useState(false);
  const [error, setError] = useState(null);

  // Assignment Form State
  const [selectedDeptId, setSelectedDeptId] = useState('');
  const [selectedOfficerId, setSelectedOfficerId] = useState('');
  const [selectedPriority, setSelectedPriority] = useState('normal');
  const [slaDeadlineInput, setSlaDeadlineInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  // Auth & Roles
  const { profile, officerRecord } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const isAssignedOfficer = Boolean(
    officerRecord?.id && complaint?.assigned_officer_id && officerRecord.id === complaint.assigned_officer_id
  );

  // Status Workflow Transition State
  const [transitionModalOpen, setTransitionModalOpen] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState(null);
  const [publicDescription, setPublicDescription] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [resolutionFile, setResolutionFile] = useState(null);
  const [resolutionPreview, setResolutionPreview] = useState(null);
  const [transitionSubmitting, setTransitionSubmitting] = useState(false);
  const [transitionError, setTransitionError] = useState(null);
  const [transitionSuccess, setTransitionSuccess] = useState(false);
  const [concurrencyAlert, setConcurrencyAlert] = useState(null);

  const handleOpenTransitionModal = (target) => {
    setTransitionTarget(target);
    setPublicDescription('');
    setInternalNote('');
    setResolutionFile(null);
    setResolutionPreview(null);
    setTransitionError(null);
    setConcurrencyAlert(null);
    setTransitionSuccess(false);
    setTransitionModalOpen(true);
  };

  const handleResolutionFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validation = validateImageFile(file);
    if (!validation.valid) {
      setTransitionError(validation.error);
      return;
    }
    setTransitionError(null);
    setResolutionFile(file);
    setResolutionPreview(URL.createObjectURL(file));
  };

  const handleSubmitTransition = async (e) => {
    e.preventDefault();
    if (!complaint || !transitionTarget) return;

    setTransitionSubmitting(true);
    setTransitionError(null);
    setConcurrencyAlert(null);

    try {
      // 1. Validation checks
      if (transitionTarget === 'rejected') {
        if (!publicDescription || publicDescription.trim().length < 5) {
          throw new Error('A detailed public rejection explanation (at least 5 characters) is required.');
        }
      }

      let uploadedPath = null;
      if (transitionTarget === 'resolved') {
        if (!publicDescription || publicDescription.trim().length < 10) {
          throw new Error('A clear public resolution summary (at least 10 characters) is required.');
        }
        if (!resolutionFile) {
          throw new Error('A completion evidence photograph is required to resolve this complaint.');
        }

        // Upload file to Supabase Storage resolution path
        const uploadRes = await uploadResolutionImage({
          file: resolutionFile,
          complaintId: complaint.id,
        });

        if (uploadRes.error) {
          throw new Error(`Failed to upload resolution evidence: ${uploadRes.error.message}`);
        }
        uploadedPath = uploadRes.data.path;
      }

      // 2. Execute RPC transition
      const { error: rpcError } = await transitionComplaintStatus({
        complaintId: complaint.id,
        newStatus: transitionTarget,
        expectedUpdatedAt: complaint.updated_at,
        publicDescription: publicDescription.trim() || null,
        internalNote: internalNote.trim() || null,
        resolutionImagePath: uploadedPath,
      });

      if (rpcError) {
        // Concurrency conflict check (SQLSTATE 40001)
        if (rpcError.message?.includes('Concurrency Conflict') || rpcError.code === '40001' || rpcError.code === 'P0002') {
          setConcurrencyAlert(
            'Concurrency Conflict: This record was modified by another user or session. Reloading the latest data...'
          );
          setTimeout(() => {
            setTransitionModalOpen(false);
            loadDetails();
          }, 2000);
          return;
        }
        throw rpcError;
      }

      setTransitionSuccess(true);
      setTimeout(() => {
        setTransitionModalOpen(false);
        setTransitionSuccess(false);
        loadDetails();
      }, 1000);
    } catch (err) {
      setTransitionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransitionSubmitting(false);
    }
  };

  // Load complaint details and departments
  const loadDetails = async () => {
    setLoading(true);
    setError(null);
    setSaveSuccess(false);

    const [compRes, deptRes] = await Promise.all([
      fetchAdminComplaintDetails(id),
      fetchAdminDepartments(),
    ]);

    if (compRes.error) {
      setError(compRes.error.message || 'Failed to load complaint details.');
    } else if (!compRes.data) {
      setError('Complaint not found or you lack permission to view it.');
    } else {
      const data = compRes.data;
      setComplaint(data);
      setSelectedDeptId(data.department_id || '');
      setSelectedOfficerId(data.assigned_officer_id || '');
      setSelectedPriority(data.priority || 'normal');

      if (data.sla_deadline) {
        // Format for datetime-local input (YYYY-MM-DDTHH:mm)
        const d = new Date(data.sla_deadline);
        const pad = (n) => String(n).padStart(2, '0');
        const formatted = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        setSlaDeadlineInput(formatted);
      } else {
        setSlaDeadlineInput('');
      }

      // If already assigned to a department, fetch active officers of that department
      if (data.department_id) {
        loadOfficersForDepartment(data.department_id);
      }
    }

    if (deptRes.data) {
      setDepartments(deptRes.data);
    }

    setLoading(false);
  };

  const loadOfficersForDepartment = async (deptId) => {
    if (!deptId) {
      setDepartmentOfficers([]);
      return;
    }
    setLoadingOfficers(true);
    const { data } = await fetchActiveDepartmentOfficers(deptId);
    setDepartmentOfficers(data || []);
    setLoadingOfficers(false);
  };

  useEffect(() => {
    loadDetails();
  }, [id]);

  // Handle department dropdown change
  const handleDepartmentChange = (e) => {
    const newDeptId = e.target.value;
    setSelectedDeptId(newDeptId);

    // Auto-clear officer assignment when department changes, as requested
    setSelectedOfficerId('');
    loadOfficersForDepartment(newDeptId);

    // If department has default SLA hours and no deadline is set, auto-suggest deadline
    if (newDeptId && !slaDeadlineInput) {
      const targetDept = departments.find((d) => d.id === newDeptId);
      if (targetDept?.default_sla_hours) {
        const targetDate = new Date(Date.now() + targetDept.default_sla_hours * 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const formatted = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}-${pad(targetDate.getDate())}T${pad(targetDate.getHours())}:${pad(targetDate.getMinutes())}`;
        setSlaDeadlineInput(formatted);
      }
    }
  };

  // Submit Assignment Changes
  const handleSaveAssignment = async () => {
    setShowConfirmModal(false);
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const deadlineIso = slaDeadlineInput ? new Date(slaDeadlineInput).toISOString() : null;

      const res = await assignComplaintAdmin({
        complaintId: complaint.id,
        departmentId: selectedDeptId || null,
        officerId: selectedOfficerId || null,
        priority: selectedPriority,
        slaDeadline: deadlineIso,
        expectedUpdatedAt: complaint.updated_at,
      });

      if (res.error) {
        setSaveError(res.error.message || 'Failed to update complaint assignment.');
      } else {
        setSaveSuccess(true);
        // Reload details to get fresh audit timeline and updated_at
        await loadDetails();
      }
    } catch (err) {
      setSaveError(err.message || 'Unexpected assignment failure.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-6 bg-slate-200 rounded w-1/4" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="h-96 bg-slate-200 rounded-2xl lg:col-span-2" />
          <div className="h-96 bg-slate-200 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (error || !complaint) {
    return (
      <div className="bg-white border border-rose-200 rounded-2xl p-8 text-center space-y-4">
        <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
        <h2 className="text-lg font-bold text-slate-900">{error || 'Complaint Not Found'}</h2>
        <Link
          to="/admin/complaints"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Complaint Queue
        </Link>
      </div>
    );
  }

  const overdue = isComplaintOverdue(complaint);

  return (
    <div className="space-y-6">
      {/* Top Breadcrumb & Status Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <Link
          to="/admin/complaints"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 transition"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Complaints Queue
        </Link>

        <div className="flex items-center gap-3">
          <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-3 py-1 rounded-lg border border-blue-200">
            {complaint.complaint_number}
          </span>
          <StatusBadge status={complaint.status} size="sm" />
          <PriorityBadge priority={complaint.priority} size="sm" />
          {overdue && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 border border-red-200">
              <Flame className="w-3.5 h-3.5" /> OVERDUE
            </span>
          )}
        </div>
      </div>

      {/* Main Grid: Details (Left) and Triage / Assignment Action Panel (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Evidence, Description, Location, Citizen */}
        <div className="lg:col-span-2 space-y-6">
          {/* Incident Overview Card */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-7 shadow-xs space-y-6">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                Category: {complaint.category?.replace('_', ' ')}
              </div>
              <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">
                {complaint.title}
              </h1>
            </div>

            {/* Description */}
            <div className="space-y-1.5 text-xs">
              <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px]">
                Citizen Description
              </span>
              <p className="text-slate-700 leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-200/70 whitespace-pre-line">
                {complaint.description}
              </p>
            </div>

            {/* Incident Images Gallery */}
            <div className="space-y-2 text-xs">
              <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px]">
                Incident Evidence Photograph
              </span>
              {complaint.signedImageUrl ? (
                <div className="rounded-xl overflow-hidden border border-slate-200 max-h-96 bg-slate-900 flex items-center justify-center relative group">
                  <img
                    src={complaint.signedImageUrl}
                    alt="Complaint Evidence"
                    className="max-h-96 w-full object-contain"
                  />
                  <a
                    href={complaint.signedImageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-black/70 hover:bg-black text-white text-xs rounded-lg backdrop-blur-xs transition"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Full Resolution
                  </a>
                </div>
              ) : (
                <div className="p-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-300 text-slate-400">
                  No photographic evidence attached.
                </div>
              )}
            </div>

            {/* Completion Image if available */}
            {complaint.signedCompletionUrl && (
              <div className="space-y-2 text-xs pt-4 border-t border-slate-100">
                <span className="font-bold text-emerald-700 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Resolution Completion Evidence
                </span>
                <div className="rounded-xl overflow-hidden border border-emerald-200 max-h-96 bg-slate-900 flex items-center justify-center relative">
                  <img
                    src={complaint.signedCompletionUrl}
                    alt="Resolution Completion Evidence"
                    className="max-h-96 w-full object-contain"
                  />
                </div>
              </div>
            )}

            {/* Verified Resolution Statement if resolved */}
            {complaint.resolution_description && (
              <div className="p-4 bg-emerald-50 rounded-xl border border-emerald-200 text-xs space-y-1">
                <span className="font-bold text-emerald-800 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" /> Verified Municipal Resolution Statement
                </span>
                <p className="text-emerald-950 font-medium leading-relaxed">{complaint.resolution_description}</p>
              </div>
            )}

            {/* Location & Citizen Data Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-slate-100 text-xs">
              {/* Location */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200/70 space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-slate-800">
                  <MapPin className="w-4 h-4 text-blue-600" /> Location Details
                </div>
                <div className="text-slate-700">
                  <div className="font-semibold">{complaint.location}</div>
                  <div className="text-slate-500">Ward: {complaint.ward}</div>
                  {complaint.latitude && complaint.longitude && (
                    <div className="font-mono text-[11px] text-slate-400 mt-1">
                      Coordinates: {complaint.latitude.toFixed(5)}, {complaint.longitude.toFixed(5)}
                    </div>
                  )}
                </div>
              </div>

              {/* Citizen Information */}
              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200/70 space-y-2">
                <div className="flex items-center gap-1.5 font-bold text-slate-800">
                  <User className="w-4 h-4 text-blue-600" /> Citizen Information
                </div>
                <div className="text-slate-700">
                  <div className="font-semibold">
                    {complaint.citizen?.full_name || 'Anonymous Citizen'}
                  </div>
                  {complaint.citizen?.phone_number && (
                    <div className="text-slate-500 flex items-center gap-1 mt-0.5">
                      <Phone className="w-3 h-3 text-slate-400" />
                      {complaint.citizen.phone_number}
                    </div>
                  )}
                  <div className="text-[11px] text-slate-400 mt-1">
                    Registered Ward: {complaint.citizen?.ward || 'Unspecified'} | Badge:{' '}
                    {complaint.citizen?.badge_level || 'Civic Starter'}
                  </div>
                </div>
              </div>
            </div>

            {/* Geospatial Map & Navigation Directions */}
            <div className="pt-4 border-t border-slate-100">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-3 flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-blue-600" />
                Geospatial Incident Map & Navigation
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

          {/* Combined Audit Timelines: Status & Assignment */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-7 shadow-xs space-y-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-blue-600" />
                <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                  Audit & Assignment Timeline
                </h2>
              </div>
              <span className="text-[11px] font-semibold text-slate-400">
                Immutable Governance Log
              </span>
            </div>

            {/* Assignment Changes Timeline */}
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Department & Officer Assignments History
              </h3>

              {complaint.assignmentAudit.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No administrative assignments logged yet.</p>
              ) : (
                <div className="space-y-3">
                  {complaint.assignmentAudit.map((audit) => (
                    <div
                      key={audit.id}
                      className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 text-xs space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-900">
                          {audit.actor?.full_name || 'Municipal Administrator'}{' '}
                          <span className="text-slate-400 font-normal">({audit.actor?.role || 'admin'})</span>
                        </span>
                        <span className="text-[11px] font-mono text-slate-400">
                          {formatDateTime(audit.created_at)}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-slate-600 text-[11px]">
                        <div>
                          <span className="font-semibold text-slate-500">Department:</span>{' '}
                          {audit.prev_department?.name || 'None'} →{' '}
                          <span className="font-bold text-slate-800">
                            {audit.new_department?.name || 'Unassigned'}
                          </span>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-500">Officer:</span>{' '}
                          {audit.prev_officer?.official_name || 'None'} →{' '}
                          <span className="font-bold text-slate-800">
                            {audit.new_officer?.official_name || 'Unassigned'}
                          </span>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-500">Priority:</span>{' '}
                          {audit.prev_priority} →{' '}
                          <span className="font-bold text-slate-800">{audit.new_priority}</span>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-500">SLA:</span>{' '}
                          {audit.new_sla_deadline ? formatDateTime(audit.new_sla_deadline) : 'None'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Complaint Status History */}
            <div className="space-y-3 pt-4 border-t border-slate-100">
              <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Status Transitions History
              </h3>

              {complaint.statusHistory.length === 0 ? (
                <p className="text-xs text-slate-400 italic">No status transitions recorded.</p>
              ) : (
                <div className="space-y-2.5">
                  {complaint.statusHistory.map((sh) => (
                    <div
                      key={sh.id}
                      className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 text-xs space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={sh.status} size="sm" />
                          <span className="font-semibold text-slate-800">{sh.title}</span>
                          {sh.actor && (
                            <span className="text-[10px] text-slate-400 font-mono">
                              by {sh.actor.full_name || 'Staff'} ({sh.actor.role})
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] font-mono text-slate-400">
                          {formatDateTime(sh.created_at)}
                        </span>
                      </div>

                      {sh.public_description && (
                        <div className="p-2.5 bg-white rounded-lg border border-slate-200/80 text-[11px] text-slate-700 leading-relaxed">
                          <span className="font-bold text-slate-500 uppercase tracking-wider block text-[10px] mb-0.5">
                            Public Explanation:
                          </span>
                          {sh.public_description}
                        </div>
                      )}

                      {sh.internal_note && (
                        <div className="p-2.5 bg-amber-50/80 rounded-lg border border-amber-200/80 text-[11px] text-amber-900 leading-relaxed">
                          <span className="font-bold text-amber-700 uppercase tracking-wider flex items-center gap-1 text-[10px] mb-0.5">
                            <Lock className="w-3 h-3 text-amber-600" /> Internal Remark (Restricted):
                          </span>
                          {sh.internal_note}
                        </div>
                      )}

                      {sh.notes && !sh.public_description && !sh.internal_note && (
                        <p className="text-slate-500 text-[11px] mt-0.5">{sh.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Triage & Assignment Workspace */}
        <div className="space-y-6">
          {/* Status & Lifecycle Actions Card */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-blue-600" />
                <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                  Status & Workflow
                </h2>
              </div>
              <StatusBadge status={complaint.status} size="sm" />
            </div>

            {/* Terminal State Warning */}
            {complaint.status === 'resolved' || complaint.status === 'rejected' ? (
              <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-600 text-xs flex items-start gap-2.5">
                <Lock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-slate-800">Workflow Completed (Terminal State)</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    This complaint is marked as <strong className="capitalize">{complaint.status}</strong>. Its status is immutable in this phase.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-xs">
                {/* Current Workflow Guidance */}
                <div className="p-3 bg-blue-50/60 border border-blue-200/70 rounded-xl text-blue-900">
                  <span className="font-bold block mb-0.5">Current Stage:</span>
                  {complaint.status === 'submitted' && 'Awaiting initial administrative review & department dispatch.'}
                  {complaint.status === 'under_review' && 'Reviewed by admin; awaiting assigned officer remediation.'}
                  {complaint.status === 'in_progress' && 'Field remediation active; awaiting completion proof.'}
                </div>

                {/* Action Buttons */}
                <div className="space-y-2 pt-1">
                  {/* Stage 1: Submitted -> Under Review */}
                  {complaint.status === 'submitted' && (
                    <>
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={() => handleOpenTransitionModal('under_review')}
                          className="w-full py-2.5 px-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition shadow-xs flex items-center justify-center gap-2"
                        >
                          <Check className="w-4 h-4" /> Move to Under Review
                        </button>
                      ) : (
                        <p className="text-[11px] text-slate-400 italic text-center">
                          Administrative review is required to advance from submitted status.
                        </p>
                      )}
                    </>
                  )}

                  {/* Stage 2: Under Review -> In Progress */}
                  {complaint.status === 'under_review' && (
                    <>
                      {!complaint.assigned_officer_id || !complaint.department_id ? (
                        <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-[11px]">
                          <AlertTriangle className="w-3.5 h-3.5 inline mr-1 text-amber-600" />
                          Assign a department and officer below before commencing fieldwork.
                        </div>
                      ) : isAdmin || isAssignedOfficer ? (
                        <button
                          type="button"
                          onClick={() => handleOpenTransitionModal('in_progress')}
                          className="w-full py-2.5 px-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition shadow-xs flex items-center justify-center gap-2"
                        >
                          <Check className="w-4 h-4" /> Commence Fieldwork (In Progress)
                        </button>
                      ) : (
                        <p className="text-[11px] text-slate-400 italic text-center">
                          Only the assigned officer or an administrator can commence fieldwork.
                        </p>
                      )}
                    </>
                  )}

                  {/* Stage 3: In Progress -> Resolved */}
                  {complaint.status === 'in_progress' && (
                    <>
                      {isAdmin || isAssignedOfficer ? (
                        <button
                          type="button"
                          onClick={() => handleOpenTransitionModal('resolved')}
                          className="w-full py-2.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl transition shadow-xs flex items-center justify-center gap-2"
                        >
                          <ShieldCheck className="w-4 h-4" /> Submit Completion Proof & Resolve
                        </button>
                      ) : (
                        <p className="text-[11px] text-slate-400 italic text-center">
                          Only the assigned officer or an administrator can submit resolution proof.
                        </p>
                      )}
                    </>
                  )}

                  {/* Administrative Rejection (Strictly Admin-Only) */}
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => handleOpenTransitionModal('rejected')}
                      className="w-full py-2 px-3 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 font-semibold rounded-xl transition flex items-center justify-center gap-1.5"
                    >
                      <XCircle className="w-3.5 h-3.5 text-rose-600" /> Reject Complaint (Admin Only)
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-6 sticky top-20">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
                Triage & Dispatch Workspace
              </h2>
              <span className="text-[11px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                Admin Mode
              </span>
            </div>

            {/* Feedback Notifications */}
            {saveSuccess && (
              <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Assignment & SLA changes recorded and audited successfully!</span>
              </div>
            )}

            {saveError && (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{saveError}</span>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                setShowConfirmModal(true);
              }}
              className="space-y-4 text-xs"
            >
              {/* Department Selection */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Assigned Municipal Division *
                </label>
                <select
                  value={selectedDeptId}
                  onChange={handleDepartmentChange}
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                >
                  <option value="">-- Select Division (Unassigned) --</option>
                  {departments.map((dept) => (
                    <option key={dept.id} value={dept.id} disabled={!dept.is_active}>
                      {dept.name} {!dept.is_active ? '(Inactive)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  Changing division will automatically clear the currently assigned officer.
                </p>
              </div>

              {/* Officer Selection */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Responsible Field Officer
                </label>
                <select
                  value={selectedOfficerId}
                  onChange={(e) => setSelectedOfficerId(e.target.value)}
                  disabled={!selectedDeptId || loadingOfficers}
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  <option value="">
                    {loadingOfficers
                      ? 'Loading active department engineers...'
                      : !selectedDeptId
                      ? '-- Select Department First --'
                      : '-- No Officer (Queue Only) --'}
                  </option>
                  {departmentOfficers.map((off) => (
                    <option key={off.id} value={off.id}>
                      {off.official_name} ({off.designation})
                      {off.assigned_ward ? ` — Ward: ${off.assigned_ward}` : ''}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  Strictly lists verified, active officers belonging to the selected department.
                </p>
              </div>

              {/* Priority Selection */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Operational Priority *
                </label>
                <select
                  value={selectedPriority}
                  onChange={(e) => setSelectedPriority(e.target.value)}
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                >
                  <option value="low">Low Priority</option>
                  <option value="normal">Normal</option>
                  <option value="medium">Medium</option>
                  <option value="high">High Priority</option>
                  <option value="emergency">Emergency (Immediate Escalation)</option>
                </select>
              </div>

              {/* SLA Deadline */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Resolution SLA Deadline
                </label>
                <input
                  type="datetime-local"
                  value={slaDeadlineInput}
                  onChange={(e) => setSlaDeadlineInput(e.target.value)}
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Target completion time agreed upon under municipal civic charter.
                </p>
              </div>

              {/* Submit Button */}
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-xs disabled:opacity-50 transition"
                >
                  <Save className={`w-4 h-4 ${saving ? 'animate-spin' : ''}`} />
                  {saving ? 'Enforcing & Auditing...' : 'Commit Assignment & SLA'}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-2xs p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Confirm Assignment Change</h3>
                <p className="text-xs text-slate-500">
                  This administrative update will be committed to the immutable audit log.
                </p>
              </div>
            </div>

            <div className="p-3 bg-slate-50 rounded-xl text-xs space-y-2 border border-slate-200/80">
              <div className="flex justify-between">
                <span className="text-slate-500">Department:</span>
                <span className="font-bold text-slate-900">
                  {departments.find((d) => d.id === selectedDeptId)?.name || 'Unassigned'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Officer:</span>
                <span className="font-bold text-slate-900">
                  {departmentOfficers.find((o) => o.id === selectedOfficerId)?.official_name ||
                    'Unassigned'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Priority:</span>
                <span className="font-bold capitalize text-slate-900">{selectedPriority}</span>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="px-4 py-2 bg-slate-100 text-slate-700 hover:bg-slate-200 font-semibold text-xs rounded-xl transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveAssignment}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl shadow-xs transition"
              >
                Confirm & Dispatch
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status Transition Modal */}
      {transitionModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-2xs p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2.5">
                {transitionTarget === 'resolved' ? (
                  <div className="w-9 h-9 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                ) : transitionTarget === 'rejected' ? (
                  <div className="w-9 h-9 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                    <XCircle className="w-5 h-5" />
                  </div>
                ) : (
                  <div className="w-9 h-9 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                    <RefreshCw className="w-5 h-5" />
                  </div>
                )}
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    {transitionTarget === 'resolved' && 'Submit Completion Proof & Resolve'}
                    {transitionTarget === 'rejected' && 'Reject Complaint (Permanent)'}
                    {transitionTarget === 'in_progress' && 'Commence Field Remediation'}
                    {transitionTarget === 'under_review' && 'Move Under Municipal Review'}
                  </h3>
                  <p className="text-xs text-slate-500">
                    Target status: <strong className="capitalize">{transitionTarget?.replace('_', ' ')}</strong>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTransitionModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg transition"
              >
                ✕
              </button>
            </div>

            {concurrencyAlert && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-xs flex items-center gap-2 animate-pulse">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>{concurrencyAlert}</span>
              </div>
            )}

            {transitionError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{transitionError}</span>
              </div>
            )}

            {transitionSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Status transition successfully recorded in civic audit trail!</span>
              </div>
            )}

            <form onSubmit={handleSubmitTransition} className="space-y-4 text-xs">
              {/* If resolving: require resolution photo upload */}
              {transitionTarget === 'resolved' && (
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">
                    Resolution Completion Evidence Photograph *{' '}
                    <span className="text-slate-400 font-normal">(JPEG, PNG, WebP up to 8MB)</span>
                  </label>
                  <div className="border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-xl p-4 text-center cursor-pointer bg-slate-50 transition relative">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleResolutionFileChange}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      required
                    />
                    {resolutionPreview ? (
                      <div className="space-y-2">
                        <img
                          src={resolutionPreview}
                          alt="Completion Proof Preview"
                          className="max-h-40 mx-auto rounded-lg object-contain border border-slate-200"
                        />
                        <p className="text-[11px] text-emerald-700 font-semibold flex items-center justify-center gap-1">
                          <Check className="w-3.5 h-3.5" /> File Selected: {resolutionFile?.name} (
                          {(resolutionFile?.size / (1024 * 1024)).toFixed(2)} MB)
                        </p>
                        <p className="text-[10px] text-slate-400">Click to choose a different photo</p>
                      </div>
                    ) : (
                      <div className="space-y-1 text-slate-500 py-3">
                        <Upload className="w-6 h-6 mx-auto text-slate-400" />
                        <p className="font-semibold text-slate-700">Click to upload completion photo</p>
                        <p className="text-[11px] text-slate-400">
                          Civic completion proof is verified and displayed to citizens
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Public description */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  {transitionTarget === 'resolved' && 'Public Resolution Statement * (Visible to Citizen)'}
                  {transitionTarget === 'rejected' && 'Public Rejection Explanation * (Visible to Citizen)'}
                  {(transitionTarget === 'under_review' || transitionTarget === 'in_progress') &&
                    'Public Note (Optional, Visible to Citizen)'}
                </label>
                <textarea
                  value={publicDescription}
                  onChange={(e) => setPublicDescription(e.target.value)}
                  rows={3}
                  required={transitionTarget === 'resolved' || transitionTarget === 'rejected'}
                  placeholder={
                    transitionTarget === 'resolved'
                      ? 'Describe work completed (e.g., "Road surface repaved with hot asphalt mix; site inspected and cleared for vehicular traffic.")'
                      : transitionTarget === 'rejected'
                      ? 'Explain clearly why this complaint was rejected (e.g., "Duplicate report of #RU-2026-0012 already addressed under work order 412.")'
                      : 'Optional public statement regarding current remediation stage...'
                  }
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  {transitionTarget === 'resolved' && 'Minimum 10 characters required.'}
                  {transitionTarget === 'rejected' && 'Minimum 5 characters required.'}
                </p>
              </div>

              {/* Private internal note */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1 flex items-center gap-1">
                  <Lock className="w-3 h-3 text-slate-400" />
                  Internal Staff Remark <span className="text-slate-400 font-normal">(Optional — Never exposed to citizens)</span>
                </label>
                <textarea
                  value={internalNote}
                  onChange={(e) => setInternalNote(e.target.value)}
                  rows={2}
                  placeholder="Operational notes, contractor details, or internal review remarks..."
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 font-medium focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setTransitionModalOpen(false)}
                  disabled={transitionSubmitting}
                  className="px-4 py-2 bg-slate-100 text-slate-700 hover:bg-slate-200 font-semibold text-xs rounded-xl transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={transitionSubmitting}
                  className={`px-4 py-2 text-white font-bold text-xs rounded-xl shadow-xs transition flex items-center gap-1.5 ${
                    transitionTarget === 'resolved'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : transitionTarget === 'rejected'
                      ? 'bg-rose-600 hover:bg-rose-700'
                      : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {transitionSubmitting ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      Committing Transition...
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      Confirm Status Transition
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
