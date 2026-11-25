/**
 * ReportlyUrban — Phase 6.4 Live Explorer & Public Details Verification Suite
 * Non-destructive test against live Supabase PostgreSQL RPCs + FastAPI Uvicorn server:
 *   node supabase/tests/phase6_4_live.test.js
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

const TEST_PORT = 8017;
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

async function waitForServerReady(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // Server still starting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for FastAPI test server to start');
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
    console.log('\n[Phase 6.4 Live Verification — Public Explorer & Details API]');

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

    let firstListRef = null;

    await check('1. Fetch first list page (/api/public/complaints) & confirm allow-listed keys only', async () => {
      const res = await fetch(`${API_BASE}/api/public/complaints?page=1&page_size=20`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=120');

      const body = await res.json();
      assert.ok(Array.isArray(body.items));
      for (const item of body.items) {
        assert.deepEqual(Object.keys(item).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
        assert.notEqual(item.status, 'rejected');
      }
      if (body.items.length > 0) {
        firstListRef = body.items[0].public_reference;
      }
    });

    await check('2. Open real reference (if present) and verify allow-listed fields & headers', async () => {
      if (!firstListRef) {
        console.log('    INFO  No public complaints currently in live DB; skipping positive detail fetch.');
        return;
      }
      const res = await fetch(`${API_BASE}/api/public/complaints/${firstListRef}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
      const detail = await res.json();
      assert.deepEqual(Object.keys(detail).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
      assert.equal(detail.public_reference, firstListRef);
      assert.notEqual(detail.status, 'rejected');
    });

    await check('3. Random UUID and malformed reference return identical 404 with Cache-Control: no-store', async () => {
      const randomUuidRes = await fetch(
        `${API_BASE}/api/public/complaints/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`
      );
      const malformedRes = await fetch(`${API_BASE}/api/public/complaints/not-a-uuid`);

      assert.equal(randomUuidRes.status, 404);
      assert.equal(malformedRes.status, 404);
      assert.equal(randomUuidRes.headers.get('cache-control'), 'no-store');
      assert.equal(malformedRes.headers.get('cache-control'), 'no-store');

      const body1 = await randomUuidRes.json();
      const body2 = await malformedRes.json();
      assert.deepEqual(body1, body2);
    });

    await check('4. Ward dropdown names endpoint & invalid filter Cache-Control: no-store check', async () => {
      const wardsRes = await fetch(`${API_BASE}/api/public/wards/names`);
      assert.equal(wardsRes.status, 200);
      assert.equal(wardsRes.headers.get('cache-control'), 'public, max-age=600');
      const wardsData = await wardsRes.json();
      assert.ok(Array.isArray(wardsData.wards));
      assert.equal(wardsData.wards.includes('Other'), false);

      const badFilterRes = await fetch(`${API_BASE}/api/public/complaints?status=rejected`);
      assert.equal(badFilterRes.status, 400);
      assert.equal(badFilterRes.headers.get('cache-control'), 'no-store');
    });

    await check('5. Home recent feed (page=1&page_size=3): every linked reference opens detail endpoint with HTTP 200', async () => {
      const homeListRes = await fetch(`${API_BASE}/api/public/complaints?page=1&page_size=3`);
      assert.equal(homeListRes.status, 200);
      const homeListBody = await homeListRes.json();
      assert.ok(Array.isArray(homeListBody.items));
      assert.ok(homeListBody.items.length <= 3);

      for (const item of homeListBody.items) {
        assert.deepEqual(Object.keys(item).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
        const detailRes = await fetch(
          `${API_BASE}/api/public/complaints/${encodeURIComponent(item.public_reference)}`
        );
        assert.equal(
          detailRes.status,
          200,
          `Expected 200 for linked reference ${item.public_reference}, got ${detailRes.status}`
        );
        const detail = await detailRes.json();
        assert.deepEqual(Object.keys(detail).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
        assert.equal(detail.public_reference, item.public_reference);
      }
    });

    console.log(`\nAll ${passed} Phase 6.4 live checks passed.`);
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
