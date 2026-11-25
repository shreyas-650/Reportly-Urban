/**
 * ReportlyUrban — Phase 6.3 & 6.4 Public Accountability API Client, Validators & Formatters
 * Consumes FastAPI /api/public/* endpoints without authentication or service keys.
 */

const PUBLIC_API_BASE_URL = (
  import.meta.env?.VITE_AI_SERVICE_URL || 'http://localhost:8000'
).replace(/\/$/, '');

const DEFAULT_TIMEOUT_MS = 12000;

export const PUBLIC_PAGE_SIZE = 20;

export const PUBLIC_ALLOWED_FIELDS = Object.freeze([
  'category',
  'latitude',
  'longitude',
  'public_reference',
  'status',
  'submitted_date',
  'title',
  'ward',
]);

export const PUBLIC_CATEGORY_OPTIONS = Object.freeze([
  { id: 'potholes', label: 'Potholes & Damaged Roads' },
  { id: 'garbage', label: 'Garbage & Waste' },
  { id: 'streetlights', label: 'Broken Streetlights' },
  { id: 'water_leakage', label: 'Water Supply & Leakage' },
  { id: 'drainage', label: 'Drainage & Sewage' },
  { id: 'public_infrastructure', label: 'Public Infrastructure' },
]);

export const VALID_PUBLIC_CATEGORIES = Object.freeze(
  PUBLIC_CATEGORY_OPTIONS.map((c) => c.id)
);

// 'rejected' is never exposed or selectable in the public explorer
export const PUBLIC_STATUS_OPTIONS = Object.freeze([
  { id: 'submitted', label: 'Submitted' },
  { id: 'under_review', label: 'Under Review' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'resolved', label: 'Resolved' },
]);

export const VALID_PUBLIC_STATUSES = Object.freeze(
  PUBLIC_STATUS_OPTIONS.map((s) => s.id)
);

