/**
 * ReportlyUrban — Phase 6.5 Public Complaint Map Pure Helpers
 * Zero WebGL dependencies so validation, GeoJSON building, same-location
 * grouping, popup models, URL param sanitization, and transparency counts
 * are independently unit-testable.
 */

import {
  VALID_PUBLIC_CATEGORIES,
  getCategoryLabel,
  isValidUuid,
  sanitizePublicComplaint,
} from '../services/publicService.js';
import { formatDate, formatStatusLabel } from './formatters.js';

export const PUBLIC_MAP_MAX_ZOOM = 16;
export const PUBLIC_MAP_DEFAULT_CENTER = Object.freeze([77.5946, 12.9716]);
export const PUBLIC_MAP_MAX_POPUP_ITEMS = 10;
export const PUBLIC_MAP_TEXT_LIST_LIMIT = 50;

/**
 * Distinct color AND non-color shape/marker symbol metadata for public statuses.
 */
export const PUBLIC_MAP_STATUS_META = Object.freeze({
  submitted: Object.freeze({
    id: 'submitted',
    label: 'Submitted',
    markerText: 'S',
    shapeLabel: 'S (Circle)',
    color: '#dc2626',
    border: '#ffffff',
  }),
  under_review: Object.freeze({
    id: 'under_review',
    label: 'Under Review',
    markerText: 'R',
    shapeLabel: 'R (Ring)',
    color: '#d97706',
    border: '#ffffff',
  }),
  in_progress: Object.freeze({
    id: 'in_progress',
    label: 'In Progress',
    markerText: 'P',
    shapeLabel: 'P (Active)',
    color: '#2563eb',
    border: '#ffffff',
  }),
  resolved: Object.freeze({
    id: 'resolved',
    label: 'Resolved',
    markerText: '✓',
    shapeLabel: '✓ (Check)',
    color: '#16a34a',
    border: '#ffffff',
  }),
});

export function getPublicMapStatusMeta(statusValue) {
  const key = typeof statusValue === 'string' ? statusValue.trim().toLowerCase() : '';
  return (
    PUBLIC_MAP_STATUS_META[key] || {
      id: key || 'submitted',
      label: formatStatusLabel(statusValue),
      markerText: '•',
      shapeLabel: '•',
      color: '#475569',
      border: '#ffffff',
    }
  );
}

/**
 * Validates Mapbox public token rules strictly from config value without ever returning/logging it.
 */
export function validatePublicMapboxToken(token) {
  if (typeof token !== 'string') {
    return { valid: false, reason: 'missing' };
  }
  const trimmed = token.trim();
  if (!trimmed) {
    return { valid: false, reason: 'missing' };
  }
  if (trimmed.startsWith('sk.')) {
    return { valid: false, reason: 'secret_forbidden' };
  }
  if (
    !trimmed.startsWith('pk.') ||
    trimmed.length <= 25 ||
    trimmed.includes('your-public-token')
  ) {
    return { valid: false, reason: 'invalid' };
  }
  return { valid: true, reason: null };
}

/**
 * Validates public map coordinates strictly as finite JSON numbers within [-90, 90] x [-180, 180].
 * Rejects null, undefined, NaN, Infinity, non-numeric values, and strings.
 */
