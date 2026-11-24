/**
 * ReportlyUrban — Phase 5 Live Environment Verification Suite
 * Module: Live JWKS Endpoint, Live Gemini Vision API, and Database Quota Verification
 *
 * Runs against live services:
 *   node supabase/tests/phase5_live.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

console.log('\n--- Running Phase 5 Live Verification Tests ---');

// Load live environment variables from frontend/.env
const envPath = resolve(process.cwd(), 'frontend/.env');
let supabaseUrl = 'https://dwcokzgdjyftrigdihkl.supabase.co';
let supabaseAnonKey = '';

try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('VITE_SUPABASE_URL=')) {
      supabaseUrl = trimmed.split('=')[1].trim();
    }
    if (trimmed.startsWith('VITE_SUPABASE_ANON_KEY=')) {
      supabaseAnonKey = trimmed.split('=')[1].trim();
    }
  }
} catch {
  // Use defaults
}

// -----------------------------------------------------------------------------
// 1. Live Supabase JWKS Verification Endpoint
// -----------------------------------------------------------------------------
await liveTest('Live Supabase Auth JWKS endpoint is reachable and serves ES256 key', async () => {
  const jwksUrl = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  const res = await fetch(jwksUrl);
  assert.equal(res.status, 200, `JWKS endpoint returned status ${res.status}`);

  const jwks = await res.json();
  assert.ok(Array.isArray(jwks.keys), 'JWKS keys must be an array');
  assert.ok(jwks.keys.length > 0, 'JWKS must contain at least one public key');

  const es256Key = jwks.keys.find((k) => k.kty === 'EC' || k.alg === 'ES256');
  assert.ok(es256Key, 'JWKS must include an asymmetric EC/ES256 public key');
  assert.ok(es256Key.kid, 'JWKS key must include key ID (kid)');
});

// -----------------------------------------------------------------------------
// 2. Live Supabase Auth Rejection on Invalid Token
// -----------------------------------------------------------------------------
await liveTest('Live Supabase Auth strictly rejects forged / invalid access token', async () => {
  const restUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/profiles?select=id,role&limit=1`;
  const res = await fetch(restUrl, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: 'Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.invalid.signature',
    },
  });

  // Supabase PostgREST rejects invalid signature with 401
  assert.equal(res.status, 401, 'Live Supabase must reject forged tokens with HTTP 401');
});

// -----------------------------------------------------------------------------
// 3. Live Gemini Vision API Execution (Synthetic Non-Identifiable Fixture)
// -----------------------------------------------------------------------------
await liveTest('Live Gemini Vision API is accessible and processes civic prompt schema', async () => {
  const { execSync } = await import('node:child_process');
  
  // Run verification script using backend virtualenv python
  const script = `
import asyncio, io
from PIL import Image, ImageDraw
from app.services.gemini_service import analyze_civic_image

img = Image.new('RGB', (200, 200), color=(128, 128, 128))
draw = ImageDraw.Draw(img)
draw.ellipse([50, 50, 150, 150], fill=(40, 40, 40))

buf = io.BytesIO()
img.save(buf, format='JPEG')
image_bytes = buf.getvalue()

async def run():
    res = await analyze_civic_image(image_bytes, 'image/jpeg')
    assert res is not None, 'Response is None'
    assert hasattr(res, 'is_civic_issue'), 'Missing is_civic_issue'

asyncio.run(run())
`;

  try {
    execSync(
      `$env:PYTHONPATH="backend"; backend/.venv/Scripts/python.exe -c "${script.replace(/"/g, '\\"')}"`,
      { shell: 'powershell.exe', stdio: 'pipe', timeout: 25000 }
    );
  } catch (err) {
    throw new Error(`Live Gemini Vision execution failed: ${err.stderr?.toString() || err.message}`);
  }
});

// -----------------------------------------------------------------------------
// 4. Live Database Quota Table & RPC Verification Checkpoint
// -----------------------------------------------------------------------------
await liveTest('Database Quota Table (public.ai_analysis_usage) & RPC Functions', async () => {
  // Query Supabase REST API to see if table exists
  const tableCheckUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/ai_analysis_usage?select=id&limit=1`;
  const res = await fetch(tableCheckUrl, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
  });

  if (res.status === 404) {
    const blockedErr = new Error(
      'Migration 20261125_phase5_ai_usage_tracking.sql is created on disk but has NOT been executed on live Supabase database yet. Awaiting explicit user approval before execution.'
    );
    blockedErr.isBlocked = true;
    throw blockedErr;
  }

  // If table exists, verify RLS blocks anon access
  assert.equal(
    res.status,
    401,
    'Live public.ai_analysis_usage must deny unauthenticated access'
  );
});

console.log(
  `\nPhase 5 Live Tests Summary: ${passed} passed, ${failed} failed, ${blocked} BLOCKED (checkpoint pending)\n`
);

if (failed > 0) {
  process.exit(1);
}
