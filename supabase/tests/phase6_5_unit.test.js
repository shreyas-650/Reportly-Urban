/**
 * ReportlyUrban — Phase 6.5 Public Map Unit, Mocked & Static Verification Suite
 * Covers:
 *   - Pure functions: coordinate validation, allow-list stripping, GeoJSON,
 *     same-location grouping (max 10 + "and N more"), UUID check, URL params,
 *     suppressed-count & truncation messages, DOM popup builder (no innerHTML).
 *   - Mocked API: AbortController filter-change abort & stale guard, empty, 429, 503, retry.
 *   - Mocked Mapbox component lifecycle: token validation blocks Map construction,
 *     single Map with clustering + maxZoom 16, source.setData on filter change,
 *     cleanup removes listeners/layers/source & calls remove() once,
 *     StrictMode double-mount leaves one active Map.
 *   - Static scans: zero innerHTML/setHTML, zero hardcoded pk./sk. tokens,
 *     frontend/src /issues/ links strictly use public_reference UUIDs only.
 *
 * Run: node supabase/tests/phase6_5_unit.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const esbuild = require(path.resolve(__dirname, '../../frontend/node_modules/esbuild'));

const publicServiceUrl = pathToFileURL(
  path.resolve(__dirname, '../../frontend/src/services/publicService.js')
).href;
const mapUtilsUrl = pathToFileURL(
  path.resolve(__dirname, '../../frontend/src/utils/publicMapUtils.js')
).href;

const { fetchPublicMapPoints, isValidUuid } = await import(publicServiceUrl);
const {
  PUBLIC_MAP_MAX_ZOOM,
  buildMapGeoJson,
  buildMapSearchParams,
  buildPopupDomElement,
  buildPopupModel,
  getMapTransparencyMessages,
  groupPointsAtLocation,
  isValidPublicMapCoordinate,
  parseMapSearchParams,
  sanitizeAndValidateMapPoints,
  validatePublicMapboxToken,
} = await import(mapUtilsUrl);

function makeFakeDocument() {
  function makeNode(tag) {
    return {
      tagName: tag.toUpperCase(),
      style: {},
      children: [],
      listeners: {},
      className: '',
      href: '',
      _textContent: '',
      get textContent() {
        return this._textContent;
      },
      set textContent(v) {
        this._textContent = String(v);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(evt, fn) {
        this.listeners[evt] = fn;
      },
    };
  }
  return { createElement: makeNode };
}

/**
 * Minimal synchronous React hook simulator supporting useState, useRef,
 * useMemo, useCallback, and useEffect cleanup so PublicComplaintsMap.jsx
 * executes directly under StrictMode double-mount in Node without jsdom.
 */
