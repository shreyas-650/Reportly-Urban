import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  CheckCheck,
  Clock,
  AlertTriangle,
  ShieldAlert,
  RefreshCw,
  ExternalLink,
  Inbox,
} from 'lucide-react';
import {
  fetchAdminNotifications,
  markAdminNotificationRead,
  fetchOfficerNotifications,
  markOfficerNotificationRead,
} from '../../services/slaApiService';

function getKindBadge(item) {
  if (item.kind === 'reminder') {
    if (item.reminder_kind === 'overdue') {
      return {
        label: 'Overdue Reminder',
        classes: 'bg-rose-50 text-rose-700 border-rose-200',
      };
    }
    return {
      label: item.reminder_kind === 'pre_deadline' ? 'Pre-Deadline Reminder' : 'Reminder',
      classes: 'bg-amber-50 text-amber-800 border-amber-200',
    };
  }
  if (item.kind === 'escalation') {
    return {
      label: 'Escalation',
      classes: 'bg-teal-50 text-teal-800 border-teal-200',
    };
  }
  if (item.kind === 'escalation_blocked') {
    return {
      label: 'Escalation Blocked',
      classes: 'bg-rose-50 text-rose-700 border-rose-200',
    };
  }
  return {
    label: 'Assignment',
    classes: 'bg-slate-100 text-slate-700 border-slate-200',
  };
}

export default function NotificationBell({
  role = 'admin',
  darkHeader = false,
  api = null,
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [markingId, setMarkingId] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');

  const containerRef = useRef(null);

  const listFn =
    api?.list ||
    (role === 'officer' ? fetchOfficerNotifications : fetchAdminNotifications);
  const markReadFn =
    api?.markRead ||
    (role === 'officer' ? markOfficerNotificationRead : markAdminNotificationRead);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listFn({ page: 1, page_size: 10 });
      setItems(Array.isArray(res?.items) ? res.items : []);
      setUnreadCount(Number(res?.unread_count || 0));
    } catch (err) {
      setError(err?.message || 'Unable to load notifications.');
    } finally {
      setLoading(false);
    }
  }, [listFn]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  useEffect(() => {
    if (!open) return undefined;
    const handleOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleMarkRead = async (notificationId) => {
    if (!notificationId || markingId) return;
    setMarkingId(notificationId);
    setStatusMessage('');
    try {
      await markReadFn(notificationId);
      setItems((prev) =>
        prev.map((item) =>
          item.id === notificationId ? { ...item, is_read: true } : item
        )
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
      setStatusMessage('Notification marked as read.');
    } catch (err) {
      setStatusMessage(err?.message || 'Failed to mark notification as read.');
    } finally {
      setMarkingId(null);
    }
  };

  const getTargetLink = (item) => {
    if (!item.complaint_id) {
      return role === 'officer' ? '/officer' : '/admin/escalations';
    }
    if (role === 'officer') {
      return `/officer/complaints/${item.complaint_id}`;
    }
    if (item.kind === 'escalation' || item.kind === 'escalation_blocked') {
      return `/admin/escalations?complaintId=${item.complaint_id}`;
    }
    return `/admin/complaints/${item.complaint_id}`;
  };

  const buttonClasses = darkHeader
    ? 'relative p-2 rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-400 transition-colors'
    : 'relative p-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-teal-600 transition-colors';

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) loadNotifications();
        }}
        className={buttonClasses}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span
            data-testid="unread-badge"
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-teal-500 text-white text-[10px] font-bold flex items-center justify-center shadow-xs"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      <div className="sr-only" aria-live="polite">
        {statusMessage}
      </div>

      {open && (
        <div
          role="region"
          aria-label="Notifications list"
          className="absolute right-0 mt-2 w-80 sm:w-96 bg-white text-slate-900 rounded-2xl shadow-xl border border-slate-200 z-50 overflow-hidden"
        >
          <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-teal-400" />
              <span className="text-xs font-bold tracking-wide uppercase">
                {role === 'officer' ? 'Officer Alerts' : 'Admin Notifications'}
              </span>
              {unreadCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-600 text-white">
                  {unreadCount} unread
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={loadNotifications}
              disabled={loading}
              className="text-slate-300 hover:text-white p-1 rounded focus:outline-none focus:ring-2 focus:ring-teal-400"
              aria-label="Refresh notifications"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
            {loading && items.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                Loading notifications...
              </div>
            ) : error ? (
              <div className="p-5 text-center space-y-2">
                <AlertTriangle className="w-5 h-5 text-rose-500 mx-auto" />
                <p className="text-xs text-rose-700 font-medium">{error}</p>
                <button
                  type="button"
                  onClick={loadNotifications}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
                >
                  Retry
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center space-y-2">
                <Inbox className="w-6 h-6 text-slate-300 mx-auto" />
                <p className="text-xs font-semibold text-slate-700">No notifications yet</p>
                <p className="text-[11px] text-slate-500">
                  {role === 'officer'
                    ? 'SLA reminders and escalated assignments will appear here.'
                    : 'Level 3 and blocked escalation notices will appear here.'}
                </p>
              </div>
            ) : (
              items.map((item) => {
                const badge = getKindBadge(item);
                return (
                  <div
                    key={item.id}
                    className={`p-3.5 transition-colors ${
                      item.is_read ? 'bg-white' : 'bg-teal-50/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-bold ${badge.classes}`}
                      >
                        {item.kind === 'escalation_blocked' ? (
                          <ShieldAlert className="w-3 h-3" />
                        ) : (
                          <Clock className="w-3 h-3" />
                        )}
                        {badge.label}
                      </span>
                      {!item.is_read && (
                        <button
                          type="button"
                          onClick={() => handleMarkRead(item.id)}
                          disabled={markingId === item.id}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 hover:text-teal-900 focus:outline-none focus:underline disabled:opacity-50"
                        >
                          <CheckCheck className="w-3.5 h-3.5" />
                          {markingId === item.id ? 'Saving...' : 'Mark read'}
                        </button>
                      )}
                    </div>

                    <p className="text-xs font-bold text-slate-900 leading-snug">{item.title}</p>
                    <p className="text-[11px] text-slate-600 mt-0.5 leading-relaxed">
                      {item.message}
                    </p>

                    <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                      <span>{new Date(item.created_at).toLocaleString()}</span>
                      <Link
                        to={getTargetLink(item)}
                        onClick={() => setOpen(false)}
                        className="inline-flex items-center gap-1 font-semibold text-teal-700 hover:text-teal-900"
                      >
                        {item.complaint_reference || 'View'}
                        <ExternalLink className="w-3 h-3" />
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex justify-between items-center text-[11px]">
            <Link
              to={role === 'officer' ? '/officer' : '/admin/escalations'}
              onClick={() => setOpen(false)}
              className="font-semibold text-slate-700 hover:text-slate-900"
            >
              {role === 'officer' ? 'Open Officer Alerts' : 'Open Escalations Console'}
            </Link>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-slate-500 hover:text-slate-800 font-medium"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
