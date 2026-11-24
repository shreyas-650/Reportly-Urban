/**
 * ReportlyUrban — Phase 4.4 Mocked Integration Test Suite
 * Module: Mapbox Forward/Reverse Geocoding & Complaint Submission Geospatial Payload
 *
 * Runs locally without live Mapbox or database connection:
 *   node supabase/tests/phase4_4_mocked.test.js
 */

import assert from 'node:assert/strict';
import {
  searchAddress,
  reverseGeocode,
} from '../../frontend/src/services/mapboxService.js';
import { createComplaint } from '../../frontend/src/services/complaintService.js';

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

console.log('\n--- Running Phase 4.4 Mocked Integration Tests ---');

const DUMMY_VALID_TOKEN =
  'pk.eyJ1IjoidGVzdHVzZXIiLCJhIjoiY2x4eXphYmNkZTAwMDBxbDFqMTIzNCJ9.abcdef1234567890abcdef1234';

async function run() {
  const originalFetch = globalThis.fetch;

  try {
    // ---------------------------------------------------------------------------
    // 1. Forward Geocoding (searchAddress)
    // ---------------------------------------------------------------------------
    await testAsync('searchAddress short query (<2 chars) returns empty without network call', async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return { ok: true };
      };

      const res = await searchAddress('a', DUMMY_VALID_TOKEN);
      assert.equal(fetchCalled, false);
      assert.deepEqual(res.data, []);
      assert.equal(res.error, null);
    });

    await testAsync('searchAddress unconfigured token returns error without network call', async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return { ok: true };
      };

      const res = await searchAddress('Indiranagar', 'invalid-token');
      assert.equal(fetchCalled, false);
      assert.deepEqual(res.data, []);
      assert.match(res.error.message, /Mapbox public access token is not configured/);
    });

    await testAsync('searchAddress parses standard Mapbox Places JSON response', async () => {
      globalThis.fetch = async (url) => {
        assert.match(url, /api\.mapbox\.com\/geocoding\/v5\/mapbox\.places/);
        assert.match(url, /access_token=pk\./);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: [
              {
                id: 'place.1',
                text: 'Indiranagar Metro Station',
                place_name: 'Indiranagar Metro Station, CMH Road, Bengaluru, Karnataka, India',
                center: [77.6406, 12.9784],
                context: [{ id: 'locality.1', text: 'Bengaluru' }],
              },
              {
                id: 'place.2',
                text: 'Indiranagar 100ft Road',
                place_name: 'Indiranagar 100ft Road, Bengaluru, Karnataka, India',
                center: [77.6412, 12.9721],
                context: [],
              },
            ],
          }),
        };
      };

      const res = await searchAddress('Indiranagar', DUMMY_VALID_TOKEN, {
        proximity: [77.5946, 12.9716],
      });

      assert.equal(res.error, null);
      assert.equal(res.data.length, 2);
      assert.equal(res.data[0].text, 'Indiranagar Metro Station');
      assert.deepEqual(res.data[0].coordinates, [77.6406, 12.9784]);
      assert.equal(res.data[1].text, 'Indiranagar 100ft Road');
    });

    await testAsync('searchAddress handles HTTP 429 rate limit gracefully', async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 429,
      });

      const res = await searchAddress('Koramangala', DUMMY_VALID_TOKEN);
      assert.deepEqual(res.data, []);
      assert.match(res.error.message, /rate limit reached/i);
    });

    await testAsync('searchAddress handles HTTP 500 error gracefully', async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 500,
      });

      const res = await searchAddress('Whitefield', DUMMY_VALID_TOKEN);
      assert.deepEqual(res.data, []);
      assert.match(res.error.message, /Mapbox search failed with status 500/);
    });

    await testAsync('searchAddress handles fetch network exception', async () => {
      globalThis.fetch = async () => {
        throw new Error('DNS lookup failure');
      };

      const res = await searchAddress('Jayanagar', DUMMY_VALID_TOKEN);
      assert.deepEqual(res.data, []);
      assert.match(res.error.message, /DNS lookup failure/);
    });

    // ---------------------------------------------------------------------------
    // 2. Reverse Geocoding (reverseGeocode)
    // ---------------------------------------------------------------------------
    await testAsync('reverseGeocode rejects invalid coordinates without network call', async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return { ok: true };
      };

      const res = await reverseGeocode(77.5946, 95.0, DUMMY_VALID_TOKEN); // invalid lat
      assert.equal(fetchCalled, false);
      assert.equal(res.data, null);
      assert.match(res.error.message, /Invalid coordinates/);
    });

    await testAsync('reverseGeocode rejects unconfigured token without network call', async () => {
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return { ok: true };
      };

      const res = await reverseGeocode(77.5946, 12.9716, 'pk.short');
      assert.equal(fetchCalled, false);
      assert.equal(res.data, null);
      assert.match(res.error.message, /Mapbox public access token is not configured/);
    });

    await testAsync('reverseGeocode parses successful reverse response', async () => {
      globalThis.fetch = async (url) => {
        assert.match(url, /77\.594600,12\.971600\.json/);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: [
              {
                id: 'address.1',
                text: 'Cubbon Park Road',
                place_name: 'Cubbon Park Road, Sampangi Rama Nagar, Bengaluru, Karnataka 560001, India',
                context: [{ id: 'postcode.1', text: '560001' }],
              },
            ],
          }),
        };
      };

      const res = await reverseGeocode(77.5946, 12.9716, DUMMY_VALID_TOKEN);
      assert.equal(res.error, null);
      assert.equal(res.data.streetAddress, 'Cubbon Park Road');
      assert.match(res.data.placeName, /Cubbon Park Road, Sampangi Rama Nagar/);
    });

    await testAsync('reverseGeocode handles empty features with coordinate fallback', async () => {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ features: [] }),
      });

      const res = await reverseGeocode(77.5946, 12.9716, DUMMY_VALID_TOKEN);
      assert.equal(res.error, null);
      assert.match(res.data.placeName, /Location at 12\.97160, 77\.59460/);
    });

    await testAsync('reverseGeocode handles 429 rate limiting', async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 429,
      });

      const res = await reverseGeocode(77.5946, 12.9716, DUMMY_VALID_TOKEN);
      assert.equal(res.data, null);
      assert.match(res.error.message, /rate limit reached/i);
    });

    // ---------------------------------------------------------------------------
    // 3. Complaint Submission Payload Geospatial Compatibility
    // ---------------------------------------------------------------------------
    await testAsync('createComplaint passes valid coordinates into database payload', async () => {
      let capturedPayload = null;
      const dummyCitizenId = 'c0000000-0000-4000-8000-000000000001';
      const dummyIdempotencyKey = 'a0000000-0000-4000-8000-000000000001';

      const mockClient = {
        auth: {
          getSession: async () => ({
            data: { session: { user: { id: dummyCitizenId } } },
            error: null,
          }),
        },
        from: (table) => {
          assert.equal(table, 'complaints');
          return {
            insert: (payload) => {
              capturedPayload = payload;
              return {
                select: () => ({
                  single: async () => ({
                    data: {
                      id: 'complaint-uuid-1',
                      complaint_number: 'RU-2026-0099',
                      status: 'submitted',
                      latitude: payload.latitude,
                      longitude: payload.longitude,
                    },
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      };

      const res = await createComplaint({
        title: 'Deep pothole on MG Road near Metro',
        category: 'potholes',
        ward: 'Ward 12 - Indiranagar',
        location: 'MG Road Metro Pillar 120',
        description: 'Large hazardous pothole damaging vehicles and causing traffic slowdown.',
        latitude: 12.9716,
        longitude: 77.5946,
        uploadedStoragePath: `${dummyCitizenId}/11111111-1111-4111-8111-111111111111.jpg`,
        idempotencyKey: dummyIdempotencyKey,
        supabaseClient: mockClient,
      });

      assert.equal(res.error, null);
      assert.equal(capturedPayload.latitude, 12.9716);
      assert.equal(capturedPayload.longitude, 77.5946);
      assert.equal(capturedPayload.location, 'MG Road Metro Pillar 120');
      assert.equal(capturedPayload.ward, 'Ward 12 - Indiranagar');
    });

    await testAsync('createComplaint supports complaints with NULL coordinates (backward-compatibility)', async () => {
      let capturedPayload = null;
      const dummyCitizenId = 'c0000000-0000-4000-8000-000000000001';
      const dummyIdempotencyKey = 'a0000000-0000-4000-8000-000000000002';

      const mockClient = {
        auth: {
          getSession: async () => ({
            data: { session: { user: { id: dummyCitizenId } } },
            error: null,
          }),
        },
        from: (table) => {
          assert.equal(table, 'complaints');
          return {
            insert: (payload) => {
              capturedPayload = payload;
              return {
                select: () => ({
                  single: async () => ({
                    data: {
                      id: 'complaint-uuid-2',
                      complaint_number: 'RU-2026-0100',
                      status: 'submitted',
                      latitude: null,
                      longitude: null,
                    },
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      };

      const res = await createComplaint({
        title: 'Garbage dump near community park',
        category: 'garbage',
        ward: 'Ward 15 - Jayanagar',
        location: 'Opposite Community Hall',
        description: 'Uncollected domestic waste accumulating for three days with strong odor.',
        latitude: null,
        longitude: null,
        uploadedStoragePath: `${dummyCitizenId}/22222222-2222-4222-8222-222222222222.jpg`,
        idempotencyKey: dummyIdempotencyKey,
        supabaseClient: mockClient,
      });

      assert.equal(res.error, null);
      assert.equal(capturedPayload.latitude, undefined);
      assert.equal(capturedPayload.longitude, undefined);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await run();

console.log(`\nMocked Integration Tests Finished: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
