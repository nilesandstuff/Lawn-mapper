/**
 * The parcel copy's format and the site's reads of it (worker/src/parcel-mirror.js).
 *
 *   node tools/parcel-mirror.test.js
 */
import assert from 'node:assert/strict';
import {
  CELL, cellOf, cellKey, cellsOfBox, mirrorKeys, mirrorKeyOf, encodeParcel, encodeCell, decodeCell, findInCell,
  parcelsInBox, insideRings, cellAt, gzip, gunzip, mirrorLookup, mirrorParcelsIn,
} from '../worker/src/parcel-mirror.js';
import { esriToGeoJSON } from '../worker/src/parcel.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

// a cell somewhere ordinary, and lots in it as Esri sends them (outer clockwise)
const [cx, cy] = cellOf(-85.61, 42.93);
const x0 = cx * CELL, y0 = cy * CELL;
const sq = (x, y, d) => [[x, y], [x, y + d], [x + d, y + d], [x + d, y], [x, y]];
const lotA = { pin: '41-01-123', rings: [sq(x0 + 0.001, y0 + 0.001, 0.0005)] };
const lotB = { pin: '41-01-124', rings: [sq(x0 + 0.0016, y0 + 0.001, 0.0005)] };
// a lot with a hole (a pond that is somebody else's), the hole counter-clockwise
const holed = { pin: 'H1', rings: [sq(x0 + 0.003, y0 + 0.003, 0.002), [[x0 + 0.0035, y0 + 0.0035], [x0 + 0.0045, y0 + 0.0035], [x0 + 0.0045, y0 + 0.0045], [x0 + 0.0035, y0 + 0.0045], [x0 + 0.0035, y0 + 0.0035]]] };
// a subdivision's outline round lot A: the smaller wins
const outline = { pin: 'SUB', rings: [sq(x0 + 0.0005, y0 + 0.0005, 0.003)] };

await test('cells: a point is in one, a box touches each it crosses, keys are per service', () => {
  assert.deepEqual(cellOf(x0 + 0.0001, y0 + 0.0001), [cx, cy]);
  assert.deepEqual(cellOf(x0 - 0.0001, y0 + 0.0001), [cx - 1, cy]);
  assert.equal(cellsOfBox([x0 - 0.001, y0 + 0.001, x0 + 0.001, y0 + 0.002]).length, 2);
  assert.equal(cellKey('kentish', 3, -4), 'parcels/kentish/3_-4.bin');
});

await test('one layer under two registry keys is copied once, under the first', () => {
  const reg = {
    a: { service: 'https://x/FeatureServer', layer: 0 },
    b: { service: 'https://x/FeatureServer', layer: 0 },
    c: { service: 'https://x/FeatureServer', layer: 0, where: "CNTY='C'" },
    d: { name: 'no service' },
  };
  assert.deepEqual(mirrorKeys(reg), { a: 'a', b: 'a', c: 'c' });
  assert.equal(mirrorKeyOf(reg, 'b'), 'a');
  assert.equal(mirrorKeyOf(reg, 'd'), null);
});

await test('a cell round-trips its parcels to the centimetre, pins included', () => {
  const b = encodeCell(cx, cy, [lotA, lotB, holed, { pin: null, rings: [sq(x0 + 0.01, y0 + 0.01, 0.0001)] }]);
  const back = decodeCell(b);
  assert.equal(back.length, 4);
  assert.equal(back[0].pin, '41-01-123');
  assert.equal(back[3].pin, null);
  assert.equal(back[2].rings.length, 2);
  for (const [i, lot] of [lotA, lotB, holed].entries()) {
    lot.rings.forEach((r, k) => r.forEach(([x, y], j) => {
      assert.ok(Math.abs(back[i].rings[k][j][0] - x) < 1e-7 && Math.abs(back[i].rings[k][j][1] - y) < 1e-7);
    }));
  }
  // compact: under 20 bytes a corner here
  assert.ok(b.length < 32 + 4 * 12 + 4 * 5 * 6 + 60, `size ${b.length}`);
});

