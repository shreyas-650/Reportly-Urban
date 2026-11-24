import React, { useState, useEffect } from 'react';
import {
  Building,
  Plus,
  RefreshCw,
  Clock,
  Mail,
  AlertCircle,
  CheckCircle2,
  Users,
  FileText,
  Edit2,
  ShieldAlert,
  Power,
  X,
} from 'lucide-react';
import {
  fetchAdminDepartments,
  updateAdminDepartment,
  createAdminDepartment,
} from '../../services/adminService';

export default function AdminDepartmentsPage() {
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modal State for New/Edit Department
  const [showModal, setShowModal] = useState(false);
  const [editingDept, setEditingDept] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    code: '',
    description: '',
    default_sla_hours: 48,
    contact_email: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const loadDepartments = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await fetchAdminDepartments();
    if (err) {
      setError(err.message || 'Failed to load municipal departments.');
    } else {
      setDepartments(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadDepartments();
  }, []);

  const openCreateModal = () => {
    setEditingDept(null);
    setFormData({
      name: '',
      code: '',
      description: '',
      default_sla_hours: 48,
      contact_email: '',
    });
    setFormError(null);
    setShowModal(true);
  };

  const openEditModal = (dept) => {
    setEditingDept(dept);
    setFormData({
      name: dept.name,
      code: dept.code,
      description: dept.description || '',
      default_sla_hours: dept.default_sla_hours || 48,
      contact_email: dept.contact_email || '',
    });
    setFormError(null);
    setShowModal(true);
  };

  const handleToggleActive = async (dept) => {
    const nextState = !dept.is_active;
    const confirmMsg = nextState
      ? `Activate department "${dept.name}"?`
      : `Deactivate department "${dept.name}"? Active officers in this department will no longer receive new complaint assignments.`;

    if (!window.confirm(confirmMsg)) return;

    const { error: err } = await updateAdminDepartment(dept.id, { is_active: nextState });
    if (err) {
      alert(`Deactivation blocked: ${err.message}`);
    } else {
      await loadDepartments();
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);

    if (!formData.name.trim() || !formData.code.trim()) {
      setFormError('Department name and unique code are required.');
      setSubmitting(false);
      return;
    }

    try {
      if (editingDept) {
        const { error: updateErr } = await updateAdminDepartment(editingDept.id, {
          name: formData.name.trim(),
          description: formData.description.trim() || null,
          default_sla_hours: Number(formData.default_sla_hours) || 48,
          contact_email: formData.contact_email.trim() || null,
        });
        if (updateErr) throw updateErr;
      } else {
        const { error: createErr } = await createAdminDepartment(formData);
        if (createErr) throw createErr;
      }

      setShowModal(false);
      await loadDepartments();
    } catch (err) {
      setFormError(err.message || 'Operation failed.');
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
            Municipal Departments & Civic Divisions
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Maintain municipal division structures, standard turnaround SLAs, and officer allocations.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadDepartments}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-xs font-semibold hover:bg-slate-50 shadow-2xs transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 shadow-xs transition"
          >
            <Plus className="w-3.5 h-3.5" /> Add Division
          </button>
        </div>
      </div>

      {/* Directory Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-44 bg-slate-200 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="bg-white border border-rose-200 rounded-2xl p-8 text-center space-y-3">
          <AlertCircle className="w-8 h-8 text-rose-500 mx-auto" />
          <h3 className="font-bold text-slate-900">Failed to load department directory</h3>
          <p className="text-xs text-slate-500">{error}</p>
        </div>
      ) : departments.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center text-xs text-slate-500 space-y-2">
          <Building className="w-8 h-8 text-slate-400 mx-auto mb-2" />
          <p className="font-bold text-slate-800">No Municipal Departments Found</p>
          <p>Click "Add Division" to configure your first municipal division.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {departments.map((dept) => (
            <div
              key={dept.id}
              className={`bg-white border rounded-2xl p-5 shadow-xs flex flex-col justify-between transition-all ${
                dept.is_active ? 'border-slate-200 hover:border-slate-300' : 'border-slate-200 bg-slate-50/60 opacity-80'
              }`}
            >
              <div>
                {/* Top Badge & Code */}
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="font-mono text-[11px] font-bold text-blue-700 bg-blue-50 px-2.5 py-0.5 rounded border border-blue-200">
                    {dept.code}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                      dept.is_active
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${dept.is_active ? 'bg-emerald-500' : 'bg-slate-400'}`}
                    />
                    {dept.is_active ? 'Active Division' : 'Inactive'}
                  </span>
                </div>

                {/* Name & Description */}
                <h3 className="text-base font-bold text-slate-900 tracking-tight">{dept.name}</h3>
                <p className="text-xs text-slate-500 mt-1 line-clamp-2 min-h-[32px]">
                  {dept.description || 'General urban civic operations and infrastructure maintenance.'}
                </p>

                {/* Metadata */}
                <div className="mt-4 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2 text-xs text-slate-600">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span>SLA: {dept.default_sla_hours} hrs</span>
                  </div>
                  <div className="flex items-center gap-1.5 truncate">
                    <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="truncate">{dept.contact_email || 'No email set'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span>
                      {dept.activeOfficers} Active ({dept.totalOfficers} Total)
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span>{dept.activeComplaints} Open Cases</span>
                  </div>
                </div>
              </div>

              {/* Actions Footer */}
              <div className="mt-5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
                <button
                  type="button"
                  onClick={() => openEditModal(dept)}
                  className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-800 transition"
                >
                  <Edit2 className="w-3.5 h-3.5" /> Edit Configuration
                </button>

                <button
                  type="button"
                  onClick={() => handleToggleActive(dept)}
                  className={`inline-flex items-center gap-1 font-semibold transition ${
                    dept.is_active ? 'text-slate-500 hover:text-rose-600' : 'text-emerald-600 hover:text-emerald-800'
                  }`}
                  title={dept.is_active ? 'Deactivate Department' : 'Activate Department'}
                >
                  <Power className="w-3.5 h-3.5" />
                  {dept.is_active ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal for Create/Edit */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-2xs p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">
                {editingDept ? `Edit Department: ${editingDept.name}` : 'Create Municipal Division'}
              </h3>
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

            <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Division Name *</label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g. Roads & Bridges"
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Unique Code * {!editingDept && <span className="text-slate-400 font-normal">(Uppercase)</span>}
                </label>
                <input
                  type="text"
                  required
                  disabled={Boolean(editingDept)}
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  placeholder="e.g. DEPT_ROADS"
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 uppercase font-mono disabled:opacity-60 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Description</label>
                <textarea
                  rows={2}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Mandate and scope of this civic department..."
                  className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Default SLA (Hours)</label>
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={formData.default_sla_hours}
                    onChange={(e) => setFormData({ ...formData, default_sla_hours: e.target.value })}
                    className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Contact Email</label>
                  <input
                    type="email"
                    value={formData.contact_email}
                    onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
                    placeholder="dept@city.gov"
                    className="w-full py-2 px-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>
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
                  {submitting ? 'Saving...' : editingDept ? 'Update Division' : 'Create Division'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
