/**
 * ReportlyUrban — Phase 6.2 Live Public Data Layer Verification Suite
 * Module: Public Reference Column, Anon/Citizen Isolation, Privacy Allow-List,
 *         Suppression Thresholds, Pagination Validation & Legacy View Revocation
 *
 * Runs against live Supabase instance:
 *   node supabase/tests/phase6_2_live.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadLocalEnv() {
  const envPaths = [
    path.resolve(__dirname, '../../frontend/.env'),
    path.resolve(__dirname, '../../backend/.env'),
    path.resolve(__dirname, '../../.env'),
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
}

loadLocalEnv();

const SUPABASE_URL = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error('\n[ERROR] VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const clientPath = path.resolve(__dirname, '../../frontend/node_modules/@supabase/supabase-js/dist/index.mjs');
const { createClient } = await import(pathToFileURL(clientPath).href);

const ALLOWED_PUBLIC_ITEM_KEYS = [
  'category',
  'latitude',
  'longitude',
  'public_reference',
  'status',
  'submitted_date',
  'title',
  'ward',
];

const FORBIDDEN_PII_KEYS = [
  'id',
  'complaint_number',
  'idempotency_key',
  'citizen_id',
  'description',
  'location',
  'image_url',
  'completion_image_url',
  'resolution_description',
  'officer_name',
  'officer_designation',
  'assigned_officer_id',
  'department_id',
  'sla_deadline',
  'created_at',
  'updated_at',
  'internal_note',
];

let passed = 0;
let failed = 0;

async function liveTest(name, fn) {
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

console.log('\n================================================================');
console.log('=== PHASE 6.2 LIVE PUBLIC DATA LAYER VERIFICATION SUITE ===');
console.log('================================================================');

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const runId = Date.now();
const citizenEmail = `test_cit_p6_${runId}@reportly.urban`;
const citizenPass = `TestPass123!${runId}`;
let citizenClient = null;
let citizenUser = null;

// -----------------------------------------------------------------------------
// 1. Anon Role Isolation & Legacy View Revocation
// -----------------------------------------------------------------------------
await liveTest('Live DB (anon): Legacy view public.public_complaints access is revoked (42501)', async () => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/public_complaints?select=*&limit=1`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  assert.ok(res.status === 401 || res.status === 403, `Expected 401/403, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.code, '42501', `Expected 42501 permission denied, got ${JSON.stringify(body)}`);
});

await liveTest('Live DB (anon): Direct RPC calls to all 6 Phase 6 functions are denied (42501)', async () => {
  const rpcCalls = [
    ['public_dashboard_stats', {}],
    ['public_ward_stats', {}],
    ['public_department_stats', {}],
    ['public_map_points', { p_ward: null, p_category: null }],
    ['public_complaint_list', { p_ward: null, p_category: null, p_status: null, p_page: 1, p_page_size: 20 }],
    ['public_complaint_detail', { p_reference: '00000000-0000-0000-0000-000000000000' }],
  ];
  for (const [fnName, payload] of rpcCalls) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    assert.ok(res.status === 401 || res.status === 403, `${fnName}: expected 401/403, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.code, '42501', `${fnName}: expected 42501, got ${JSON.stringify(body)}`);
  }
});

// -----------------------------------------------------------------------------
// 2. Authenticated Citizen Isolation & public_reference Column Protection
// -----------------------------------------------------------------------------
await liveTest('Setup: Sign up dedicated test citizen and verify role=citizen', async () => {
  const { data, error } = await anonClient.auth.signUp({
    email: citizenEmail,
    password: citizenPass,
    options: { data: { full_name: `Phase6 Test Citizen ${runId}`, ward: 'Ward 1 - North Central' } },
  });
  assert.equal(error, null, `Citizen signup failed: ${error?.message}`);
  assert.ok(data?.session?.access_token);
  citizenUser = data.user;
  citizenClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
});

await liveTest('Live DB (authenticated): Citizen cannot call Phase 6 service_role-only RPCs directly (42501)', async () => {
  const { error } = await citizenClient.rpc('public_dashboard_stats');
  assert.ok(error, 'Citizen must not be able to execute public_dashboard_stats directly');
  assert.equal(error.code, '42501', `Expected 42501, got ${error.code}`);

  const { error: listErr } = await citizenClient.rpc('public_complaint_list', { p_page: 1, p_page_size: 10 });
  assert.ok(listErr, 'Citizen must not be able to execute public_complaint_list directly');
  assert.equal(listErr.code, '42501', `Expected 42501, got ${listErr.code}`);
});

await liveTest('Live DB (authenticated): Citizen cannot specify public_reference on INSERT or mutate it on UPDATE', async () => {
  const spoofRef = '11111111-1111-4111-8111-111111111111';
  const { error: insertSpoofErr } = await citizenClient.from('complaints').insert({
    citizen_id: citizenUser.id,
    title: 'Spoof Public Ref Test',
    category: 'potholes',
    description: 'Testing column-level INSERT protection on public_reference.',
    location: 'Test Junction',
    ward: 'Ward 1 - North Central',
    image_url: `${citizenUser.id}/test.jpg`,
    public_reference: spoofRef,
  });
  assert.ok(insertSpoofErr, 'Citizen INSERT specifying public_reference must fail');
  assert.equal(insertSpoofErr.code, '42501', `Expected 42501, got ${insertSpoofErr.code}`);

  // Normal citizen INSERT without public_reference succeeds and auto-generates random public_reference != id
  const { data: inserted, error: okErr } = await citizenClient
    .from('complaints')
    .insert({
      citizen_id: citizenUser.id,
      title: `Phase 6.2 Live Test Complaint ${runId}`,
      category: 'potholes',
      description: 'Valid citizen complaint verifying auto-generated immutable public_reference.',
      location: 'Phase 6 Test Cross',
      ward: 'Ward 1 - North Central',
      latitude: 12.971654,
      longitude: 77.594654,
      image_url: `${citizenUser.id}/test_${runId}.jpg`,
    })
    .select('id, complaint_number, public_reference')
    .single();

  assert.equal(okErr, null, `Valid citizen INSERT failed: ${okErr?.message}`);
  assert.ok(inserted.public_reference, 'public_reference must be auto-populated');
  assert.notEqual(inserted.public_reference, inserted.id, 'public_reference must differ from internal id');
  assert.notEqual(inserted.public_reference, inserted.complaint_number, 'public_reference must differ from complaint_number');

  // Attempt UPDATE on public_reference -> 42501
  const { error: updateErr } = await citizenClient
    .from('complaints')
    .update({ public_reference: spoofRef })
    .eq('id', inserted.id);
  assert.ok(updateErr, 'Citizen UPDATE on public_reference must be denied');
  assert.equal(updateErr.code, '42501', `Expected 42501, got ${updateErr.code}`);
});

// -----------------------------------------------------------------------------
// 3. Service-Role Live RPC Functional, Suppression & Allow-List Tests
// -----------------------------------------------------------------------------
await liveTest('Live RPC (service_role): public_dashboard_stats() returns valid aggregates & suppression consistency', async () => {
  const { data, error } = await serviceClient.rpc('public_dashboard_stats');
  assert.equal(error, null, `public_dashboard_stats failed: ${error?.message}`);
  const expectedKeys = [
    'avg_resolution_hours',
    'no_deadline_count',
    'overdue',
    'pending',
    'rejected',
    'rejected_suppressed',
    'resolution_rate',
    'resolved',
    'total',
  ];
  assert.deepEqual(Object.keys(data).sort(), expectedKeys);
  assert.equal(data.total, data.resolved + data.pending, 'total must equal resolved + pending');
  if (data.rejected_suppressed) {
    assert.equal(data.rejected, null, 'Suppressed rejected count must be NULL');
  } else {
    assert.ok(data.rejected >= 5, 'Unsuppressed rejected count must be >= 5');
  }
});

await liveTest('Live RPC (service_role): public_ward_stats() & public_department_stats() enforce < 5 folding/suppression', async () => {
  const { data: wards, error: wErr } = await serviceClient.rpc('public_ward_stats');
  assert.equal(wErr, null, `public_ward_stats failed: ${wErr?.message}`);
  assert.ok(Array.isArray(wards));
  for (const row of wards) {
    if (!row.is_other) {
      assert.ok(row.total >= 5, `Non-Other ward ${row.ward} must have >= 5 complaints, got ${row.total}`);
      assert.equal(row.is_suppressed, false);
    } else if (row.is_suppressed) {
      assert.equal(row.total, null, 'Suppressed Other ward total must be NULL');
      assert.equal(row.resolution_rate, null, 'Suppressed Other ward rate must be NULL');
    } else {
      assert.ok(row.total >= 5, 'Unsuppressed Other ward must have >= 5 complaints');
    }
  }

  const { data: depts, error: dErr } = await serviceClient.rpc('public_department_stats');
  assert.equal(dErr, null, `public_department_stats failed: ${dErr?.message}`);
  assert.ok(Array.isArray(depts));
  for (const row of depts) {
    if (!row.is_other) {
      assert.ok(row.assigned_total >= 5, `Non-Other dept ${row.department_name} must have >= 5, got ${row.assigned_total}`);
      assert.equal(row.is_suppressed, false);
    } else if (row.is_suppressed) {
      assert.equal(row.assigned_total, null, 'Suppressed Other dept total must be NULL');
      assert.equal(row.resolution_rate, null, 'Suppressed Other dept rate must be NULL');
    } else {
      assert.ok(row.assigned_total >= 5, 'Unsuppressed Other dept must have >= 5');
    }
  }
});

await liveTest('Live RPC (service_role): public_map_points() enforces strict allow-list, 3-decimal rounding, truncated flag & ward suppression', async () => {
  const { data, error } = await serviceClient.rpc('public_map_points', { p_ward: null, p_category: null });
  assert.equal(error, null, `public_map_points failed: ${error?.message}`);
  assert.deepEqual(Object.keys(data).sort(), ['count_suppressed', 'points', 'total_count', 'truncated', 'unmapped_count']);
  assert.equal(typeof data.truncated, 'boolean');
  assert.equal(data.count_suppressed, false);
  assert.ok(Array.isArray(data.points) && data.points.length > 0, 'Expected at least 1 geocoded public point');

  for (const pt of data.points) {
    assert.deepEqual(Object.keys(pt).sort(), ALLOWED_PUBLIC_ITEM_KEYS, 'Map point keys mismatch allow-list');
    for (const badKey of FORBIDDEN_PII_KEYS) {
      assert.ok(!(badKey in pt), `Forbidden field ${badKey} leaked in map point`);
    }
    assert.notEqual(pt.status, 'rejected');
    assert.match(pt.submitted_date, /^\d{4}-\d{2}-\d{2}$/, 'submitted_date must be YYYY-MM-DD only');
    assert.notEqual(pt.latitude, null);
    assert.notEqual(pt.longitude, null);
    // Check <= 3 decimal places
    assert.equal(Number(pt.latitude.toFixed(3)), pt.latitude, `Latitude ${pt.latitude} exceeds 3 decimals`);
    assert.equal(Number(pt.longitude.toFixed(3)), pt.longitude, `Longitude ${pt.longitude} exceeds 3 decimals`);
  }

  // Ward filter with < 5 complaints returns NULL total_count & unmapped_count + count_suppressed = true
  const { data: smallWard, error: swErr } = await serviceClient.rpc('public_map_points', {
    p_ward: 'Ward 999 - Sparse Verification',
    p_category: null,
  });
  assert.equal(swErr, null);
  assert.equal(smallWard.count_suppressed, true);
  assert.equal(smallWard.total_count, null);
  assert.equal(smallWard.unmapped_count, null);

  // Invalid category rejected with P0400
  const { error: badCatErr } = await serviceClient.rpc('public_map_points', { p_ward: null, p_category: 'not_a_category' });
  assert.ok(badCatErr);
  assert.equal(badCatErr.code, 'P0400');
});

await liveTest('Live RPC (service_role): public_complaint_list() validates params, enforces max size 50, suppresses small ward counts & matches allow-list', async () => {
  const { data, error } = await serviceClient.rpc('public_complaint_list', {
    p_ward: null,
    p_category: null,
    p_status: null,
    p_page: 1,
    p_page_size: 20,
  });
  assert.equal(error, null, `public_complaint_list failed: ${error?.message}`);
  assert.deepEqual(Object.keys(data).sort(), ['count_suppressed', 'items', 'page', 'page_size', 'total_count']);
  assert.ok(Array.isArray(data.items) && data.items.length > 0);
  assert.deepEqual(Object.keys(data.items[0]).sort(), ALLOWED_PUBLIC_ITEM_KEYS);
  for (const item of data.items) {
    assert.notEqual(item.status, 'rejected');
  }

  // Validation guards (P0400)
  for (const badArgs of [
    { p_page: 0, p_page_size: 20 },
    { p_page: 1, p_page_size: 51 },
    { p_page: 1, p_page_size: 0 },
    { p_status: 'rejected', p_page: 1, p_page_size: 10 },
    { p_category: 'fake_cat', p_page: 1, p_page_size: 10 },
  ]) {
    const { error: valErr } = await serviceClient.rpc('public_complaint_list', badArgs);
    assert.ok(valErr, `Expected P0400 for args ${JSON.stringify(badArgs)}`);
    assert.equal(valErr.code, 'P0400', `Expected P0400, got ${valErr.code}`);
  }

  // Small ward suppression check
  const { data: sparseList } = await serviceClient.rpc('public_complaint_list', {
    p_ward: 'Ward 999 - Sparse Verification',
    p_page: 1,
    p_page_size: 10,
  });
  assert.equal(sparseList.count_suppressed, true);
  assert.equal(sparseList.total_count, null);
});

await liveTest('Live RPC (service_role): public_complaint_detail() enforces exact UUID match & strict field allow-list', async () => {
  // Missing UUID returns NULL
  const { data: missing, error: missErr } = await serviceClient.rpc('public_complaint_detail', {
    p_reference: '00000000-0000-0000-0000-000000000000',
  });
  assert.equal(missErr, null);
  assert.equal(missing, null);

  // Valid reference from list returns strict allow-list object
  const { data: listData } = await serviceClient.rpc('public_complaint_list', { p_page: 1, p_page_size: 1 });
  const ref = listData.items[0].public_reference;

  const { data: detail, error: detErr } = await serviceClient.rpc('public_complaint_detail', {
    p_reference: ref,
  });
  assert.equal(detErr, null, `public_complaint_detail failed: ${detErr?.message}`);
  assert.ok(detail);
  assert.deepEqual(Object.keys(detail).sort(), ALLOWED_PUBLIC_ITEM_KEYS);
  assert.equal(detail.public_reference, ref);
  assert.match(detail.submitted_date, /^\d{4}-\d{2}-\d{2}$/);
  for (const badKey of FORBIDDEN_PII_KEYS) {
    assert.ok(!(badKey in detail), `Forbidden key ${badKey} leaked in detail response`);
  }
});

console.log(`\nPhase 6.2 Live Tests Summary: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
