/**
 * ReportlyUrban — Phase 6.4 Unit & Mocked Behavior Verification Suite
 * Covers:
 *   - URL query parameter validation, sanitization, defaults, and builders
 *   - Version-agnostic UUID validation
 *   - Category/status labels, plain-language status explanations, suppressed count formatters
 *   - Untrusted API payload sanitization (strict 8-field allow-list)
 *   - Mocked fetch handling for list, ward names, detail, 400/404/429/503, and identical 404 behavior
 *   - Clipboard API + execCommand fallback (including failure handling)
 *   - <meta name="robots" content="noindex, nofollow"> mount + unmount cleanup
 *   - Static privacy & rendering guarantees on ExploreIssuesPage.jsx & PublicComplaintDetailsPage.jsx
 *
 * Run: node supabase/tests/phase6_4_unit.test.js
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
  PUBLIC_ALLOWED_FIELDS,
  PUBLIC_CATEGORY_OPTIONS,
  PUBLIC_STATUS_OPTIONS,
  applyNoIndexMetaTag,
  buildExplorerSearchParams,
  copyTextToClipboard,
  fetchPublicComplaintDetail,
  fetchPublicComplaints,
  fetchPublicWardNames,
  formatSuppressedExplorerTotal,
  getCategoryLabel,
  getPublicStatusDescription,
  isValidUuid,
  parseExplorerSearchParams,
  sanitizePublicComplaint,
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

  console.log('\n[Phase 6.4 Unit & Mocked Tests — Explorer & Public Details]');

  await check('1. parseExplorerSearchParams validates, normalizes, and strips invalid/unknown params', async () => {
    const clean = parseExplorerSearchParams(
      new URLSearchParams('category=potholes&status=in_progress&ward=%20Ward%20%204%20&page=2')
    );
    assert.equal(clean.category, 'potholes');
    assert.equal(clean.status, 'in_progress');
    assert.equal(clean.ward, 'Ward 4');
    assert.equal(clean.page, 2);
    assert.equal(clean.hadInvalidParams, true); // collapsed whitespace + encoded spaces changed query string
    assert.equal(clean.sanitizedSearchParams.get('ward'), 'Ward 4');

    const exactClean = parseExplorerSearchParams(
      new URLSearchParams('category=potholes&status=in_progress&ward=Ward+4&page=2')
    );
    assert.equal(exactClean.hadInvalidParams, false);

    // Invalid category, rejected status, bad page, unknown key -> stripped cleanly to defaults
    const bad = parseExplorerSearchParams(
      new URLSearchParams('category=bogus&status=rejected&page=0&foo=bar&ward=%20%20')
    );
    assert.equal(bad.category, '');
    assert.equal(bad.status, '');
    assert.equal(bad.ward, '');
    assert.equal(bad.page, 1);
    assert.equal(bad.hadInvalidParams, true);
    assert.equal(bad.sanitizedSearchParams.toString(), '');

    const badPage = parseExplorerSearchParams(new URLSearchParams('page=2abc'));
    assert.equal(badPage.page, 1);
    assert.equal(badPage.hadInvalidParams, true);

    const built = buildExplorerSearchParams({
      category: 'garbage',
      status: 'resolved',
      ward: 'Ward 1',
      page: 1,
    });
    assert.equal(built.toString(), 'category=garbage&status=resolved&ward=Ward+1');
  });

  await check('2. isValidUuid accepts standard UUID formats across versions and rejects malformed IDs', async () => {
    assert.equal(isValidUuid('550e8400-e29b-41d4-a716-446655440000'), true);
    assert.equal(isValidUuid('11111111-2222-7333-8444-555555555555'), true);
    assert.equal(isValidUuid('  550E8400-E29B-41D4-A716-446655440000  '), true);
    assert.equal(isValidUuid('RU-2026-1042'), false);
    assert.equal(isValidUuid('not-a-uuid'), false);
    assert.equal(isValidUuid('550e8400-e29b-41d4-a716-44665544000'), false);
    assert.equal(isValidUuid(''), false);
    assert.equal(isValidUuid(null), false);
  });

  await check('3. Category labels, status options/explanations, and suppressed count formatter', async () => {
    assert.equal(PUBLIC_CATEGORY_OPTIONS.length, 6);
    assert.equal(PUBLIC_STATUS_OPTIONS.length, 4);
    assert.equal(
      PUBLIC_STATUS_OPTIONS.some((s) => s.id === 'rejected'),
      false
    );
    assert.equal(getCategoryLabel('water_leakage'), 'Water Supply & Leakage');
    assert.match(getPublicStatusDescription('under_review'), /reviewed/i);
    assert.match(getPublicStatusDescription('resolved'), /resolved/i);

    assert.deepEqual(formatSuppressedExplorerTotal(3, true), {
      suppressed: true,
      label: 'Fewer than 5 matching complaints',
    });
    assert.deepEqual(formatSuppressedExplorerTotal(null, false), {
      suppressed: true,
      label: 'Fewer than 5 matching complaints',
    });
    assert.deepEqual(formatSuppressedExplorerTotal(42, false), {
      suppressed: false,
      count: 42,
      label: '42 matching complaints',
    });
  });

  await check('4. sanitizePublicComplaint strips non-allow-listed keys from untrusted payloads', async () => {
    const raw = {
      public_reference: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Road Damage Issue',
      category: 'potholes',
      ward: 'Ward 4',
      status: 'submitted',
      submitted_date: '2026-11-20',
      latitude: 19.076,
      longitude: 72.877,
      // Unauthorized properties:
      id: 999,
      complaint_number: 'RU-2026-0999',
      citizen_id: 'secret-citizen',
      description: 'Private description',
      officer_name: 'Officer Name',
      timeline: [{ status: 'submitted' }],
    };

    const sanitized = sanitizePublicComplaint(raw);
    assert.deepEqual(Object.keys(sanitized).sort(), [...PUBLIC_ALLOWED_FIELDS].sort());
    assert.equal(sanitized.id, undefined);
    assert.equal(sanitized.complaint_number, undefined);
    assert.equal(sanitized.description, undefined);
    assert.equal(sanitized.timeline, undefined);
  });

  await check('5. Mocked fetch strips extra keys and maps 400, 404 (malformed vs unknown), 429, 503 identically/cleanly', async () => {
    const originalFetch = global.fetch;
    try {
      // List endpoint strips unauthorized fields
      global.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          items: [
            {
              public_reference: '550e8400-e29b-41d4-a716-446655440000',
              title: 'Drainage Issue',
              category: 'drainage',
              ward: 'Ward 2',
              status: 'in_progress',
              submitted_date: '2026-11-20',
              latitude: 19.1,
              longitude: 72.8,
              id: 10,
              complaint_number: 'RU-2026-0010',
            },
          ],
          total_count: null,
          count_suppressed: true,
          page: 1,
          page_size: 20,
        }),
      });

      const listRes = await fetchPublicComplaints({ category: 'drainage', page: 1 });
      assert.equal(listRes.count_suppressed, true);
      assert.equal(listRes.items.length, 1);
      assert.equal(listRes.items[0].id, undefined);
      assert.equal(listRes.items[0].complaint_number, undefined);

      // Ward names handles empty list cleanly
      global.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ wards: ['Ward 2', 'Other', ''] }),
      });
      assert.deepEqual(await fetchPublicWardNames(), ['Ward 2']);

      // Distinct 429 and 503 messages
      global.fetch = async () => ({
        ok: false,
        status: 429,
        headers: new Headers(),
        json: async () => ({ detail: 'rate limit' }),
      });
      await assert.rejects(fetchPublicComplaints({}), (err) => {
        assert.equal(err.status, 429);
        assert.match(err.message, /Too many requests, try again shortly/i);
        return true;
      });

      global.fetch = async () => ({
        ok: false,
        status: 503,
        headers: new Headers(),
        json: async () => ({ detail: 'down' }),
      });
      await assert.rejects(fetchPublicComplaints({}), (err) => {
        assert.equal(err.status, 503);
        assert.match(err.message, /temporarily unavailable/i);
        return true;
      });

      // Detail endpoint: malformed UUID vs API 404 produce identical status + message
      let malformedErr;
      try {
        await fetchPublicComplaintDetail('not-a-uuid');
      } catch (e) {
        malformedErr = e;
      }

      global.fetch = async () => ({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({ detail: 'Not found' }),
      });
      let unknownErr;
      try {
        await fetchPublicComplaintDetail('550e8400-e29b-41d4-a716-446655440000');
      } catch (e) {
        unknownErr = e;
      }

      assert.equal(malformedErr.status, 404);
      assert.equal(unknownErr.status, 404);
      assert.equal(malformedErr.message, unknownErr.message);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('6. copyTextToClipboard handles clipboard API, execCommand fallback, and failure honestly', async () => {
    // Direct navigator.clipboard success
    const okNav = { clipboard: { writeText: async () => {} } };
    assert.equal(await copyTextToClipboard('https://example.test/issues/1', okNav, null), true);

    // Fallback to document.execCommand when clipboard fails
    const failingNav = { clipboard: { writeText: async () => { throw new Error('denied'); } } };
    let appended = null;
    const mockDocFallbackSuccess = {
      body: {
        appendChild: (el) => {
          el.parentNode = mockDocFallbackSuccess.body;
          appended = el;
        },
        removeChild: (el) => {
          if (el === appended) appended.parentNode = null;
        },
      },
      createElement: () => ({
        style: {},
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        focus() {},
        select() {},
      }),
      execCommand: () => true,
    };
    assert.equal(
      await copyTextToClipboard('https://example.test/issues/1', failingNav, mockDocFallbackSuccess),
      true
    );
    assert.equal(appended.parentNode, null); // Cleaned up DOM node

    // Both clipboard & fallback fail -> must return false (never falsely claim success)
    const mockDocFallbackFail = {
      ...mockDocFallbackSuccess,
      execCommand: () => false,
    };
    assert.equal(
      await copyTextToClipboard('https://example.test/issues/1', failingNav, mockDocFallbackFail),
      false
    );
  });

  await check('7. applyNoIndexMetaTag inserts noindex, nofollow on mount and removes it on unmount', async () => {
    const headChildren = [];
    const mockDoc = {
      head: {
        appendChild: (el) => {
          el.parentNode = mockDoc.head;
          headChildren.push(el);
        },
        removeChild: (el) => {
          const idx = headChildren.indexOf(el);
          if (idx !== -1) headChildren.splice(idx, 1);
          el.parentNode = null;
        },
      },
      querySelector: (selector) => {
        if (selector === 'meta[name="robots"]') {
          return headChildren.find((el) => el.attrs?.name === 'robots') || null;
        }
        return null;
      },
      createElement: () => ({
        attrs: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        getAttribute(k) {
          return this.attrs[k] ?? null;
        },
        removeAttribute(k) {
          delete this.attrs[k];
        },
      }),
    };

    const cleanup = applyNoIndexMetaTag(mockDoc);
    assert.equal(headChildren.length, 1);
    assert.equal(headChildren[0].getAttribute('name'), 'robots');
    assert.equal(headChildren[0].getAttribute('content'), 'noindex, nofollow');

    cleanup();
    assert.equal(headChildren.length, 0);
  });

  await check('8. ExploreIssuesPage, PublicComplaintDetailsPage, IssueCard, and HomePage enforce UI privacy & link safeguards', async () => {
    const explorerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/ExploreIssuesPage.jsx'),
      'utf8'
    );
    const detailsSrc = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/PublicComplaintDetailsPage.jsx'),
      'utf8'
    );
    const homeSrc = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/HomePage.jsx'),
      'utf8'
    );
    const issueCardSrc = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/components/issues/IssueCard.jsx'),
      'utf8'
    );
    const citizenDashSrc = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/CitizenDashboard.jsx'),
      'utf8'
    );
    const serviceSrc = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/services/publicService.js'),
      'utf8'
    );

    for (const src of [explorerSrc, detailsSrc, homeSrc, issueCardSrc]) {
      assert.equal(src.includes('dangerouslySetInnerHTML'), false);
      assert.equal(src.includes('useComplaints'), false, 'Public pages/cards must not use ComplaintContext');
      assert.equal(src.includes('ComplaintContext'), false);
      assert.equal(src.includes('mockComplaints'), false);
      assert.equal(src.includes('localStorage'), false);
      assert.equal(src.includes('SERVICE_ROLE'), false);
      assert.equal(src.includes('latitude'), false, 'Coordinates must never appear in Phase 6.4 UI');
      assert.equal(src.includes('longitude'), false, 'Coordinates must never appear in Phase 6.4 UI');
      assert.equal(src.includes('complaint_number'), false);
      assert.equal(src.includes('ComplaintTimeline'), false);
    }

    assert.equal(/\.\s*description\b|\bdescription\b(?=\s*[,}])/.test(issueCardSrc), false);
    assert.equal(/\.\s*department\b|\bdepartment\b(?=\s*[,}])/.test(issueCardSrc), false);
    assert.equal(issueCardSrc.includes('<img'), false);
    assert.ok(issueCardSrc.includes('isValidUuid'));
    assert.ok(issueCardSrc.includes('public_reference'));

    assert.ok(homeSrc.includes('fetchPublicComplaints'));
    assert.ok(homeSrc.includes('pageSize: 3'));
    assert.ok(homeSrc.includes('No public complaints recorded yet'));
    assert.ok(homeSrc.includes('Unable to load recent public complaints'));
    assert.ok(homeSrc.includes('Retry'));

    assert.ok(explorerSrc.includes('formatSuppressedExplorerTotal'));
    assert.ok(serviceSrc.includes('Fewer than 5 matching complaints'));
    assert.ok(explorerSrc.includes('No public complaints match these filters'));
    assert.ok(explorerSrc.includes('Clear filters'));
    assert.ok(explorerSrc.includes('Look up by public reference'));
    assert.ok(detailsSrc.includes('Back to complaints'));
    assert.ok(detailsSrc.includes('applyNoIndexMetaTag'));
    assert.ok(detailsSrc.includes('not a secret credential'));
    assert.ok(detailsSrc.includes('Copy link'));

    // Citizen dashboard must continue linking only to authenticated /dashboard/issues/:id
    assert.ok(citizenDashSrc.includes('/dashboard/issues/${'));
  });

  await check('9. Static scan of entire frontend/src confirms no /issues/:seg links use non-public_reference IDs', async () => {
    const srcRoot = path.resolve(__dirname, '../../frontend/src');
    const files = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(jsx?|tsx?)$/.test(entry.name)) files.push(full);
      }
    }
    walk(srcRoot);

    const dynamicIssuesLinkRegex = /\/issues\/\$\{([^}]+)\}/g;
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      const rel = path.relative(srcRoot, filePath).replace(/\\/g, '/');
      let match;
      while ((match = dynamicIssuesLinkRegex.exec(content)) !== null) {
        // Skip /dashboard/issues/${...}
        const prefixStart = Math.max(0, match.index - 10);
        const context = content.slice(prefixStart, match.index + match[0].length);
        if (context.includes('/dashboard/issues/')) {
          continue;
        }
        const expr = match[1];
        assert.ok(
          expr.includes('public_reference') ||
            expr.includes('publicRef') ||
            expr === 'encodeURIComponent(ref)' ||
            (rel === 'pages/ExploreIssuesPage.jsx' && expr.includes('cleaned')),
          `Forbidden dynamic /issues/ link in ${rel}: ${match[0]}`
        );
      }
    }
  });

  await check('10. Mocked HomePage recent feed: 3 items, empty list, 429, and 503', async () => {
    const originalFetch = global.fetch;
    try {
      // 3 items
      global.fetch = async (url) => {
        const u = new URL(url);
        assert.equal(u.searchParams.get('page'), '1');
        assert.equal(u.searchParams.get('page_size'), '3');
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            items: [1, 2, 3].map((n) => ({
              public_reference: `550e8400-e29b-41d4-a716-44665544000${n}`,
              title: `Public Issue ${n}`,
              category: 'potholes',
              ward: `Ward ${n}`,
              status: 'submitted',
              submitted_date: '2026-11-22',
              latitude: 19.0,
              longitude: 72.8,
              id: n,
              complaint_number: `RU-2026-000${n}`,
            })),
            total_count: 10,
            count_suppressed: false,
            page: 1,
            page_size: 3,
          }),
        };
      };
      const threeRes = await fetchPublicComplaints({ page: 1, pageSize: 3 });
      assert.equal(threeRes.items.length, 3);
      for (const item of threeRes.items) {
        assert.equal(isValidUuid(item.public_reference), true);
        assert.equal(item.id, undefined);
        assert.equal(item.complaint_number, undefined);
      }

      // Empty list
      global.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          items: [],
          total_count: 0,
          count_suppressed: false,
          page: 1,
          page_size: 3,
        }),
      });
      const emptyRes = await fetchPublicComplaints({ page: 1, pageSize: 3 });
      assert.equal(emptyRes.items.length, 0);

      // 429 & 503
      for (const [code, regex] of [
        [429, /Too many requests, try again shortly/i],
        [503, /temporarily unavailable/i],
      ]) {
        global.fetch = async () => ({
          ok: false,
          status: code,
          headers: new Headers(),
          json: async () => ({ detail: 'error' }),
        });
        await assert.rejects(fetchPublicComplaints({ page: 1, pageSize: 3 }), (err) => {
          assert.equal(err.status, code);
          assert.match(err.message, regex);
          return true;
        });
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log(`\nAll ${passed} Phase 6.4 unit & mocked checks passed.`);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
