import React, { useState, useEffect } from 'react';
import {
  Users,
  UserCheck,
  Plus,
  RefreshCw,
  Mail,
  Phone,
  Building,
  MapPin,
  FileText,
  AlertCircle,
  Power,
  X,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import {
  fetchAdminOfficers,
  fetchAdminDepartments,
  linkOfficerUser,
  updateOfficerStatus,
} from '../../services/adminService';
import { formatDateTime } from '../../utils/formatters';

export default function AdminOfficersPage() {
  const [officers, setOfficers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Link Officer Modal State
  const [showModal, setShowModal] = useState(false);
  const [formData, setFormData] = useState({
    email: '',
    departmentId: '',
    officialName: '',
    designation: '',
    assignedWard: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [actionSuccess, setActionSuccess] = useState(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    const [offRes, deptRes] = await Promise.all([
      fetchAdminOfficers(),
      fetchAdminDepartments(),
    ]);

    if (offRes.error) {
      setError(offRes.error.message || 'Failed to load officer roster.');
    } else {
      setOfficers(offRes.data || []);
    }

    if (deptRes.data) {
      setDepartments(deptRes.data);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleToggleActive = async (officer) => {
    const nextState = !officer.is_active;
    const msg = nextState
      ? `Activate officer "${officer.official_name}"?`
      : `Deactivate officer "${officer.official_name}"? The database will block deactivation if this officer holds active open complaints.`;

    if (!window.confirm(msg)) return;

    setActionSuccess(null);
    const { error: err } = await updateOfficerStatus({
      officerId: officer.id,
      isActive: nextState,
    });

    if (err) {
      alert(`Action Blocked: ${err.message}`);
    } else {
      setActionSuccess(`Officer ${officer.official_name} status updated successfully.`);
      await loadData();
    }
  };

  const handleLinkSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setActionSuccess(null);

    if (!formData.email.trim() || !formData.departmentId || !formData.officialName.trim() || !formData.designation.trim()) {
      setFormError('Registered email, department, official name, and designation are required.');
      setSubmitting(false);
      return;
    }

    try {
      const res = await linkOfficerUser({
        email: formData.email.trim(),
        departmentId: formData.departmentId,
        officialName: formData.officialName.trim(),
        designation: formData.designation.trim(),
        assignedWard: formData.assignedWard.trim() || null,
      });

      if (res.error) {
        setFormError(res.error.message || 'Failed to link officer.');
      } else {
        setShowModal(false);
        setActionSuccess(`User ${formData.email} successfully linked as municipal officer.`);
        setFormData({
          email: '',
          departmentId: '',
          officialName: '',
          designation: '',
          assignedWard: '',
        });
        await loadData();
      }
    } catch (err) {
      setFormError(err.message || 'Unexpected failure linking officer.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">
            Municipal Officer Directory & Personnel
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Authoritative municipal staff roster, division designations, and assigned jurisdictional wards.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 shadow-2xs transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              setFormError(null);
              setShowModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 shadow-xs transition"
          >
            <Plus className="w-3.5 h-3.5" /> Link Registered User
          </button>
        </div>
      </div>

      {actionSuccess && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800 text-xs flex items-center justify-between">
          <span>{actionSuccess}</span>
          <button onClick={() => setActionSuccess(null)} className="text-emerald-600 hover:text-emerald-800">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Directory Table */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-xs text-slate-500 space-y-3">
            <RefreshCw className="w-6 h-6 animate-spin text-blue-600 mx-auto" />
            <p>Loading officer personnel roster...</p>
          </div>
        ) : error ? (
          <div className="p-12 text-center text-xs space-y-3">
            <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
            <p className="font-bold text-slate-800">Unable to load officer roster</p>
            <p className="text-slate-500">{error}</p>
          </div>
        ) : officers.length === 0 ? (
          <div className="p-12 text-center text-xs text-slate-500 space-y-2">
            <Users className="w-8 h-8 text-slate-400 mx-auto mb-2" />
            <p className="font-bold text-slate-800">No Officers Currently Linked</p>
            <p className="max-w-sm mx-auto">
              Link registered users to a municipal division to designate them as field verification engineers.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold uppercase tracking-wider">
                <tr>
                  <th className="py-3.5 px-4">Officer Name & Title</th>
                  <th className="py-3.5 px-4">Municipal Department</th>
                  <th className="py-3.5 px-4">Authorized Email & Contact</th>
                  <th className="py-3.5 px-4">Assigned Ward</th>
                  <th className="py-3.5 px-4">Active Cases</th>
                  <th className="py-3.5 px-4">Status</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {officers.map((off) => (
                  <tr
                    key={off.id}
                    className={`hover:bg-slate-50/80 transition-colors ${
                      !off.is_active ? 'bg-slate-50/50 opacity-70' : ''
                    }`}
                  >
                    {/* Name & Title */}
                    <td className="py-3.5 px-4">
                      <div className="font-bold text-slate-900">{off.official_name}</div>
                      <div className="text-[11px] text-slate-500">{off.designation}</div>
                    </td>

                    {/* Department */}
                    <td className="py-3.5 px-4 font-medium text-slate-800">
                      <div>{off.department_name}</div>
                      <div className="font-mono text-[10px] text-slate-400">{off.department_code}</div>
                    </td>

                    {/* Email & Phone */}
                    <td className="py-3.5 px-4">
                      <div className="font-mono text-slate-700 flex items-center gap-1.5">
                        <Mail className="w-3 h-3 text-slate-400 shrink-0" />
                        {off.officer_email || 'No email available'}
                      </div>
                      {off.officer_phone && (
                        <div className="text-[11px] text-slate-500 flex items-center gap-1.5 mt-0.5">
                          <Phone className="w-3 h-3 text-slate-400 shrink-0" />
                          {off.officer_phone}
                        </div>
                      )}
                    </td>

                    {/* Assigned Ward */}
                    <td className="py-3.5 px-4 text-slate-700">
                      {off.assigned_ward ? (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-slate-400" />
                          {off.assigned_ward}
                        </span>
                      ) : (
                        <span className="text-slate-400 italic">All Division Wards</span>
                      )}
                    </td>

                    {/* Active & Resolved Count */}
                    <td className="py-3.5 px-4 font-mono">
                      <span className="font-bold text-slate-900">{off.active_complaints_count || 0}</span>{' '}
                      <span className="text-slate-400">active</span> /{' '}
                      <span className="text-emerald-600 font-semibold">{off.resolved_complaints_count || 0}</span>{' '}
                      <span className="text-slate-400">resolved</span>
                    </td>

                    {/* Active Status Badge */}
                    <td className="py-3.5 px-4">
                      <span
                        className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${
                          off.is_active
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'bg-slate-200 text-slate-600'
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            off.is_active ? 'bg-emerald-500' : 'bg-slate-400'
                          }`}
                        />
                        {off.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="py-3.5 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(off)}
                        className={`inline-flex items-center gap-1 font-semibold text-xs transition ${
                          off.is_active
                            ? 'text-slate-500 hover:text-rose-600'
                            : 'text-emerald-600 hover:text-emerald-800'
                        }`}
                      >
                        <Power className="w-3.5 h-3.5" />
                        {off.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Link Officer Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-2xs p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">Link Registered User as Officer</h3>
                <p className="text-xs text-slate-500">
                  Promotes an existing registered citizen account to officer role and assigns a municipal department.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleLinkSubmit} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Registered Account Email *
                </label>
                <input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="officer.smith@example.com"
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  User must have registered an account beforehand.
                </p>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Municipal Department *
                </label>
                <select
                  required
                  value={formData.departmentId}
                  onChange={(e) => setFormData({ ...formData, departmentId: e.target.value })}
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                >
                  <option value="">-- Select Department --</option>
                  {departments
                    .filter((d) => d.is_active)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.code})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Official Name *</label>
                  <input
                    type="text"
                    required
                    value={formData.officialName}
                    onChange={(e) => setFormData({ ...formData, officialName: e.target.value })}
                    placeholder="e.g. Er. Rajesh Kumar"
                    className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Designation *</label>
                  <input
                    type="text"
                    required
                    value={formData.designation}
                    onChange={(e) => setFormData({ ...formData, designation: e.target.value })}
                    placeholder="e.g. Senior Road Inspector"
                    className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Assigned Ward Jurisdictions (Optional)
                </label>
                <input
                  type="text"
                  value={formData.assignedWard}
                  onChange={(e) => setFormData({ ...formData, assignedWard: e.target.value })}
                  placeholder="e.g. Ward 4, Ward 5"
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 bg-slate-100 text-slate-700 hover:bg-slate-200 font-semibold rounded-xl transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-xs disabled:opacity-50 transition"
                >
                  {submitting ? 'Linking...' : 'Link Officer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
