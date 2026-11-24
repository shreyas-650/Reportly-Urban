/**
 * ReportlyUrban — Phase 4.4 Unit Test Suite
 * Module: Mapbox Geospatial Intelligence & Coordinate Validation
 *
 * Runs locally without network or database connection:
 *   node supabase/tests/phase4_4_unit.test.js
 */

import assert from 'node:assert/strict';
import {
  isMapboxTokenConfigured,
  isValidCoordinate,
  isValidCoordinatePair,
  formatCoordinatesText,
  generateGoogleMapsDirectionsUrl,
  generateAppleMapsDirectionsUrl,
} from '../../frontend/src/services/mapboxService.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
  }
}

console.log('\n--- Running Phase 4.4 Geospatial Unit Tests ---');

// -----------------------------------------------------------------------------
// 1. Coordinate Range Validation (isValidCoordinate)
// -----------------------------------------------------------------------------
test('Valid coordinates within standard boundaries pass', () => {
  assert.equal(isValidCoordinate(12.9716, 77.5946), true); // Bengaluru
  assert.equal(isValidCoordinate(0, 0), true);             // Equator / Prime Meridian
  assert.equal(isValidCoordinate(-90, -180), true);        // South / West extreme
  assert.equal(isValidCoordinate(90, 180), true);          // North / East extreme
  assert.equal(isValidCoordinate(28.6139, 77.2090), true); // New Delhi
  assert.equal(isValidCoordinate(-33.8688, 151.2093), true); // Sydney
});

test('Valid numeric string coordinates are parsed correctly', () => {
  assert.equal(isValidCoordinate('12.9716', '77.5946'), true);
  assert.equal(isValidCoordinate('-15.5', '45.2'), true);
});

test('Out of range latitude is rejected (> 90 or < -90)', () => {
  assert.equal(isValidCoordinate(90.0001, 77.5946), false);
  assert.equal(isValidCoordinate(-90.0001, 77.5946), false);
  assert.equal(isValidCoordinate(180, 77.5946), false);
  assert.equal(isValidCoordinate(-95, 77.5946), false);
});

test('Out of range longitude is rejected (> 180 or < -180)', () => {
  assert.equal(isValidCoordinate(12.9716, 180.0001), false);
  assert.equal(isValidCoordinate(12.9716, -180.0001), false);
  assert.equal(isValidCoordinate(12.9716, 200), false);
  assert.equal(isValidCoordinate(12.9716, -195), false);
});

test('Null, undefined, NaN, and non-numeric coordinates are rejected', () => {
  assert.equal(isValidCoordinate(null, 77.5946), false);
  assert.equal(isValidCoordinate(12.9716, null), false);
  assert.equal(isValidCoordinate(null, null), false);
  assert.equal(isValidCoordinate(undefined, undefined), false);
  assert.equal(isValidCoordinate('abc', 'def'), false);
  assert.equal(isValidCoordinate(NaN, 77.5946), false);
  assert.equal(isValidCoordinate(Infinity, 77.5946), false);
  assert.equal(isValidCoordinate(12.9716, -Infinity), false);
});

// -----------------------------------------------------------------------------
// 2. Coordinate Pair Completeness (isValidCoordinatePair)
// -----------------------------------------------------------------------------
test('Coordinate pair completeness allows both NULL (legacy complaints)', () => {
  assert.equal(isValidCoordinatePair(null, null), true);
  assert.equal(isValidCoordinatePair(undefined, undefined), true);
  assert.equal(isValidCoordinatePair('', ''), true);
});

test('Coordinate pair completeness allows valid non-null pairs', () => {
  assert.equal(isValidCoordinatePair(12.9716, 77.5946), true);
  assert.equal(isValidCoordinatePair('12.9716', '77.5946'), true);
});

test('Coordinate pair completeness rejects solitary coordinates', () => {
  assert.equal(isValidCoordinatePair(12.9716, null), false);
  assert.equal(isValidCoordinatePair(null, 77.5946), false);
  assert.equal(isValidCoordinatePair(12.9716, undefined), false);
  assert.equal(isValidCoordinatePair(undefined, 77.5946), false);
  assert.equal(isValidCoordinatePair(12.9716, ''), false);
  assert.equal(isValidCoordinatePair('', 77.5946), false);
});

