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

console.log(`\n${passed} passed`);
