/**
 * ReportlyUrban — Phase 7.3 Non-Destructive Live Verification
 * Rules:
 *   - Read-only GET requests + 401/403 authorization checks ONLY.
 *   - Do NOT create or modify complaints, do NOT run the SLA sweep, do NOT write DB data.
 *   - Never print tokens.
 *   - Checks whether pre-existing role credentials exist in local env; if absent, skips
 *     authenticated cross-role checks cleanly with exact reason without fabricating users.
 *
 * Run: node supabase/tests/phase7_3_live.test.js
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
const TEST_PORT = 8020;
const API_BASE = `http://127.0.0.1:${TEST_PORT}`;

async function waitForServerReady(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for FastAPI test server');
}

async function signInPassword(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Sign-in failed with status ${res.status}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function main() {
  const backendDir = path.resolve(__dirname, '../../backend');
  const pythonExe = path.resolve(backendDir, '.venv/Scripts/python.exe');

  const serverProc = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(TEST_PORT)],
    {
      cwd: backendDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  try {
    await waitForServerReady(API_BASE);
    console.log('\n[Phase 7.3 Live Non-Destructive Verification]');

    const unauthRoutes = [
      ['GET', '/api/admin/escalations'],
      ['GET', '/api/admin/sla-rules'],
      ['GET', '/api/admin/notifications'],
      ['GET', '/api/officer/reminders'],
      ['GET', '/api/officer/escalations'],
      ['GET', '/api/officer/notifications'],
      ['GET', '/api/officer/complaints/11111111-1111-4111-8111-111111111111'],
      ['GET', '/api/citizen/complaints/11111111-1111-4111-8111-111111111111/followup'],
    ];
    for (const [method, route] of unauthRoutes) {
      const res = await fetch(`${API_BASE}${route}`, { method });
      assert.equal(res.status, 401, `Expected 401 without token for ${method} ${route}, got ${res.status}`);
    }
    console.log(`  PASS  1. Unauthenticated requests return 401 on all ${unauthRoutes.length} read routes`);

    // Check if pre-existing role credentials exist in env (no test user creation)
    const adminEmail = process.env.TEST_ADMIN_EMAIL || '';
    const adminPass = process.env.TEST_ADMIN_PASSWORD || '';
    const officerEmail = process.env.TEST_OFFICER_EMAIL || '';
    const officerPass = process.env.TEST_OFFICER_PASSWORD || '';
    const citizenEmail = process.env.TEST_CITIZEN_EMAIL || '';
    const citizenPass = process.env.TEST_CITIZEN_PASSWORD || '';

    if (adminEmail && adminPass) {
      const token = await signInPassword(adminEmail, adminPass);
      const rRules = await fetch(`${API_BASE}/api/admin/sla-rules`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(rRules.status, 200);
      const rEsc = await fetch(`${API_BASE}/api/admin/escalations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(rEsc.status, 200);
      const rNotif = await fetch(`${API_BASE}/api/admin/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(rNotif.status, 200);
      console.log('  PASS  2a. Admin read-only GETs succeeded (no token logged)');
    } else {
      console.log('  NOT RUN  2a. Admin live GETs: TEST_ADMIN_EMAIL/TEST_ADMIN_PASSWORD not configured in env');
    }

    if (officerEmail && officerPass) {
      const token = await signInPassword(officerEmail, officerPass);
      const rRem = await fetch(`${API_BASE}/api/officer/reminders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(rRem.status, 200);
      const rForbidden = await fetch(`${API_BASE}/api/admin/sla-rules`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(rForbidden.status, 403);
      console.log('  PASS  2b. Officer read-only GETs + 403 on admin endpoint succeeded');
    } else {
      console.log('  NOT RUN  2b. Officer live GETs / officer A vs B isolation: officer test credentials not configured in env');
    }

    if (citizenEmail && citizenPass) {
      const token = await signInPassword(citizenEmail, citizenPass);
      const rForbAdmin = await fetch(`${API_BASE}/api/admin/escalations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rForbOff = await fetch(`${API_BASE}/api/officer/reminders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(rForbAdmin.status, 403);
      assert.equal(rForbOff.status, 403);
      console.log('  PASS  2c. Citizen blocked (403) on admin/officer endpoints');
    } else {
      console.log('  NOT RUN  2c. Citizen live 403 checks: citizen test credentials not configured in env');
    }
  } finally {
    serverProc.kill('SIGTERM');
    await new Promise((resolve) => {
      serverProc.on('exit', resolve);
      setTimeout(resolve, 1500);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