test('Coordinate pair completeness rejects out-of-range pairs', () => {
  assert.equal(isValidCoordinatePair(95.0, 77.5946), false);
  assert.equal(isValidCoordinatePair(12.9716, 185.0), false);
});

// -----------------------------------------------------------------------------
// 3. Human-Readable Coordinate Text Formatter
// -----------------------------------------------------------------------------
test('formatCoordinatesText formats valid numbers to 6 decimal places', () => {
  const text = formatCoordinatesText(12.9715987, 77.5945627);
  assert.equal(text, '12.971599, 77.594563');
});

test('formatCoordinatesText returns empty string for invalid coordinates', () => {
  assert.equal(formatCoordinatesText(null, null), '');
  assert.equal(formatCoordinatesText(100, 77.5946), '');
  assert.equal(formatCoordinatesText(12.9716, 200), '');
});

// -----------------------------------------------------------------------------
// 4. External Directions URL Generators
// -----------------------------------------------------------------------------
test('generateGoogleMapsDirectionsUrl formats correct standard URL', () => {
  const url = generateGoogleMapsDirectionsUrl(12.9716, 77.5946);
  assert.equal(
    url,
    'https://www.google.com/maps/dir/?api=1&destination=12.971600,77.594600'
  );
});

test('generateGoogleMapsDirectionsUrl encodes custom landmark label', () => {
  const url = generateGoogleMapsDirectionsUrl(12.9716, 77.5946, 'MG Road Metro');
  assert.match(url, /destination=12\.971600,77\.594600/);
  assert.match(url, /destination_place_id=MG%20Road%20Metro/);
});

test('generateGoogleMapsDirectionsUrl returns empty string for invalid coordinates', () => {
  assert.equal(generateGoogleMapsDirectionsUrl(null, null), '');
  assert.equal(generateGoogleMapsDirectionsUrl(95, 77), '');
});

test('generateAppleMapsDirectionsUrl formats correct standard URL', () => {
  const url = generateAppleMapsDirectionsUrl(12.9716, 77.5946);
  assert.equal(url, 'https://maps.apple.com/?daddr=12.971600,77.594600');
});

test('generateAppleMapsDirectionsUrl encodes custom landmark label', () => {
  const url = generateAppleMapsDirectionsUrl(12.9716, 77.5946, 'MG Road Metro');
  assert.match(url, /daddr=12\.971600,77\.594600/);
  assert.match(url, /q=MG%20Road%20Metro/);
});

test('generateAppleMapsDirectionsUrl returns empty string for invalid coordinates', () => {
  assert.equal(generateAppleMapsDirectionsUrl(null, null), '');
  assert.equal(generateAppleMapsDirectionsUrl(12, 190), '');
});

// -----------------------------------------------------------------------------
// 5. Mapbox Access Token Validation (isMapboxTokenConfigured)
// -----------------------------------------------------------------------------
test('Valid Mapbox public token starting with pk. passes', () => {
  const validToken = 'pk.eyJ1IjoiZXhhbXBsZXVzZXIiLCJhIjoiY2x4eXphYmNkZTAwMDBxbDFqMTIzNCJ9.abcdef123456';
  assert.equal(isMapboxTokenConfigured(validToken), true);
});

test('Secret Mapbox tokens starting with sk. are rejected in frontend context', () => {
  const secretToken = 'sk.eyJ1IjoiZXhhbXBsZXVzZXIiLCJhIjoiY2x4eXphYmNkZTAwMDBxbDFqMTIzNCJ9.abcdef123456';
  assert.equal(isMapboxTokenConfigured(secretToken), false);
});

test('Placeholder tokens or malformed strings are rejected', () => {
  assert.equal(isMapboxTokenConfigured(''), false);
  assert.equal(isMapboxTokenConfigured(null), false);
  assert.equal(isMapboxTokenConfigured('pk.your-public-token-here'), false);
  assert.equal(isMapboxTokenConfigured('pk.short'), false);
  assert.equal(isMapboxTokenConfigured('random-string-without-prefix'), false);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log(`\nUnit Tests Finished: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
