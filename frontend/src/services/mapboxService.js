/**
 * ReportlyUrban — Mapbox Geospatial Intelligence Service
 *
 * Implements:
 * - Mapbox GL JS configuration with public access token.
 * - Mapbox Forward Geocoding (Address Search).
 * - Mapbox Reverse Geocoding (Point to Address).
 * - External GPS Navigation URL formatting (Google Maps & Apple Maps).
 * - Client-side coordinate range & completeness validation.
 *
 * Terms of Service & Privacy Compliance:
 * - Results are transiently rendered in UI; no permanent database caching of Mapbox geocoder datasets.
 * - In-memory component-level caching only during active search sessions.
 * - Secret tokens (sk.*) are strictly forbidden; only public tokens (pk.*) are used.
 */

export const MAPBOX_PUBLIC_TOKEN =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MAPBOX_ACCESS_TOKEN) || '';

/**
 * Validates whether a Mapbox public access token is properly configured.
 * Must start with 'pk.' and have sufficient length.
 *
 * @param {string} [token=MAPBOX_PUBLIC_TOKEN]
 * @returns {boolean}
 */
export function isMapboxTokenConfigured(token = MAPBOX_PUBLIC_TOKEN) {
  if (!token || typeof token !== 'string') return false;
  const trimmed = token.trim();
  return trimmed.startsWith('pk.') && trimmed.length > 25 && !trimmed.includes('your-public-token');
}

/**
 * Validates individual latitude and longitude ranges.
 * Latitude must be within [-90, 90], Longitude must be within [-180, 180].
 *
 * @param {number|string} lat
 * @param {number|string} lng
 * @returns {boolean}
 */
export function isValidCoordinate(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return false;
  const numLat = Number(lat);
  const numLng = Number(lng);

  if (Number.isNaN(numLat) || Number.isNaN(numLng)) return false;
  if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) return false;

  return numLat >= -90.0 && numLat <= 90.0 && numLng >= -180.0 && numLng <= 180.0;
}

/**
 * Validates coordinate pair completeness (both null OR both valid numbers).
 *
 * @param {*} lat
 * @param {*} lng
 * @returns {boolean}
 */
export function isValidCoordinatePair(lat, lng) {
  const latEmpty = lat === null || lat === undefined || lat === '';
  const lngEmpty = lng === null || lng === undefined || lng === '';

  if (latEmpty && lngEmpty) return true;
  if (latEmpty !== lngEmpty) return false;

  return isValidCoordinate(lat, lng);
}

/**
 * Formats a coordinate pair into a human-readable string.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {string}
 */
export function formatCoordinatesText(lat, lng) {
  if (!isValidCoordinate(lat, lng)) return '';
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

/**
 * Generates an external directions URL for Google Maps.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} [label]
 * @returns {string}
 */
export function generateGoogleMapsDirectionsUrl(lat, lng, label = '') {
  if (!isValidCoordinate(lat, lng)) return '';
  const query = label ? `&destination_place_id=${encodeURIComponent(label)}` : '';
  return `https://www.google.com/maps/dir/?api=1&destination=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}${query}`;
}

/**
 * Generates an external directions URL for Apple Maps (iOS / macOS).
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} [label]
 * @returns {string}
 */
export function generateAppleMapsDirectionsUrl(lat, lng, label = '') {
  if (!isValidCoordinate(lat, lng)) return '';
  const q = label ? `&q=${encodeURIComponent(label)}` : '';
  return `https://maps.apple.com/?daddr=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}${q}`;
}

/**
 * Forward Geocoding: Searches Mapbox Places API for address or landmark query.
 *
 * @param {string} query
 * @param {string} [token=MAPBOX_PUBLIC_TOKEN]
 * @param {Object} [options={}]
 * @param {number[]} [options.proximity] - [lng, lat] to bias search results
 * @param {string} [options.country] - ISO 3166-1 alpha-2 country code (e.g. 'in')
 * @returns {Promise<{ data: Array<{ id: string, placeName: string, text: string, coordinates: [number, number] }>, error: Error | null }>}
 */
export async function searchAddress(query, token = MAPBOX_PUBLIC_TOKEN, options = {}) {
  try {
    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return { data: [], error: null };
    }

    if (!isMapboxTokenConfigured(token)) {
      return {
        data: [],
        error: new Error('Mapbox public access token is not configured.'),
      };
    }

    const encoded = encodeURIComponent(query.trim());
    let url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${token}&autocomplete=true&types=address,poi,neighborhood,locality,place`;

    if (options.proximity && Array.isArray(options.proximity) && options.proximity.length === 2) {
      url += `&proximity=${options.proximity[0]},${options.proximity[1]}`;
    }

    if (options.country) {
      url += `&country=${encodeURIComponent(options.country)}`;
    }

    const res = await fetch(url);

    if (res.status === 429) {
      return {
        data: [],
        error: new Error('Geocoding rate limit reached. Please try again shortly.'),
      };
    }

    if (!res.ok) {
      return {
        data: [],
        error: new Error(`Mapbox search failed with status ${res.status}.`),
      };
    }

    const json = await res.json();
    const features = Array.isArray(json.features) ? json.features : [];

    const results = features.map((f) => ({
      id: f.id,
      placeName: f.place_name || '',
      text: f.text || '',
      coordinates: Array.isArray(f.center) && f.center.length === 2 ? [f.center[0], f.center[1]] : null,
      context: f.context || [],
    })).filter((item) => item.coordinates !== null);

    return { data: results, error: null };
  } catch (err) {
    return { data: [], error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Reverse Geocoding: Converts [lng, lat] coordinates to a human-readable address.
 *
 * @param {number} lng - Longitude
 * @param {number} lat - Latitude
 * @param {string} [token=MAPBOX_PUBLIC_TOKEN]
 * @returns {Promise<{ data: { placeName: string, streetAddress: string, context: Array } | null, error: Error | null }>}
 */
export async function reverseGeocode(lng, lat, token = MAPBOX_PUBLIC_TOKEN) {
  try {
    if (!isValidCoordinate(lat, lng)) {
      return { data: null, error: new Error('Invalid coordinates supplied for reverse geocoding.') };
    }

    if (!isMapboxTokenConfigured(token)) {
      return { data: null, error: new Error('Mapbox public access token is not configured.') };
    }

    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${Number(lng).toFixed(6)},${Number(lat).toFixed(6)}.json?access_token=${token}&types=address,poi,neighborhood,locality`;

    const res = await fetch(url);

    if (res.status === 429) {
      return {
        data: null,
        error: new Error('Geocoding rate limit reached. Please verify address manually.'),
      };
    }

    if (!res.ok) {
      return {
        data: null,
        error: new Error(`Reverse geocoding failed with status ${res.status}.`),
      };
    }

    const json = await res.json();
    const features = Array.isArray(json.features) ? json.features : [];

    if (features.length === 0) {
      return {
        data: {
          placeName: `Location at ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`,
          streetAddress: `Near coordinates (${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)})`,
          context: [],
        },
        error: null,
      };
    }

    const primaryFeature = features[0];
    const placeName = primaryFeature.place_name || '';
    const streetAddress = primaryFeature.text || placeName;

    return {
      data: {
        placeName,
        streetAddress,
        context: primaryFeature.context || [],
      },
      error: null,
    };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
