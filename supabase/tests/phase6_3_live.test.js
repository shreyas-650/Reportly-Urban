/**
 * ReportlyUrban — Phase 6.3 Live End-to-End API & Security Verification
 * Non-destructive test against live Supabase PostgreSQL RPCs + FastAPI Uvicorn server:
 *   node supabase/tests/phase6_3_live.test.js
 */

import assert from 'node:assert/strict';
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
const TEST_PORT = 8016;
const API_BASE = `http://127.0.0.1:${TEST_PORT}`;

const ALLOWED_PUBLIC_ITEM_KEYS = new Set([
  'category',
  'latitude',
  'longitude',
  'public_reference',
  'status',
  'submitted_date',
  'title',
  'ward',
]);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[ERROR] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be configured.');
  process.exit(1);
}

async function waitForServerReady(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // Server still booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for local FastAPI test server to start');
}

async function main() {
  const backendDir = path.resolve(__dirname, '../../backend');
  const pythonExe = path.resolve(backendDir, '.venv/Scripts/python.exe');

  const serverProc = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(TEST_PORT)],
    {
      cwd: backendDir,
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
    console.log('\n[Phase 6.3 Live Verification — Supabase RPC Security & FastAPI Public API]');

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

    // 1. Direct anon Supabase REST RPC calls remain blocked
    await check('1. Supabase anon REST role is denied execution on all 6 Phase 6.2 RPCs', async () => {
      const rpcPayloads = [
        ['public_dashboard_stats', {}],
        ['public_ward_stats', {}],
        ['public_department_stats', {}],
        ['public_map_points', { p_ward: null, p_category: null }],
        ['public_complaint_list', { p_ward: null, p_category: null, p_status: null, p_page: 1, p_page_size: 20 }],
        ['public_complaint_detail', { p_reference: '11111111-2222-3333-4444-555555555555' }],
      ];
      for (const [fn, payload] of rpcPayloads) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        assert.ok(
          [401, 403, 404].includes(res.status),
          `Expected 401/403/404 for anon RPC ${fn}, got ${res.status}`
        );
      }
    });

    // 2. /stats, /wards, /wards/names, /departments live responses
    await check('2. /stats, /wards, /wards/names, and /departments return valid HTTP 200 JSON', async () => {
      const [rStats, rWards, rNames, rDepts] = await Promise.all([
        fetch(`${API_BASE}/api/public/stats`),
        fetch(`${API_BASE}/api/public/wards`),
        fetch(`${API_BASE}/api/public/wards/names`),
        fetch(`${API_BASE}/api/public/departments`),
      ]);
      assert.equal(rStats.status, 200);
      assert.equal(rStats.headers.get('cache-control'), 'public, max-age=600');
      const stats = await rStats.json();
      for (const key of [
        'total',
        'resolved',
        'pending',
        'rejected',
        'rejected_suppressed',
        'overdue',
        'no_deadline_count',
        'resolution_rate',
        'avg_resolution_hours',
      ]) {
        assert.ok(key in stats, `Missing key ${key} in /stats`);
      }

      assert.equal(rWards.status, 200);
      const wards = await rWards.json();
      assert.ok(Array.isArray(wards));

      assert.equal(rNames.status, 200);
      const namesBody = await rNames.json();
      assert.ok(Array.isArray(namesBody.wards));
      assert.equal(namesBody.wards.includes('Other'), false);

      assert.equal(rDepts.status, 200);
      const depts = await rDepts.json();
      assert.ok(Array.isArray(depts));
    });

    // 3. /map-points, /complaints, and /complaints/{reference} allow-list & 400/404 checks
    await check('3. /map-points, /complaints, and /complaints/{ref} return strictly allow-listed keys', async () => {
      const rMap = await fetch(`${API_BASE}/api/public/map-points`);
      assert.equal(rMap.status, 200);
      assert.equal(rMap.headers.get('cache-control'), 'public, max-age=120');
      const mapData = await rMap.json();
      assert.ok(Array.isArray(mapData.points));
      for (const pt of mapData.points) {
        assert.deepEqual(Object.keys(pt).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
      }

      const rList = await fetch(`${API_BASE}/api/public/complaints?page=1&page_size=5`);
      assert.equal(rList.status, 200);
      const listData = await rList.json();
      assert.ok(Array.isArray(listData.items));
      for (const item of listData.items) {
        assert.deepEqual(Object.keys(item).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
      }

      if (listData.items.length > 0) {
        const ref = listData.items[0].public_reference;
        const rDetail = await fetch(`${API_BASE}/api/public/complaints/${ref}`);
        assert.equal(rDetail.status, 200);
        assert.equal(rDetail.headers.get('cache-control'), 'public, max-age=300');
        const detail = await rDetail.json();
        assert.deepEqual(Object.keys(detail).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
        assert.equal(detail.public_reference, ref);
      } else {
        const rMissing = await fetch(
          `${API_BASE}/api/public/complaints/11111111-2222-3333-4444-555555555555`
        );
        assert.equal(rMissing.status, 404);
      }
    });

    await check('4. Query validation returns 400 and malformed UUID returns 404 (not 422)', async () => {
      const bad400 = [
        '/api/public/stats?unexpected=1',
        '/api/public/complaints?page=0',
        '/api/public/complaints?category=invalid',
        '/api/public/complaints?status=rejected',
        '/api/public/map-points?extra=true',
      ];
      for (const urlPath of bad400) {
        const res = await fetch(`${API_BASE}${urlPath}`);
        assert.equal(res.status, 400, `Expected 400 for ${urlPath}, got ${res.status}`);
      }

      const bad404 = await fetch(`${API_BASE}/api/public/complaints/not-a-valid-uuid`);
      assert.equal(bad404.status, 404);
    });

    // 5. Rate limit enforcement on live server (remaining budget up to 61st request)
    await check('5. Rate limit returns 429 + Retry-After after 60 requests from same IP', async () => {
      // Requests already sent above: 4 + 2 (+1 detail/missing) + 6 = 13 calls on 127.0.0.1.
      // Send requests until we hit 429 within <= 65 attempts.
      let hit429 = null;
      for (let i = 0; i < 65; i += 1) {
        const res = await fetch(`${API_BASE}/api/public/stats`);
        if (res.status === 429) {
          hit429 = res;
          break;
        }
        assert.equal(res.status, 200, `Expected 200 before rate limit, got ${res.status}`);
      }
      assert.ok(hit429, 'Expected HTTP 429 after exhausting 60 req/min limit');
      const retryAfter = hit429.headers.get('retry-after');
      assert.ok(retryAfter && Number(retryAfter) >= 1, 'Expected Retry-After header on 429');
    });

    console.log(`\nAll ${passed} Phase 6.3 live verification checks passed.`);
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
