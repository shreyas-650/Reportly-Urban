/**
 * ReportlyUrban — Phase 6.5 Live Map API Verification Suite
 * Non-destructive check against live Supabase + local FastAPI Uvicorn server:
 *   node supabase/tests/phase6_5_live.test.js
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_PORT = 8018;
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

const ALLOWED_MAP_TOP_KEYS = new Set([
  'points',
  'truncated',
  'total_count',
  'unmapped_count',
  'count_suppressed',
]);

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
    console.log('\n[Phase 6.5 Live Verification — /api/public/map-points]');

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

    let discoveredWard = null;

    await check('1. Unfiltered GET /api/public/map-points returns allow-listed keys and valid coordinate ranges', async () => {
      const res = await fetch(`${API_BASE}/api/public/map-points`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=120');

      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), [...ALLOWED_MAP_TOP_KEYS].sort());
      assert.ok(Array.isArray(body.points));

      for (const pt of body.points) {
        assert.deepEqual(Object.keys(pt).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
        assert.notEqual(pt.status, 'rejected');
        assert.equal(typeof pt.latitude, 'number');
        assert.equal(typeof pt.longitude, 'number');
        assert.ok(Number.isFinite(pt.latitude) && pt.latitude >= -90 && pt.latitude <= 90);
        assert.ok(Number.isFinite(pt.longitude) && pt.longitude >= -180 && pt.longitude <= 180);
        if (!discoveredWard && pt.ward) {
          discoveredWard = pt.ward;
        }
      }
    });

    await check('2. Filtered GET /api/public/map-points (category & ward) enforces allow-list & valid coordinates', async () => {
      const catRes = await fetch(`${API_BASE}/api/public/map-points?category=potholes`);
      assert.equal(catRes.status, 200);
      const catBody = await catRes.json();
      assert.deepEqual(Object.keys(catBody).sort(), [...ALLOWED_MAP_TOP_KEYS].sort());
      for (const pt of catBody.points) {
        assert.equal(pt.category, 'potholes');
        assert.deepEqual(Object.keys(pt).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
        assert.ok(pt.latitude >= -90 && pt.latitude <= 90);
        assert.ok(pt.longitude >= -180 && pt.longitude <= 180);
      }

      if (discoveredWard) {
        const wardRes = await fetch(
          `${API_BASE}/api/public/map-points?ward=${encodeURIComponent(discoveredWard)}&category=potholes`
        );
        assert.equal(wardRes.status, 200);
        const wardBody = await wardRes.json();
        assert.deepEqual(Object.keys(wardBody).sort(), [...ALLOWED_MAP_TOP_KEYS].sort());
        for (const pt of wardBody.points) {
          assert.deepEqual(Object.keys(pt).sort(), [...ALLOWED_PUBLIC_ITEM_KEYS].sort());
        }
      }
    });

    await check('3. Invalid map query parameters return 400 with Cache-Control: no-store', async () => {
      const badCat = await fetch(`${API_BASE}/api/public/map-points?category=invalid_cat`);
      assert.equal(badCat.status, 400);
      assert.equal(badCat.headers.get('cache-control'), 'no-store');

      const badUnknown = await fetch(`${API_BASE}/api/public/map-points?status=submitted`);
      assert.equal(badUnknown.status, 400);
      assert.equal(badUnknown.headers.get('cache-control'), 'no-store');
    });

    console.log(`\nAll ${passed} Phase 6.5 live map verification checks passed.`);
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
