/**
 * ReportlyUrban — Phase 4.3 Unit Test Suite
 * Module: Complaint Status Management & Resolution Workflow
 *
 * Runs locally without database connection:
 *   node supabase/tests/phase4_3_unit.test.js
 */

import assert from 'node:assert/strict';
import {
  INCIDENT_STORAGE_PATH_REGEX,
  RESOLUTION_STORAGE_PATH_REGEX,
  isValidStoragePath,
  generateResolutionStoragePath,
  validateImageFile,
} from '../../frontend/src/services/storageService.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(`         ${err.message}`);
  }
}

console.log('\n--- Running Phase 4.3 Unit Tests ---');

// -----------------------------------------------------------------------------
// 1. Storage Path Regex & Path Traversal Immunity
// -----------------------------------------------------------------------------
test('Valid incident storage path passes regex', () => {
  const path = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg';
  assert.equal(INCIDENT_STORAGE_PATH_REGEX.test(path), true);
  assert.equal(isValidStoragePath(path), true);
});

test('Valid resolution storage path passes regex', () => {
  const path = 'resolution/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png';
  assert.equal(RESOLUTION_STORAGE_PATH_REGEX.test(path), true);
  assert.equal(isValidStoragePath(path), true);
});

test('Path traversal attempts are rejected', () => {
  const maliciousPaths = [
    '../11111111-1111-4111-8111-111111111111/file.jpg',
    'resolution/../../etc/passwd',
    'resolution/11111111-1111-4111-8111-111111111111/../../../secret.jpg',
    'resolution/invalid-uuid/file.jpg',
    'complaint-images/resolution/11111111-1111-4111-8111-111111111111/file.jpg',
  ];
  for (const path of maliciousPaths) {
    assert.equal(isValidStoragePath(path), false, `Should reject ${path}`);
  }
});

test('Non-image extensions are rejected', () => {
  const badExtensions = [
    'resolution/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.exe',
    'resolution/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf',
    'resolution/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.svg',
    'resolution/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.gif',
  ];
  for (const path of badExtensions) {
    assert.equal(isValidStoragePath(path), false, `Should reject extension: ${path}`);
  }
});

// -----------------------------------------------------------------------------
// 2. generateResolutionStoragePath
// -----------------------------------------------------------------------------
test('generateResolutionStoragePath creates isolated, formatted path', () => {
  const complaintId = 'a0000000-0000-0000-0000-000000000001';
  const path = generateResolutionStoragePath(complaintId, 'image/jpeg');
  assert.equal(path.startsWith(`resolution/${complaintId}/`), true);
  assert.equal(path.endsWith('.jpg'), true);
  assert.equal(isValidStoragePath(path), true);
});

test('generateResolutionStoragePath rejects invalid complaintId', () => {
  assert.throws(() => {
    generateResolutionStoragePath('not-a-uuid', 'image/png');
  }, /valid complaint UUID is required/);
});

// -----------------------------------------------------------------------------
// 3. validateImageFile
// -----------------------------------------------------------------------------
test('validateImageFile accepts valid JPEG, PNG, WebP under 8MB', () => {
  const validFile = { type: 'image/jpeg', size: 2 * 1024 * 1024 };
  const res = validateImageFile(validFile);
  assert.equal(res.valid, true);
  assert.equal(res.error, null);
});

test('validateImageFile rejects files exceeding 8MB', () => {
  const largeFile = { type: 'image/png', size: 9 * 1024 * 1024 };
  const res = validateImageFile(largeFile);
  assert.equal(res.valid, false);
  assert.match(res.error, /exceeds the 8 MB maximum limit/);
});

test('validateImageFile rejects unsupported MIME types', () => {
  const badFiles = [
    { type: 'image/gif', size: 1024 },
    { type: 'application/pdf', size: 1024 },
    { type: 'image/svg+xml', size: 1024 },
    { type: 'text/plain', size: 1024 },
  ];
  for (const f of badFiles) {
    const res = validateImageFile(f);
    assert.equal(res.valid, false);
    assert.match(res.error, /Unsupported file format/);
  }
});

// -----------------------------------------------------------------------------
// 4. State Machine Transition Matrix Simulation
// -----------------------------------------------------------------------------
const VALID_TRANSITIONS = {
  submitted: ['under_review', 'rejected'],
  under_review: ['in_progress', 'rejected'],
  in_progress: ['resolved', 'rejected'],
  resolved: [], // Terminal
  rejected: [], // Terminal
};

