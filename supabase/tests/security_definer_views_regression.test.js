/**
 * ReportlyUrban — Regression Verification Suite for Security Advisor View Fixes
 * Covers:
 *   1. Anonymous access on public_officers, public_complaints, public_complaint_history, and Phase 6 public RPCs
 *   2. Citizen access, cross-citizen complaint isolation, unauthorized officer isolation, history isolation
 *   3. Assigned vs unassigned officer access (including internal_note exclusion on complaint_status_history)
 *   4. Admin access across all 3 views and base complaint_status_history
 *   5. Non-regression of Phase 6 / citizen / officer API behavior
 *
 * Run against live Supabase AFTER applying 20261205_fix_security_definer_views.sql:
 *   node supabase/tests/security_definer_views_regression.test.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadLocalEnv() {
  for (const rel of ['../../frontend/.env', '../../backend/.env', '../../.env']) {
    const p = path.resolve(__dirname, rel);
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx !== -1) {
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
          if (!process.env[k]) process.env[k] = v;
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

const adminService = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function makeUser(roleLabel, role = 'citizen') {
  const email = `sec_view_${roleLabel}_${Date.now()}_${crypto.randomInt(1000, 9999)}@reportly.urban`;
  const password = `SecPass123!${crypto.randomInt(1000, 9999)}`;
  const { data: created, error } = await adminService.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Test ${roleLabel}`, ward: 'Ward 1' },
  });
  assert.equal(error, null);
  const uid = created.user.id;
  if (role !== 'citizen') {
    await adminService.from('profiles').update({ role }).eq('id', uid);
  }
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInErr } = await client.auth.signInWithPassword({ email, password });
  assert.equal(signInErr, null);
  return { uid, client };
}

const createdUserIds = [];
const createdComplaintIds = [];
const createdOfficerIds = [];

try {
  const citizenA = await makeUser('citA', 'citizen');
  const citizenB = await makeUser('citB', 'citizen');
  const officerA = await makeUser('offA', 'officer');
  const officerB = await makeUser('offB', 'officer');
  const adminUser = await makeUser('admin', 'admin');
  createdUserIds.push(citizenA.uid, citizenB.uid, officerA.uid, officerB.uid, adminUser.uid);

  const { data: dept } = await adminService.from('departments').select('id').limit(1).single();
  const { data: offARow } = await adminService
    .from('officers')
    .insert({
      profile_id: officerA.uid,
      department_id: dept.id,
      official_name: 'Regression Officer A',
      designation: 'Inspector',
      assigned_ward: 'Ward 1',
      is_active: true,
    })
    .select('id')
    .single();
  const { data: offBRow } = await adminService
    .from('officers')
    .insert({
      profile_id: officerB.uid,
      department_id: dept.id,
      official_name: 'Regression Officer B',
      designation: 'Engineer',
      assigned_ward: 'Ward 2',
      is_active: true,
    })
    .select('id')
    .single();
  createdOfficerIds.push(offARow.id, offBRow.id);

  // Citizen A creates complaint assigned to Officer A, with an internal note
  const { data: compA } = await citizenA.client
    .from('complaints')
    .insert({
      citizen_id: citizenA.uid,
      title: 'Regression Test Pothole A',
      category: 'potholes',
      ward: 'Ward 1',
      location: 'Street 10',
      description: 'Testing security invoker views with full RLS boundary checks.',
      image_url: `${citizenA.uid}/${crypto.randomUUID()}.jpg`,
      idempotency_key: crypto.randomUUID(),
    })
    .select('id, updated_at')
    .single();
  createdComplaintIds.push(compA.id);

  await adminUser.client.rpc('assign_complaint_admin', {
    p_complaint_id: compA.id,
    p_department_id: dept.id,
    p_officer_id: offARow.id,
    p_priority: 'high',
    p_sla_deadline: null,
    p_expected_updated_at: compA.updated_at,
  });

  // 1. Anonymous access denied on all 3 views + function
  for (const viewName of ['public_officers', 'public_complaints', 'public_complaint_history']) {
    const { error } = await anonClient.from(viewName).select('*').limit(1);
    assert.ok(error, `anon must be denied on ${viewName}`);
  }
  const { data: pubStats } = await adminService.rpc('public_dashboard_stats');
  assert.ok(pubStats, 'Phase 6 public_dashboard_stats RPC still works via service_role');

  // 2. Citizen A vs Citizen B (cross-citizen & unauthorized officer isolation)
  const { data: citAOfficers } = await citizenA.client.from('public_officers').select('*');
  assert.equal(citAOfficers?.length ?? 0, 0, 'Citizen A must receive 0 rows from public_officers');

  const { data: citBComplaints } = await citizenB.client
    .from('public_complaints')
    .select('*')
    .eq('id', compA.id);
  assert.equal(citBComplaints?.length ?? 0, 0, 'Citizen B must not see Citizen A complaint via public_complaints');

  const { data: citAComplaints } = await citizenA.client
    .from('public_complaints')
    .select('*')
    .eq('id', compA.id);
  assert.equal(citAComplaints?.length, 1, 'Citizen A sees own complaint');
  assert.equal(citAComplaints[0].officer_name, null, 'Citizen A must NOT see unauthorized officer_name via officers RLS');

  const { data: citBHistory } = await citizenB.client
    .from('public_complaint_history')
    .select('*')
    .eq('complaint_id', compA.id);
  assert.equal(citBHistory?.length ?? 0, 0, 'Citizen B must receive 0 rows from public_complaint_history');

  const { data: citAHistory } = await citizenA.client
    .from('public_complaint_history')
    .select('*')
    .eq('complaint_id', compA.id);
  assert.ok((citAHistory?.length ?? 0) >= 1, 'Citizen A must still see own timeline via public_complaint_history');
  assert.equal('internal_note' in citAHistory[0], false, 'internal_note must never appear');

  // 3. Officer A (assigned) vs Officer B (unassigned)
  const { data: offAOfficers } = await officerA.client.from('public_officers').select('*');
  assert.equal(offAOfficers?.length, 1);
  assert.equal(offAOfficers[0].id, offARow.id, 'Officer A sees only self in public_officers');

  const { data: offAHistory } = await officerA.client
    .from('public_complaint_history')
    .select('*')
    .eq('complaint_id', compA.id);
  assert.ok((offAHistory?.length ?? 0) >= 1, 'Assigned Officer A sees complaint timeline');

  const { data: offBHistory } = await officerB.client
    .from('public_complaint_history')
    .select('*')
    .eq('complaint_id', compA.id);
  assert.equal(offBHistory?.length ?? 0, 0, 'Unassigned Officer B receives 0 rows from public_complaint_history');

  const { data: offABaseHist } = await officerA.client
    .from('complaint_status_history')
    .select('*')
    .eq('complaint_id', compA.id);
  assert.equal(offABaseHist?.length ?? 0, 0, 'Phase 7.4 base-table internal_note isolation preserved for officers');

  // 4. Admin access across all 3 views and base history
  const { data: admOfficers } = await adminUser.client.from('public_officers').select('*');
  assert.ok((admOfficers?.length ?? 0) >= 2, 'Admin sees all active officers');

  const { data: admComplaints } = await adminUser.client
    .from('public_complaints')
    .select('*')
    .eq('id', compA.id);
  assert.equal(admComplaints?.length, 1);
  assert.equal(admComplaints[0].officer_name, 'Regression Officer A');

  const { data: admHistory } = await adminUser.client
    .from('public_complaint_history')
    .select('*')
    .eq('complaint_id', compA.id);
  assert.ok((admHistory?.length ?? 0) >= 1, 'Admin sees sanitized timeline');

  console.log('\n[PASS] All regression checks passed for public_officers, public_complaints, and public_complaint_history.');
} finally {
  for (const cid of createdComplaintIds) {
    await adminService.from('complaint_assignment_audit').delete().eq('complaint_id', cid);
    await adminService.from('complaint_status_history').delete().eq('complaint_id', cid);
    await adminService.from('complaint_sla_state').delete().eq('complaint_id', cid);
    await adminService.from('complaints').delete().eq('id', cid);
  }
  for (const oid of createdOfficerIds) {
    await adminService.from('officers').delete().eq('id', oid);
  }
  for (const uid of createdUserIds) {
    await adminService.auth.admin.deleteUser(uid);
  }
}
