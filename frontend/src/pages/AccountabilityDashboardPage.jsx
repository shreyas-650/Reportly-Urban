import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CheckCircle2,
  Clock,
  Info,
  MapPin,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import StatisticsCard from '../components/dashboard/StatisticsCard';
import Button from '../components/common/Button';
import {
  fetchPublicDepartmentStats,
  fetchPublicStats,
  fetchPublicWardStats,
  formatResolutionDuration,
  formatResolutionRate,
  formatSuppressedValue,
} from '../services/publicService';

export default function AccountabilityDashboardPage() {
  const [stats, setStats] = useState(null);
  const [wards, setWards] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wardSort, setWardSort] = useState('total_desc');

  const abortControllerRef = useRef(null);

  const loadDashboard = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError('');

    try {
      const [statsData, wardData, deptData] = await Promise.all([
        fetchPublicStats({ signal: controller.signal }),
        fetchPublicWardStats({ signal: controller.signal }),
        fetchPublicDepartmentStats({ signal: controller.signal }),
      ]);

      if (!controller.signal.aborted) {
        setStats(statsData);
        setWards(Array.isArray(wardData) ? wardData : []);
        setDepartments(Array.isArray(deptData) ? deptData : []);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err.message || 'Unable to load public accountability metrics right now.');
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadDashboard();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [loadDashboard]);

  const highVolumeWardNames = useMemo(() => {
    const eligible = wards.filter(
      (w) => !w.is_other && !w.is_suppressed && w.ward !== 'Other' && typeof w.total === 'number'
    );
    return new Set(
      [...eligible]
        .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
        .slice(0, 3)
        .filter((w) => (w.total ?? 0) > 0)
        .map((w) => w.ward)
    );
  }, [wards]);

  const sortedWards = useMemo(() => {
    const list = [...wards];
    list.sort((a, b) => {
      // Keep 'Other' bucket at the bottom regardless of sort order
      const aOther = Boolean(a.is_other || a.ward === 'Other');
      const bOther = Boolean(b.is_other || b.ward === 'Other');
      if (aOther !== bOther) return aOther ? 1 : -1;

      if (wardSort === 'rate_desc') {
        return (b.resolution_rate ?? -1) - (a.resolution_rate ?? -1);
      }
      if (wardSort === 'unresolved_desc') {
        return (b.unresolved ?? -1) - (a.unresolved ?? -1);
      }
      return (b.total ?? -1) - (a.total ?? -1);
    });
    return list;
  }, [wards, wardSort]);

  return (
    <div className="min-h-screen bg-slate-50 py-8 sm:py-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        {/* Header */}
        <div className="bg-slate-900 text-white rounded-2xl p-6 sm:p-8 shadow-sm border border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-medium text-teal-300">
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Citywide Transparency Ledger</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Public Accountability Dashboard
            </h1>
            <p className="text-sm text-slate-300 max-w-2xl">
              Live civic service metrics across wards and municipal departments. Aggregated directly from verified complaint records with privacy protections for small groups.
            </p>
          </div>
          <div className="shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onClick={loadDashboard}
              disabled={loading}
              className="bg-slate-800 text-white border-slate-700 hover:bg-slate-700"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>{loading ? 'Refreshing...' : 'Refresh Metrics'}</span>
            </Button>
          </div>
        </div>

        {/* Error State */}
        {error && (
          <div
            role="alert"
            className="bg-rose-50 border border-rose-200 rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <h2 className="text-sm font-semibold text-rose-900">
                  Failed to load accountability metrics
                </h2>
                <p className="text-xs text-rose-700 mt-0.5">{error}</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={loadDashboard}>
              Retry
            </Button>
          </div>
        )}

        {/* Loading Skeleton */}
        {loading && !stats && (
          <div className="space-y-6" aria-busy="true" aria-label="Loading public dashboard">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
              {[...Array(6)].map((_, idx) => (
                <div
                  key={idx}
                  className="bg-white rounded-2xl border border-slate-200 p-5 h-32 animate-pulse"
                >
                  <div className="h-3 w-24 bg-slate-200 rounded mb-4" />
                  <div className="h-7 w-20 bg-slate-200 rounded mb-2" />
                  <div className="h-3 w-36 bg-slate-100 rounded" />
                </div>
              ))}
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-6 h-64 animate-pulse" />
          </div>
        )}

        {/* Loaded Metrics */}
        {stats && (
          <>
            {/* Citywide KPI Cards */}
            <section aria-labelledby="citywide-metrics-heading">
              <div className="flex items-center justify-between mb-4">
                <h2
                  id="citywide-metrics-heading"
                  className="text-lg font-bold text-slate-900"
                >
                  Citywide Overview
                </h2>
                <span className="text-xs text-slate-500">
                  Excludes rejected complaints from performance rates
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
                <StatisticsCard
                  title="Total Public Reports"
                  value={Number(stats.total ?? 0).toLocaleString()}
                  subtitle="Non-rejected civic reports tracked"
                  icon={ShieldCheck}
                  colorScheme="blue"
                />
                <StatisticsCard
                  title="Issues Resolved"
                  value={Number(stats.resolved ?? 0).toLocaleString()}
                  trend={
                    stats.resolution_rate !== null && stats.resolution_rate !== undefined
                      ? `${formatResolutionRate(stats.resolution_rate)} Rate`
                      : undefined
                  }
                  subtitle="Verified resolved complaints"
                  icon={CheckCircle2}
                  colorScheme="emerald"
                />
                <StatisticsCard
                  title="Active / Pending"
                  value={Number(stats.pending ?? 0).toLocaleString()}
                  subtitle="Submitted, under review, or in progress"
                  icon={Clock}
                  colorScheme="amber"
                />
                <StatisticsCard
                  title="Overdue Complaints"
                  value={Number(stats.overdue ?? 0).toLocaleString()}
                  subtitle={`${Number(stats.no_deadline_count ?? 0).toLocaleString()} complaints have no deadline set`}
                  icon={AlertTriangle}
                  colorScheme="amber"
                />
                <StatisticsCard
                  title="Avg. Resolution Time"
                  value={formatResolutionDuration(stats.avg_resolution_hours)}
                  subtitle="Measured from submission to final resolution"
                  icon={Clock}
                  colorScheme="slate"
                />
                <StatisticsCard
                  title="Rejected Reports"
                  value={
                    stats.rejected_suppressed
                      ? 'Fewer than 5'
                      : Number(stats.rejected ?? 0).toLocaleString()
                  }
                  subtitle="Suppressed when fewer than 5 for privacy"
                  icon={ShieldAlert}
                  colorScheme="slate"
                />
              </div>
            </section>

            {/* Ward Analytics */}
            <section
              aria-labelledby="ward-analytics-heading"
              className="bg-white rounded-2xl border border-slate-200/90 shadow-2xs overflow-hidden"
            >
              <div className="p-5 sm:p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <MapPin className="w-5 h-5 text-teal-600" />
                    <h2
                      id="ward-analytics-heading"
                      className="text-lg font-bold text-slate-900"
                    >
                      Ward Analytics
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Resolution progress and workload distribution by municipal ward.
                  </p>
                </div>

                {wards.length > 0 && (
                  <div className="flex items-center gap-2">
                    <label htmlFor="ward-sort" className="text-xs font-medium text-slate-600">
                      Sort by:
                    </label>
                    <select
                      id="ward-sort"
                      value={wardSort}
                      onChange={(e) => setWardSort(e.target.value)}
                      className="text-xs border border-slate-300 rounded-lg px-2.5 py-1.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
                    >
                      <option value="total_desc">Highest Volume</option>
                      <option value="rate_desc">Resolution Rate</option>
                      <option value="unresolved_desc">Unresolved Count</option>
                    </select>
                  </div>
                )}
              </div>

              {sortedWards.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No ward-level accountability records are available yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                        <th className="py-3.5 px-5">Ward</th>
                        <th className="py-3.5 px-4 text-right">Total</th>
                        <th className="py-3.5 px-4 text-right">Resolved</th>
                        <th className="py-3.5 px-4 text-right">Unresolved</th>
                        <th className="py-3.5 px-4 text-right">Overdue</th>
                        <th className="py-3.5 px-4 text-right">Resolution Rate</th>
                        <th className="py-3.5 px-5 text-right">Avg. Resolution</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {sortedWards.map((row) => {
                        const isOther = Boolean(row.is_other || row.ward === 'Other');
                        const isSuppressed = Boolean(row.is_suppressed);
                        const isHighVolume = highVolumeWardNames.has(row.ward);
                        const label = isOther
                          ? 'Other (groups with fewer than 5 complaints)'
                          : row.ward;

                        return (
                          <tr key={row.ward} className="hover:bg-slate-50/80 transition-colors">
                            <td className="py-3.5 px-5 font-medium text-slate-900">
                              <div className="flex flex-wrap items-center gap-2">
                                <span>{label}</span>
                                {isHighVolume && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                                    High Volume
                                  </span>
                                )}
                              </div>
                            </td>
                            {isSuppressed ? (
                              <td
                                colSpan={6}
                                className="py-3.5 px-5 text-right text-xs font-medium text-slate-600"
                              >
                                Fewer than 5 complaints (suppressed for reporter privacy)
                              </td>
                            ) : (
                              <>
                                <td className="py-3.5 px-4 text-right font-semibold text-slate-900 tabular-nums">
                                  {formatSuppressedValue(row.total, false)}
                                </td>
                                <td className="py-3.5 px-4 text-right text-emerald-700 font-medium tabular-nums">
                                  {formatSuppressedValue(row.resolved, false)}
                                </td>
                                <td className="py-3.5 px-4 text-right text-amber-700 font-medium tabular-nums">
                                  {formatSuppressedValue(row.unresolved, false)}
                                </td>
                                <td className="py-3.5 px-4 text-right text-slate-700 tabular-nums">
                                  <div>{formatSuppressedValue(row.overdue, false)}</div>
                                  <div className="text-[11px] text-slate-400">
                                    {Number(row.no_deadline_count ?? 0).toLocaleString()} no deadline
                                  </div>
                                </td>
                                <td className="py-3.5 px-4 text-right font-medium text-slate-800 tabular-nums">
                                  {formatResolutionRate(row.resolution_rate)}
                                </td>
                                <td className="py-3.5 px-5 text-right text-slate-700">
                                  {formatResolutionDuration(row.avg_resolution_hours)}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Department Analytics */}
            <section
              aria-labelledby="department-analytics-heading"
              className="bg-white rounded-2xl border border-slate-200/90 shadow-2xs overflow-hidden"
            >
              <div className="p-5 sm:p-6 border-b border-slate-200">
                <div className="flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-blue-600" />
                  <h2
                    id="department-analytics-heading"
                    className="text-lg font-bold text-slate-900"
                  >
                    Department Performance
                  </h2>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Assigned workload, SLA compliance, and resolution turnaround by municipal department.
                </p>
              </div>

              {departments.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No department-level accountability records are available yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                        <th className="py-3.5 px-5">Department</th>
                        <th className="py-3.5 px-4 text-right">Assigned</th>
                        <th className="py-3.5 px-4 text-right">Resolved</th>
                        <th className="py-3.5 px-4 text-right">Pending</th>
                        <th className="py-3.5 px-4 text-right">Overdue</th>
                        <th className="py-3.5 px-4 text-right">Resolution Rate</th>
                        <th className="py-3.5 px-5 text-right">Avg. Resolution</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {departments.map((dept) => {
                        const isOther = Boolean(
                          dept.is_other || dept.department_code === 'OTHER'
                        );
                        const isSuppressed = Boolean(dept.is_suppressed);
                        const label = isOther
                          ? 'Other (groups with fewer than 5 complaints)'
                          : dept.department_name;

                        return (
                          <tr
                            key={`${dept.department_code}-${dept.department_name}`}
                            className="hover:bg-slate-50/80 transition-colors"
                          >
                            <td className="py-3.5 px-5 font-medium text-slate-900">
                              <div className="flex flex-col">
                                <span>{label}</span>
                                {!isOther && dept.department_code && (
                                  <span className="text-[11px] font-mono text-slate-400">
                                    {dept.department_code}
                                  </span>
                                )}
                              </div>
                            </td>
                            {isSuppressed ? (
                              <td
                                colSpan={6}
                                className="py-3.5 px-5 text-right text-xs font-medium text-slate-600"
                              >
                                Fewer than 5 complaints (suppressed for reporter privacy)
                              </td>
                            ) : (
                              <>
                                <td className="py-3.5 px-4 text-right font-semibold text-slate-900 tabular-nums">
                                  {formatSuppressedValue(dept.assigned_total, false)}
                                </td>
                                <td className="py-3.5 px-4 text-right text-emerald-700 font-medium tabular-nums">
                                  {formatSuppressedValue(dept.resolved, false)}
                                </td>
                                <td className="py-3.5 px-4 text-right text-amber-700 font-medium tabular-nums">
                                  {formatSuppressedValue(dept.pending, false)}
                                </td>
                                <td className="py-3.5 px-4 text-right text-slate-700 tabular-nums">
                                  <div>{formatSuppressedValue(dept.overdue, false)}</div>
                                  <div className="text-[11px] text-slate-400">
                                    {Number(dept.no_deadline_count ?? 0).toLocaleString()} no deadline
                                  </div>
                                </td>
                                <td className="py-3.5 px-4 text-right font-medium text-slate-800 tabular-nums">
                                  {formatResolutionRate(dept.resolution_rate)}
                                </td>
                                <td className="py-3.5 px-5 text-right text-slate-700">
                                  {formatResolutionDuration(dept.avg_resolution_hours)}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Methodology / Metric Rules Note */}
            <section
              aria-labelledby="methodology-heading"
              className="bg-slate-100/90 border border-slate-200 rounded-2xl p-5 sm:p-6"
            >
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-slate-700 shrink-0 mt-0.5" />
                <div className="space-y-2 text-xs text-slate-700 leading-relaxed">
                  <h2 id="methodology-heading" className="text-sm font-bold text-slate-900">
                    How these numbers are calculated
                  </h2>
                  <ul className="list-disc pl-4 space-y-1">
                    <li>
                      <strong>Pending complaints</strong> include active reports in{' '}
                      <code className="bg-white px-1 py-0.5 rounded border border-slate-200">
                        submitted
                      </code>
                      ,{' '}
                      <code className="bg-white px-1 py-0.5 rounded border border-slate-200">
                        under_review
                      </code>
                      , and{' '}
                      <code className="bg-white px-1 py-0.5 rounded border border-slate-200">
                        in_progress
                      </code>{' '}
                      states.
                    </li>
                    <li>
                      <strong>Average resolution time</strong> is computed only from resolved complaints, measuring elapsed hours from submission to the final{' '}
                      <code className="bg-white px-1 py-0.5 rounded border border-slate-200">
                        resolved
                      </code>{' '}
                      milestone.
                    </li>
                    <li>
                      <strong>Rejected reports & privacy suppression:</strong> Rejected complaints are excluded from resolution rates, ward metrics, and department metrics. Groups with fewer than 5 complaints are folded or labeled{' '}
                      <em>Fewer than 5 complaints</em> to avoid re-identifying individual reporters.
                    </li>
                    <li>
                      <strong>Overdue & missing deadlines:</strong> Overdue counts include unresolved complaints past an assigned SLA deadline. Reports that do not yet have an assigned SLA deadline are reported separately under <em>no deadline set</em>.
                    </li>
                  </ul>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
