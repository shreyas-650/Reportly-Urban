/**
 * @file indiaGeoBounds.js
 * @description Single source of truth for the India-only geospatial lock across
 * interactive maps, geocoding, complaint form validation, and SQL error mapping.
 *
 * Mirrors the PostgreSQL trigger bounds (`6.0..37.6` lat, `68.0..97.6` lng)
 * in `supabase/migrations/20261213_india_geospatial_bounds.sql`.
 */

export const INDIA_GEO_BOUNDS = Object.freeze({
  minLat: 6.0,
  maxLat: 37.6,
  minLng: 68.0,
  maxLng: 97.6,
});

// Mapbox Geocoding v5 `bbox` format: [minLng, minLat, maxLng, maxLat]
export const INDIA_GEO_BBOX_ARRAY = Object.freeze([
  INDIA_GEO_BOUNDS.minLng,
  INDIA_GEO_BOUNDS.minLat,
  INDIA_GEO_BOUNDS.maxLng,
  INDIA_GEO_BOUNDS.maxLat,
]);

// Mapbox GL `maxBounds` format: [[swLng, swLat], [neLng, neLat]]
export const INDIA_MAP_MAX_BOUNDS = Object.freeze([
  [INDIA_GEO_BOUNDS.minLng, INDIA_GEO_BOUNDS.minLat],
  [INDIA_GEO_BOUNDS.maxLng, INDIA_GEO_BOUNDS.maxLat],
]);

// Tighter than 3.5 so the map never zooms out to show the whole subcontinent.
export const INDIA_MAP_MIN_ZOOM = 4.5;

export const INDIA_COUNTRY_CODE = 'in';

export const INDIA_DB_ERROR_MARKER = 'INDIA_BOUNDS_VIOLATION';

export const INDIA_OUTSIDE_ERROR =
  'Locations outside India are not accepted. Please select a location within India.';

/**
 * Checks whether finite numeric latitude/longitude fall inside the India bounding box.
 * Accepts numeric strings safely via Number() only when finite numbers? No — strict numeric
 * or finite number check matching publicMapUtils, with explicit Number coercion helper if needed.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {boolean}
 */
export function isWithinIndiaBounds(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  return (
    lat >= INDIA_GEO_BOUNDS.minLat &&
    lat <= INDIA_GEO_BOUNDS.maxLat &&
    lng >= INDIA_GEO_BOUNDS.minLng &&
    lng <= INDIA_GEO_BOUNDS.maxLng
  );
}

/**
 * Extracts the lowercase ISO country short_code from a Mapbox geocoding `context` array
 * (or feature `properties`), returning `null` if no country metadata is present.
 *
 * @param {Array|null|undefined} context
 * @returns {string|null}
 */
export function extractCountryShortCode(context) {
  if (!Array.isArray(context) || context.length === 0) {
    return null;
  }

  const countryEntry = context.find(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      (entry.id === 'country' || entry.id.startsWith('country.'))
  );

  if (!countryEntry) {
    return null;
  }

  const rawCode = countryEntry.short_code;
  if (typeof rawCode !== 'string' || !rawCode.trim()) {
    return null;
  }

  return rawCode.trim().toLowerCase();
}

/**
 * Returns true ONLY when Mapbox explicitly reports a non-'in' country context.
 * When country metadata is missing/unavailable, returns false so the caller falls back
 * to the bounding box alone.
 *
 * @param {Array|null|undefined} context
 * @returns {boolean}
 */
export function isOutsideIndiaGeocodeContext(context) {
  const shortCode = extractCountryShortCode(context);
  if (!shortCode) {
    return false;
  }
  return shortCode !== INDIA_COUNTRY_CODE;
}

/**
 * Detects whether a database error was raised by the PostgreSQL India bounds trigger.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isIndiaBoundsDbError(error) {
  if (!error || typeof error !== 'object') return false;
  const haystacks = [error.message, error.details, error.hint]
    .filter((v) => typeof v === 'string')
    .join(' ');
  return haystacks.includes(INDIA_DB_ERROR_MARKER);
}