await test('a parcel is encoded once and serves every cell it crosses', () => {
  const big = { pin: 'FARM', rings: [sq(x0 + CELL - 0.001, y0 + 0.001, 0.002)] };
  const rec = encodeParcel(big);
  const here = encodeCell(cx, cy, [rec]), east = encodeCell(cx + 1, cy, [rec]);
  assert.equal(findInCell(here, x0 + CELL - 0.0005, y0 + 0.002)?.pin, 'FARM');
  assert.equal(findInCell(east, x0 + CELL + 0.0005, y0 + 0.002)?.pin, 'FARM');
});

await test('the parcel at a point: inside, not in a hole, the smallest of nested ones, by pin first', () => {
  const b = encodeCell(cx, cy, [outline, lotA, lotB, holed]);
  assert.equal(findInCell(b, x0 + 0.00125, y0 + 0.00125)?.pin, '41-01-123');
  assert.equal(findInCell(b, x0 + 0.00185, y0 + 0.00125)?.pin, '41-01-124');
  assert.equal(findInCell(b, x0 + 0.0032, y0 + 0.0032)?.pin, 'H1');
  assert.equal(findInCell(b, x0 + 0.004, y0 + 0.004)?.pin ?? null, null, 'in the hole is not the lot');
  assert.equal(findInCell(b, x0 + 0.0025, y0 + 0.0025)?.pin, 'SUB');
  assert.equal(findInCell(b, x0 + 0.02, y0 + 0.02), null);
  // a queued job's number: its lot, even from a point beside it
  assert.equal(findInCell(b, x0 + 0.00185, y0 + 0.00125, { pin: '41-01-123' })?.pin, '41-01-123');
  assert.equal(findInCell(b, x0 + 0.00185, y0 + 0.00125, { pin: 'nobody' })?.pin, '41-01-124');
  assert.equal(findInCell(new Uint8Array([1, 2, 3]), x0, y0), null);
  assert.equal(insideRings(holed.rings, x0 + 0.004, y0 + 0.004), false);
});

await test('the parcels in a box', () => {
  const b = encodeCell(cx, cy, [lotA, lotB, holed]);
  assert.deepEqual(parcelsInBox(b, [x0 + 0.0009, y0 + 0.0009, x0 + 0.0014, y0 + 0.0014]).map((p) => p.pin), ['41-01-123']);
  assert.equal(parcelsInBox(b, [x0, y0, x0 + 0.01, y0 + 0.01]).length, 3);
});

await test('gzip round trip', async () => {
  const b = encodeCell(cx, cy, [lotA, lotB, holed]);
  assert.deepEqual(await gunzip(await gzip(b)), b);
  assert.equal(cellAt(encodeCell(cx, cy, [], Date.parse('2026-01-02T03:04:05.000Z'))), '2026-01-02T03:04:05.000Z');
});

await test('the site reads the copy: a feature like a live one, saying it is the copy and how old', async () => {
  const at = '2026-11-01T00:00:00.000Z';
  const store = new Map();
  store.set(cellKey('mine', cx, cy), await gzip(encodeCell(cx, cy, [lotA, lotB, holed], Date.parse(at))));
  const env = { CORPUS: { get: async (k) => (store.has(k) ? { arrayBuffer: async () => store.get(k).buffer.slice(0) } : null) } };
  const reg = { mine: { name: 'Some County', service: 'https://s/FeatureServer', layer: 2 }, alias: { name: 'Same Layer', service: 'https://s/FeatureServer', layer: 2 } };
  const f = await mirrorLookup(env, reg, ['alias'], x0 + 0.00125, y0 + 0.00125, { toGeoJSON: esriToGeoJSON });
  assert.equal(f.type, 'Feature');
  assert.equal(f.geometry.type, 'Polygon');
  assert.deepEqual(f.properties, { county: 'Same Layer', countyKey: 'alias', pin: '41-01-123', address: null, source: 'mirror', mirroredAt: at });
  const withPin = await mirrorLookup(env, reg, ['mine'], x0 + 0.00185, y0 + 0.00125, { pin: '41-01-123', toGeoJSON: esriToGeoJSON });
  assert.equal(withPin.properties.matched, 'pin');
  assert.equal(await mirrorLookup(env, reg, ['mine'], x0 + 0.02, y0 + 0.02, { toGeoJSON: esriToGeoJSON }), null);
  assert.equal(await mirrorLookup({}, reg, ['mine'], x0, y0, { toGeoJSON: esriToGeoJSON }), null);
  const around = await mirrorParcelsIn(env, reg, 'mine', [x0 + 0.0005, y0 + 0.0005, x0 + 0.0025, y0 + 0.002], { toGeoJSON: esriToGeoJSON });
  assert.deepEqual(around.map((p) => p.properties.pin), ['41-01-123', '41-01-124']);
});