const STATUS_DESCRIPTIONS = Object.freeze({
  submitted: 'This report has been received and logged into the municipal queue.',
  under_review: 'This report is being reviewed by municipal staff for triage and assignment.',
  in_progress: 'Work has been assigned and remediation is currently underway.',
  resolved: 'The reported issue has been marked resolved by the municipal team.',
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates standard canonical UUID textual syntax without restricting UUID version bits.
 */
export function isValidUuid(value) {
  if (typeof value !== 'string') return false;
  return UUID_REGEX.test(value.trim());
}

/**
 * Strictly strips any property outside PUBLIC_ALLOWED_FIELDS from untrusted API records.
 */
export function sanitizePublicComplaint(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const clean = {};
  for (const field of PUBLIC_ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      clean[field] = raw[field];
    }
  }
  return clean;
}

export function getCategoryLabel(categoryId) {
  const match = PUBLIC_CATEGORY_OPTIONS.find((c) => c.id === categoryId);
  return match ? match.label : 'Civic Issue';
}

export function getPublicStatusDescription(statusValue) {
  const key = typeof statusValue === 'string' ? statusValue.trim().toLowerCase() : '';
  return (
    STATUS_DESCRIPTIONS[key] ||
    'Public status information is currently recorded for this civic report.'
  );
}

/**
 * Validates URLSearchParams strictly for the Public Explorer (/issues):
 * - Allowed keys: category, status, ward, page
 * - Invalid/unknown values reset to defaults and flag hadInvalidParams=true
 */
export function parseExplorerSearchParams(inputParams) {
  const raw =
    inputParams instanceof URLSearchParams
      ? inputParams
      : new URLSearchParams(typeof inputParams === 'string' ? inputParams : '');

  const allowedKeys = new Set(['category', 'status', 'ward', 'page']);
  let hadInvalidParams = false;

  for (const key of raw.keys()) {
    if (!allowedKeys.has(key)) {
      hadInvalidParams = true;
    }
  }

  let category = '';
  const rawCategory = raw.get('category');
  if (rawCategory !== null) {
    const normalizedCat = rawCategory.trim().toLowerCase();
    if (VALID_PUBLIC_CATEGORIES.includes(normalizedCat)) {
      category = normalizedCat;
    } else {
      hadInvalidParams = true;
    }
  }

  let statusVal = '';
  const rawStatus = raw.get('status');
  if (rawStatus !== null) {
    const normalizedStatus = rawStatus.trim().toLowerCase();
    if (VALID_PUBLIC_STATUSES.includes(normalizedStatus)) {
      statusVal = normalizedStatus;
    } else {
      hadInvalidParams = true;
    }
  }

  let ward = '';
  const rawWard = raw.get('ward');
  if (rawWard !== null) {
    const collapsedWard = rawWard.trim().replace(/\s+/g, ' ');
    if (collapsedWard.length > 0 && collapsedWard.length <= 100) {
      ward = collapsedWard;
    } else {
      hadInvalidParams = true;
    }
  }

  let page = 1;
  const rawPage = raw.get('page');
  if (rawPage !== null) {
    const trimmedPage = rawPage.trim();
    if (/^[1-9]\d*$/.test(trimmedPage)) {
      const parsedPage = Number.parseInt(trimmedPage, 10);
      if (Number.isSafeInteger(parsedPage) && parsedPage >= 1) {
        page = parsedPage;
      } else {
        hadInvalidParams = true;
      }
    } else {
      hadInvalidParams = true;
    }
  }

  const sanitizedSearchParams = buildExplorerSearchParams({
    category,
    status: statusVal,
    ward,
    page,
  });

  if (raw.toString() !== sanitizedSearchParams.toString()) {
    hadInvalidParams = true;
  }

  return {
    category,
    status: statusVal,
    ward,
    page,
    sanitizedSearchParams,
    hadInvalidParams,
  };
}

export function buildExplorerSearchParams({ category = '', status = '', ward = '', page = 1 } = {}) {
  const params = new URLSearchParams();
  if (category && VALID_PUBLIC_CATEGORIES.includes(category)) {
    params.set('category', category);
  }
  if (status && VALID_PUBLIC_STATUSES.includes(status)) {
    params.set('status', status);
  }
  if (ward && ward.trim()) {
    params.set('ward', ward.trim().replace(/\s+/g, ' '));
  }
  if (page && Number.isInteger(page) && page > 1) {
    params.set('page', String(page));
  }
  return params;
}

export function formatSuppressedExplorerTotal(totalCount, countSuppressed) {
  if (countSuppressed || totalCount === null || totalCount === undefined) {
    return { suppressed: true, label: 'Fewer than 5 matching complaints' };
  }
  const n = Number(totalCount);
  if (!Number.isFinite(n) || n < 0) {
    return { suppressed: true, label: 'Fewer than 5 matching complaints' };
  }
  return {
    suppressed: false,
    count: n,
    label: `${n.toLocaleString()} matching ${n === 1 ? 'complaint' : 'complaints'}`,
  };
}

async function fetchPublicJson(path, { timeoutMs = DEFAULT_TIMEOUT_MS, signal: externalSignal } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException('Request aborted', 'AbortError');
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetch(`${PUBLIC_API_BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = 'Unable to load public accountability data.';
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        message = retryAfter
          ? `Too many requests, try again shortly (in ${retryAfter} seconds).`
          : 'Too many requests, try again shortly.';
      } else if (response.status === 400) {
        message = 'Invalid filter parameters were supplied.';
      } else if (response.status === 404) {
        message = 'Public complaint record not found.';
      } else if (response.status === 503) {
        message = 'Public accountability service is temporarily unavailable. Please try again shortly.';
      } else {
        try {
          const payload = await response.json();
          if (payload && typeof payload.detail === 'string') {
            message = payload.detail;
          }
        } catch {
          // Keep generic fallback message
        }
      }
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }

    return await response.json();
  } catch (err) {
    if (err.name === 'AbortError' && !externalSignal?.aborted) {
      const timeoutErr = new Error('Public accountability request timed out. Please try again.');
      timeoutErr.status = 504;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export function fetchPublicStats(options = {}) {
  return fetchPublicJson('/api/public/stats', options);
}

export function fetchPublicWardStats(options = {}) {
  return fetchPublicJson('/api/public/wards', options);
}

export function fetchPublicDepartmentStats(options = {}) {
  return fetchPublicJson('/api/public/departments', options);
}

export async function fetchPublicWardNames(options = {}) {
  const payload = await fetchPublicJson('/api/public/wards/names', options);
  if (!payload || !Array.isArray(payload.wards)) {
    return [];
  }
  return payload.wards.filter((w) => typeof w === 'string' && w.trim().length > 0 && w !== 'Other');
}

export async function fetchPublicComplaints(
  { category = '', status = '', ward = '', page = 1, pageSize = PUBLIC_PAGE_SIZE } = {},
  options = {}
) {
  const query = new URLSearchParams();
  if (category && VALID_PUBLIC_CATEGORIES.includes(category)) {
    query.set('category', category);
  }
  if (status && VALID_PUBLIC_STATUSES.includes(status)) {
    query.set('status', status);
  }
  if (ward && ward.trim()) {
    query.set('ward', ward.trim().replace(/\s+/g, ' '));
  }
  query.set('page', String(page >= 1 ? page : 1));
  query.set('page_size', String(pageSize));

  const payload = await fetchPublicJson(`/api/public/complaints?${query.toString()}`, options);
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  const items = rawItems.map(sanitizePublicComplaint).filter(Boolean);

  return {
    items,
    total_count: payload?.total_count ?? null,
    count_suppressed: Boolean(payload?.count_suppressed),
    page: Number(payload?.page ?? page) || 1,
    page_size: Number(payload?.page_size ?? pageSize) || PUBLIC_PAGE_SIZE,
  };
}

export async function fetchPublicComplaintDetail(reference, options = {}) {
  const trimmed = typeof reference === 'string' ? reference.trim() : '';
  if (!isValidUuid(trimmed)) {
    const err = new Error('Public complaint record not found.');
    err.status = 404;
    throw err;
  }

  const payload = await fetchPublicJson(
    `/api/public/complaints/${encodeURIComponent(trimmed)}`,
    options
  );
  const sanitized = sanitizePublicComplaint(payload);
  if (!sanitized || !sanitized.public_reference) {
    const err = new Error('Public complaint record not found.');
    err.status = 404;
    throw err;
  }
  return sanitized;
}

export async function fetchPublicMapPoints(
  { ward = '', category = '' } = {},
  options = {}
) {
  const query = new URLSearchParams();
  if (ward && ward.trim()) {
    query.set('ward', ward.trim().replace(/\s+/g, ' '));
  }
  if (category && VALID_PUBLIC_CATEGORIES.includes(category)) {
    query.set('category', category);
  }
  const qs = query.toString();
  const path = qs ? `/api/public/map-points?${qs}` : '/api/public/map-points';

  const payload = await fetchPublicJson(path, options);
  const rawPoints = Array.isArray(payload?.points) ? payload.points : [];
  const points = rawPoints.map(sanitizePublicComplaint).filter(Boolean);

  return {
    points,
    truncated: Boolean(payload?.truncated),
    total_count: payload?.total_count ?? null,
    unmapped_count:
      payload?.unmapped_count === null || payload?.unmapped_count === undefined
        ? null
        : Number(payload.unmapped_count),
    count_suppressed: Boolean(payload?.count_suppressed),
  };
}

/**
 * Formats avg_resolution_hours using the Phase 6.3 rule:
 * - null/undefined -> "Not enough data"
 * - finite number -> "X days Y hours"
 */
export function formatResolutionDuration(avgHours) {
  if (avgHours === null || avgHours === undefined) {
    return 'Not enough data';
  }
  const numeric = Number(avgHours);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 'Not enough data';
  }
  const roundedHours = Math.round(numeric);
  const days = Math.floor(roundedHours / 24);
  const hours = roundedHours % 24;
  return `${days} ${days === 1 ? 'day' : 'days'} ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

export function formatResolutionRate(rate) {
  if (rate === null || rate === undefined) {
    return 'Not enough data';
  }
  const numeric = Number(rate);
  if (!Number.isFinite(numeric)) {
    return 'Not enough data';
  }
  return `${numeric.toFixed(1)}%`;
}

export function formatSuppressedValue(value, isSuppressed, suffix = '') {
  if (isSuppressed) {
    return suffix ? `Fewer than 5 ${suffix}` : 'Fewer than 5';
  }
  if (value === null || value === undefined) {
    return '—';
  }
  return Number(value).toLocaleString();
}

/**
 * Copies text via Clipboard API with a textarea + execCommand fallback.
 * Returns true ONLY if copying succeeded, false otherwise.
 */
export async function copyTextToClipboard(
  text,
  nav = typeof navigator !== 'undefined' ? navigator : null,
  doc = typeof document !== 'undefined' ? document : null
) {
  if (!text) return false;

  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }

  if (!doc || !doc.body || typeof doc.createElement !== 'function') {
    return false;
  }

  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';

  let copied = false;
  try {
    doc.body.appendChild(textarea);
    textarea.focus?.();
    textarea.select?.();
    if (typeof doc.execCommand === 'function') {
      copied = Boolean(doc.execCommand('copy'));
    }
  } catch {
    copied = false;
  } finally {
    if (textarea.parentNode) {
      textarea.parentNode.removeChild(textarea);
    }
  }
  return copied;
}

/**
 * Sets <meta name="robots" content="noindex, nofollow"> on document head and
 * returns a cleanup callback that removes or restores the prior tag on unmount.
 */
export function applyNoIndexMetaTag(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.head) {
    return () => {};
  }

  let meta = doc.querySelector('meta[name="robots"]');
  const created = !meta;
  const previousContent = meta ? meta.getAttribute('content') : null;

  if (!meta) {
    meta = doc.createElement('meta');
    meta.setAttribute('name', 'robots');
    doc.head.appendChild(meta);
  }
  meta.setAttribute('content', 'noindex, nofollow');

  return () => {
    if (created) {
      if (meta.parentNode) {
        meta.parentNode.removeChild(meta);
      }
    } else if (previousContent !== null) {
      meta.setAttribute('content', previousContent);
    } else {
      meta.removeAttribute('content');
    }
  };
}