export function isValidPublicMapCoordinate(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Parses and validates /map URL query params (allowed: ward, category only).
 * Invalid or unknown params reset to defaults with hadInvalidParams=true.
 */
export function parseMapSearchParams(inputParams) {
  const raw =
    inputParams instanceof URLSearchParams
      ? inputParams
      : new URLSearchParams(typeof inputParams === 'string' ? inputParams : '');

  const allowedKeys = new Set(['ward', 'category']);
  let hadInvalidParams = false;

  for (const key of raw.keys()) {
    if (!allowedKeys.has(key)) {
      hadInvalidParams = true;
    }
  }

  let ward = '';
  const rawWard = raw.get('ward');
  if (rawWard !== null) {
    const collapsed = rawWard.trim().replace(/\s+/g, ' ');
    if (collapsed.length > 0 && collapsed.length <= 100) {
      ward = collapsed;
    } else {
      hadInvalidParams = true;
    }
  }

  let category = '';
  const rawCat = raw.get('category');
  if (rawCat !== null) {
    const normalized = rawCat.trim().toLowerCase();
    if (VALID_PUBLIC_CATEGORIES.includes(normalized)) {
      category = normalized;
    } else {
      hadInvalidParams = true;
    }
  }

  const sanitizedSearchParams = buildMapSearchParams({ ward, category });
  if (raw.toString() !== sanitizedSearchParams.toString()) {
    hadInvalidParams = true;
  }

  return {
    ward,
    category,
    sanitizedSearchParams,
    hadInvalidParams,
  };
}

export function buildMapSearchParams({ ward = '', category = '' } = {}) {
  const params = new URLSearchParams();
  if (ward && ward.trim()) {
    params.set('ward', ward.trim().replace(/\s+/g, ' '));
  }
  if (category && VALID_PUBLIC_CATEGORIES.includes(category)) {
    params.set('category', category);
  }
  return params;
}

export function formatCoordKey(lat, lng) {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/**
 * Sanitizes API map points, enforcing the 8-field allow-list and finite valid coordinates.
 * Invalid points are skipped cleanly without crashing.
 */
export function sanitizeAndValidateMapPoints(rawPoints) {
  if (!Array.isArray(rawPoints)) return [];
  const valid = [];
  for (const raw of rawPoints) {
    const clean = sanitizePublicComplaint(raw);
    if (!clean) continue;
    if (!isValidPublicMapCoordinate(clean.latitude, clean.longitude)) continue;
    valid.push({
      public_reference: clean.public_reference,
      title: clean.title,
      category: clean.category,
      ward: clean.ward,
      status: clean.status,
      submitted_date: clean.submitted_date,
      latitude: clean.latitude,
      longitude: clean.longitude,
      coordKey: formatCoordKey(clean.latitude, clean.longitude),
    });
  }
  return valid;
}

/**
 * Builds a single Mapbox GeoJSON FeatureCollection for clustering & unclustered layers.
 */
export function buildMapGeoJson(validPoints) {
  const features = [];
  if (!Array.isArray(validPoints)) {
    return { type: 'FeatureCollection', features };
  }

  for (const pt of validPoints) {
    if (!isValidPublicMapCoordinate(pt?.latitude, pt?.longitude)) continue;
    const statusMeta = getPublicMapStatusMeta(pt.status);
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [pt.longitude, pt.latitude],
      },
      properties: {
        public_reference: pt.public_reference || '',
        title: pt.title || 'Civic Issue',
        category: pt.category || '',
        categoryLabel: getCategoryLabel(pt.category),
        ward: pt.ward || 'Unspecified',
        status: statusMeta.id,
        statusLabel: statusMeta.label,
        statusColor: statusMeta.color,
        statusMarkerText: statusMeta.markerText,
        submitted_date: pt.submitted_date || '',
        coordKey: pt.coordKey || formatCoordKey(pt.latitude, pt.longitude),
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

/**
 * Groups all valid points sharing an identical ~110 m rounded coordinate key.
 */
export function groupPointsAtLocation(validPoints, targetCoordKey) {
  if (!Array.isArray(validPoints) || !targetCoordKey) return [];
  return validPoints.filter((pt) => {
    const key = pt.coordKey || (isValidPublicMapCoordinate(pt.latitude, pt.longitude)
      ? formatCoordKey(pt.latitude, pt.longitude)
      : '');
    return key === targetCoordKey;
  });
}

/**
 * Builds a strictly allow-listed popup model (max 10 visible items + overflow count).
 * Never exposes coordinates, contact data, names, descriptions, images, or internal IDs.
 */
export function buildPopupModel(pointsAtLocation, maxItems = PUBLIC_MAP_MAX_POPUP_ITEMS) {
  const list = Array.isArray(pointsAtLocation) ? pointsAtLocation : [];
  const cap = Math.max(1, maxItems);
  const visible = list.slice(0, cap).map((pt) => {
    const statusMeta = getPublicMapStatusMeta(pt.status);
    const ref = typeof pt.public_reference === 'string' ? pt.public_reference.trim() : '';
    const detailsHref = isValidUuid(ref)
      ? `/issues/${encodeURIComponent(ref)}`
      : null;

    return {
      title: String(pt.title || 'Civic Issue'),
      categoryLabel: getCategoryLabel(pt.category),
      ward: String(pt.ward || 'Unspecified'),
      status: statusMeta.id,
      statusLabel: statusMeta.label,
      statusColor: statusMeta.color,
      submittedDateText: formatDate(pt.submitted_date),
      detailsHref,
      publicReference: isValidUuid(ref) ? ref : null,
    };
  });

  return {
    totalAtLocation: list.length,
    items: visible,
    overflowCount: Math.max(0, list.length - visible.length),
  };
}

/**
 * Builds DOM nodes strictly via createElement + textContent (NEVER innerHTML or setHTML).
 */
export function buildPopupDomElement(popupModel, onSelectReference, doc = document) {
  const root = doc.createElement('div');
  root.className = 'reportly-public-popup';
  root.style.maxWidth = '290px';
  root.style.maxHeight = '280px';
  root.style.overflowY = 'auto';
  root.style.fontFamily = "'Google Sans', sans-serif";
  root.style.color = '#0f172a';
  root.style.padding = '2px';

  const header = doc.createElement('div');
  header.style.fontSize = '11px';
  header.style.fontWeight = '700';
  header.style.color = '#0f766e';
  header.style.textTransform = 'uppercase';
  header.style.letterSpacing = '0.04em';
  header.style.marginBottom = '6px';
  header.textContent =
    popupModel.totalAtLocation > 1
      ? `${popupModel.totalAtLocation} reports near this area`
      : '1 report near this area';
  root.appendChild(header);

  const listEl = doc.createElement('ul');
  listEl.style.listStyle = 'none';
  listEl.style.margin = '0';
  listEl.style.padding = '0';
  listEl.style.display = 'flex';
  listEl.style.flexDirection = 'column';
  listEl.style.gap = '8px';

  for (const item of popupModel.items) {
    const li = doc.createElement('li');
    li.style.borderTop = '1px solid #e2e8f0';
    li.style.paddingTop = '8px';

    const topRow = doc.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.justifyContent = 'space-between';
    topRow.style.alignItems = 'center';
    topRow.style.gap = '6px';
    topRow.style.marginBottom = '3px';

    const catSpan = doc.createElement('span');
    catSpan.style.fontSize = '10px';
    catSpan.style.fontWeight = '700';
    catSpan.style.color = '#334155';
    catSpan.textContent = item.categoryLabel;

    const statusSpan = doc.createElement('span');
    statusSpan.style.fontSize = '10px';
    statusSpan.style.fontWeight = '700';
    statusSpan.style.color = '#ffffff';
    statusSpan.style.backgroundColor = item.statusColor;
    statusSpan.style.padding = '1px 6px';
    statusSpan.style.borderRadius = '9999px';
    statusSpan.textContent = item.statusLabel;

    topRow.appendChild(catSpan);
    topRow.appendChild(statusSpan);
    li.appendChild(topRow);

    const titleEl = doc.createElement('div');
    titleEl.style.fontSize = '12px';
    titleEl.style.fontWeight = '700';
    titleEl.style.color = '#0f172a';
    titleEl.style.marginBottom = '2px';
    titleEl.textContent = item.title;
    li.appendChild(titleEl);

    const metaEl = doc.createElement('div');
    metaEl.style.fontSize = '11px';
    metaEl.style.color = '#475569';
    metaEl.textContent = `${item.ward} • ${item.submittedDateText}`;
    li.appendChild(metaEl);

    if (item.detailsHref) {
      const link = doc.createElement('a');
      link.href = item.detailsHref;
      link.style.display = 'inline-block';
      link.style.marginTop = '4px';
      link.style.fontSize = '11px';
      link.style.fontWeight = '700';
      link.style.color = '#0f766e';
      link.style.textDecoration = 'underline';
      link.textContent = 'View details';
      if (typeof onSelectReference === 'function' && item.publicReference) {
        link.addEventListener('click', (e) => {
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            onSelectReference(item.publicReference);
          }
        });
      }
      li.appendChild(link);
    }

    listEl.appendChild(li);
  }

  root.appendChild(listEl);

  if (popupModel.overflowCount > 0) {
    const moreEl = doc.createElement('div');
    moreEl.style.marginTop = '8px';
    moreEl.style.paddingTop = '6px';
    moreEl.style.borderTop = '1px dashed #cbd5e1';
    moreEl.style.fontSize = '11px';
    moreEl.style.fontWeight = '600';
    moreEl.style.color = '#334155';
    moreEl.textContent = `and ${popupModel.overflowCount} more`;
    root.appendChild(moreEl);
  }

  return root;
}

/**
 * Formats map transparency & privacy messages consistently.
 */
export function getMapTransparencyMessages({
  truncated = false,
  pointCount = 0,
  unmappedCount = 0,
  countSuppressed = false,
  totalCount = null,
} = {}) {
  const safePointCount = Math.max(0, Number(pointCount) || 0);
  const safeUnmapped =
    unmappedCount === null || unmappedCount === undefined
      ? 0
      : Math.max(0, Number(unmappedCount) || 0);

  const suppressed = Boolean(countSuppressed) || totalCount === null || totalCount === undefined;

  return {
    suppressed,
    countText: suppressed
      ? 'Fewer than 5 matching complaints'
      : `${Number(totalCount).toLocaleString()} matching ${
          Number(totalCount) === 1 ? 'complaint' : 'complaints'
        } (${safePointCount.toLocaleString()} mapped)`,
    truncatedText: truncated
      ? `Showing the ${safePointCount.toLocaleString()} most recent mapped complaints`
      : null,
    unmappedText:
      safeUnmapped > 0
        ? `${safeUnmapped.toLocaleString()} ${
            safeUnmapped === 1 ? 'complaint has' : 'complaints have'
          } no map location`
        : null,
  };
}