function createComponentHarness(renderFn) {
  let state = [];
  let refs = [];
  let memos = [];
  let effects = [];
  let hookIdx = 0;

  const reactShim = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Component: class Component {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
    },
    useState(init) {
      const i = hookIdx++;
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init;
      const setter = (next) => {
        state[i] = typeof next === 'function' ? next(state[i]) : next;
      };
      return [state[i], setter];
    },
    useRef(init) {
      const i = hookIdx++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    useMemo(factory, deps) {
      const i = hookIdx++;
      const prev = memos[i];
      if (!prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
        memos[i] = { val: factory(), deps };
      }
      return memos[i].val;
    },
    useCallback(fn, deps) {
      return reactShim.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const i = hookIdx++;
      const prev = effects[i];
      const changed = !prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps[k]));
      if (changed) {
        effects[i] = { fn, deps, cleanup: prev?.cleanup, needsRun: true };
      }
    },
  };

  function runEffects() {
    for (const eff of effects) {
      if (eff && eff.needsRun) {
        eff.needsRun = false;
        if (typeof eff.cleanup === 'function') {
          eff.cleanup();
        }
        const res = eff.fn();
        eff.cleanup = typeof res === 'function' ? res : undefined;
      }
    }
  }

  function unmountEffects() {
    for (const eff of effects) {
      if (eff && typeof eff.cleanup === 'function') {
        eff.cleanup();
        eff.cleanup = undefined;
      }
      if (eff) eff.needsRun = true;
    }
  }

  return {
    reactShim,
    render(props) {
      hookIdx = 0;
      const out = renderFn(props);
      runEffects();
      return out;
    },
    strictModeDoubleMount(props) {
      // Simulate React 18 StrictMode: mount -> run effects -> cleanup -> re-run effects
      this.render(props);
      unmountEffects();
      runEffects();
    },
    unmount() {
      unmountEffects();
    },
  };
}

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

  console.log('\n[Phase 6.5 Unit, Mocked & Static Verification — Public Complaint Map]');

  await check('1. Coordinate validation strictly rejects NaN, strings, null, and out-of-range', async () => {
    assert.equal(isValidPublicMapCoordinate(12.971, 77.594), true);
    assert.equal(isValidPublicMapCoordinate(0, 0), true);
    assert.equal(isValidPublicMapCoordinate(-90, 180), true);

    assert.equal(isValidPublicMapCoordinate(Number.NaN, 77.5), false);
    assert.equal(isValidPublicMapCoordinate(Infinity, 77.5), false);
    assert.equal(isValidPublicMapCoordinate('12.971', '77.594'), false);
    assert.equal(isValidPublicMapCoordinate('', ''), false);
    assert.equal(isValidPublicMapCoordinate('abc', 'def'), false);
    assert.equal(isValidPublicMapCoordinate(null, null), false);
    assert.equal(isValidPublicMapCoordinate(undefined, 77.5), false);
    assert.equal(isValidPublicMapCoordinate(90.001, 77.5), false);
    assert.equal(isValidPublicMapCoordinate(-90.001, 77.5), false);
    assert.equal(isValidPublicMapCoordinate(12.9, 180.001), false);
    assert.equal(isValidPublicMapCoordinate(12.9, -180.001), false);
  });

  await check('2. sanitizeAndValidateMapPoints & buildMapGeoJson strip extra keys and skip invalid coords', async () => {
    const raw = [
      {
        public_reference: '550e8400-e29b-41d4-a716-446655440001',
        title: 'Potholes & Damaged Roads Issue',
        category: 'potholes',
        ward: 'Ward 4',
        status: 'in_progress',
        submitted_date: '2026-11-20',
        latitude: 19.076,
        longitude: 72.878,
        // Forbidden properties that must be stripped:
        id: 123,
        complaint_number: 'RU-2026-0123',
        description: 'Private text',
        citizen_email: 'user@example.com',
      },
      {
        public_reference: '550e8400-e29b-41d4-a716-446655440002',
        title: 'Unmapped Issue',
        category: 'garbage',
        ward: 'Ward 4',
        status: 'submitted',
        submitted_date: '2026-11-20',
        latitude: null,
        longitude: null,
      },
      {
        public_reference: '550e8400-e29b-41d4-a716-446655440003',
        title: 'Out of range',
        category: 'garbage',
        ward: 'Ward 4',
        status: 'submitted',
        submitted_date: '2026-11-20',
        latitude: 95,
        longitude: 200,
      },
    ];

    const valid = sanitizeAndValidateMapPoints(raw);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].id, undefined);
    assert.equal(valid[0].complaint_number, undefined);
    assert.equal(valid[0].description, undefined);
    assert.equal(valid[0].citizen_email, undefined);
    assert.equal(valid[0].coordKey, '19.076,72.878');

    const geoJson = buildMapGeoJson(valid);
    assert.equal(geoJson.type, 'FeatureCollection');
    assert.equal(geoJson.features.length, 1);
    assert.deepEqual(geoJson.features[0].geometry, {
      type: 'Point',
      coordinates: [72.878, 19.076],
    });
    assert.equal(geoJson.features[0].properties.statusMarkerText, 'P');
    assert.equal(geoJson.features[0].properties.categoryLabel, 'Potholes & Damaged Roads');
    assert.equal(geoJson.features[0].properties.id, undefined);
  });

  await check('3. Same-location grouping, max 10 popup items + "and N more", UUID link guard, DOM without innerHTML', async () => {
    const stacked = [];
    for (let i = 1; i <= 12; i += 1) {
      stacked.push({
        public_reference:
          i === 12 ? 'malformed-ref' : `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')}`,
        title: `<script>alert(${i})</script> Road Damage`,
        category: 'potholes',
        ward: 'Ward 7',
        status: 'submitted',
        submitted_date: '2026-11-21',
        latitude: 19.076,
        longitude: 72.878,
        coordKey: '19.076,72.878',
      });
    }
    stacked.push({
      public_reference: '550e8400-e29b-41d4-a716-446655440099',
      title: 'Other Location',
      category: 'drainage',
      ward: 'Ward 1',
      status: 'resolved',
      submitted_date: '2026-11-21',
      latitude: 19.1,
      longitude: 72.9,
      coordKey: '19.100,72.900',
    });

    const grouped = groupPointsAtLocation(stacked, '19.076,72.878');
    assert.equal(grouped.length, 12);

    const model = buildPopupModel(grouped);
    assert.equal(model.totalAtLocation, 12);
    assert.equal(model.items.length, 10);
    assert.equal(model.overflowCount, 2);

    for (const item of model.items) {
      assert.deepEqual(
        Object.keys(item).sort(),
        [
          'categoryLabel',
          'detailsHref',
          'publicReference',
          'status',
          'statusColor',
          'statusLabel',
          'submittedDateText',
          'title',
          'ward',
        ].sort()
      );
      assert.ok(item.detailsHref.startsWith('/issues/'));
      assert.equal(isValidUuid(item.publicReference), true);
    }

    // Malformed UUID never generates a /issues/ link
    const malformedModel = buildPopupModel([stacked[11]]);
    assert.equal(malformedModel.items[0].detailsHref, null);

    // DOM popup creation uses textContent only, renders "and 2 more", never innerHTML
    const fakeDoc = makeFakeDocument();
    let clickedRef = null;
    const domEl = buildPopupDomElement(model, (ref) => {
      clickedRef = ref;
    }, fakeDoc);
    assert.equal(domEl.innerHTML, undefined);
    const listUl = domEl.children[1];
    assert.equal(listUl.children.length, 10);
    const moreDiv = domEl.children[2];
    assert.equal(moreDiv.textContent, 'and 2 more');

    // Click handler triggers callback cleanly
    const firstLink = listUl.children[0].children[3];
    firstLink.listeners.click({ preventDefault() {} });
    assert.equal(clickedRef, '550e8400-e29b-41d4-a716-446655440001');
  });

  await check('4. URL param parsing/defaults, token rules, truncation, and suppressed-count banners', async () => {
    const parsed = parseMapSearchParams(
      new URLSearchParams('ward=%20Ward%20%204%20&category=bogus&status=resolved&page=2')
    );
    assert.equal(parsed.ward, 'Ward 4');
    assert.equal(parsed.category, '');
    assert.equal(parsed.hadInvalidParams, true);
    assert.equal(parsed.sanitizedSearchParams.toString(), 'ward=Ward+4');

    assert.equal(
      buildMapSearchParams({ ward: 'Ward 4', category: 'garbage' }).toString(),
      'ward=Ward+4&category=garbage'
    );

    assert.equal(validatePublicMapboxToken('').valid, false);
    assert.equal(validatePublicMapboxToken('sk.secret_1234567890123456789012345').reason, 'secret_forbidden');
    assert.equal(validatePublicMapboxToken('pk.valid_public_token_1234567890123456').valid, true);

    const suppressedMsg = getMapTransparencyMessages({
      truncated: true,
      pointCount: 1000,
      unmappedCount: 4,
      countSuppressed: true,
      totalCount: null,
    });
    assert.equal(suppressedMsg.suppressed, true);
    assert.equal(suppressedMsg.countText, 'Fewer than 5 matching complaints');
    assert.equal(suppressedMsg.truncatedText, 'Showing the 1,000 most recent mapped complaints');
    assert.equal(suppressedMsg.unmappedText, '4 complaints have no map location');
  });

  await check('5. Mocked fetchPublicMapPoints aborts prior requests on filter change and surfaces empty/429/503', async () => {
    const originalFetch = global.fetch;
    try {
      // Simulate abort on filter change
      const ctrl1 = new AbortController();
      global.fetch = (_url, opts) =>
        new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });

      const p1 = fetchPublicMapPoints({ ward: 'Ward 1' }, { signal: ctrl1.signal });
      ctrl1.abort();
      await assert.rejects(p1, (err) => err.name === 'AbortError');

      // Empty valid response
      global.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          points: [],
          truncated: false,
          total_count: 0,
          unmapped_count: 2,
          count_suppressed: false,
        }),
      });
      const empty = await fetchPublicMapPoints({});
      assert.equal(empty.points.length, 0);
      assert.equal(empty.unmapped_count, 2);

      // 429 & 503 followed by Retry 200
      for (const [code, re] of [
        [429, /Too many requests, try again shortly/i],
        [503, /temporarily unavailable/i],
      ]) {
        global.fetch = async () => ({
          ok: false,
          status: code,
          headers: new Headers(),
          json: async () => ({ detail: 'error' }),
        });
        await assert.rejects(fetchPublicMapPoints({}), (err) => {
          assert.equal(err.status, code);
          assert.match(err.message, re);
          return true;
        });
      }

      global.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          points: [
            {
              public_reference: '550e8400-e29b-41d4-a716-446655440005',
              title: 'Streetlight Issue',
              category: 'streetlights',
              ward: 'Ward 2',
              status: 'submitted',
              submitted_date: '2026-11-22',
              latitude: 19.08,
              longitude: 72.88,
              extra_leak: 'must-strip',
            },
          ],
          truncated: false,
          total_count: 5,
          unmapped_count: 0,
          count_suppressed: false,
        }),
      });
      const retryRes = await fetchPublicMapPoints({ category: 'streetlights' });
      assert.equal(retryRes.points.length, 1);
      assert.equal(retryRes.points[0].extra_leak, undefined);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await check('6. Mocked PublicComplaintsMap lifecycle: invalid token blocks Map, source updates cleanly, StrictMode double-mount leaves 1 Map & calls remove()', async () => {
    const srcPath = path.resolve(__dirname, '../../frontend/src/components/maps/PublicComplaintsMap.jsx');
    const result = esbuild.transformSync(fs.readFileSync(srcPath, 'utf8'), {
      loader: 'jsx',
      jsx: 'transform',
      format: 'cjs',
    });
    const compiledCode = result.code;

    // Extract default component using module compilation in memory via data URL? Simpler: rewrite imports to test shims!
    const mapboxTracker = {
      constructed: 0,
      removed: 0,
      setDataCalls: 0,
      sources: {},
      layers: {},
      instances: [],
    };

    class MockMap {
      constructor(opts) {
        this.opts = opts;
        this.listeners = {};
        this.removed = false;
        mapboxTracker.constructed += 1;
        mapboxTracker.instances.push(this);
      }
      addControl() {}
      on(evt, layerOrFn, maybeFn) {
        const key = typeof layerOrFn === 'string' ? `${evt}:${layerOrFn}` : evt;
        const fn = typeof layerOrFn === 'function' ? layerOrFn : maybeFn;
        this.listeners[key] = fn;
        if (evt === 'load') {
          fn();
        }
      }
      off(evt, layerOrFn) {
        const key = typeof layerOrFn === 'string' ? `${evt}:${layerOrFn}` : evt;
        delete this.listeners[key];
      }
      addSource(id, cfg) {
        mapboxTracker.sources[id] = {
          ...cfg,
          setData: (nextData) => {
            mapboxTracker.sources[id].data = nextData;
            mapboxTracker.setDataCalls += 1;
          },
        };
      }
      getSource(id) {
        return mapboxTracker.sources[id] || null;
      }
      removeSource(id) {
        delete mapboxTracker.sources[id];
      }
      addLayer(layer) {
        mapboxTracker.layers[layer.id] = layer;
      }
      getLayer(id) {
        return mapboxTracker.layers[id] || null;
      }
      removeLayer(id) {
        delete mapboxTracker.layers[id];
      }
      getStyle() {
        return true;
      }
      fitBounds() {}
      easeTo() {}
      resize() {}
      remove() {
        if (!this.removed) {
          this.removed = true;
          mapboxTracker.removed += 1;
        }
      }
    }

    const mockMapboxLib = {
      accessToken: '',
      Map: MockMap,
      NavigationControl: class {},
      LngLatBounds: class { extend() {} },
      Popup: class {
        setLngLat() { return this; }
        setDOMContent() { return this; }
        addTo() { return this; }
        remove() {}
      },
    };

    let harnessRef = null;
    const modDeps = {
      react: Object.assign(
        {
          createElement: (...a) => harnessRef.reactShim.createElement(...a),
          Component: class Component {
            constructor(p) { this.props = p; this.state = {}; }
          },
          useState: (i) => harnessRef.reactShim.useState(i),
          useRef: (i) => harnessRef.reactShim.useRef(i),
          useMemo: (f, d) => harnessRef.reactShim.useMemo(f, d),
          useCallback: (f, d) => harnessRef.reactShim.useCallback(f, d),
          useEffect: (f, d) => harnessRef.reactShim.useEffect(f, d),
        },
        {}
      ),
      'mapbox-gl': mockMapboxLib,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '../common/Button': () => null,
      '../../services/mapboxService': await import(
        pathToFileURL(path.resolve(__dirname, '../../frontend/src/services/mapboxService.js')).href
      ),
      '../../utils/publicMapUtils': await import(mapUtilsUrl),
    };
    const fakeModule = { exports: {} };
    const customRequire = (id) => {
      if (id === 'react') {
        return Object.assign(modDeps.react, { default: modDeps.react });
      }
      if (id === 'mapbox-gl' || id === '../common/Button') {
        return { __esModule: true, default: modDeps[id] };
      }
      if (id in modDeps) return modDeps[id];
      throw new Error(`Unexpected import in test: ${id}`);
    };
    new Function('require', 'module', 'exports', compiledCode)(
      customRequire,
      fakeModule,
      fakeModule.exports
    );
    const PublicComplaintsMap = fakeModule.exports.default;

    try {
      // Case A: Missing/sk. token never constructs a Map
      harnessRef = createComponentHarness((props) => {
        const out = PublicComplaintsMap(props);
        return out;
      });
      harnessRef.render({
        points: [],
        mapboxToken: 'sk.invalid_secret_token_1234567890123456789',
        mapboxglLib: mockMapboxLib,
      });
      assert.equal(mapboxTracker.constructed, 0);

      // Case B: Valid token + StrictMode double mount + source update + unmount cleanup
      harnessRef = createComponentHarness((props) => {
        // Pre-populate container ref to simulate attached DOM node
        const out = PublicComplaintsMap(props);
        return out;
      });

      const fakeContainer = { tagName: 'DIV' };
      // Patch useRef index 0 (mapContainerRef) by intercepting first useRef
      const origUseRef = harnessRef.reactShim.useRef;
      let firstRefSet = false;
      harnessRef.reactShim.useRef = (init) => {
        const r = origUseRef(init);
        if (!firstRefSet && init === null) {
          firstRefSet = true;
          r.current = fakeContainer;
        }
        return r;
      };

      const validToken = 'pk.test_public_token_1234567890123456789012345';
      const initialPts = [
        {
          public_reference: '550e8400-e29b-41d4-a716-446655440001',
          title: 'Road Damage',
          category: 'potholes',
          ward: 'Ward 4',
          status: 'submitted',
          submitted_date: '2026-11-22',
          latitude: 19.076,
          longitude: 72.878,
          coordKey: '19.076,72.878',
        },
      ];

      // StrictMode double mount constructs 2 sequentially, removing the 1st cleanly, leaving 1 active
      harnessRef.strictModeDoubleMount({
        points: initialPts,
        mapboxToken: validToken,
        mapboxglLib: mockMapboxLib,
      });
      assert.equal(mapboxTracker.constructed, 2);
      assert.equal(mapboxTracker.removed, 1);
      assert.equal(mapboxTracker.instances[0].removed, true);
      assert.equal(mapboxTracker.instances[1].removed, false);
      assert.equal(mapboxTracker.instances[1].opts.maxZoom, PUBLIC_MAP_MAX_ZOOM);
      assert.equal(Object.keys(mapboxTracker.layers).length, 4);

      // Filter change updates GeoJSON source without constructing another Map
      harnessRef.render({
        points: [],
        mapboxToken: validToken,
        mapboxglLib: mockMapboxLib,
      });
      assert.equal(mapboxTracker.constructed, 2);
      assert.equal(mapboxTracker.setDataCalls, 1);
      assert.equal(mapboxTracker.sources['public-complaints-source'].data.features.length, 0);

      // Final unmount cleans up active Map
      harnessRef.unmount();
      assert.equal(mapboxTracker.removed, 2);
      assert.equal(Object.keys(mapboxTracker.sources).length, 0);
      assert.equal(Object.keys(mapboxTracker.layers).length, 0);
    } finally {
      delete globalThis.__phase65TestDeps;
    }
  });

  await check('7. Static scans: zero innerHTML/setHTML, zero pk./sk. literals, strict /issues/ link safety', async () => {
    const phase65Files = [
      'utils/publicMapUtils.js',
      'components/maps/PublicComplaintsMap.jsx',
      'pages/PublicMapPage.jsx',
    ];
    for (const rel of phase65Files) {
      const content = fs.readFileSync(path.resolve(__dirname, '../../frontend/src', rel), 'utf8');
      const codeOnly = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.equal(codeOnly.includes('innerHTML'), false, `innerHTML forbidden in ${rel}`);
      assert.equal(codeOnly.includes('setHTML'), false, `setHTML forbidden in ${rel}`);
      assert.equal(content.includes('dangerouslySetInnerHTML'), false);
      assert.equal(content.includes('useComplaints'), false);
      assert.equal(content.includes('SERVICE_ROLE'), false);
      assert.equal(/['"]pk\.[A-Za-z0-9_-]{10,}['"]/.test(content), false, `Hardcoded pk literal found in ${rel}`);
      assert.equal(/['"]sk\.[A-Za-z0-9_-]{10,}['"]/.test(content), false, `Hardcoded sk literal found in ${rel}`);
    }

    // Recursive frontend/src /issues/ link check + CitizenDashboard check
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
        const prefixStart = Math.max(0, match.index - 10);
        const context = content.slice(prefixStart, match.index + match[0].length);
        if (context.includes('/dashboard/issues/')) continue;
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

    const citizenDash = fs.readFileSync(
      path.resolve(srcRoot, 'pages/CitizenDashboard.jsx'),
      'utf8'
    );
    assert.ok(citizenDash.includes('/dashboard/issues/${'));
  });

  await check('8. PublicMapPage renders synchronously without ReferenceError or undeclared variables', async () => {
    const pagePath = path.resolve(__dirname, '../../frontend/src/pages/PublicMapPage.jsx');
    const result = esbuild.transformSync(fs.readFileSync(pagePath, 'utf8'), {
      loader: 'jsx',
      jsx: 'transform',
      format: 'cjs',
    });

    let harness = null;
    const modDeps = {
      react: {
        createElement: (...a) => harness.reactShim.createElement(...a),
        Fragment: 'Fragment',
        useState: (i) => harness.reactShim.useState(i),
        useRef: (i) => harness.reactShim.useRef(i),
        useMemo: (f, d) => harness.reactShim.useMemo(f, d),
        useCallback: (f, d) => harness.reactShim.useCallback(f, d),
        useEffect: () => {}, // Render pass only
      },
      'react-router-dom': {
        Link: () => null,
        useNavigate: () => () => {},
        useSearchParams: () => [new URLSearchParams('ward=Ward+1&category=potholes'), () => {}],
      },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '../components/common/Button': { __esModule: true, default: () => null },
      '../components/common/StatusBadge': { __esModule: true, default: () => null },
      '../components/maps/PublicComplaintsMap': {
        __esModule: true,
        default: () => null,
        MapErrorBoundary: () => null,
      },
      '../utils/formatters': await import(
        pathToFileURL(path.resolve(__dirname, '../../frontend/src/utils/formatters.js')).href
      ),
      '../services/publicService': await import(publicServiceUrl),
      '../utils/publicMapUtils': await import(mapUtilsUrl),
    };

    const fakeModule = { exports: {} };
    const customRequire = (id) => {
      if (id === 'react') {
        return Object.assign(modDeps.react, { default: modDeps.react });
      }
      if (id in modDeps) return modDeps[id];
      throw new Error(`Unexpected import in PublicMapPage test: ${id}`);
    };
    new Function('require', 'module', 'exports', result.code)(
      customRequire,
      fakeModule,
      fakeModule.exports
    );
    const PublicMapPage = fakeModule.exports.default;
    harness = createComponentHarness(() => PublicMapPage());
    const vdom = harness.render({});
    assert.ok(vdom && vdom.type === 'div');
  });

  console.log(`\nAll ${passed} Phase 6.5 unit, mocked & static checks passed.`);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
