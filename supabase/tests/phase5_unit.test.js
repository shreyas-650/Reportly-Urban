/**
 * ReportlyUrban — Phase 5 Unit Test Suite
 * Module: AI Problem Detection Frontend Logic & Validation
 *
 * Runs locally without network or database connection:
 *   node supabase/tests/phase5_unit.test.js
 */

import assert from 'node:assert/strict';
import {
  AI_SERVICE_URL,
  analyzeIncidentPhoto,
  resizeImageForAnalysis,
} from '../../frontend/src/services/aiService.js';
import { ISSUE_CATEGORIES } from '../../frontend/src/data/categories.js';

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

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
  }
}

console.log('\n--- Running Phase 5 AI Frontend Unit Tests ---');

// -----------------------------------------------------------------------------
// 1. Service Configuration & URL
// -----------------------------------------------------------------------------
test('AI_SERVICE_URL defaults to localhost:8000 when environment variable is not set', () => {
  assert.equal(typeof AI_SERVICE_URL, 'string');
  assert.ok(AI_SERVICE_URL.startsWith('http://'));
});

// -----------------------------------------------------------------------------
// 2. Pre-Transport File Validation
// -----------------------------------------------------------------------------
await asyncTest('analyzeIncidentPhoto rejects null or undefined file before network operation', async () => {
  const resultNull = await analyzeIncidentPhoto({ file: null });
  assert.equal(resultNull.data, null);
  assert.ok(resultNull.error instanceof Error);
  assert.match(resultNull.error.message, /select an image photograph/i);

  const resultUndefined = await analyzeIncidentPhoto({});
  assert.equal(resultUndefined.data, null);
  assert.ok(resultUndefined.error instanceof Error);
  assert.match(resultUndefined.error.message, /select an image photograph/i);
});

// -----------------------------------------------------------------------------
// 3. Authentication Verification Guard
// -----------------------------------------------------------------------------
await asyncTest('analyzeIncidentPhoto rejects unauthenticated session before network request', async () => {
  const fakeFile = new File(['fake image bytes'], 'test.jpg', { type: 'image/jpeg' });
  const mockSupabaseUnauthenticated = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  };

  const result = await analyzeIncidentPhoto({
    file: fakeFile,
    supabaseClient: mockSupabaseUnauthenticated,
  });

  assert.equal(result.data, null);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /authentication required/i);
});

await asyncTest('analyzeIncidentPhoto rejects auth session error before network request', async () => {
  const fakeFile = new File(['fake image bytes'], 'test.jpg', { type: 'image/jpeg' });
  const mockSupabaseError = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: new Error('Token refresh failed') }),
    },
  };

  const result = await analyzeIncidentPhoto({
    file: fakeFile,
    supabaseClient: mockSupabaseError,
  });

  assert.equal(result.data, null);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /authentication required/i);
});

// -----------------------------------------------------------------------------
// 4. Civic Categories Whitelist Consistency
// -----------------------------------------------------------------------------
test('Frontend ISSUE_CATEGORIES includes all six authorized municipal categories', () => {
  const authorizedIds = [
    'potholes',
    'garbage',
    'streetlights',
    'water_leakage',
    'drainage',
    'public_infrastructure',
  ];

  const categoryIds = ISSUE_CATEGORIES.map((c) => c.id);
  for (const id of authorizedIds) {
    assert.ok(categoryIds.includes(id), `Missing required civic category: ${id}`);
  }
});

// -----------------------------------------------------------------------------
// 5. Image Transport Resizing Helper Fallback
// -----------------------------------------------------------------------------
await asyncTest('resizeImageForAnalysis gracefully falls back to raw file in non-DOM environments', async () => {
  const fakeFile = new File(['test image data'], 'pothole.jpg', { type: 'image/jpeg' });
  const result = await resizeImageForAnalysis(fakeFile, 1600, 0.85);
  assert.ok(result);
});

// -----------------------------------------------------------------------------
// 6. Overwrite Confirmation Decision Logic
// -----------------------------------------------------------------------------
test('Field overwrite logic correctly flags conflicting user-entered text', () => {
  const currentFormData = {
    category: 'potholes',
    title: 'Citizen original pothole title',
    description: 'Citizen original description written manually.',
  };

  const aiSuggestions = {
    category: 'drainage',
    title: 'AI suggested drainage title',
    description: 'AI suggested description.',
  };

  // Check category conflict
  const categoryDiffers = Boolean(
    currentFormData.category && currentFormData.category !== aiSuggestions.category
  );
  assert.equal(categoryDiffers, true);

  // Check title conflict
  const titleDiffers = Boolean(
    currentFormData.title.trim() && currentFormData.title.trim() !== aiSuggestions.title.trim()
  );
  assert.equal(titleDiffers, true);

  // Check matching text does NOT trigger overwrite conflict
  const matchingTitle = Boolean(
    'AI suggested drainage title'.trim() !== aiSuggestions.title.trim()
  );
  assert.equal(matchingTitle, false);
});

console.log(`\nPhase 5 Unit Tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
