/**
 * ReportlyUrban — Phase 4.4 Live Database Integration Test Suite
 * Module: Geospatial Integrity, Coordinate Check Constraints & Authorization
 *
 * Runs live assertions against the Supabase database.
 * Uses VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from frontend/.env for client/citizen/anon tests.
 *
 * Run:
 *   node supabase/tests/phase4_4_live.test.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to load env from frontend/.env or root .env
function loadLocalEnv() {
  const envPaths = [
    path.resolve(__dirname, '../../frontend/.env'),
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

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('\n[ERROR] SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required in frontend/.env.');
  process.exit(1);
}

const clientPath = path.resolve(__dirname, '../../frontend/node_modules/@supabase/supabase-js/dist/index.mjs');
const { createClient } = await import(pathToFileURL(clientPath).href);

let passed = 0;
let failed = 0;

async function testStep(name, fn) {
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
console.log('=== PHASE 4.4 COMPREHENSIVE LIVE GEOSPATIAL TEST SUITE ===');
console.log('================================================================');

async function runLiveSuite() {
  const runId = Date.now();
  const testCitizenEmail = `test_cit_geo_${runId}@reportly.urban`;
  const testCitizenBEmail = `test_citB_geo_${runId}@reportly.urban`;
  const testPassword = `TestPass123!${runId}`;

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  let citizenUser = null;
  let citizenBUser = null;
  let citizenClient = null;
  let citizenBClient = null;
  const createdComplaintIds = [];

  try {
    // -------------------------------------------------------------------------
    // Setup Test Citizens (A and B)
    // -------------------------------------------------------------------------
    await testStep('Setup: Create dedicated authenticated Citizen A and Citizen B sessions', async () => {
      const { data: citAAuth, error: errA } = await anonClient.auth.signUp({
        email: testCitizenEmail,
        password: testPassword,
        options: { data: { full_name: `Test Citizen Geo A ${runId}`, ward: 'Ward 12' } },
      });
      assert.equal(errA, null, 'Citizen A signup must succeed');
      assert.ok(citAAuth.session, 'Citizen A session must be returned');
      citizenUser = citAAuth.user;

      citizenClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      await citizenClient.auth.setSession(citAAuth.session);

      const { data: citBAuth, error: errB } = await anonClient.auth.signUp({
        email: testCitizenBEmail,
        password: testPassword,
        options: { data: { full_name: `Test Citizen Geo B ${runId}`, ward: 'Ward 14' } },
      });
      assert.equal(errB, null, 'Citizen B signup must succeed');
      assert.ok(citBAuth.session, 'Citizen B session must be returned');
      citizenBUser = citBAuth.user;

      citizenBClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      await citizenBClient.auth.setSession(citBAuth.session);
    });

    // -------------------------------------------------------------------------
    // 1. Live Insertion with Valid Coordinates
    // -------------------------------------------------------------------------
    await testStep('Citizen submits complaint with valid coordinates [12.971600, 77.594600]', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        citizen_id: citizenUser.id,
        title: `Pothole on MG Road ${runId}`,
        category: 'potholes',
        ward: 'Ward 12',
        location: 'MG Road near Metro Station',
        description: 'Large pothole in the left lane causing hazards for two wheelers.',
        image_url: `${citizenUser.id}/image1.jpg`,
        idempotency_key: idempotencyKey,
        latitude: 12.9716,
        longitude: 77.5946,
      };

      const { data, error } = await citizenClient
        .from('complaints')
        .insert(payload)
        .select('id, complaint_number, status, latitude, longitude, location, ward')
        .single();

      assert.equal(error, null, `Insert must succeed: ${error?.message}`);
      assert.ok(data.id, 'Complaint ID must be generated');
      assert.equal(Number(data.latitude).toFixed(4), '12.9716');
      assert.equal(Number(data.longitude).toFixed(4), '77.5946');
      createdComplaintIds.push(data.id);
    });

    // -------------------------------------------------------------------------
    // 2. Backward Compatibility: Live Insertion with NULL Coordinates
    // -------------------------------------------------------------------------
    await testStep('Citizen submits complaint with NULL coordinates (backward-compatibility)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        citizen_id: citizenUser.id,
        title: `Garbage accumulation ${runId}`,
        category: 'garbage',
        ward: 'Ward 12',
        location: 'Community Park Gate 2',
        description: 'Uncollected garbage accumulating over the weekend without clearance.',
        image_url: `${citizenUser.id}/image2.jpg`,
        idempotency_key: idempotencyKey,
        latitude: null,
        longitude: null,
      };

      const { data, error } = await citizenClient
        .from('complaints')
        .insert(payload)
        .select('id, complaint_number, status, latitude, longitude')
        .single();

      assert.equal(error, null, `Insert with NULL coordinates must succeed: ${error?.message}`);
      assert.ok(data.id, 'Complaint ID must be generated');
      assert.equal(data.latitude, null);
      assert.equal(data.longitude, null);
      createdComplaintIds.push(data.id);
    });

    // -------------------------------------------------------------------------
    // 3. Database Check Constraint: Latitude Boundary Enforcement [-90, 90]
    // -------------------------------------------------------------------------
    await testStep('Database rejects latitude > 90 (chk_complaints_latitude)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        citizen_id: citizenUser.id,
        title: `Invalid lat test ${runId}`,
        category: 'potholes',
        ward: 'Ward 12',
        location: 'Invalid Latitude',
        description: 'Testing check constraint rejection for out-of-bounds north latitude.',
        image_url: `${citizenUser.id}/image3.jpg`,
        idempotency_key: idempotencyKey,
        latitude: 95.0,
        longitude: 77.5946,
      };

      const { data, error } = await citizenClient.from('complaints').insert(payload).select('id').maybeSingle();
      if (data?.id) createdComplaintIds.push(data.id);
      assert.ok(error, 'Insert with latitude > 90 must fail');
      assert.match(
        `${error?.message || ''} ${error?.details || ''}`,
        /chk_complaints_latitude|violates check constraint/i,
        'Expected constraint chk_complaints_latitude violation'
      );
    });

    await testStep('Database rejects latitude < -90 (chk_complaints_latitude)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        citizen_id: citizenUser.id,
        title: `Invalid lat test south ${runId}`,
        category: 'potholes',
        ward: 'Ward 12',
        location: 'Invalid South Latitude',
        description: 'Testing check constraint rejection for out-of-bounds south latitude.',
        image_url: `${citizenUser.id}/image4.jpg`,
        idempotency_key: idempotencyKey,
        latitude: -95.0,
        longitude: 77.5946,
      };

      const { data, error } = await citizenClient.from('complaints').insert(payload).select('id').maybeSingle();
      if (data?.id) createdComplaintIds.push(data.id);
      assert.ok(error, 'Insert with latitude < -90 must fail');
      assert.match(
        `${error?.message || ''} ${error?.details || ''}`,
        /chk_complaints_latitude|violates check constraint/i,
        'Expected constraint chk_complaints_latitude violation'
      );
    });

    // -------------------------------------------------------------------------
    // 4. Database Check Constraint: Longitude Boundary Enforcement [-180, 180]
    // -------------------------------------------------------------------------
    await testStep('Database rejects longitude > 180 (chk_complaints_longitude)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        citizen_id: citizenUser.id,
        title: `Invalid lng test ${runId}`,
        category: 'potholes',
        ward: 'Ward 12',
        location: 'Invalid Longitude',
        description: 'Testing check constraint rejection for out-of-bounds east longitude.',
        image_url: `${citizenUser.id}/image5.jpg`,
        idempotency_key: idempotencyKey,
        latitude: 12.9716,
        longitude: 185.0,
      };

      const { data, error } = await citizenClient.from('complaints').insert(payload).select('id').maybeSingle();
      if (data?.id) createdComplaintIds.push(data.id);
      assert.ok(error, 'Insert with longitude > 180 must fail');
      assert.match(
        `${error?.message || ''} ${error?.details || ''}`,
        /chk_complaints_longitude|violates check constraint/i,
        'Expected constraint chk_complaints_longitude violation'
      );
    });

    await testStep('Database rejects longitude < -180 (chk_complaints_longitude)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        citizen_id: citizenUser.id,
        title: `Invalid lng test west ${runId}`,
        category: 'potholes',
        ward: 'Ward 12',
        location: 'Invalid West Longitude',
        description: 'Testing check constraint rejection for out-of-bounds west longitude.',
        image_url: `${citizenUser.id}/image6.jpg`,
        idempotency_key: idempotencyKey,
        latitude: 12.9716,
        longitude: -185.0,
      };

      const { data, error } = await citizenClient.from('complaints').insert(payload).select('id').maybeSingle();
      if (data?.id) createdComplaintIds.push(data.id);
      assert.ok(error, 'Insert with longitude < -180 must fail');
      assert.match(
        `${error?.message || ''} ${error?.details || ''}`,
        /chk_complaints_longitude|violates check constraint/i,
        'Expected constraint chk_complaints_longitude violation'
      );
    });

    // -------------------------------------------------------------------------
    // 5. Database Check Constraint: Coordinate Pair Completeness
    // -------------------------------------------------------------------------
    await testStep('Database rejects solitary latitude with NULL longitude (chk_complaints_coordinates_pair)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        citizen_id: citizenUser.id,
        title: `Solitary lat test ${runId}`,
        category: 'streetlights',
        ward: 'Ward 12',
        location: 'Solitary Lat',
        description: 'Testing coordinate completeness rejection when longitude is null.',
        image_url: `${citizenUser.id}/image7.jpg`,
        idempotency_key: idempotencyKey,
        latitude: 12.9716,
        longitude: null,
      };

      const { data, error } = await citizenClient.from('complaints').insert(payload).select('id').maybeSingle();
      if (data?.id) createdComplaintIds.push(data.id);
      assert.ok(error, 'Insert with solitary latitude must fail');
      assert.match(
        `${error?.message || ''} ${error?.details || ''}`,
        /chk_complaints_coordinates_pair|violates check constraint/i,
        'Expected constraint chk_complaints_coordinates_pair violation'
      );
    });

    await testStep('Database rejects solitary longitude with NULL latitude (chk_complaints_coordinates_pair)', async () => {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        citizen_id: citizenUser.id,
        title: `Solitary lng test ${runId}`,
        category: 'drainage',
        ward: 'Ward 12',
        location: 'Solitary Lng',
        description: 'Testing coordinate completeness rejection when latitude is null.',
        image_url: `${citizenUser.id}/image8.jpg`,
        idempotency_key: idempotencyKey,
        latitude: null,
        longitude: 77.5946,
      };

      const { data, error } = await citizenClient.from('complaints').insert(payload).select('id').maybeSingle();
      if (data?.id) createdComplaintIds.push(data.id);
      assert.ok(error, 'Insert with solitary longitude must fail');
      assert.match(
        `${error?.message || ''} ${error?.details || ''}`,
        /chk_complaints_coordinates_pair|violates check constraint/i,
        'Expected constraint chk_complaints_coordinates_pair violation'
      );
      assert.equal(data, null);
    });

    // -------------------------------------------------------------------------
    // 6. Authorization Isolation & View Security
    // -------------------------------------------------------------------------
    await testStep('Citizen A can query own complaint with coordinates', async () => {
      assert.ok(createdComplaintIds.length > 0, 'At least one test complaint must exist');
      const testId = createdComplaintIds[0];

      const { data, error } = await citizenClient
        .from('complaints')
        .select('id, complaint_number, latitude, longitude, location, ward')
        .eq('id', testId)
        .maybeSingle();

      assert.equal(error, null);
      assert.ok(data, 'Citizen A must find own complaint');
      assert.equal(Number(data.latitude).toFixed(4), '12.9716');
      assert.equal(Number(data.longitude).toFixed(4), '77.5946');
    });

    await testStep('Citizen B cannot query Citizen A complaint (RLS isolation)', async () => {
      const testId = createdComplaintIds[0];

      const { data, error } = await citizenBClient
        .from('complaints')
        .select('id, complaint_number, latitude, longitude')
        .eq('id', testId)
        .maybeSingle();

      assert.equal(error, null);
      assert.equal(data, null, 'Citizen B query on Citizen A complaint must return null via RLS');
    });

    await testStep('Anonymous user cannot read from complaints table (RLS returns empty)', async () => {
      const testId = createdComplaintIds[0];

      const { data, error } = await anonClient
        .from('complaints')
        .select('id, complaint_number, latitude, longitude')
        .eq('id', testId)
        .maybeSingle();

      assert.equal(data, null, 'Anon direct select on complaints table must return null via RLS');
    });

    await testStep('public_complaints view allows safe public reading without exposing citizen PII', async () => {
      const testId = createdComplaintIds[0];

      const { data, error } = await anonClient
        .from('public_complaints')
        .select('*')
        .eq('id', testId)
        .maybeSingle();

      assert.equal(error, null, 'public_complaints view must be accessible');
      if (data) {
        assert.ok(data.complaint_number, 'Complaint number must be public');
        assert.ok(data.title, 'Title must be public');
        assert.equal(data.citizen_id, undefined, 'citizen_id must NEVER be exposed in public_complaints');
        assert.equal(data.phone_number, undefined, 'phone_number must NEVER be exposed in public_complaints');
      }
    });

    await testStep('Authenticated citizen cannot directly UPDATE complaints table', async () => {
      const testId = createdComplaintIds[0];

      const { error } = await citizenClient
        .from('complaints')
        .update({ status: 'resolved' })
        .eq('id', testId);

      assert.ok(error, 'Direct UPDATE by citizen must be blocked by RLS / lack of UPDATE grant');
    });

  } finally {
    // -------------------------------------------------------------------------
    // Cleanup: Delete created complaints
    // -------------------------------------------------------------------------
    if (citizenClient && createdComplaintIds.length > 0) {
      for (const id of createdComplaintIds) {
        try {
          await citizenClient.from('complaints').delete().eq('id', id);
        } catch {
          // Best effort cleanup
        }
      }
    }
  }
}

await runLiveSuite();

console.log(`\n================================================================`);
console.log(`Live Tests Finished: ${passed} passed, ${failed} failed.`);
console.log('================================================================\n');

if (failed > 0) {
  process.exit(1);
}