await test("a county's published parcel file: the newest public parcel file here, not its address points", async () => {
  const { pickFile } = await import('./parcel-mirror.mjs');
  const box = [-86, 42, -85, 43];
  const items = [
    { id: 'a', type: 'File Geodatabase', title: 'County Parcels', access: 'public', modified: 2, extent: [] },
    { id: 'b', type: 'File Geodatabase', title: 'County Address Points', access: 'public', modified: 3 },
    { id: 'c', type: 'Shapefile', title: 'Parcels 2019', access: 'public', modified: 1 },
    { id: 'd', type: 'Feature Service', title: 'Parcels', access: 'public', modified: 9 },
    { id: 'e', type: 'Shapefile', title: 'Parcels', access: 'private', modified: 8 },
    { id: 'f', type: 'Shapefile', title: 'Parcels elsewhere', access: 'public', modified: 7, extent: [[-90, 30], [-89, 31]] },
    { id: 'g', type: 'GeoPackage', title: 'Tax Parcels', access: 'public', modified: 5, size: 3e9 },
  ];
  assert.equal(pickFile(items, box).id, 'a');
  assert.equal(pickFile(items.filter((x) => x.id !== 'a'), box).id, 'c');
  assert.equal(pickFile([], box), null);
});

console.log(`\n${passed} passed`);

// the copy's order (tools/parcel-mirror.mjs): a parcel service half copied goes before a water layer never copied
{
  const { order } = await import('./parcel-mirror.mjs');
  const now = Date.parse('2026-11-16T00:00:00Z'), box = [0, 0, 1, 1];
  const services = [{ key: 'w-new', water: true, box }, { key: 'p-half', box }, { key: 'p-new', box }, { key: 'p-old', box }, { key: 'w-half', water: true, box }];
  const state = { services: { 'p-half': { round: '2026-11-11T00:00:00Z' }, 'w-half': { round: '2026-11-15T00:00:00Z' }, 'p-old': { round: '2026-10-01T00:00:00Z', done: '2026-10-02T00:00:00Z' } } };
  const got = order(services, state, now).map((s) => s.key);
  assert.deepEqual(got, ['p-new', 'p-half', 'w-new', 'w-half', 'p-old'], `the order: ${got}`);
  console.log('parcel copy order: parcels first, then water layers, then the oldest copies: ok');
  // failed yesterday: before the fallbacks existed, tried again now; since them, in three days; a water layer as before
  const t = Date.parse('2026-11-17T21:00:00Z');
  const F = { services: { 'p-before': { round: '2026-11-16T00:00:00Z', failed: { at: '2026-11-17T03:00:00Z' } }, 'p-since': { round: '2026-11-17T08:00:00Z', failed: { at: '2026-11-17T20:00:00Z' } }, 'w-before': { round: '2026-11-16T00:00:00Z', failed: { at: '2026-11-17T03:00:00Z' } } } };
  const again = order([{ key: 'p-before', box }, { key: 'p-since', box }, { key: 'w-before', water: true, box }], F, t).map((s) => s.key);
  assert.deepEqual(again, ['p-before'], `retried now: ${again}`);
  console.log('parcel copy order: failures from before the fallbacks retried at once: ok');
}

