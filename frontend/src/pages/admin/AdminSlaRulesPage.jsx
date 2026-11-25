import React, { useState, useEffect, useCallback } from 'react';
import {
  Sliders,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Save,
  Clock,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  fetchAdminSlaRules,
  updateAdminSlaRule,
  validateSlaRuleInput,
} from '../../services/slaApiService';

const CATEGORY_LABELS = {
  potholes: 'Potholes & Road Damage',
  garbage: 'Garbage & Sanitation',
  streetlights: 'Broken Streetlights',
  water_leakage: 'Water Supply & Leakage',
  drainage: 'Drainage & Sewage',
  public_infrastructure: 'Public Infrastructure',
};

function formatRuleCategory(category) {
  return CATEGORY_LABELS[category] || String(category || '').replace(/_/g, ' ');
}

export default function AdminSlaRulesPage({ api = null }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [editingCategory, setEditingCategory] = useState(null);
  const [formValues, setFormValues] = useState({
    sla_hours: '',
    reminder_before_hours: '',
    level2_after_hours: '',
    level3_after_hours: '',
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [successBanner, setSuccessBanner] = useState('');
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadFn = api?.fetchRules || fetchAdminSlaRules;
  const updateFn = api?.updateRule || updateAdminSlaRule;

  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await loadFn();
      setRules(Array.isArray(res?.items) ? res.items : []);
    } catch (err) {
      setError(err?.message || 'Unable to load SLA rules.');
    } finally {
      setLoading(false);
    }
  }, [loadFn]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const startEditing = (rule) => {
    setEditingCategory(rule.category);
    setFormValues({
      sla_hours: String(rule.sla_hours),
      reminder_before_hours: String(rule.reminder_before_hours),
      level2_after_hours: String(rule.level2_after_hours),
      level3_after_hours: String(rule.level3_after_hours),
    });
    setFieldErrors({});
    setServerError(null);
    setSuccessBanner('');
    setConfirmTarget(null);
  };

  const cancelEditing = () => {
    setEditingCategory(null);
    setFieldErrors({});
    setServerError(null);
    setConfirmTarget(null);
  };

  const handlePrepareSave = (e, rule) => {
    e.preventDefault();
    setServerError(null);
    setSuccessBanner('');
    const check = validateSlaRuleInput(formValues);
    if (!check.valid) {
      setFieldErrors(check.errors);
      return;
    }
    setFieldErrors({});
    setConfirmTarget({
      original: rule,
      next: check.parsed,
    });
  };

  const handleConfirmSave = async () => {
    if (!confirmTarget || saving) return;
    setSaving(true);
    setServerError(null);

    try {
      const updated = await updateFn(confirmTarget.original.category, {
        ...confirmTarget.next,
        expected_updated_at: confirmTarget.original.updated_at || null,
      });

      setRules((prev) =>
        prev.map((r) => (r.category === updated.category ? updated : r))
      );
      setSuccessBanner(
        `Saved SLA configuration for "${formatRuleCategory(updated.category)}".`
      );
      setEditingCategory(null);
      setConfirmTarget(null);
    } catch (err) {
      setServerError(err?.message || 'Failed to update SLA rule.');
      setConfirmTarget(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-slate-900 flex items-center gap-2.5">
            <Sliders className="w-6 h-6 text-teal-600" />
            Category SLA Rules
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            Configure resolution deadlines, pre-deadline reminders, and automatic overdue escalation thresholds by civic category.
          </p>
        </div>

        <button
          type="button"
          onClick={loadRules}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-600 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Rules
        </button>
      </div>

      <div aria-live="polite" className="space-y-2">
        {successBanner && (
          <div
            role="status"
            className="p-3.5 bg-teal-50 border border-teal-200 rounded-xl text-teal-900 text-xs flex items-center gap-2 font-medium"
          >
            <CheckCircle2 className="w-4 h-4 text-teal-600 shrink-0" />
            <span>{successBanner}</span>
          </div>
        )}
        {serverError && (
          <div
            role="alert"
            className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center justify-between gap-3"
          >
            <span className="flex items-center gap-2 font-medium">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              {serverError}
            </span>
            <button
              type="button"
              onClick={loadRules}
              className="px-2.5 py-1 rounded-lg bg-rose-700 text-white text-[11px] font-semibold hover:bg-rose-800"
            >
              Reload Latest
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-pulse">
          {[...Array(6)].map((_, idx) => (
            <div key={idx} className="h-44 bg-slate-200 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <div className="bg-white border border-rose-200 rounded-2xl p-8 text-center space-y-3">
          <AlertCircle className="w-7 h-7 text-rose-600 mx-auto" />
          <h2 className="text-base font-bold text-slate-900">Unable to Load SLA Rules</h2>
          <p className="text-xs text-slate-600">{error}</p>
          <button
            type="button"
            onClick={loadRules}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      ) : rules.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-xs text-slate-600">
          No category SLA rules are configured.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {rules.map((rule) => {
            const isEditing = editingCategory === rule.category;
            return (
              <section
                key={rule.category}
                aria-label={`${formatRuleCategory(rule.category)} SLA Rule`}
                className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4"
              >
                <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">
                      {formatRuleCategory(rule.category)}
                    </h2>
                    <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                      {rule.category}
                    </p>
                  </div>
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={() => startEditing(rule)}
                      className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600"
                    >
                      Edit Rule
                    </button>
                  )}
                </div>

                {!isEditing ? (
                  <dl className="grid grid-cols-2 gap-3 text-xs">
                    <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <dt className="text-slate-500">SLA Deadline (`sla_hours`)</dt>
                      <dd className="text-base font-extrabold text-slate-900 mt-0.5">
                        {rule.sla_hours}h
                      </dd>
                    </div>
                    <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <dt className="text-slate-500">Reminder (`reminder_before_hours`)</dt>
                      <dd className="text-base font-extrabold text-teal-700 mt-0.5">
                        {rule.reminder_before_hours}h before
                      </dd>
                    </div>
                    <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <dt className="text-slate-500">Level 2 (`level2_after_hours`)</dt>
                      <dd className="text-base font-extrabold text-slate-900 mt-0.5">
                        +{rule.level2_after_hours}h overdue
                      </dd>
                    </div>
                    <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                      <dt className="text-slate-500">Level 3 (`level3_after_hours`)</dt>
                      <dd className="text-base font-extrabold text-slate-900 mt-0.5">
                        +{rule.level3_after_hours}h overdue
                      </dd>
                    </div>
                    <div className="col-span-2 flex items-center gap-1.5 text-[11px] text-slate-500 pt-1">
                      <Clock className="w-3.5 h-3.5" />
                      Last updated: {new Date(rule.updated_at).toLocaleString()}
                    </div>
                  </dl>
                ) : (
                  <form onSubmit={(e) => handlePrepareSave(e, rule)} className="space-y-3 text-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor={`${rule.category}-sla-hours`}
                          className="block font-semibold text-slate-700 mb-1"
                        >
                          SLA Hours (`sla_hours`)
                        </label>
                        <input
                          id={`${rule.category}-sla-hours`}
                          type="number"
                          min="1"
                          max="8760"
                          step="1"
                          value={formValues.sla_hours}
                          onChange={(e) =>
                            setFormValues((prev) => ({ ...prev, sla_hours: e.target.value }))
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        {fieldErrors.sla_hours && (
                          <p className="text-[11px] text-rose-700 mt-1">{fieldErrors.sla_hours}</p>
                        )}
                      </div>

                      <div>
                        <label
                          htmlFor={`${rule.category}-reminder-before`}
                          className="block font-semibold text-slate-700 mb-1"
                        >
                          Reminder Before (`reminder_before_hours`)
                        </label>
                        <input
                          id={`${rule.category}-reminder-before`}
                          type="number"
                          min="0"
                          max="8759"
                          step="1"
                          value={formValues.reminder_before_hours}
                          onChange={(e) =>
                            setFormValues((prev) => ({
                              ...prev,
                              reminder_before_hours: e.target.value,
                            }))
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        {fieldErrors.reminder_before_hours && (
                          <p className="text-[11px] text-rose-700 mt-1">
                            {fieldErrors.reminder_before_hours}
                          </p>
                        )}
                      </div>

                      <div>
                        <label
                          htmlFor={`${rule.category}-level2-after`}
                          className="block font-semibold text-slate-700 mb-1"
                        >
                          Level 2 Threshold (`level2_after_hours`)
                        </label>
                        <input
                          id={`${rule.category}-level2-after`}
                          type="number"
                          min="0"
                          max="8760"
                          step="1"
                          value={formValues.level2_after_hours}
                          onChange={(e) =>
                            setFormValues((prev) => ({
                              ...prev,
                              level2_after_hours: e.target.value,
                            }))
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        {fieldErrors.level2_after_hours && (
                          <p className="text-[11px] text-rose-700 mt-1">
                            {fieldErrors.level2_after_hours}
                          </p>
                        )}
                      </div>

                      <div>
                        <label
                          htmlFor={`${rule.category}-level3-after`}
                          className="block font-semibold text-slate-700 mb-1"
                        >
                          Level 3 Threshold (`level3_after_hours`)
                        </label>
                        <input
                          id={`${rule.category}-level3-after`}
                          type="number"
                          min="1"
                          max="17520"
                          step="1"
                          value={formValues.level3_after_hours}
                          onChange={(e) =>
                            setFormValues((prev) => ({
                              ...prev,
                              level3_after_hours: e.target.value,
                            }))
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-300 text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
                        />
                        {fieldErrors.level3_after_hours && (
                          <p className="text-[11px] text-rose-700 mt-1">
                            {fieldErrors.level3_after_hours}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={cancelEditing}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-teal-600 text-white font-semibold hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-600"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Review & Save
                      </button>
                    </div>
                  </form>
                )}
              </section>
            );
          })}
        </div>
      )}

      {confirmTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="sla-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
        >
          <div className="bg-white rounded-2xl border border-slate-200 max-w-md w-full p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <ShieldAlert className="w-5 h-5 text-teal-600" />
                <h3 id="sla-confirm-title" className="text-base font-bold text-slate-900">
                  Confirm SLA Rule Changes
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setConfirmTarget(null)}
                aria-label="Close confirmation dialog"
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Review changes for{' '}
              <strong className="text-slate-900">
                {formatRuleCategory(confirmTarget.original.category)}
              </strong>{' '}
              before overwriting:
            </p>

            <div className="bg-slate-50 rounded-xl border border-slate-200 divide-y divide-slate-200 text-xs">
              {[
                ['sla_hours', 'SLA Hours'],
                ['reminder_before_hours', 'Reminder Before (h)'],
                ['level2_after_hours', 'Level 2 After (h)'],
                ['level3_after_hours', 'Level 3 After (h)'],
              ].map(([key, label]) => {
                const prevVal = confirmTarget.original[key];
                const nextVal = confirmTarget.next[key];
                const changed = prevVal !== nextVal;
                return (
                  <div key={key} className="px-3.5 py-2 flex items-center justify-between">
                    <span className="font-medium text-slate-700">{label}</span>
                    <span className={changed ? 'font-bold text-teal-700' : 'text-slate-500'}>
                      {prevVal}h &rarr; {nextVal}h
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmTarget(null)}
                disabled={saving}
                className="px-3.5 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Back to Edit
              </button>
              <button
                type="button"
                onClick={handleConfirmSave}
                disabled={saving}
                className="px-4 py-2 rounded-xl bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Confirm Update'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
