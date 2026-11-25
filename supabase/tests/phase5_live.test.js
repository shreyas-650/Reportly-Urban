/**
 * ReportlyUrban — Phase 5.4 Comprehensive Live Verification Suite
 * Module: Live Supabase Privileges, Real Citizen JWT Auth, FastAPI HTTP & Gemini Vision
 *
 * Runs against live Supabase & Google Gemini services:
 *   node supabase/tests/phase5_live.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment from frontend/.env, backend/.env, root .env
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

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('\n[ERROR] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required in frontend/.env.');
  process.exit(1);
}

const clientPath = path.resolve(__dirname, '../../frontend/node_modules/@supabase/supabase-js/dist/index.mjs');
const { createClient } = await import(pathToFileURL(clientPath).href);

let passed = 0;
let failed = 0;
let blocked = 0;

async function liveTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    if (err.isBlocked) {
      blocked++;
      console.log(`  [BLOCKED] ${name}`);
      console.log(`            Reason: ${err.message}`);
    } else {
      failed++;
      console.error(`  [FAIL] ${name}`);
      console.error(`         ${err.message}`);
    }
  }
}

function blockTest(reason) {
  const err = new Error(reason);
  err.isBlocked = true;
  throw err;
}

console.log('\n================================================================');
console.log('=== PHASE 5.4 LIVE VERIFICATION & E2E INTEGRATION SUITE ===');
console.log('================================================================');

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const runId = Date.now();
const testCitizenEmail = `test_cit_p5_${runId}@reportly.urban`;
const testPassword = `TestPass123!${runId}`;
let citizenUser = null;
let citizenAccessToken = null;
let backendProc = null;
const TEST_BACKEND_PORT = 8015;
const TEST_BACKEND_URL = `http://127.0.0.1:${TEST_BACKEND_PORT}`;

try {
  // ---------------------------------------------------------------------------
  // 1. Live Supabase Auth JWKS Verification
  // ---------------------------------------------------------------------------
  await liveTest('Live Supabase Auth JWKS endpoint serves asymmetric ES256 public key', async () => {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
    assert.equal(res.status, 200, `JWKS returned ${res.status}`);
    const jwks = await res.json();
    assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0, 'JWKS must contain keys');
    const es256 = jwks.keys.find((k) => k.kty === 'EC' || k.alg === 'ES256');
    assert.ok(es256 && es256.kid, 'JWKS must contain ES256 key with kid');
  });

  // ---------------------------------------------------------------------------
  // 2. Live Database Privilege Isolation (Anonymous & Authenticated Citizen)
  // ---------------------------------------------------------------------------
  await liveTest('Live DB: Anonymous client cannot read or write public.ai_analysis_usage (42501)', async () => {
    const resGet = await fetch(`${SUPABASE_URL}/rest/v1/ai_analysis_usage?select=id&limit=1`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    assert.ok(resGet.status === 401 || resGet.status === 403, `Expected 401/403, got ${resGet.status}`);
    const bodyGet = await resGet.json();
    assert.equal(bodyGet.code, '42501', `Expected 42501 permission denied, got ${JSON.stringify(bodyGet)}`);

    const resPost = await fetch(`${SUPABASE_URL}/rest/v1/ai_analysis_usage`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ citizen_id: '00000000-0000-0000-0000-000000000000' }),
    });
    assert.ok(resPost.status === 401 || resPost.status === 403, `Expected 401/403 on INSERT, got ${resPost.status}`);
  });

  await liveTest('Live DB: Anonymous client cannot execute quota RPCs (42501)', async () => {
    for (const [fnName, payload] of [
      ['reserve_ai_analysis_quota', { p_citizen_id: '00000000-0000-0000-0000-000000000000', p_global_daily_cap: 500 }],
      ['finalize_ai_analysis_quota', { p_reservation_id: '00000000-0000-0000-0000-000000000000' }],
      ['refund_ai_analysis_quota', { p_reservation_id: '00000000-0000-0000-0000-000000000000' }],
    ]) {
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

  await liveTest('Setup: Sign up dedicated live test citizen account and obtain ES256 JWT', async () => {
    const { data, error } = await anonClient.auth.signUp({
      email: testCitizenEmail,
      password: testPassword,
      options: { data: { full_name: `Phase5 Test Citizen ${runId}`, ward: 'Ward 12' } },
    });
    assert.equal(error, null, `Citizen signup failed: ${error?.message}`);
    assert.ok(data?.session?.access_token, 'Citizen signup did not return access_token');
    citizenUser = data.user;
    citizenAccessToken = data.session.access_token;

    // Verify citizen profile exists with role='citizen'
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${citizenUser.id}&select=id,role`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${citizenAccessToken}`,
        },
      }
    );
    assert.equal(profRes.status, 200);
    const profiles = await profRes.json();
    assert.equal(profiles[0]?.role, 'citizen', 'Created user must have role=citizen');
  });

  await liveTest('Live DB: Authenticated citizen cannot directly read/write public.ai_analysis_usage or call RPCs', async () => {
    assert.ok(citizenAccessToken, 'Citizen JWT missing');
    const resTable = await fetch(`${SUPABASE_URL}/rest/v1/ai_analysis_usage?select=id&limit=1`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${citizenAccessToken}`,
      },
    });
    assert.ok(resTable.status === 401 || resTable.status === 403, `Expected 401/403 on table, got ${resTable.status}`);
    const bodyTable = await resTable.json();
    assert.equal(bodyTable.code, '42501', `Expected 42501, got ${JSON.stringify(bodyTable)}`);

    const resRpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reserve_ai_analysis_quota`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${citizenAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_citizen_id: citizenUser.id, p_global_daily_cap: 500 }),
    });
    assert.ok(resRpc.status === 401 || resRpc.status === 403, `Expected 401/403 on RPC, got ${resRpc.status}`);
    const bodyRpc = await resRpc.json();
    assert.equal(bodyRpc.code, '42501', `Expected 42501 on RPC, got ${JSON.stringify(bodyRpc)}`);
  });

  // ---------------------------------------------------------------------------
  // 3. Live FastAPI Backend Integration (Real uvicorn + Real Citizen JWT + Real Gemini)
  // ---------------------------------------------------------------------------
  await liveTest('Startup: Launch live FastAPI server for real HTTP integration verification', async () => {
    const pyExe = path.resolve(__dirname, '../../backend/.venv/Scripts/python.exe');
    const backendDir = path.resolve(__dirname, '../../backend');
    backendProc = spawn(
      pyExe,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(TEST_BACKEND_PORT)],
      {
        cwd: backendDir,
        env: { ...process.env, PYTHONPATH: backendDir },
        stdio: 'pipe',
      }
    );

    // Poll /health until ready (up to 10s)
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`${TEST_BACKEND_URL}/health`);
        if (res.status === 200) {
          const data = await res.json();
          assert.equal(data.status, 'healthy');
          assert.ok(!JSON.stringify(data).toLowerCase().includes('key'));
          ready = true;
          break;
        }
      } catch {
        // Server still booting
      }
    }
    assert.ok(ready, 'FastAPI test server failed to start within timeout');
  });

  await liveTest('Live Backend HTTP: Missing and forged JWTs are rejected with HTTP 401 via live JWKS', async () => {
    const dummyImg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
    const formNoAuth = new FormData();
    formNoAuth.append('file', dummyImg, 'test.jpg');

    const resNoAuth = await fetch(`${TEST_BACKEND_URL}/api/ai/analyze-issue`, {
      method: 'POST',
      body: formNoAuth,
    });
    assert.equal(resNoAuth.status, 401);

    const formBadAuth = new FormData();
    formBadAuth.append('file', dummyImg, 'test.jpg');
    const resBadAuth = await fetch(`${TEST_BACKEND_URL}/api/ai/analyze-issue`, {
      method: 'POST',
      headers: { Authorization: 'Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.forged.sig' },
      body: formBadAuth,
    });
    assert.equal(resBadAuth.status, 401);
  });

  await liveTest('Live Backend HTTP: Valid citizen JWT + invalid/oversized files rejected (422 / 413)', async () => {
    assert.ok(citizenAccessToken, 'Citizen JWT missing');

    // Invalid MIME / non-image bytes -> 422
    const formBadImg = new FormData();
    formBadImg.append('file', new Blob(['not-an-image-payload'], { type: 'image/jpeg' }), 'fake.jpg');
    const res422 = await fetch(`${TEST_BACKEND_URL}/api/ai/analyze-issue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenAccessToken}` },
      body: formBadImg,
    });
    assert.equal(res422.status, 422, `Expected 422, got ${res422.status}`);

    // Oversized > 5 MB -> 413
    const largeBuf = new Uint8Array(5 * 1024 * 1024 + 512);
    largeBuf[0] = 0xff;
    largeBuf[1] = 0xd8;
    largeBuf[2] = 0xff;
    const formLarge = new FormData();
    formLarge.append('file', new Blob([largeBuf], { type: 'image/jpeg' }), 'huge.jpg');
    const res413 = await fetch(`${TEST_BACKEND_URL}/api/ai/analyze-issue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenAccessToken}` },
      body: formLarge,
    });
    assert.equal(res413.status, 413, `Expected 413, got ${res413.status}`);
  });

  await liveTest('Live Backend HTTP: Valid citizen JWT + synthetic JPEG calls real Gemini 2.5 Flash end-to-end', async () => {
    assert.ok(citizenAccessToken, 'Citizen JWT missing');
    // Generate valid synthetic JPEG bytes via Python Pillow (non-identifiable)
    const pyExe = path.resolve(__dirname, '../../backend/.venv/Scripts/python.exe');
    const b64Img = execSync(
      `${pyExe} -c "import io, base64; from PIL import Image, ImageDraw; img=Image.new('RGB',(320,240),(120,120,120)); d=ImageDraw.Draw(img); d.ellipse([80,60,240,180],fill=(30,30,30)); b=io.BytesIO(); img.save(b,'JPEG'); print(base64.b64encode(b.getvalue()).decode())"`,
      { encoding: 'utf8' }
    ).trim();
    const imgBytes = Buffer.from(b64Img, 'base64');

    const form = new FormData();
    form.append('file', new Blob([imgBytes], { type: 'image/jpeg' }), 'synthetic.jpg');
    const res = await fetch(`${TEST_BACKEND_URL}/api/ai/analyze-issue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${citizenAccessToken}` },
      body: form,
    });
    assert.equal(res.status, 200, `Expected 200 from live FastAPI+Gemini, got ${res.status}: ${await res.clone().text()}`);
    const data = await res.json();
    assert.equal(typeof data.is_civic_issue, 'boolean');
    assert.equal(typeof data.confidence, 'number');
    assert.ok('suggestions' in data);
    assert.ok('quota_remaining' in data);
  });

  // ---------------------------------------------------------------------------
  // 4. Service-Role Live DB Quota, Concurrency, Officer/Admin & Lease Tests
  // ---------------------------------------------------------------------------
  const runServiceRoleOrBlock = async (label, fn) => {
    await liveTest(label, async () => {
      if (!SUPABASE_SERVICE_KEY) {
        blockTest(
          'SUPABASE_SERVICE_ROLE_KEY is not configured in backend/.env or environment; service_role RPC calls and officer/admin role provisioning cannot execute live without exposing/supplying the service key.'
        );
      }
      await fn();
    });
  };

  let createdTestUserIds = [];
  let activeReservationId = null;

  await runServiceRoleOrBlock('Live DB Quota (service_role): Direct table access denied (42501) & RPC reserve/finalize/refund lifecycle', async () => {
    const adminSupa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    // 0. Confirm service_role has ZERO direct table access (RPC-only enforcement)
    const { error: directReadErr } = await adminSupa.from('ai_analysis_usage').select('id').limit(1);
    assert.ok(directReadErr, 'service_role direct table SELECT must be denied');
    assert.equal(directReadErr.code, '42501', `Expected 42501 on direct SELECT, got ${directReadErr.code}`);

    // 1. Reserve
    const { data: resId, error: resErr } = await adminSupa.rpc('reserve_ai_analysis_quota', {
      p_citizen_id: citizenUser.id,
      p_global_daily_cap: 500,
    });
    assert.equal(resErr, null, `reserve_ai_analysis_quota failed: ${resErr?.message}`);
    assert.ok(resId, 'Expected UUID reservation ID');
    activeReservationId = resId;

    // 2. Finalize -> TRUE
    const { data: finOk, error: finErr } = await adminSupa.rpc('finalize_ai_analysis_quota', {
      p_reservation_id: resId,
    });
    assert.equal(finErr, null, `finalize_ai_analysis_quota failed: ${finErr?.message}`);
    assert.equal(finOk, true, 'First finalize must return true');

    // 3. Repeated finalize -> FALSE (idempotent)
    const { data: finAgain, error: finAgainErr } = await adminSupa.rpc('finalize_ai_analysis_quota', {
      p_reservation_id: resId,
    });
    assert.equal(finAgainErr, null, `Repeated finalize failed: ${finAgainErr?.message}`);
    assert.equal(finAgain, false, 'Repeated finalize must return false');

    // 4. Refund after finalize -> FALSE (never overwrites succeeded)
    const { data: refAfterFin, error: refAfterErr } = await adminSupa.rpc('refund_ai_analysis_quota', {
      p_reservation_id: resId,
      p_error_reason: 'Attempted late refund',
    });
    assert.equal(refAfterErr, null, `refund_ai_analysis_quota errored (${refAfterErr?.code}): ${refAfterErr?.message}`);
    assert.equal(refAfterFin, false, 'Refund after finalization must return false');
  });

  await runServiceRoleOrBlock('Live DB Quota (service_role): Refund frees quota & repeated refund returns FALSE', async () => {
    const adminSupa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

    const { data: resId, error } = await adminSupa.rpc('reserve_ai_analysis_quota', {
      p_citizen_id: citizenUser.id,
      p_global_daily_cap: 500,
    });
    assert.equal(error, null, `reserve failed: ${error?.message}`);

    const { data: refOk, error: refErr } = await adminSupa.rpc('refund_ai_analysis_quota', {
      p_reservation_id: resId,
      p_error_reason: 'Simulated Gemini failure',
    });
    assert.equal(refErr, null, `refund_ai_analysis_quota errored (${refErr?.code}): ${refErr?.message}`);
    assert.equal(refOk, true, 'Explicit refund must return true');

    const { data: refAgain, error: refAgainErr } = await adminSupa.rpc('refund_ai_analysis_quota', {
      p_reservation_id: resId,
      p_error_reason: 'Duplicate refund',
    });
    assert.equal(refAgainErr, null, `Duplicate refund errored (${refAgainErr?.code}): ${refAgainErr?.message}`);
    assert.equal(refAgain, false, 'Duplicate refund must return false');
  });

  await runServiceRoleOrBlock('Live DB Quota (service_role): Hardcoded 10/24h limit & concurrent burst safety', async () => {
    const adminSupa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const burstEmail = `test_burst_${runId}@reportly.urban`;
    const { data: uData } = await adminSupa.auth.admin.createUser({
      email: burstEmail,
      password: testPassword,
      email_confirm: true,
    });
    const burstUserId = uData.user.id;
    createdTestUserIds.push(burstUserId);

    // Fire 15 concurrent reservation calls simultaneously via Promise.all
    const promises = Array.from({ length: 15 }, () =>
      adminSupa.rpc('reserve_ai_analysis_quota', {
        p_citizen_id: burstUserId,
        p_global_daily_cap: 500,
      })
    );
    const results = await Promise.all(promises);
    const successes = results.filter((r) => !r.error && r.data);
    const limitErrors = results.filter((r) => r.error && (r.error.code === 'P0429' || /limit reached/i.test(r.error.message)));

    assert.equal(successes.length, 10, `Expected exactly 10 concurrent reservations, got ${successes.length}`);
    assert.equal(limitErrors.length, 5, `Expected 5 P0429 rejections, got ${limitErrors.length}`);
  });

  await runServiceRoleOrBlock('Live DB Quota (service_role): Global daily cap enforcement (P0430)', async () => {
    const adminSupa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    // Pass global cap = 1 (already exceeded by earlier tests today)
    const { error } = await adminSupa.rpc('reserve_ai_analysis_quota', {
      p_citizen_id: citizenUser.id,
      p_global_daily_cap: 1,
    });
    assert.ok(error, 'Global daily cap = 1 must reject');
    assert.ok(error.code === 'P0430' || /global daily ai quota reached/i.test(error.message));
  });

  await liveTest('Live Backend HTTP (staff): Officer and Admin JWTs rejected with HTTP 403', async () => {
    const admEmail = process.env.TEST_ADMIN_EMAIL;
    const admPass = process.env.TEST_ADMIN_PASSWORD;
    let offEmail = process.env.TEST_OFFICER_EMAIL;
    let offPass = process.env.TEST_OFFICER_PASSWORD;

    if (!admEmail || !admPass) {
      blockTest(
        'TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD are not set in environment; skipping live staff HTTP 403 checks.'
      );
    }

    // 1. Sign in with Admin account & verify Admin JWT -> HTTP 403
    const admClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: admSignIn, error: admErr } = await admClient.auth.signInWithPassword({
      email: admEmail,
      password: admPass,
    });
    assert.equal(admErr, null, `Admin sign-in failed: ${admErr?.message}`);
    assert.ok(admSignIn?.session?.access_token, 'Admin access token missing');

    const dummyImg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });
    const admForm = new FormData();
    admForm.append('file', dummyImg, 'test.jpg');
    const admRes = await fetch(`${TEST_BACKEND_URL}/api/ai/analyze-issue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admSignIn.session.access_token}` },
      body: admForm,
    });
    assert.equal(admRes.status, 403, `Expected HTTP 403 for admin, got ${admRes.status}`);

    // 2. Obtain or provision disposable Officer account & verify Officer JWT -> HTTP 403
    if (!offEmail || !offPass) {
      offEmail = `test_off_p5_${runId}@reportly.urban`;
      offPass = testPassword;
      const { error: offSignUpErr } = await anonClient.auth.signUp({
        email: offEmail,
        password: offPass,
        options: { data: { full_name: `Phase5 Test Officer ${runId}`, ward: 'Ward 5' } },
      });
      assert.equal(offSignUpErr, null, `Officer base signup failed: ${offSignUpErr?.message}`);

      const { data: depts, error: deptErr } = await admClient
        .from('departments')
        .select('id')
        .eq('is_active', true)
        .limit(1);
      assert.equal(deptErr, null, `Departments lookup failed: ${deptErr?.message}`);
      assert.ok(depts && depts.length > 0, 'No active department found for officer linking');

      const { error: linkErr } = await admClient.rpc('link_officer_user', {
        p_user_email: offEmail,
        p_department_id: depts[0].id,
        p_official_name: `Phase5 Test Officer ${runId}`,
        p_designation: 'Field Inspector',
      });
      assert.equal(linkErr, null, `link_officer_user failed: ${linkErr?.message}`);
    }

    const offClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: offSignIn, error: offErr } = await offClient.auth.signInWithPassword({
      email: offEmail,
      password: offPass,
    });
    assert.equal(offErr, null, `Officer sign-in failed: ${offErr?.message}`);
    assert.ok(offSignIn?.session?.access_token, 'Officer access token missing');

    const offForm = new FormData();
    offForm.append('file', dummyImg, 'test.jpg');
    const offRes = await fetch(`${TEST_BACKEND_URL}/api/ai/analyze-issue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${offSignIn.session.access_token}` },
      body: offForm,
    });
    assert.equal(offRes.status, 403, `Expected HTTP 403 for officer, got ${offRes.status}`);
  });
} finally {
  if (backendProc) {
    backendProc.kill();
  }
}

console.log(
  `\nPhase 5.4 Live Tests Summary: ${passed} passed, ${failed} failed, ${blocked} BLOCKED\n`
);

if (failed > 0) {
  process.exit(1);
}