/* WHAT STILL FAILED AFTER A WEEK (2026-11-17, tools/parcel-mirror.mjs): a server that cannot list a big square's ids
   is asked in quarters; one that gives no ids at all is paged by count; a failed page goes by the other method, then
   in halves. A fake ArcGIS server, by fetch. */
{
  const M = await import('./parcel-mirror.mjs');
  const realFetch = globalThis.fetch;
  // parcels on a grid over the square [0, 0, 0.5, 0.5]: id i at (i % 20, i / 20) * 0.025
  const lots = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, x: (i % 20) * 0.025 + 0.01, y: Math.floor(i / 20) * 0.025 + 0.01 }));
  const feat = (l) => ({ attributes: { PIN: `P${l.id}` }, geometry: { rings: [[[l.x, l.y], [l.x, l.y + 0.001], [l.x + 0.001, l.y + 0.001], [l.x + 0.001, l.y], [l.x, l.y]]] } });
  const serve = (opts) => async (u, init = {}) => {
    const q = init.body ? new URLSearchParams(String(init.body)) : new URL(u).searchParams;
    const post = !!init.body, json = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    opts.calls.push({ post, ids: q.get('returnIdsOnly') === 'true', n: (q.get('objectIds') || '').split(',').filter(Boolean).length, offset: q.get('resultOffset') });
    const g = q.get('geometry') ? JSON.parse(q.get('geometry')) : null;
    const inBox = (l) => !g || (l.x >= g.xmin && l.x <= g.xmax && l.y >= g.ymin && l.y <= g.ymax);
    if (q.get('returnIdsOnly') === 'true') {
      if (opts.noIds) return json({ error: { code: 400, message: 'Unable to complete operation.' } });
      const span = g.xmax - g.xmin;
      if (span > opts.maxSpan) return json({ error: { code: 500, message: 'Error performing query operation' } });
      return json({ objectIds: lots.filter(inBox).map((l) => l.id) });
    }
    if (q.get('resultOffset') != null) {
      if (opts.noOffset) return json({ error: { code: 400, message: 'Pagination is not supported.' } });
      const k = +q.get('resultOffset'), n = +q.get('resultRecordCount'), hit = lots.filter(inBox);
      return json({ features: hit.slice(k, k + n).map(feat), exceededTransferLimit: k + n < hit.length });
    }
    const ids = (q.get('objectIds') || '').split(',').map(Number);
    if (opts.getMax && !post && ids.length > opts.getMax) return new Response('not found', { status: 404 });
    if (opts.pageMax && ids.length > opts.pageMax) return json({ error: { code: 500, message: 'too many' } });
    return json({ features: lots.filter((l) => ids.includes(l.id)).map(feat) });
  };
  const ep = { service: 'https://example.test/arcgis/rest/services/Parcels/MapServer', layer: 0, fields: { pin: 'PIN' } };
  const svc = () => ({ page: 1000, box: [0, 0, 0.5, 0.5] });
  try {
    await test('a square too big to list at once is asked for in quarters', async () => {
      const o = { calls: [], maxSpan: 0.13 }; globalThis.fetch = serve(o);
      const s = svc(), got = await M.fetchSquare(s, ep, [0, 0, 0.5, 0.5]);
      assert.equal(got.parcels.length, 400); assert.equal(new Set(got.parcels.map((p) => p.pin)).size, 400, 'none twice from neighbouring quarters');
      assert.equal(s.split, 2);
    });
    await test('a square too big even in eighths ends after one chain of quarters, not all 85', async () => {
      const o = { calls: [], maxSpan: 0.01, noOffset: true }; globalThis.fetch = serve(o);
      await assert.rejects(M.fetchSquare(svc(), ep, [0, 0, 0.5, 0.5]), (e) => e.kind === 'ids' && /by pages/.test(e.message));
      assert.ok(o.calls.filter((c) => c.ids).length <= 2 * (M.SPLIT_DEPTH + 1), `${o.calls.filter((c) => c.ids).length} id questions`);
    });
    await test('no ids at all: the parcels by pages of a count', async () => {
      const o = { calls: [], noIds: true, maxSpan: 9 }; globalThis.fetch = serve(o);
      const s = { ...svc(), page: 150 }, got = await M.fetchSquare(s, ep, [0, 0, 0.5, 0.5]);
      assert.equal(got.parcels.length, 400); assert.equal(s.offset, true);
      assert.equal(o.calls.filter((c) => c.offset != null).length, 3, 'three pages of 150');
    });
    await test('a page refused by GET (a long address, 404) goes by POST', async () => {
      const o = { calls: [], maxSpan: 9, getMax: 100 }; globalThis.fetch = serve(o);
      const s = { ...svc(), get: true, page: 300 }, got = await M.fetchSquare(s, ep, [0, 0, 0.5, 0.5]);
      assert.equal(got.parcels.length, 400); assert.equal(s.get, false, 'POST from then on');
    });
    await test('a page too big for the server goes in halves, and the page size stays smaller', async () => {
      const o = { calls: [], maxSpan: 9, pageMax: 130 }; globalThis.fetch = serve(o);
      const s = svc(), got = await M.fetchSquare(s, ep, [0, 0, 0.5, 0.5]);
      assert.equal(got.parcels.length, 400); assert.ok(s.page <= 130 && s.page >= M.PAGE_MIN, `page ${s.page}`);
    });
    await test('what may be asked again smaller', () => {
      for (const w of ['error 500', 'error 400', 'timeout', 'error -2147467259', 'http 503', 'http 522']) assert.ok(M.splittable(w), w);
      for (const w of ['http 404', 'error 404', 'unreachable', 'http 406', 'refused 499', '']) assert.ok(!M.splittable(w), w);
    });
  } finally { globalThis.fetch = realFetch; }
}
console.log(`parcel-mirror fallbacks: ${passed} passed`);

