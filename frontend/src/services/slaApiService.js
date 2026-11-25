/**
 * ReportlyUrban — Phase 7.3 Escalations, SLA Management & Notifications Frontend API Client
 * Communicates strictly with FastAPI endpoints using the caller's Supabase Bearer JWT.
 * Never accesses Supabase service-role credentials or private tables directly for these modules.
 */

import { supabase } from '../lib/supabase.js';

const API_BASE_URL = (
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_AI_SERVICE_URL) ||
  'http://localhost:8000'
).replace(/\/$/, '');

const DEFAULT_TIMEOUT_MS = 12000;

export function validateSlaRuleInput(values) {
  const errors = {};
  if (!values || typeof values !== 'object') {
    return { valid: false, errors: { _form: 'SLA rule values are required.' } };
  }

  const parseIntStrict = (raw) => {
    if (raw === '' || raw === null || raw === undefined) return NaN;
    if (typeof raw === 'boolean') return NaN;
    const str = String(raw).trim();
    if (!/^-?\d+$/.test(str)) return NaN;
    return Number.parseInt(str, 10);
  };

  const slaHours = parseIntStrict(values.sla_hours);
  const reminderBefore = parseIntStrict(values.reminder_before_hours);
  const level2After = parseIntStrict(values.level2_after_hours);
  const level3After = parseIntStrict(values.level3_after_hours);

  if (!Number.isInteger(slaHours) || slaHours < 1 || slaHours > 8760) {
    errors.sla_hours = 'SLA hours must be a whole number between 1 and 8760.';
  }

  if (!Number.isInteger(reminderBefore) || reminderBefore < 0) {
    errors.reminder_before_hours = 'Reminder hours must be a whole number of 0 or more.';
  } else if (Number.isInteger(slaHours) && reminderBefore >= slaHours) {
    errors.reminder_before_hours = 'Reminder before deadline must be strictly less than SLA hours.';
  }

  if (!Number.isInteger(level2After) || level2After < 0 || level2After > 8760) {
    errors.level2_after_hours = 'Level 2 escalation threshold must be a whole number between 0 and 8760.';
  }

  if (!Number.isInteger(level3After) || level3After < 1 || level3After > 17520) {
    errors.level3_after_hours = 'Level 3 escalation threshold must be a whole number between 1 and 17520.';
  } else if (Number.isInteger(level2After) && level3After <= level2After) {
    errors.level3_after_hours = 'Level 3 threshold must be strictly greater than Level 2 threshold.';
  }

  const valid = Object.keys(errors).length === 0;
  return {
    valid,
    errors,
    parsed: valid
      ? {
          sla_hours: slaHours,
          reminder_before_hours: reminderBefore,
          level2_after_hours: level2After,
          level3_after_hours: level3After,
        }
      : null,
  };
}

export function validateManualEscalationReason(reason) {
  if (typeof reason !== 'string') {
    return { valid: false, error: 'Escalation reason is required.', trimmed: '' };
  }
  const trimmed = reason.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 5) {
    return {
      valid: false,
      error: 'Please enter a meaningful escalation reason (at least 5 characters).',
      trimmed,
    };
  }
  if (trimmed.length > 500) {
    return {
      valid: false,
      error: 'Escalation reason cannot exceed 500 characters.',
      trimmed,
    };
  }
  return { valid: true, error: null, trimmed };
}

async function getAccessToken(supabaseClient = supabase) {
  const {
    data: { session },
    error,
  } = await supabaseClient.auth.getSession();

  if (error || !session?.access_token) {
    const authErr = new Error('Authentication required. Please sign in.');
    authErr.status = 401;
    throw authErr;
  }
  return session.access_token;
}

