/**
 * Each soil of a map unit in its own place (lib/soilplace.js, FINDINGS H62). Made-up ground.
 *   node water/test/soilplace.test.js
 */
import assert from 'node:assert/strict';
import { placeable, placeSoils, soilIndex, twiAtMerc, DRAINAGE_ORDER } from '../lib/soilplace.js';
import { terrain } from '../lib/upslope.js';
import { toMerc, fromMerc } from '../lib/ept.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const lat = 42.87, lng = -85.86;
// a 60 x 60 grid of 10 m cells: ground falling 2% to the east, with a valley along the middle row
function ground() {
  const W = 60, H = 60, cell = 10, k = 1 / Math.cos((lat * Math.PI) / 180);
  const [cx, cy] = toMerc([lng, lat]), h = (W * cell * k) / 2;
  const z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) z[r * W + c] = 200 - 0.2 * c + 0.03 * Math.abs(r - 30) * cell;
  return { W, H, cell, z, bbox: [cx - h, cy - h, cx + h, cy + h], k };
}
const ring = (dem, c0, r0, c1, r1) => { const cs = (dem.bbox[2] - dem.bbox[0]) / dem.W; const p = (c, r) => fromMerc([dem.bbox[0] + c * cs, dem.bbox[3] - r * cs]); return [[p(c0, r0), p(c1, r0), p(c1, r1), p(c0, r1), p(c0, r0)]]; };
const soil = (name, pct, drainage, wet = null) => ({ name, pct, drainage, hydgrp: 'B', soil: true, profile: { name, horizons: [{ topCm: 0, bottomCm: 150, awc: 0.15, ksatUmS: 5 }] }, wetByMonth: new Array(12).fill(wet) });

test('placeable: described soils only, driest first, shares summing to one', () => {
  const u = { components: [soil('Fern', 25, 'Somewhat poorly drained', 54), { name: 'Urban land', pct: 20, soil: false }, soil('Spinks', 50, 'Well drained'), soil('Capac', 5, 'Somewhat poorly drained', 15)] };
  const p = placeable(u);
  assert.deepEqual(p.map((c) => c.name), ['Spinks', 'Fern', 'Capac'], 'by drainage, then the shallower water table as wetter');
  assert.ok(Math.abs(p.reduce((s, c) => s + c.share, 0) - 1) < 1e-9 && Math.abs(p[0].share - 50 / 80) < 1e-9);
  assert.ok(DRAINAGE_ORDER.indexOf('Poorly drained') > DRAINAGE_ORDER.indexOf('Moderately well drained'));
});

test('the wetter soil takes the valley: its share of the unit, in the unit\'s wettest ground', () => {
  const dem = ground(), t = terrain(dem);
  const unit = { mukey: 'u1', name: 'Spinks-Fern complex', polygons: [ring(dem, 0, 0, 60, 60)], components: [soil('Spinks', 75, 'Well drained'), soil('Fern', 25, 'Somewhat poorly drained', 54)] };
  const { byUnit, twi } = placeSoils([unit], [unit], dem, t);
  const P = byUnit.get('u1');
  assert.equal(P.comps.length, 2); assert.equal(P.cuts.length, 1); assert.equal(P.borrowed, null);
  let wet = 0, n = 0;
  for (let i = 0; i < twi.length; i++) if (Number.isFinite(twi[i])) { n++; if (soilIndex(P, twi[i]) === 1) wet++; }
  assert.ok(Math.abs(wet / n - 0.25) < 0.03, `Fern's share of the unit: ${(wet / n).toFixed(3)}`);
  // a cell in the valley floor near the east end, against one high on the side
  const at = (c, r) => { const cs = (dem.bbox[2] - dem.bbox[0]) / dem.W; return twiAtMerc(dem, twi, dem.bbox[0] + (c + 0.5) * cs, dem.bbox[3] - (r + 0.5) * cs); };
  assert.equal(soilIndex(P, at(50, 30)), 1, 'the valley floor: Fern');
  assert.equal(soilIndex(P, at(10, 5)), 0, 'the side, upslope: Spinks');
});

test('urban land borrows the nearest unit\'s soils, placed the same way; one soil needs no placing', () => {
  const dem = ground(), t = terrain(dem);
  const urban = { mukey: 'u2', name: 'Urban land', polygons: [ring(dem, 20, 24, 40, 40)], components: [{ name: 'Urban land', pct: 100, soil: false }] };
  const around = { mukey: 'u1', name: 'Spinks-Fern complex', polygons: [ring(dem, 0, 0, 60, 24)], components: [soil('Spinks', 75, 'Well drained'), soil('Fern', 25, 'Somewhat poorly drained', 54)] };
  const single = { mukey: 'u3', name: 'Spinks loamy sand', polygons: [ring(dem, 0, 40, 60, 60)], components: [soil('Spinks', 90, 'Well drained')] };
  const { byUnit } = placeSoils([urban, single], [urban, around, single], dem, t);
  const U = byUnit.get('u2');
  assert.ok(U && U.borrowed && U.comps.map((c) => c.name).join() === 'Spinks,Fern', `borrowed: ${U?.borrowed}`);
  const S = byUnit.get('u3');
  assert.equal(S.comps.length, 1); assert.equal(S.cuts.length, 0); assert.equal(soilIndex(S, 99), 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water soil placing: ${tests.length} passed`);