/* WHERE TO LOOK FOR THE PUBLISHED FILE (2026-11-17): a login-only service on ArcGIS Online whose server names no
   portal is looked for in its own organisation's items there; why none was found is kept. */
{
  const M = await import('./parcel-mirror.mjs');
  const realFetch = globalThis.fetch;
  const asked = [];
  const json = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    await test('a login-only service on ArcGIS Online: its organisation searched there', async () => {
      globalThis.fetch = async (u) => {
        const url = new URL(u); asked.push(url.host + url.pathname);
        if (/rest\/info/.test(url.pathname)) return json({ error: { code: 499, message: 'Token Required' } });
        if (url.host === 'www.arcgis.com') {
          assert.match(url.searchParams.get('q'), /orgid:ORG1/);
          return json({ results: [{ id: 'abc', type: 'File Geodatabase', access: 'public', title: 'Parcels', modified: 5, extent: [[0, 0], [1, 1]] }] });
        }
        return json({ results: [] });
      };
      const svc = { cfg: { service: 'https://services3.arcgis.com/ORG1/arcgis/rest/services/Parcels/FeatureServer' }, box: [0.2, 0.2, 0.4, 0.4] };
      const f = await M.findFile(svc);
      assert.equal(f?.url, 'https://www.arcgis.com/sharing/rest/content/items/abc/data');
    });
    await test('none found: why is kept', async () => {
      globalThis.fetch = async (u) => (/rest\/info/.test(String(u)) ? json({}) : json({ results: [] }));
      const svc = { cfg: { service: 'https://gis.example.test/arcgis/rest/services/Parcels/MapServer' }, box: [0, 0, 1, 1] };
      assert.equal(await M.findFile(svc), null);
      assert.match(svc.fileWhy, /1 portal searched: no public parcel file/);
    });
  } finally { globalThis.fetch = realFetch; }
}
console.log(`parcel-mirror published file: ${passed} passed`);