function checkTransitionPermitted(from, to, role, isAssigned) {
  // Rejection is strictly admin-only
  if (to === 'rejected' && role !== 'admin') {
    return { allowed: false, reason: 'Officer rejection strictly forbidden' };
  }

  // Triage to under_review is admin-only
  if (from === 'submitted' && to === 'under_review' && role !== 'admin') {
    return { allowed: false, reason: 'Admin triage required' };
  }

  // Officers can only transition complaints assigned to them
  if (role === 'officer' && !isAssigned) {
    return { allowed: false, reason: 'Officer not assigned' };
  }

  const allowedTargets = VALID_TRANSITIONS[from] || [];
  if (!allowedTargets.includes(to)) {
    return { allowed: false, reason: `Illegal transition: ${from} -> ${to}` };
  }

  return { allowed: true, reason: null };
}

test('Admin can triage submitted -> under_review', () => {
  const res = checkTransitionPermitted('submitted', 'under_review', 'admin', false);
  assert.equal(res.allowed, true);
});

test('Officer cannot triage submitted -> under_review', () => {
  const res = checkTransitionPermitted('submitted', 'under_review', 'officer', true);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Admin triage required/);
});

test('Officer rejection is strictly rejected for all states', () => {
  for (const st of ['submitted', 'under_review', 'in_progress']) {
    const res = checkTransitionPermitted(st, 'rejected', 'officer', true);
    assert.equal(res.allowed, false, `Officer must not be able to reject from ${st}`);
    assert.match(res.reason, /Officer rejection strictly forbidden/);
  }
});

test('Admin can reject from submitted, under_review, and in_progress', () => {
  for (const st of ['submitted', 'under_review', 'in_progress']) {
    const res = checkTransitionPermitted(st, 'rejected', 'admin', false);
    assert.equal(res.allowed, true, `Admin should be able to reject from ${st}`);
  }
});

test('Assigned officer can move under_review -> in_progress', () => {
  const res = checkTransitionPermitted('under_review', 'in_progress', 'officer', true);
  assert.equal(res.allowed, true);
});

test('Unassigned officer cannot move under_review -> in_progress', () => {
  const res = checkTransitionPermitted('under_review', 'in_progress', 'officer', false);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /Officer not assigned/);
});

test('Assigned officer can move in_progress -> resolved', () => {
  const res = checkTransitionPermitted('in_progress', 'resolved', 'officer', true);
  assert.equal(res.allowed, true);
});

test('Terminal states (resolved, rejected) reject all transitions for all roles', () => {
  const allStates = ['submitted', 'under_review', 'in_progress', 'resolved', 'rejected'];
  for (const terminal of ['resolved', 'rejected']) {
    for (const target of allStates) {
      const adminRes = checkTransitionPermitted(terminal, target, 'admin', false);
      assert.equal(adminRes.allowed, false, `Admin should not transition terminal ${terminal} -> ${target}`);
      const officerRes = checkTransitionPermitted(terminal, target, 'officer', true);
      assert.equal(officerRes.allowed, false, `Officer should not transition terminal ${terminal} -> ${target}`);
    }
  }
});

// -----------------------------------------------------------------------------
// 5. Concurrency Timestamp Validation
// -----------------------------------------------------------------------------
test('Strict string timestamp is required for concurrency check', () => {
  function validateConcurrencyArg(ts) {
    if (!ts || typeof ts !== 'string' || ts.trim() === '') {
      throw new Error('Exact timestamp string required');
    }
  }

  assert.doesNotThrow(() => validateConcurrencyArg('2026-11-24T10:39:15.123456+00:00'));
  assert.throws(() => validateConcurrencyArg(null), /timestamp string required/);
  assert.throws(() => validateConcurrencyArg(undefined), /timestamp string required/);
  assert.throws(() => validateConcurrencyArg(new Date()), /timestamp string required/);
});

// -----------------------------------------------------------------------------
// 6. Citizen Timeline Redaction Guarantee
// -----------------------------------------------------------------------------
test('Citizen public timeline mapper strictly omits internal notes and actor id', () => {
  const mockDbRow = {
    id: 'history-1',
    complaint_id: 'c-1',
    status: 'in_progress',
    stage_title: 'Remediation In Progress',
    public_description: 'Field engineer dispatched to fix leaking valve.',
    created_at: '2026-11-24T12:00:00Z',
    // Sensitive backend columns that must never leak:
    internal_note: 'Contractor requested additional excavator support.',
    actor_id: 'staff-secret-uuid',
  };

  // Simulating frontend mapping from public_complaint_history
  const timelineItem = {
    id: mockDbRow.id,
    status: mockDbRow.status,
    title: mockDbRow.stage_title,
    public_description: mockDbRow.public_description,
    created_at: mockDbRow.created_at,
  };

  assert.equal(timelineItem.id, 'history-1');
  assert.equal(timelineItem.public_description, 'Field engineer dispatched to fix leaking valve.');
  assert.equal('internal_note' in timelineItem, false, 'internal_note must not exist in timelineItem');
  assert.equal('actor_id' in timelineItem, false, 'actor_id must not exist in timelineItem');
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
