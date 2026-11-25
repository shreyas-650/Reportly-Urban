/**
 * ReportlyUrban — Phase 7.2 Live End-to-End Verification Suite
 * Non-destructive against complaints:
 *   1. Missing / wrong X-Sweep-Secret -> 403 + Cache-Control: no-store.
 *   2. Browser Origin request rejected (403, no CORS headers) + Cache-Control: no-store.
 *   3. Direct anon REST call to public.run_sla_sweep -> denied (401/403, 42501).
 *   4. PostgREST OpenAPI spec for service_role confirms public.run_sla_sweep exists
 *      with expected (p_batch_limit: int32/integer, p_triggered_by: text/string) signature.
 *   5. Checks live overdue/deadline state read-only via public_dashboard_stats RPC
 *      (raw table REST SELECT is revoked by design for service_role), then executes
 *      POST /api/internal/sla-sweep TWICE with a runtime-only random 48-char
 *      SLA_SWEEP_SECRET (never printed or logged), verifying:
 *        * HTTP 200, Cache-Control: no-store, strict 7 allow-listed keys
 *        * Valid distinct UUID run_id returned from sweep_runs RETURNING id
 *        * Repeated invocation yields zero reminders/escalations and error_count=0
 *        * Invalid batch_limit=999 returns 400 + Cache-Control: no-store
 *
 * Run: node supabase/tests/phase7_2_live.test.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const TEST_PORT = 8019;
const API_BASE = `http://127.0.0.1:${TEST_PORT}`;

const EXPECTED_SWEEP_KEYS = [
  'error_count',
  'escalations_blocked',
  'escalations_completed',
  'reminders_sent',
  'run_id',
  'scanned',
  'status',
];

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error('[ERROR] VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

async function fetchServiceOpenApiSpec() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Accept: 'application/json',
    },
  });
  assert.equal(res.status, 200, `Unexpected REST OpenAPI status ${res.status}`);
  return await res.json();
}

async function serviceRpcCall(rpcName, payload = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200, `Unexpected RPC ${rpcName} status ${res.status}`);
  return await res.json();
}

async function waitForServerReady(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // Server booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for FastAPI test server');
}

async function main() {
  const backendDir = path.resolve(__dirname, '../../backend');
  const pythonExe = path.resolve(backendDir, '.venv/Scripts/python.exe');

  // Ephemeral runtime-only secret kept strictly in memory and never printed
  const ephemeralSecret = crypto.randomBytes(24).toString('hex');

  const serverProc = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(TEST_PORT)],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        SLA_SWEEP_SECRET: ephemeralSecret,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  let serverStderr = '';
  serverProc.stderr.on('data', (chunk) => {
    serverStderr += chunk.toString();
  });

  try {
    await waitForServerReady(API_BASE);
    console.log('\n[Phase 7.2 Live Integration Verification]');

    let passed = 0;
    async function check(name, fn) {
      try {
        await fn();
        console.log(`  PASS  ${name}`);
        passed += 1;
      } catch (err) {
        console.error(`  FAIL  ${name}: ${err.message}`);
        throw err;
      }
    }

    await check('1. Missing, wrong secret, and browser Origin return generic 403 + no-store (no CORS)', async () => {
      const rMissing = await fetch(`${API_BASE}/api/internal/sla-sweep`, { method: 'POST' });
      const rWrong = await fetch(`${API_BASE}/api/internal/sla-sweep`, {
        method: 'POST',
        headers: { 'X-Sweep-Secret': 'wrong-secret-value' },
      });
      const rOrigin = await fetch(`${API_BASE}/api/internal/sla-sweep`, {
        method: 'POST',
        headers: {
          'X-Sweep-Secret': ephemeralSecret,
          Origin: 'https://example.com',
        },
      });
      for (const r of [rMissing, rWrong, rOrigin]) {
        assert.equal(r.status, 403);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.equal(r.headers.get('access-control-allow-origin'), null);
        assert.deepEqual(await r.json(), { detail: 'Forbidden.' });
      }
    });

    await check('2. run_sla_sweep exists with (integer, text) signature & anon EXECUTE is denied', async () => {
      const spec = await fetchServiceOpenApiSpec();
      const rpcSpec = spec?.paths?.['/rpc/run_sla_sweep']?.post;
      assert.ok(rpcSpec, 'Expected /rpc/run_sla_sweep in service_role PostgREST OpenAPI spec');
      const bodyParam = (rpcSpec.parameters || []).find((p) => p.in === 'body');
      const props = bodyParam?.schema?.properties || {};
      assert.equal(props.p_batch_limit?.type, 'integer');
      assert.equal(props.p_batch_limit?.format, 'int32');
      assert.equal(props.p_triggered_by?.type, 'string');
      assert.equal(props.p_triggered_by?.format, 'text');

      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/run_sla_sweep`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_batch_limit: 1, p_triggered_by: 'anon-test' }),
      });
      assert.ok(
        [401, 403].includes(res.status),
        `Expected 401/403 for anon RPC run_sla_sweep, got ${res.status}`
      );
      const errBody = await res.json();
      assert.equal(errBody.code, '42501');
    });

    await check('3. Live FastAPI POST /api/internal/sla-sweep twice + sanitized payload + distinct run_ids', async () => {
      const statsBefore = await serviceRpcCall('public_dashboard_stats');
      assert.equal(
        statsBefore.overdue,
        0,
        `Refusing to run automatic sweep when live overdue=${statsBefore.overdue} > 0 without explicit backfill.`
      );
      console.log(
        `    INFO  Live stats before sweep: total=${statsBefore.total}, pending=${statsBefore.pending}, overdue=${statsBefore.overdue}, no_deadline_count=${statsBefore.no_deadline_count}`
      );

      // Run 1 through FastAPI POST /api/internal/sla-sweep
      const r1 = await fetch(`${API_BASE}/api/internal/sla-sweep`, {
        method: 'POST',
        headers: { 'X-Sweep-Secret': ephemeralSecret },
      });
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get('cache-control'), 'no-store');
      const b1 = await r1.json();
      assert.deepEqual(Object.keys(b1).sort(), EXPECTED_SWEEP_KEYS);
      assert.equal(b1.status, 'completed');
      assert.equal(b1.error_count, 0);
      assert.match(b1.run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      // Run 2 (repeated invocation idempotency + zero duplicates)
      const r2 = await fetch(`${API_BASE}/api/internal/sla-sweep`, {
        method: 'POST',
        headers: { 'X-Sweep-Secret': ephemeralSecret },
      });
      assert.equal(r2.status, 200);
      assert.equal(r2.headers.get('cache-control'), 'no-store');
      const b2 = await r2.json();
      assert.deepEqual(Object.keys(b2).sort(), EXPECTED_SWEEP_KEYS);
      assert.equal(b2.status, 'completed');
      assert.equal(b2.reminders_sent, 0);
      assert.equal(b2.escalations_completed, 0);
      assert.equal(b2.escalations_blocked, 0);
      assert.equal(b2.error_count, 0);
      assert.match(b2.run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      assert.notEqual(b2.run_id, b1.run_id);

      console.log(`    INFO  Run 1 response: ${JSON.stringify(b1)}`);
      console.log(`    INFO  Run 2 response: ${JSON.stringify(b2)}`);

      // Also verify validation error with valid secret returns 400 + no-store
      const rBadBatch = await fetch(`${API_BASE}/api/internal/sla-sweep?batch_limit=999`, {
        method: 'POST',
        headers: { 'X-Sweep-Secret': ephemeralSecret },
      });
      assert.equal(rBadBatch.status, 400);
      assert.equal(rBadBatch.headers.get('cache-control'), 'no-store');
    });

    console.log(`\nAll ${passed} Phase 7.2 live integration checks passed.`);
  } finally {
    serverProc.kill('SIGTERM');
    await new Promise((resolve) => {
      serverProc.on('exit', resolve);
      setTimeout(resolve, 1500);
    });
    if (serverStderr.includes('Traceback')) {
      console.error('\n[Server Stderr Diagnostics]\n', serverStderr);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