// the probe's line says what answered and nothing of where (PROBE=yes)
{
  const { probeLine } = await import('./parcel-mirror.mjs');
  const l = probeLine(2, { info: { ok: true, paging: false, max: 2000, sr: 'projected' }, count: { ok: true, n: 9 }, idsAll: { ok: false, why: 'error 500' }, tiny: { ok: true, n: 0 }, point: null, offset: { ok: false, why: 'refused 499' } });
  assert.equal(l, '  service 2: description ok (pagination no, max 2000, projected); count ok 9; ids, no area error 500; tiny box ok 0; point -; ten by count, no area refused 499');
  console.log('parcel-mirror probe line: ok');
}

/* THE WHOLE LAYER BY ITS IDS (2026-11-17): a server that refuses every square but answers its count and every id with
   no area gives its parcels whole, each into the squares it touches; a list cut short is refused, not half copied. */
{
  const M = await import('./parcel-mirror.mjs');
  const realFetch = globalThis.fetch;
  const lots = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, x: (i % 30) * 0.03 + 0.01, y: Math.floor(i / 30) * 0.04 + 0.01 }));   // x 0.01..0.88: two squares
  const outside = { id: 999, x: 5.2, y: 5.2 };   // a statewide layer's parcel far away
  const all = [...lots, outside];
  const feat = (l) => ({ attributes: { PIN: `P${l.id}` }, geometry: { rings: [[[l.x, l.y], [l.x, l.y + 0.001], [l.x + 0.001, l.y + 0.001], [l.x + 0.001, l.y], [l.x, l.y]]] } });
  let cut = false;
  globalThis.fetch = async (u, init = {}) => {
    const q = init.body ? new URLSearchParams(String(init.body)) : new URL(u).searchParams;
    const json = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (q.get('geometry')) return json({ error: { code: 500, message: 'Error performing query operation' } });
    if (q.get('returnCountOnly') === 'true') return json({ count: all.length });
    if (q.get('returnIdsOnly') === 'true') return json({ objectIds: (cut ? all.slice(0, 200) : all).map((l) => l.id) });
    const ids = (q.get('objectIds') || '').split(',').map(Number);
    return json({ features: all.filter((l) => ids.includes(l.id)).map(feat) });
  };
  const ep = { service: 'https://example.test/arcgis/rest/services/P/MapServer', layer: 0, fields: { pin: 'PIN' } };
  try {
    await test('a server that refuses squares gives its whole layer by ids, each parcel in its square', async () => {
      await assert.rejects(M.fetchSquare({ page: 1000, box: [0, 0, 1, 0.5] }, ep, [0, 0, 0.5, 0.5]), (e) => e.kind === 'ids', 'squares refused');
      const wrote = new Map();
      const st = { squares: {} };
      const got = await M.wholeLayer({ key: 'k1', page: 100, box: [0, 0, 1, 0.5] }, ep, st, async (svc, tx, ty, parcels) => { wrote.set(`${tx}_${ty}`, parcels.map((p) => p.pin)); return { n: parcels.length, mask: 'm', bytes: 1 }; });
      assert.equal(got.n, 300, 'every parcel in the county, none from outside it');
      assert.equal(got.squares, 6, 'every square of the box is written (one ending on an edge counts the next row and column, as squaresOf always has)');
      assert.equal(wrote.get('0_0').length + wrote.get('1_0').length, 300);
      assert.ok(wrote.get('0_0').includes('P1') && wrote.get('1_0').includes('P30'), 'each in its own square');
      assert.ok(st.squares['0_0'].whole && st.squares['1_0'].whole);
    });
    await test('a list of ids cut short at the server\'s limit is refused, not half copied', async () => {
      cut = true;
      await assert.rejects(M.wholeLayer({ key: 'k2', page: 100, box: [0, 0, 1, 0.5] }, ep, { squares: {} }, async () => ({ n: 0, mask: '', bytes: 0 })), (e) => e.kind === 'whole' && /cut short/.test(e.message));
      cut = false;
    });
  } finally { globalThis.fetch = realFetch; }
}
console.log(`parcel-mirror whole layer: ${passed} passed`);
