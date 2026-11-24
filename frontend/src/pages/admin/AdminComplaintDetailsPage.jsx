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
} from 'lucide-react';
import {
  fetchAdminComplaintDetails,
  fetchAdminDepartments,
  fetchActiveDepartmentOfficers,
  assignComplaintAdmin,
  isComplaintOverdue,
} from '../../services/adminService';
import StatusBadge from '../../components/common/StatusBadge';
import PriorityBadge from '../../components/common/PriorityBadge';
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
                      className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 text-xs flex items-center justify-between"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={sh.status} size="sm" />
                          <span className="font-semibold text-slate-800">{sh.title}</span>
                        </div>
                        {sh.notes && <p className="text-slate-500 text-[11px] mt-0.5">{sh.notes}</p>}
                      </div>
                      <span className="text-[11px] font-mono text-slate-400">
                        {formatDateTime(sh.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Triage & Assignment Workspace */}
        <div className="space-y-6">
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
    </div>
  );
}
