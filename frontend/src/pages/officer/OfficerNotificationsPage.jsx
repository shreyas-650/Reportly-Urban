import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  Clock,
  AlertTriangle,
  ShieldAlert,
  RefreshCw,
  CheckCheck,
  ExternalLink,
  Inbox,
  ClipboardList,
  Image as ImageIcon,
} from 'lucide-react';
import {
  fetchOfficerComplaints,
  fetchOfficerReminders,
  fetchOfficerEscalations,
  fetchOfficerNotifications,
  markOfficerNotificationRead,
} from '../../services/slaApiService';
import StatusBadge from '../../components/common/StatusBadge';

function formatCategory(cat) {
  return String(cat || '').replace(/_/g, ' ');
}

const DEFAULT_EMPTY_COMPLAINTS = async () => ({
  items: [],
  page: 1,
  page_size: 20,
  total: 0,
  total_pages: 1,
});

export default function OfficerNotificationsPage({ api = null }) {
  const [complaints, setComplaints] = useState([]);
  const [complaintsTotal, setComplaintsTotal] = useState(0);
  const [complaintsPage, setComplaintsPage] = useState(1);
  const [complaintsTotalPages, setComplaintsTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [complaintsLoading, setComplaintsLoading] = useState(true);
  const [complaintsError, setComplaintsError] = useState(null);

  const [reminders, setReminders] = useState([]);
  const [escalations, setEscalations] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const [reminderFilter, setReminderFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [markingId, setMarkingId] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');

  const complaintsFn = api?.fetchComplaints || (api ? DEFAULT_EMPTY_COMPLAINTS : fetchOfficerComplaints);
  const remindersFn = api?.fetchReminders || fetchOfficerReminders;
  const escalationsFn = api?.fetchEscalations || fetchOfficerEscalations;
  const notificationsFn = api?.fetchNotifications || fetchOfficerNotifications;
  const markReadFn = api?.markRead || markOfficerNotificationRead;

  const loadComplaints = useCallback(async () => {
    setComplaintsLoading(true);
    setComplaintsError(null);
    try {
      const compRes = await complaintsFn({
        status: statusFilter,
        page: complaintsPage,
        page_size: 20,
      });
      setComplaints(Array.isArray(compRes?.items) ? compRes.items : []);
      setComplaintsTotal(Number(compRes?.total || 0));
      setComplaintsTotalPages(Math.max(1, Number(compRes?.total_pages || 1)));
    } catch (err) {
      setComplaintsError(err?.message || 'Failed to load assigned complaints.');
      setComplaints([]);
    } finally {
      setComplaintsLoading(false);
    }
  }, [complaintsFn, statusFilter, complaintsPage]);

  useEffect(() => {
    loadComplaints();
  }, [loadComplaints]);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [remRes, escRes, notifRes] = await Promise.all([
        remindersFn({ kind: reminderFilter, page: 1, page_size: 20 }),
        escalationsFn({ page: 1, page_size: 20 }),
        notificationsFn({ page: 1, page_size: 20 }),
      ]);
      setReminders(Array.isArray(remRes?.items) ? remRes.items : []);
      setEscalations(Array.isArray(escRes?.items) ? escRes.items : []);
      setNotifications(Array.isArray(notifRes?.items) ? notifRes.items : []);
      setUnreadCount(Number(notifRes?.unread_count || 0));
    } catch (err) {
      setError(err?.message || 'Failed to load officer alerts and reminders.');
    } finally {
      setLoading(false);
    }
  }, [remindersFn, escalationsFn, notificationsFn, reminderFilter]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const handleMarkRead = async (notificationId) => {
    if (!notificationId || markingId) return;
    setMarkingId(notificationId);
    setStatusMessage('');
    try {
      await markReadFn(notificationId);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, is_read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      setStatusMessage('Alert marked as read.');
    } catch (err) {
      setStatusMessage(err?.message || 'Unable to mark alert as read.');
    } finally {
      setMarkingId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <div className="bg-slate-900 text-white rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-teal-300">
            <Bell className="w-3.5 h-3.5" />
            Municipal Officer Workspace
          </span>
          <h1 className="text-2xl font-extrabold mt-1">
            SLA Reminders &amp; Assigned Escalations
          </h1>
          <p className="text-xs text-slate-300 mt-1">
            Track upcoming SLA deadlines, overdue alerts, and complaints escalated to your attention.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            loadWorkspace();
            loadComplaints();
          }}
          disabled={loading || complaintsLoading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-teal-600 text-white text-xs font-semibold hover:bg-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-300 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading || complaintsLoading ? 'animate-spin' : ''}`} />
          Refresh Workspace
        </button>
      </div>

      <div aria-live="polite" className="sr-only">
        {statusMessage}
      </div>

      {/* My Assigned Complaints Section */}
      <section
        aria-label="My Assigned Complaints"
        className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-teal-600" />
              My Assigned Complaints
              <span className="text-xs font-semibold text-slate-500">
                ({complaintsTotal})
              </span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Complaints currently assigned to you for inspection and resolution.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <label htmlFor="officer-complaint-status-filter" className="font-semibold text-slate-700">
              Status:
            </label>
            <select
              id="officer-complaint-status-filter"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setComplaintsPage(1);
              }}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-900"
            >
              <option value="all">All Statuses</option>
              <option value="submitted">Submitted</option>
              <option value="under_review">Under Review</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
        </div>

        {complaintsLoading ? (
          <p className="text-xs text-slate-500 py-4">Loading assigned complaints...</p>
        ) : complaintsError ? (
          <div className="p-6 text-center space-y-2 bg-rose-50/50 rounded-xl border border-rose-200">
            <AlertTriangle className="w-6 h-6 text-rose-600 mx-auto" />
            <p className="text-xs font-semibold text-slate-900">Unable to load assigned complaints</p>
            <p className="text-xs text-slate-600">{complaintsError}</p>
            <button
              type="button"
              onClick={loadComplaints}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Retry
            </button>
          </div>
        ) : complaints.length === 0 ? (
          <div className="p-6 text-center space-y-1.5 bg-slate-50 rounded-xl border border-slate-100">
            <Inbox className="w-6 h-6 text-slate-300 mx-auto" />
            <p className="text-xs font-semibold text-slate-700">No assigned complaints found</p>
            <p className="text-[11px] text-slate-500">
              Complaints assigned to your officer profile will appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <th className="py-2.5 pr-3">Photo</th>
                    <th className="py-2.5 pr-3">Reference</th>
                    <th className="py-2.5 pr-3">Category &amp; Ward</th>
                    <th className="py-2.5 pr-3">Status</th>
                    <th className="py-2.5 pr-3">Created</th>
                    <th className="py-2.5 pr-3">SLA Deadline</th>
                    <th className="py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {complaints.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 pr-3">
                        {c.thumbnail_url ? (
                          <img
                            src={c.thumbnail_url}
                            alt={`Thumbnail for ${c.complaint_reference}`}
                            className="w-12 h-12 rounded-lg object-cover border border-slate-200 bg-slate-100"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-lg border border-dashed border-slate-200 bg-slate-50 flex items-center justify-center text-slate-400">
                            <ImageIcon className="w-4 h-4" />
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                        <Link
                          to={`/officer/complaints/${c.id}`}
                          className="hover:text-teal-700 underline-offset-2 hover:underline"
                        >
                          {c.complaint_reference}
                        </Link>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="font-semibold text-slate-800 capitalize">
                          {formatCategory(c.category)}
                        </div>
                        <div className="text-[11px] text-slate-500">{c.ward}</div>
                      </td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <StatusBadge status={c.status} size="sm" />
                      </td>
                      <td className="py-3 pr-3 text-slate-600 whitespace-nowrap">
                        {c.created_at ? new Date(c.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="py-3 pr-3 text-slate-600 whitespace-nowrap">
                        {c.sla_deadline ? new Date(c.sla_deadline).toLocaleString() : 'Not scheduled'}
                      </td>
                      <td className="py-3 text-right whitespace-nowrap">
                        <Link
                          to={`/officer/complaints/${c.id}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
                        >
                          Open <ExternalLink className="w-3.5 h-3.5" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {complaintsTotalPages > 1 && (
              <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
                <span className="text-slate-500">
                  Page {complaintsPage} of {complaintsTotalPages}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={complaintsPage <= 1}
                    onClick={() => setComplaintsPage((p) => Math.max(1, p - 1))}
                    className="px-3 py-1 rounded-lg border border-slate-300 text-slate-700 font-semibold disabled:opacity-40 hover:bg-slate-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={complaintsPage >= complaintsTotalPages}
                    onClick={() => setComplaintsPage((p) => Math.min(complaintsTotalPages, p + 1))}
                    className="px-3 py-1 rounded-lg border border-slate-300 text-slate-700 font-semibold disabled:opacity-40 hover:bg-slate-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {error ? (
        <div className="bg-white border border-rose-200 rounded-2xl p-8 text-center space-y-3">
          <AlertTriangle className="w-7 h-7 text-rose-600 mx-auto" />
          <h2 className="text-base font-bold text-slate-900">Unable to Load Officer Alerts</h2>
          <p className="text-xs text-slate-600">{error}</p>
          <button
            type="button"
            onClick={loadWorkspace}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Retry
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: SLA Reminders + Escalated Complaints */}
          <div className="lg:col-span-7 space-y-6">
            {/* Reminders Section */}
            <section
              aria-label="SLA reminders"
              className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3">
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-teal-600" />
                  SLA Reminders
                </h2>

                <div className="flex items-center gap-2 text-xs">
                  <label htmlFor="officer-reminder-filter" className="font-semibold text-slate-700">
                    Type:
                  </label>
                  <select
                    id="officer-reminder-filter"
                    value={reminderFilter}
                    onChange={(e) => setReminderFilter(e.target.value)}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-900"
                  >
                    <option value="all">All Reminders</option>
                    <option value="pre_deadline">Pre-Deadline</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </div>
              </div>

              {loading ? (
                <p className="text-xs text-slate-500 py-4">Loading reminders...</p>
              ) : reminders.length === 0 ? (
                <div className="p-6 text-center space-y-1.5 bg-slate-50 rounded-xl border border-slate-100">
                  <Inbox className="w-6 h-6 text-slate-300 mx-auto" />
                  <p className="text-xs font-semibold text-slate-700">No reminders found</p>
                  <p className="text-[11px] text-slate-500">
                    Pre-deadline and overdue SLA reminders for your assigned complaints will appear here.
                  </p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {reminders.map((rem) => {
                    const isOverdue = rem.kind === 'overdue';
                    return (
                      <li
                        key={rem.id}
                        className="p-4 rounded-xl border border-slate-200 bg-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                                isOverdue
                                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                                  : 'bg-amber-50 text-amber-800 border-amber-200'
                              }`}
                            >
                              {isOverdue ? 'Overdue' : 'Pre-Deadline'}
                            </span>
                            <span className="font-mono text-xs font-bold text-slate-900">
                              {rem.complaint_reference}
                            </span>
                          </div>
                          <div className="text-xs text-slate-700 capitalize">
                            {formatCategory(rem.category)} &bull; {rem.ward}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            Recorded: {new Date(rem.created_at).toLocaleString()}
                          </div>
                        </div>

                        <Link
                          to={`/officer/complaints/${rem.complaint_id}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 shrink-0"
                        >
                          View Complaint <ExternalLink className="w-3.5 h-3.5" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Escalated Complaints Section */}
            <section
              aria-label="Escalated complaints"
              className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4"
            >
              <div className="border-b border-slate-100 pb-3">
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-teal-600" />
                  Escalated Complaints Assigned to You
                </h2>
              </div>

              {loading ? (
                <p className="text-xs text-slate-500 py-4">Loading escalated complaints...</p>
              ) : escalations.length === 0 ? (
                <div className="p-6 text-center space-y-1.5 bg-slate-50 rounded-xl border border-slate-100">
                  <Inbox className="w-6 h-6 text-slate-300 mx-auto" />
                  <p className="text-xs font-semibold text-slate-700">No escalated complaints</p>
                  <p className="text-[11px] text-slate-500">
                    Complaints escalated to you at Level 1 or Level 2 appear here.
                  </p>
                </div>
              ) : (
                <ul className="space-y-3">
                  {escalations.map((esc) => (
                    <li
                      key={esc.id}
                      className="p-4 rounded-xl border border-slate-200 bg-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold bg-teal-50 text-teal-800 border border-teal-200">
                            Level {esc.to_level} Escalation
                          </span>
                          <span className="font-mono text-xs font-bold text-slate-900">
                            {esc.complaint_reference}
                          </span>
                        </div>
                        <div className="text-xs text-slate-700 capitalize">
                          {formatCategory(esc.category)} &bull; {esc.ward}
                        </div>
                        <p className="text-xs text-slate-600">{esc.reason}</p>
                        <div className="text-[11px] text-slate-500">
                          Escalated: {new Date(esc.created_at).toLocaleString()}
                        </div>
                      </div>

                      <Link
                        to={`/officer/complaints/${esc.complaint_id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700 shrink-0"
                      >
                        Open Case <ExternalLink className="w-3.5 h-3.5" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* Right Column: Notification Feed with Mark-as-Read */}
          <section
            aria-label="Officer notifications feed"
            className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Bell className="w-4 h-4 text-teal-600" />
                In-App Notifications
              </h2>
              {unreadCount > 0 && (
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-teal-600 text-white">
                  {unreadCount} unread
                </span>
              )}
            </div>

            {loading ? (
              <p className="text-xs text-slate-500 py-4">Loading notifications...</p>
            ) : notifications.length === 0 ? (
              <div className="p-6 text-center space-y-1.5 bg-slate-50 rounded-xl border border-slate-100">
                <Inbox className="w-6 h-6 text-slate-300 mx-auto" />
                <p className="text-xs font-semibold text-slate-700">No notifications yet</p>
                <p className="text-[11px] text-slate-500">
                  Assignment, reminder, and escalation notices for you will appear here.
                </p>
              </div>
            ) : (
              <ul className="space-y-3">
                {notifications.map((item) => {
                  const typeLabel =
                    item.kind === 'reminder'
                      ? item.reminder_kind === 'overdue'
                        ? 'Overdue Reminder'
                        : item.reminder_kind === 'pre_deadline'
                          ? 'Pre-Deadline Reminder'
                          : 'Reminder'
                      : item.kind === 'escalation'
                        ? 'Escalation'
                        : 'Assignment';

                  return (
                    <li
                      key={item.id}
                      className={`p-3.5 rounded-xl border ${
                        item.is_read
                          ? 'border-slate-200 bg-white'
                          : 'border-teal-200 bg-teal-50/40'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-slate-100 text-slate-800 border border-slate-200">
                          {typeLabel}
                        </span>
                        {!item.is_read && (
                          <button
                            type="button"
                            onClick={() => handleMarkRead(item.id)}
                            disabled={markingId === item.id}
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 hover:text-teal-900 disabled:opacity-50"
                          >
                            <CheckCheck className="w-3.5 h-3.5" />
                            {markingId === item.id ? 'Saving...' : 'Mark read'}
                          </button>
                        )}
                      </div>
                      <p className="text-xs font-bold text-slate-900">{item.title}</p>
                      <p className="text-[11px] text-slate-600 mt-0.5">{item.message}</p>
                      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                        <span>{new Date(item.created_at).toLocaleString()}</span>
                        {item.complaint_id && (
                          <Link
                            to={`/officer/complaints/${item.complaint_id}`}
                            className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:underline"
                          >
                            {item.complaint_reference || 'View'}
                            <ExternalLink className="w-3 h-3" />
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
