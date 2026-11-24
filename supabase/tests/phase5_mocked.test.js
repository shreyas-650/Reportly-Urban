/**
 * ReportlyUrban — Phase 5 Mocked Integration Test Suite
 * Module: AI Service HTTP Protocol, Status Code Mapping & Error Handling
 *
 * Runs locally with mocked global fetch:
 *   node supabase/tests/phase5_mocked.test.js
 */

import assert from 'node:assert/strict';
import { analyzeIncidentPhoto } from '../../frontend/src/services/aiService.js';

let passed = 0;
let failed = 0;

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

console.log('\n--- Running Phase 5 Mocked Integration Tests ---');

const mockCitizenSupabase = {
  auth: {
    getSession: async () => ({
      data: {
        session: {
          access_token: 'valid.mocked.citizen.jwt.token',
          user: { id: 'citizen-uuid-001' },
        },
      },
      error: null,
    }),
  },
};

const fakeFile = new File(['valid synthetic photo bytes'], 'pothole.jpg', {
  type: 'image/jpeg',
});

// -----------------------------------------------------------------------------
// 1. Success (HTTP 200) Handling
// -----------------------------------------------------------------------------
await asyncTest('HTTP 200: Successfully parses structured civic suggestions', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      is_civic_issue: true,
      confidence: 0.93,
      suggestions: {
        category: 'potholes',
        title: 'Large asphalt crater near intersection',
        description: 'Road crater roughly 40cm wide causing vehicles to swerve abruptly.',
        confidence: 0.93,
        detected_issue: 'Damaged asphalt surface',
      },
      uncertainty_reason: null,
      quota_remaining: 8,
    }),
  });

  try {
    const { data, error } = await analyzeIncidentPhoto({
      file: fakeFile,
      supabaseClient: mockCitizenSupabase,
    });

    assert.equal(error, null);
    assert.ok(data);
    assert.equal(data.is_civic_issue, true);
    assert.equal(data.suggestions.category, 'potholes');
    assert.equal(data.suggestions.title, 'Large asphalt crater near intersection');
    assert.equal(data.quota_remaining, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// 2. HTTP 401 Unauthorized Handling
// -----------------------------------------------------------------------------
await asyncTest('HTTP 401: Maps to session expired / invalid message', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ detail: 'Authentication token has expired.' }),
  });

  try {
    const { data, error } = await analyzeIncidentPhoto({
      file: fakeFile,
      supabaseClient: mockCitizenSupabase,
    });

    assert.equal(data, null);
    assert.ok(error instanceof Error);
    assert.match(error.message, /session expired or invalid/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// 3. HTTP 403 Forbidden Handling
// -----------------------------------------------------------------------------
await asyncTest('HTTP 403: Maps to citizen-only authorization requirement', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ detail: 'Role officer cannot utilize citizen AI issue detection' }),
  });

  try {
    const { data, error } = await analyzeIncidentPhoto({
      file: fakeFile,
      supabaseClient: mockCitizenSupabase,
    });

    assert.equal(data, null);
    assert.ok(error instanceof Error);
    assert.match(error.message, /reserved for citizens|cannot utilize/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// 4. HTTP 413 Payload Too Large Handling
// -----------------------------------------------------------------------------
await asyncTest('HTTP 413: Informs user that photo exceeds maximum size limit (5MB)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 413,
    json: async () => ({ detail: 'Uploaded image exceeds maximum allowable limit of 5 MB.' }),
  });

  try {
    const { data, error } = await analyzeIncidentPhoto({
      file: fakeFile,
      supabaseClient: mockCitizenSupabase,
    });

    assert.equal(data, null);
    assert.ok(error instanceof Error);
    assert.match(error.message, /too large.*5 MB/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// 5. HTTP 422 Unprocessable Content Handling
// -----------------------------------------------------------------------------
await asyncTest('HTTP 422: Informs user that image format or bytes are invalid', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ detail: 'Unsupported image format. File must be an authentic JPEG, PNG, or WebP image.' }),
  });

  try {
    const { data, error } = await analyzeIncidentPhoto({
      file: fakeFile,
      supabaseClient: mockCitizenSupabase,
    });

    assert.equal(data, null);
    assert.ok(error instanceof Error);
    assert.match(error.message, /unsupported image format|not a valid or supported image format/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// 6. HTTP 429 Rate Limit Handling
// -----------------------------------------------------------------------------
await asyncTest('HTTP 429: Informs user that daily quota is reached with manual fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ detail: 'Daily AI analysis quota reached (10/10). You may still file grievances manually.' }),
  });

  try {
    const { data, error } = await analyzeIncidentPhoto({
      file: fakeFile,
      supabaseClient: mockCitizenSupabase,
    });

    assert.equal(data, null);
    assert.ok(error instanceof Error);
    assert.match(error.message, /quota reached.*manually/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// 7. Network Disconnection Handling
// -----------------------------------------------------------------------------
await asyncTest('Network Disconnection: Informs user clearly without crashing form', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };

  try {
    const { data, error } = await analyzeIncidentPhoto({
      file: fakeFile,
      supabaseClient: mockCitizenSupabase,
    });

    assert.equal(data, null);
    assert.ok(error instanceof Error);
    assert.match(error.message, /unable to connect to reportly ai backend/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log(`\nPhase 5 Mocked Integration Tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
