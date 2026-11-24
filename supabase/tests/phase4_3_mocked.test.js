/**
 * ReportlyUrban — Phase 4.3 Mocked Integration Test Suite
 * Module: Complaint Status Management & Resolution Workflow
 *
 * Runs locally without live database connection:
 *   node supabase/tests/phase4_3_mocked.test.js
 */

import assert from 'node:assert/strict';
import {
  transitionComplaintStatus,
} from '../../frontend/src/services/adminService.js';
import {
  uploadResolutionImage,
  getSignedImageUrl,
  generateResolutionStoragePath,
} from '../../frontend/src/services/storageService.js';
import { supabase } from '../../frontend/src/lib/supabase.js';

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
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

console.log('\n--- Running Phase 4.3 Mocked Integration Tests ---');

async function run() {
  // Save original RPC and storage implementations
  const originalRpc = supabase.rpc;
  const originalStorageFrom = supabase.storage?.from;

  try {
    // ---------------------------------------------------------------------------
    // 1. Argument Validation on transitionComplaintStatus
    // ---------------------------------------------------------------------------
    await testAsync('transitionComplaintStatus rejects missing complaintId', async () => {
      const res = await transitionComplaintStatus({
        complaintId: '',
        newStatus: 'under_review',
        expectedUpdatedAt: '2026-11-24T12:00:00Z',
      });
      assert.equal(res.data, null);
      assert.match(res.error.message, /Complaint ID is required/);
    });

    await testAsync('transitionComplaintStatus rejects missing newStatus', async () => {
      const res = await transitionComplaintStatus({
        complaintId: 'a0000000-0000-0000-0000-000000000001',
        newStatus: '',
        expectedUpdatedAt: '2026-11-24T12:00:00Z',
      });
      assert.equal(res.data, null);
      assert.match(res.error.message, /New status is required/);
    });

    await testAsync('transitionComplaintStatus rejects missing or non-string expectedUpdatedAt', async () => {
      const res = await transitionComplaintStatus({
        complaintId: 'a0000000-0000-0000-0000-000000000001',
        newStatus: 'under_review',
        expectedUpdatedAt: null,
      });
      assert.equal(res.data, null);
      assert.match(res.error.message, /Exact expectedUpdatedAt timestamp string is required/);
    });

    // ---------------------------------------------------------------------------
    // 2. Successful RPC Execution
    // ---------------------------------------------------------------------------
    await testAsync('transitionComplaintStatus dispatches correct RPC parameters', async () => {
      let capturedMethod = null;
      let capturedArgs = null;

      supabase.rpc = async (method, args) => {
        capturedMethod = method;
        capturedArgs = args;
        return { data: null, error: null };
      };

      const res = await transitionComplaintStatus({
        complaintId: 'a0000000-0000-0000-0000-000000000001',
        newStatus: 'resolved',
        expectedUpdatedAt: '2026-11-24T12:00:00.000Z',
        publicDescription: 'Road resurfaced and inspected.',
        internalNote: 'Work order executed under budget.',
        resolutionImagePath: 'resolution/a0000000-0000-0000-0000-000000000001/b0000000-0000-4000-8000-000000000002.jpg',
      });

      assert.equal(res.error, null);
      assert.equal(capturedMethod, 'transition_complaint_status');
      assert.equal(capturedArgs.p_complaint_id, 'a0000000-0000-0000-0000-000000000001');
      assert.equal(capturedArgs.p_new_status, 'resolved');
      assert.equal(capturedArgs.p_expected_updated_at, '2026-11-24T12:00:00.000Z');
      assert.equal(capturedArgs.p_public_description, 'Road resurfaced and inspected.');
      assert.equal(capturedArgs.p_internal_note, 'Work order executed under budget.');
      assert.equal(capturedArgs.p_resolution_image_path, 'resolution/a0000000-0000-0000-0000-000000000001/b0000000-0000-4000-8000-000000000002.jpg');
    });

    // ---------------------------------------------------------------------------
    // 3. Concurrency Error Propagation (SQLSTATE 40001)
    // ---------------------------------------------------------------------------
    await testAsync('transitionComplaintStatus surfaces concurrency conflict (40001)', async () => {
      supabase.rpc = async () => {
        return {
          data: null,
          error: {
            code: '40001',
            message: 'Concurrency Conflict: Complaint has been modified by another administrative session. Please refresh and review current state before retrying.',
          },
        };
      };

      const res = await transitionComplaintStatus({
        complaintId: 'a0000000-0000-0000-0000-000000000001',
        newStatus: 'in_progress',
        expectedUpdatedAt: '2026-11-24T10:00:00Z',
      });

      assert.notEqual(res.error, null);
      assert.equal(res.error.code, '40001');
      assert.match(res.error.message, /Concurrency Conflict/);
    });

    // ---------------------------------------------------------------------------
    // 4. Precondition Error Propagation
    // ---------------------------------------------------------------------------
    await testAsync('transitionComplaintStatus surfaces workflow violation (P0001)', async () => {
      supabase.rpc = async () => {
        return {
          data: null,
          error: {
            code: 'P0001',
            message: 'Precondition Failed: Cannot move complaint to in_progress without an assigned officer.',
          },
        };
      };

      const res = await transitionComplaintStatus({
        complaintId: 'a0000000-0000-0000-0000-000000000001',
        newStatus: 'in_progress',
        expectedUpdatedAt: '2026-11-24T10:00:00Z',
      });

      assert.notEqual(res.error, null);
      assert.equal(res.error.code, 'P0001');
      assert.match(res.error.message, /without an assigned officer/);
    });

    // ---------------------------------------------------------------------------
    // 5. Resolution Image Upload Validation
    // ---------------------------------------------------------------------------
    await testAsync('uploadResolutionImage validates image type before storage request', async () => {
      const invalidFile = { type: 'image/gif', size: 1024, name: 'anim.gif' };
      const res = await uploadResolutionImage({
        file: invalidFile,
        complaintId: 'a0000000-0000-0000-0000-000000000001',
      });
      assert.equal(res.data, null);
      assert.match(res.error.message, /Unsupported file format/);
    });

    await testAsync('uploadResolutionImage executes storage upload with upsert: false', async () => {
      let uploadOptions = null;
      let targetPath = null;

      supabase.storage.from = (bucket) => {
        assert.equal(bucket, 'complaint-images');
        return {
          upload: async (path, file, opts) => {
            targetPath = path;
            uploadOptions = opts;
            return { data: { path }, error: null };
          },
        };
      };

      const validFile = { type: 'image/jpeg', size: 1024 * 500, name: 'proof.jpg' };
      const res = await uploadResolutionImage({
        file: validFile,
        complaintId: 'a0000000-0000-0000-0000-000000000001',
      });

      assert.equal(res.error, null);
      assert.equal(uploadOptions.upsert, false, 'Storage upload MUST NOT allow upsert/overwrite');
      assert.equal(targetPath.startsWith('resolution/a0000000-0000-0000-0000-000000000001/'), true);
      assert.equal(targetPath.endsWith('.jpg'), true);
    });

    // ---------------------------------------------------------------------------
    // 6. getSignedImageUrl Path Validation
    // ---------------------------------------------------------------------------
    await testAsync('getSignedImageUrl accepts valid resolution storage path', async () => {
      supabase.storage.from = () => ({
        createSignedUrl: async (path, exp) => {
          assert.equal(exp, 1800);
          return { data: { signedUrl: `https://storage.mock/${path}?token=xyz` }, error: null };
        },
      });

      const res = await getSignedImageUrl(
        'resolution/a0000000-0000-0000-0000-000000000001/b0000000-0000-4000-8000-000000000002.jpg',
        1800
      );
      assert.equal(res.error, null);
      assert.match(res.data.signedUrl, /https:\/\/storage.mock/);
    });

    await testAsync('getSignedImageUrl rejects path traversal in resolution path', async () => {
      const res = await getSignedImageUrl('resolution/../../etc/passwd');
      assert.equal(res.data, null);
      assert.match(res.error.message, /Malformed storage path/);
    });
  } finally {
    // Restore original methods
    supabase.rpc = originalRpc;
    supabase.storage.from = originalStorageFrom;
  }

  console.log(`\nMocked Integration Results: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run();
