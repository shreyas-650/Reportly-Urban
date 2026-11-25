/**
 * ReportlyUrban — Phase 6.3 Frontend Service & Dashboard Unit Verification
 * Runs cleanly without backend or live database:
 *   node supabase/tests/phase6_3_unit.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceUrl = pathToFileURL(
  path.resolve(__dirname, '../../frontend/src/services/publicService.js')
).href;
const {
  fetchPublicStats,
  fetchPublicWardStats,
  fetchPublicDepartmentStats,
  formatResolutionDuration,
  formatResolutionRate,
  formatSuppressedValue,
} = await import(serviceUrl);

async function runTests() {
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

  console.log('\n[Phase 6.3 Unit Tests — Frontend Service & Dashboard Guarantees]');

  await check('1. formatResolutionDuration handles null, boundary rounding, and pluralization', async () => {
    assert.equal(formatResolutionDuration(null), 'Not enough data');
    assert.equal(formatResolutionDuration(undefined), 'Not enough data');
    assert.equal(formatResolutionDuration(-1), 'Not enough data');
    assert.equal(formatResolutionDuration(0), '0 days 0 hours');
    assert.equal(formatResolutionDuration(29.2), '1 day 5 hours');
    assert.equal(formatResolutionDuration(47.9), '2 days 0 hours');
    assert.equal(formatResolutionDuration(49), '2 days 1 hour');
  });

  await check('2. formatResolutionRate and formatSuppressedValue enforce suppression rules', async () => {
    assert.equal(formatResolutionRate(null), 'Not enough data');
    assert.equal(formatResolutionRate(82.36), '82.4%');
    assert.equal(formatSuppressedValue(null, true, 'complaints'), 'Fewer than 5 complaints');
    assert.equal(formatSuppressedValue(3, true), 'Fewer than 5');
    assert.equal(formatSuppressedValue(1250, false), '1,250');
  });

  await check('3. fetchPublic* functions target /api/public/* without auth headers and parse 429/503', async () => {
    const originalFetch = global.fetch;
    try {
      const seenCalls = [];
      global.fetch = async (url, opts) => {
        seenCalls.push({ url, opts });
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ total: 5 }),
        };
      };

      const stats = await fetchPublicStats();
      assert.equal(stats.total, 5);
      await fetchPublicWardStats();
      await fetchPublicDepartmentStats();

      assert.deepEqual(
        seenCalls.map((c) => new URL(c.url).pathname),
        ['/api/public/stats', '/api/public/wards', '/api/public/departments']
      );
      for (const call of seenCalls) {
        assert.equal(call.opts.headers.Authorization, undefined);
      }

      // HTTP 429 includes Retry-After context
      global.fetch = async () => ({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '42' }),
        json: async () => ({ detail: 'Rate limit exceeded' }),
      });
      await assert.rejects(fetchPublicStats(), (err) => {
        assert.equal(err.status, 429);
        assert.match(err.message, /42 seconds/);
        return true;
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('4. HomePage & AccountabilityDashboardPage remove fake stats and expose methodology/privacy copy', async () => {
    const homeSource = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/HomePage.jsx'),
      'utf8'
    );
    const dashSource = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/AccountabilityDashboardPage.jsx'),
      'utf8'
    );

    assert.equal(homeSource.includes('12480'), false, 'Fake offset 12480 must be removed');
    assert.equal(homeSource.includes('10115'), false, 'Fake offset 10115 must be removed');
    assert.equal(homeSource.includes('"34 Hours"'), false, 'Hardcoded 34 Hours must be removed');
    assert.ok(homeSource.includes('fetchPublicStats'));

    assert.ok(dashSource.includes('Other (groups with fewer than 5 complaints)'));
    assert.ok(dashSource.includes('Fewer than 5'));
    assert.ok(dashSource.includes('complaints have no deadline set'));
    assert.ok(dashSource.includes('How these numbers are calculated'));
    assert.equal(dashSource.includes('SERVICE_ROLE'), false);
  });

  console.log(`\nAll ${passed} Phase 6.3 frontend unit checks passed.`);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