async function apiRequest(
  path,
  {
    method = 'GET',
    query = null,
    body = null,
    fetchFn = typeof fetch !== 'undefined' ? fetch : null,
    supabaseClient = supabase,
    signal = undefined,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}
) {
  if (!fetchFn) {
    throw new Error('Fetch API is unavailable in this environment.');
  }

  const token = await getAccessToken(supabaseClient);

  const search = new URLSearchParams();
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '' && v !== 'all') {
        search.set(k, String(v));
      }
    }
  }
  const qs = search.toString();
  const url = `${API_BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const init = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body !== null && body !== undefined) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        init.body = body;
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    const res = await fetchFn(url, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      let msg =
        (data && typeof data.detail === 'string' && data.detail) ||
        `Request failed with status ${res.status}.`;
      if (res.status === 401) {
        msg = 'Your session has expired or is invalid. Please sign in again.';
      }
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      err.isTimeout = res.status === 504;
      throw err;
    }

    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const abortErr = new Error('Request timed out or was cancelled.');
      abortErr.name = 'AbortError';
      abortErr.isTimeout = true;
      throw abortErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAdminEscalations(filters = {}, options = {}) {
  return apiRequest('/api/admin/escalations', {
    method: 'GET',
    query: filters,
    ...options,
  });
}

export async function fetchAdminComplaintEscalations(complaintId, options = {}) {
  return apiRequest(`/api/admin/complaints/${encodeURIComponent(complaintId)}/escalations`, {
    method: 'GET',
    ...options,
  });
}

export async function submitManualEscalation(
  complaintId,
  { reason, expectedUpdatedAt = null },
  options = {}
) {
  const payload = { reason };
  if (expectedUpdatedAt) {
    payload.expected_updated_at = expectedUpdatedAt;
  }
  return apiRequest(`/api/admin/complaints/${encodeURIComponent(complaintId)}/escalate`, {
    method: 'POST',
    body: payload,
    ...options,
  });
}

export async function fetchAdminSlaRules(options = {}) {
  return apiRequest('/api/admin/sla-rules', {
    method: 'GET',
    ...options,
  });
}

export async function updateAdminSlaRule(category, payload, options = {}) {
  return apiRequest(`/api/admin/sla-rules/${encodeURIComponent(category)}`, {
    method: 'PUT',
    body: payload,
    ...options,
  });
}

export async function fetchAdminNotifications(params = {}, options = {}) {
  return apiRequest('/api/admin/notifications', {
    method: 'GET',
    query: params,
    ...options,
  });
}

export async function markAdminNotificationRead(notificationId, options = {}) {
  return apiRequest(`/api/admin/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: 'POST',
    ...options,
  });
}

export async function fetchOfficerReminders(params = {}, options = {}) {
  return apiRequest('/api/officer/reminders', {
    method: 'GET',
    query: params,
    ...options,
  });
}

export async function fetchOfficerEscalations(params = {}, options = {}) {
  return apiRequest('/api/officer/escalations', {
    method: 'GET',
    query: params,
    ...options,
  });
}

export async function fetchOfficerNotifications(params = {}, options = {}) {
  return apiRequest('/api/officer/notifications', {
    method: 'GET',
    query: params,
    ...options,
  });
}

export async function markOfficerNotificationRead(notificationId, options = {}) {
  return apiRequest(`/api/officer/notifications/${encodeURIComponent(notificationId)}/read`, {
    method: 'POST',
    ...options,
  });
}

export async function fetchOfficerComplaintDetail(complaintId, options = {}) {
  return apiRequest(`/api/officer/complaints/${encodeURIComponent(complaintId)}`, {
    method: 'GET',
    ...options,
  });
}

export async function fetchCitizenComplaintFollowup(complaintId, options = {}) {
  return apiRequest(`/api/citizen/complaints/${encodeURIComponent(complaintId)}/followup`, {
    method: 'GET',
    ...options,
  });
}

async function _uploadResolutionPhoto(rolePrefix, complaintId, file, options = {}) {
  const formData = new FormData();
  formData.append('file', file);
  return apiRequest(`/api/${rolePrefix}/complaints/${encodeURIComponent(complaintId)}/resolution-photo`, {
    method: 'POST',
    body: formData,
    timeoutMs: 25000,
    ...options,
  });
}

async function _registerResolutionPhoto(rolePrefix, complaintId, storagePath, options = {}) {
  return apiRequest(`/api/${rolePrefix}/complaints/${encodeURIComponent(complaintId)}/resolution-photo/register`, {
    method: 'POST',
    body: { storage_path: storagePath },
    ...options,
  });
}

async function _resolveComplaintWithPhoto(
  rolePrefix,
  complaintId,
  { expectedUpdatedAt, publicDescription, resolutionImagePath, internalNote = null },
  options = {}
) {
  const payload = {
    expected_updated_at: expectedUpdatedAt,
    public_description: publicDescription,
    resolution_image_path: resolutionImagePath,
  };
  if (internalNote) {
    payload.internal_note = internalNote;
  }
  return apiRequest(`/api/${rolePrefix}/complaints/${encodeURIComponent(complaintId)}/resolve`, {
    method: 'POST',
    body: payload,
    ...options,
  });
}

export function uploadOfficerResolutionPhoto(complaintId, file, options = {}) {
  return _uploadResolutionPhoto('officer', complaintId, file, options);
}

export function registerOfficerResolutionPhoto(complaintId, storagePath, options = {}) {
  return _registerResolutionPhoto('officer', complaintId, storagePath, options);
}

export function resolveOfficerComplaint(complaintId, payload, options = {}) {
  return _resolveComplaintWithPhoto('officer', complaintId, payload, options);
}

export function uploadAdminResolutionPhoto(complaintId, file, options = {}) {
  return _uploadResolutionPhoto('admin', complaintId, file, options);
}

export function registerAdminResolutionPhoto(complaintId, storagePath, options = {}) {
  return _registerResolutionPhoto('admin', complaintId, storagePath, options);
}

export function resolveAdminComplaint(complaintId, payload, options = {}) {
  return _resolveComplaintWithPhoto('admin', complaintId, payload, options);
}
