/**
 * ReportlyUrban — Phase 4.3 Live Database Integration Test Suite
 * Module: Complaint Status Management & Resolution Workflow
 *
 * Runs live assertions against the Supabase database.
 * Uses VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from frontend/.env for client/citizen/anon tests.
 * If SUPABASE_SERVICE_ROLE_KEY is also present, it additionally runs the full admin/officer transition lifecycle.
 *
 * Run:
 *   node supabase/tests/phase4_3_live.test.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('\n[ERROR] SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required in frontend/.env.');
  process.exit(1);
}

import { pathToFileURL } from 'node:url';

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
console.log('=== PHASE 4.3 COMPREHENSIVE LIVE DATABASE TEST SUITE ===');
console.log('================================================================');

async function runLiveSuite() {
  const runId = Date.now();
  const testCitizenEmail = `test_cit_${runId}@reportly.urban`;
  const testCitizenBEmail = `test_citB_${runId}@reportly.urban`;
  const testPassword = `TestPass123!${runId}`;

  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  let citizenUser = null;
  let citizenBUser = null;
  let citizenClient = null;
  let citizenBClient = null;
  let testComplaintId = null;

  try {
    // -------------------------------------------------------------------------
    // Setup Test Citizens (A and B)
    // -------------------------------------------------------------------------
    await testStep('Setup: Create dedicated authenticated Citizen A and Citizen B sessions', async () => {
      const { data: citAAuth, error: errA } = await anonClient.auth.signUp({
        email: testCitizenEmail,
        password: testPassword,
        options: { data: { full_name: `Test Citizen A ${runId}`, ward: 'Ward 12' } },
      });
      assert.equal(errA, null, 'Citizen A signup must succeed');
      assert.ok(citAAuth.session, 'Citizen A session must be returned');
      citizenUser = citAAuth.user;

      citizenClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      await citizenClient.auth.setSession(citAAuth.session);

      const { data: citBAuth, error: errB } = await anonClient.auth.signUp({
        email: testCitizenBEmail,
        password: testPassword,
        options: { data: { full_name: `Test Citizen B ${runId}`, ward: 'Ward 14' } },
      });
      assert.equal(errB, null, 'Citizen B signup must succeed');
      assert.ok(citBAuth.session, 'Citizen B session must be returned');
      citizenBUser = citBAuth.user;

      citizenBClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      await citizenBClient.auth.setSession(citBAuth.session);
    });

    // -------------------------------------------------------------------------
    // Phase 3 Complaint Submission Regression & Initial History Row
    // -------------------------------------------------------------------------
    await testStep('Citizen submits valid complaint (Phase 3 regression & trigger execution)', async () => {
      const { data: comp, error: insErr } = await citizenClient
        .from('complaints')
        .insert({
          citizen_id: citizenUser.id,
          title: 'Deep Pothole on 5th Avenue',
          description: 'Large crater near stormwater drain causing vehicular accidents.',
          category: 'potholes',
          location: '5th Avenue, Crossroad 4',
          ward: 'Ward 12',
          image_url: `${citizenUser.id}/test-pothole.jpg`,
        })
        .select()
        .single();

      assert.equal(insErr, null, 'Citizen complaint submission must succeed');
      assert.ok(comp?.id, 'Complaint ID must be present');
      assert.equal(comp.status, 'submitted');
      assert.match(comp.complaint_number, /^RU-\d{4}-\d+/);
      testComplaintId = comp.id;
    });

    // -------------------------------------------------------------------------
    // Direct Mutation Lockdown Verifications (Column-Level & Table-Level Grants)
    // -------------------------------------------------------------------------
    await testStep('Direct UPDATE on complaints.status is denied for authenticated citizen', async () => {
      const { error } = await citizenClient
        .from('complaints')
        .update({ status: 'resolved' })
        .eq('id', testComplaintId);

      assert.notEqual(error, null, 'Direct UPDATE on complaints.status MUST be denied');
      assert.match(error.message, /permission denied/i);
    });

    await testStep('Direct UPDATE on complaints.completion_image_url is denied', async () => {
      const { error } = await citizenClient
        .from('complaints')
        .update({ completion_image_url: 'resolution/fake/path.jpg' })
        .eq('id', testComplaintId);

      assert.notEqual(error, null, 'Direct UPDATE on complaints.completion_image_url MUST be denied');
      assert.match(error.message, /permission denied/i);
    });

    await testStep('Direct UPDATE on complaints.resolution_description is denied', async () => {
      const { error } = await citizenClient
        .from('complaints')
        .update({ resolution_description: 'Malicious modification of resolution statement' })
        .eq('id', testComplaintId);

      assert.notEqual(error, null, 'Direct UPDATE on complaints.resolution_description MUST be denied');
      assert.match(error.message, /permission denied/i);
    });

    await testStep('Direct INSERT on complaint_resolution_evidence is denied', async () => {
      const { error } = await citizenClient
        .from('complaint_resolution_evidence')
        .insert({
          complaint_id: testComplaintId,
          storage_path: 'resolution/fake/path.jpg',
          file_size_bytes: 100,
          mime_type: 'image/jpeg',
          uploaded_by: citizenUser.id,
        });

      assert.notEqual(error, null, 'Direct INSERT on complaint_resolution_evidence MUST be denied');
      assert.match(error.message, /permission denied/i);
    });

    await testStep('Direct INSERT on complaint_status_history is denied (immutable log bypass check)', async () => {
      const { error } = await citizenClient
        .from('complaint_status_history')
        .insert({
          complaint_id: testComplaintId,
          status: 'resolved',
          title: 'Fabricated status entry',
          actor_id: citizenUser.id,
        });

      assert.notEqual(error, null, 'Direct INSERT on complaint_status_history MUST be denied');
      assert.match(error.message, /permission denied/i);
    });

    await testStep('Direct UPDATE on complaint_status_history is denied', async () => {
      const { error } = await citizenClient
        .from('complaint_status_history')
        .update({ title: 'Tampered' })
        .eq('complaint_id', testComplaintId);

      assert.notEqual(error, null, 'Direct UPDATE on complaint_status_history MUST be denied');
      assert.match(error.message, /permission denied/i);
    });

    await testStep('Direct DELETE on complaint_status_history is denied', async () => {
      const { error } = await citizenClient
        .from('complaint_status_history')
        .delete()
        .eq('complaint_id', testComplaintId);

      assert.notEqual(error, null, 'Direct DELETE on complaint_status_history MUST be denied');
      assert.match(error.message, /permission denied/i);
    });

    // -------------------------------------------------------------------------
    // Anonymous Visitor Security & Lockdown
    // -------------------------------------------------------------------------
    await testStep('Anonymous visitor direct UPDATE on complaints.status is denied', async () => {
      const { error } = await anonClient
        .from('complaints')
        .update({ status: 'resolved' })
        .eq('id', testComplaintId);

      assert.notEqual(error, null);
    });

    await testStep('Anonymous visitor direct INSERT on complaint_resolution_evidence is denied', async () => {
      const { error } = await anonClient
        .from('complaint_resolution_evidence')
        .insert({
          complaint_id: testComplaintId,
          storage_path: 'resolution/fake/path.jpg',
          file_size_bytes: 100,
          mime_type: 'image/jpeg',
          uploaded_by: '00000000-0000-0000-0000-000000000000',
        });

      assert.notEqual(error, null);
    });

    await testStep('Anonymous visitor calling transition_complaint_status is rejected (42501)', async () => {
      const { error } = await anonClient.rpc('transition_complaint_status', {
        p_complaint_id: testComplaintId,
        p_new_status: 'resolved',
        p_expected_updated_at: new Date().toISOString(),
      });

      assert.notEqual(error, null);
      assert.match(error.message, /Complaint not found or you lack permission|Authentication required|permission denied/i);
    });

    await testStep('Citizen A calling transition_complaint_status is rejected (42501)', async () => {
      const { error } = await citizenClient.rpc('transition_complaint_status', {
        p_complaint_id: testComplaintId,
        p_new_status: 'resolved',
        p_expected_updated_at: new Date().toISOString(),
      });

      assert.notEqual(error, null);
      assert.match(error.message, /Complaint not found or you lack permission/i);
    });

    // -------------------------------------------------------------------------
    // History Visibility & Redaction Tests
    // -------------------------------------------------------------------------
    await testStep('Citizen A queries public_complaint_history: gets canonical title, zero internal_note', async () => {
      const { data: pubHistory, error } = await citizenClient
        .from('public_complaint_history')
        .select('*')
        .eq('complaint_id', testComplaintId);

      assert.equal(error, null);
      assert.ok(pubHistory && pubHistory.length > 0, 'Public history must contain initial submission row');

      const initialEvent = pubHistory[0];
      assert.equal(initialEvent.status, 'submitted');
      assert.equal(initialEvent.stage_title, 'Report Registered');
      assert.equal(initialEvent.public_description, null);
      assert.equal('internal_note' in initialEvent, false, 'View must never expose internal_note');
      assert.equal('actor_id' in initialEvent, false, 'View must never expose actor_id');
      assert.equal('notes' in initialEvent, false, 'View must never expose legacy notes column');
    });

    await testStep('Citizen B (other citizen) CANNOT read Citizen A complaint history (View Ownership Filter)', async () => {
      const { data: otherHistory, error } = await citizenBClient
        .from('public_complaint_history')
        .select('*')
        .eq('complaint_id', testComplaintId);

      assert.equal(error, null);
      assert.equal(otherHistory.length, 0, 'Unrelated citizen must receive 0 rows from public_complaint_history');
    });

    await testStep('Anonymous visitor CANNOT read complaint history via view (Revoked grant)', async () => {
      const { data: anonHistory, error } = await anonClient
        .from('public_complaint_history')
        .select('*')
        .eq('complaint_id', testComplaintId);

      assert.ok(Boolean(error) || anonHistory?.length === 0, 'Anonymous visitor must receive error or 0 rows');
    });

    await testStep('Anonymous visitor CANNOT read complaint_status_history base table (RLS check)', async () => {
      const { data: baseHistory, error } = await anonClient
        .from('complaint_status_history')
        .select('*')
        .eq('complaint_id', testComplaintId);

      assert.ok(Boolean(error) || baseHistory?.length === 0, 'Anonymous visitor must receive 0 rows');
    });

    // -------------------------------------------------------------------------
    // Optional Staff Lifecycle Tests (If SUPABASE_SERVICE_ROLE_KEY is provided)
    // -------------------------------------------------------------------------
    if (SUPABASE_SERVICE_KEY) {
      console.log('\n--- Running Staff Lifecycle & Concurrency Suite (Service Role Enabled) ---');
      const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const testAdminEmail = `test_adm_${runId}@reportly.urban`;
      const testOff1Email = `test_off1_${runId}@reportly.urban`;
      const testOff2Email = `test_off2_${runId}@reportly.urban`;

      let adminUser, off1User, off2User;
      let testDeptId, testOff1Id, testOff2Id;
      let officer1Client, officer2Client, adminSessionClient;
      let testResolutionStoragePath;

      await testStep('Staff Setup: Fetch active department & provision admin/officer users', async () => {
        const { data: depts } = await adminClient.from('departments').select('id').eq('is_active', true).limit(1);
        assert.ok(depts && depts.length > 0);
        testDeptId = depts[0].id;

        const admRes = await adminClient.auth.admin.createUser({
          email: testAdminEmail,
          password: testPassword,
          email_confirm: true,
          user_metadata: { full_name: `Admin ${runId}` },
        });
        adminUser = admRes.data.user;
        await adminClient.rpc('provision_admin_user', { p_user_email: testAdminEmail });

        const off1Res = await adminClient.auth.admin.createUser({
          email: testOff1Email,
          password: testPassword,
          email_confirm: true,
          user_metadata: { full_name: `Officer 1 ${runId}` },
        });
        off1User = off1Res.data.user;

        const off2Res = await adminClient.auth.admin.createUser({
          email: testOff2Email,
          password: testPassword,
          email_confirm: true,
          user_metadata: { full_name: `Officer 2 ${runId}` },
        });
        off2User = off2Res.data.user;

        const { data: o1Id } = await adminClient.rpc('link_officer_user', {
          p_user_email: testOff1Email,
          p_department_id: testDeptId,
          p_official_name: `Inspector Alpha ${runId}`,
          p_designation: 'Senior Ward Inspector',
          p_assigned_ward: 'Ward 12',
        });
        testOff1Id = o1Id;

        const { data: o2Id } = await adminClient.rpc('link_officer_user', {
          p_user_email: testOff2Email,
          p_department_id: testDeptId,
          p_official_name: `Inspector Beta ${runId}`,
          p_designation: 'Junior Engineer',
          p_assigned_ward: 'Ward 14',
        });
        testOff2Id = o2Id;

        adminSessionClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
        await adminSessionClient.auth.signInWithPassword({ email: testAdminEmail, password: testPassword });

        officer1Client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
        await officer1Client.auth.signInWithPassword({ email: testOff1Email, password: testPassword });

        officer2Client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
        await officer2Client.auth.signInWithPassword({ email: testOff2Email, password: testPassword });
      });

      await testStep('Officer reject attempt fails (Admin-Only rejection rule)', async () => {
        const { data: comp } = await adminClient.from('complaints').select('updated_at').eq('id', testComplaintId).single();
        const { error } = await officer1Client.rpc('transition_complaint_status', {
          p_complaint_id: testComplaintId,
          p_new_status: 'rejected',
          p_expected_updated_at: comp.updated_at,
          p_public_description: 'Officer rejection attempt',
        });
        assert.notEqual(error, null);
        assert.match(error.message, /Complaint rejection is strictly an administrative privilege/);
      });

      await testStep('Admin triages submitted -> under_review (records exactly 1 history row)', async () => {
        const { data: beforeRows } = await adminClient.from('complaint_status_history').select('id').eq('complaint_id', testComplaintId);
        const { data: comp } = await adminClient.from('complaints').select('updated_at').eq('id', testComplaintId).single();

        const { error } = await adminSessionClient.rpc('transition_complaint_status', {
          p_complaint_id: testComplaintId,
          p_new_status: 'under_review',
          p_expected_updated_at: comp.updated_at,
          p_public_description: 'Triaged by municipal administration.',
          p_internal_note: 'Assigned to Ward 12 queue.',
        });
        assert.equal(error, null);

        const { data: afterRows } = await adminClient.from('complaint_status_history').select('id').eq('complaint_id', testComplaintId);
        assert.equal(afterRows.length, beforeRows.length + 1);
      });

      await testStep('Admin assigns department and Officer 1', async () => {
        const { data: comp } = await adminClient.from('complaints').select('updated_at').eq('id', testComplaintId).single();
        const { error } = await adminSessionClient.rpc('assign_complaint_admin', {
          p_complaint_id: testComplaintId,
          p_department_id: testDeptId,
          p_officer_id: testOff1Id,
          p_priority: 'high',
          p_sla_deadline: new Date(Date.now() + 86400000).toISOString(),
          p_expected_updated_at: comp.updated_at,
        });
        assert.equal(error, null);
      });

      await testStep('Unassigned Officer 2 cannot move under_review -> in_progress (42501)', async () => {
        const { data: comp } = await adminClient.from('complaints').select('updated_at').eq('id', testComplaintId).single();
        const { error } = await officer2Client.rpc('transition_complaint_status', {
          p_complaint_id: testComplaintId,
          p_new_status: 'in_progress',
          p_expected_updated_at: comp.updated_at,
        });
        assert.notEqual(error, null);
      });

      await testStep('Assigned Officer 1 moves under_review -> in_progress', async () => {
        const { data: comp } = await adminClient.from('complaints').select('updated_at').eq('id', testComplaintId).single();
        const { error } = await officer1Client.rpc('transition_complaint_status', {
          p_complaint_id: testComplaintId,
          p_new_status: 'in_progress',
          p_expected_updated_at: comp.updated_at,
          p_public_description: 'Field remediation underway.',
          p_internal_note: 'Asphalt crew dispatched.',
        });
        assert.equal(error, null);
      });

      await testStep('Moving to resolved without resolution photo is rejected', async () => {
        const { data: comp } = await adminClient.from('complaints').select('updated_at').eq('id', testComplaintId).single();
        const { error } = await officer1Client.rpc('transition_complaint_status', {
          p_complaint_id: testComplaintId,
          p_new_status: 'resolved',
          p_expected_updated_at: comp.updated_at,
          p_public_description: 'Work completed without photo.',
          p_resolution_image_path: null,
        });
        assert.notEqual(error, null);
        assert.match(error.message, /Resolution Evidence Required/);
      });

      await testStep('Assigned Officer 1 completes resolution workflow with proof photo', async () => {
        const fileId = crypto.randomUUID();
        testResolutionStoragePath = `resolution/${testComplaintId}/${fileId}.jpg`;
        const dummyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0xff, 0xd9]);

        const { error: upErr } = await officer1Client.storage
          .from('complaint-images')
          .upload(testResolutionStoragePath, dummyJpeg, { contentType: 'image/jpeg', upsert: false });
        assert.equal(upErr, null);

        const { data: comp } = await adminClient.from('complaints').select('updated_at').eq('id', testComplaintId).single();
        const { error: transErr } = await officer1Client.rpc('transition_complaint_status', {
          p_complaint_id: testComplaintId,
          p_new_status: 'resolved',
          p_expected_updated_at: comp.updated_at,
          p_public_description: 'Pothole excavated, backfilled, and bitumen surface restored.',
          p_internal_note: 'Signed off by inspector.',
          p_resolution_image_path: testResolutionStoragePath,
        });
        assert.equal(transErr, null);

        const { data: resolvedComp } = await adminClient.from('complaints').select('status, resolution_description').eq('id', testComplaintId).single();
        assert.equal(resolvedComp.status, 'resolved');
        assert.match(resolvedComp.resolution_description, /bitumen surface restored/);
      });

      await testStep('Concurrency: Stale updated_at returns SQLSTATE 40001 (no timestamp leak)', async () => {
        const staleTimestamp = new Date(Date.now() - 3600000).toISOString();
        const { error } = await adminSessionClient.rpc('transition_complaint_status', {
          p_complaint_id: testComplaintId,
          p_new_status: 'under_review',
          p_expected_updated_at: staleTimestamp,
        });
        assert.notEqual(error, null);
        assert.equal(error.code, '40001');
        assert.doesNotMatch(error.message, /\d{4}-\d{2}-\d{2}/);
      });

      // Staff Cleanup
      if (testResolutionStoragePath) await adminClient.storage.from('complaint-images').remove([testResolutionStoragePath]);
      if (testComplaintId) {
        await adminClient.from('complaint_resolution_evidence').delete().eq('complaint_id', testComplaintId);
        await adminClient.from('complaint_status_history').delete().eq('complaint_id', testComplaintId);
        await adminClient.from('complaints').delete().eq('id', testComplaintId);
      }
      if (testOff1Id) await adminClient.from('officers').delete().eq('id', testOff1Id);
      if (testOff2Id) await adminClient.from('officers').delete().eq('id', testOff2Id);
      if (citizenUser) await adminClient.auth.admin.deleteUser(citizenUser.id);
      if (citizenBUser) await adminClient.auth.admin.deleteUser(citizenBUser.id);
      if (adminUser) await adminClient.auth.admin.deleteUser(adminUser.id);
      if (off1User) await adminClient.auth.admin.deleteUser(off1User.id);
      if (off2User) await adminClient.auth.admin.deleteUser(off2User.id);
    } else {
      console.log('\n[INFO] Staff lifecycle steps skipped: to run admin/officer transitions, add SUPABASE_SERVICE_ROLE_KEY to frontend/.env.');
    }
  } catch (err) {
    console.error('Fatal Test Runner Error:', err);
    failed++;
  }

  console.log('\n================================================================');
  console.log(`LIVE DATABASE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================');

  if (failed > 0) process.exit(1);
}

runLiveSuite();
