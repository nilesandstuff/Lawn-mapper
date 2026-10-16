/**
 * The low-spot map on made-up ground whose answer is known (water session).
 *
 *   node water/test/lowspots.test.js
 */

import assert from 'node:assert/strict';

import { LAT, cloud, dish } from '../lib/synthetic.js';
import { analyse } from '../lib/lowspots.js';
import { fill } from '../lib/hydro.js';
import { parseLots } from '../tools/lowspots.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('Priority-Flood fills a pit to its spill point and leaves a slope alone', () => {
  const g = { W: 5, H: 5, cell: 1 };
  const z = new Float64Array(25).fill(1);
  z[12] = 0.5; z[13] = 0.8; // a pit at the centre, its lowest way out at 0.8? no: neighbours are 1
  z[14] = 0.8;               // ...and a notch through to the east edge at 0.8
  const f = fill(g, z, new Uint8Array(25));
  assert.ok(Math.abs(f[12] - 0.8) < 1e-9, `pit filled to ${f[12]}`);
  assert.equal(f[0], 1);
  const slope = Float64Array.from({ length: 25 }, (_, i) => i % 5);
  assert.deepEqual(Array.from(fill(g, slope, new Uint8Array(25))), Array.from(slope));
});

test('a 12 cm dish 10 m across in a yard falling 1% is found, shallower than it is', () => {
  // it found 10 of 10 noise seeds; an 8 m, 10 cm one 8 of 10 (FINDINGS H3 has the whole table)
  const bowl = dish(40, 40, 5, 0.12);
  const height = (x, y) => 0.01 * x + bowl(x, y);
  const { cols, bbox } = cloud({ height, density: 3 }); // what the first Kent and Ottawa lots had
  const res = analyse(cols, bbox, LAT);
  const hit = res.spots.spots.filter((s) => s.reported);
  assert.equal(hit.length, 1, `expected one spot, got ${hit.length}`);
  const s = hit[0];
  assert.ok(Math.abs(s.col - 40) <= 2 && Math.abs(s.row - 40) <= 2, `spot at ${s.col},${s.row}`);
  // it spills on its low (west) side, so it holds less than 12 cm; smoothing takes more off
  assert.ok(s.depth > 0.03 && s.depth < 0.11, `depth ${s.depth}`);
});

test('noise alone, on twenty flat or gently sloping yards, rarely reports a spot', () => {
  // by design (lib/lowspots.js noiseFloor) a yard's noise beats the floor about 1 time in 9 over a
  // whole box; tools/limits.mjs measures it inside a lot at under 2 in 100
  let falsePositives = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const tilt = (seed % 4) * 0.005;
    const { cols, bbox } = cloud({ seed, noise: 0.03, height: (x, y) => tilt * x + 0.003 * y });
    falsePositives += analyse(cols, bbox, LAT).spots.spots.filter((s) => s.reported).length;
  }
  assert.ok(falsePositives <= 3, `${falsePositives} spots reported on noise`);
});

test('the noise floor rises with scatter and falls with density', async () => {
  const { noiseFloor } = await import('../lib/lowspots.js');
  const { bbox } = cloud({ density: 0.01, height: () => 0 });
  const a = noiseFloor(bbox, LAT, 1.2, 0.035).floor, b = noiseFloor(bbox, LAT, 1.2, 0.02).floor, c = noiseFloor(bbox, LAT, 4, 0.035).floor;
  assert.ok(a > b && a > c, `floors ${a} ${b} ${c}`);
  assert.ok(a > 0.03 && a < 0.12, `floor at 1.2/m^2, 3.5 cm: ${a}`);
});

test('roofs are found without class 6, and ground running toward one is flagged', () => {
  // the house is 30-45 m east, 30-42 m north; west of it the ground falls 3% toward it, east of it 6% away
  const height = (x) => (x < 37.5 ? -0.03 * x : -0.03 * 37.5 - 0.06 * (x - 37.5));
  const { cols, bbox } = cloud({ height, roofs: [[30, 30, 45, 42]], noise: 0.015 });
  const res = analyse(cols, bbox, LAT);
  const roofArea = res.stats.buildingCells;
  assert.ok(roofArea > 150 && roofArea < 210, `roof ${roofArea} m^2, built 180`);
  const west = res.beside.walls.filter((w) => w.col <= 31 && w.row > 40 && w.row < 48);
  const east = res.beside.walls.filter((w) => w.col >= 44 && w.row > 40 && w.row < 48);
  assert.ok(west.length && east.length, 'both walls measured');
  const med = (a) => a.map((w) => w.fallAway).sort((p, q) => p - q)[a.length >> 1];
  assert.ok(med(west) < -0.015, `west wall falls ${med(west)} (toward the house)`);
  assert.ok(med(east) > 0.045, `east wall falls ${med(east)} away`);
});

test('the kind of a spot: shape, returns, canopy and depth', async () => {
  const { kindOf, shapeOf } = await import('../lib/kinds.js');
  const base = { depth: 0.08, againstBuilding: false, returnRatio: 1, class9Share: 0, treesShare: 0, intensityRatio: 1, length: 5, elongation: 1.2 };
  assert.equal(kindOf(base), 'hollow');
  assert.equal(kindOf({ ...base, returnRatio: 0.02 }), 'water');
  assert.equal(kindOf({ ...base, class9Share: 0.5 }), 'water');
  assert.equal(kindOf({ ...base, returnRatio: 0.3 }), 'paved');
  assert.equal(kindOf({ ...base, intensityRatio: 0.3 }), 'paved');
  assert.equal(kindOf({ ...base, treesShare: 0.5 }), 'trees');
  assert.equal(kindOf({ ...base, elongation: 5, length: 20 }), 'ditch');
  assert.equal(kindOf({ ...base, elongation: 5, length: 4 }), 'hollow', 'a short narrow dip is still a hollow');
  assert.equal(kindOf({ ...base, depth: 0.4, againstBuilding: true }), 'built');
  assert.equal(kindOf({ ...base, depth: 0.4 }), 'deep');
  // a 20 x 2 strip of cells is about 20 m long, 2 m wide
  const W = 50, strip = [];
  for (let r = 10; r < 12; r++) for (let c = 5; c < 25; c++) strip.push(r * W + c);
  const sh = shapeOf(strip, W);
  assert.ok(Math.abs(sh.length - 20) < 1 && Math.abs(sh.width - 2) < 0.5 && sh.elongation > 8, JSON.stringify(sh));
});

test('lots read from text, and a bad line names its label, not its place', () => {
  assert.deepEqual(parseLots('a, 42.1, -85.2\nb,42.2,-85.3,30'), [
    { label: 'a', lat: 42.1, lng: -85.2, half: 25 }, { label: 'b', lat: 42.2, lng: -85.3, half: 30 }]);
  assert.throws(() => parseLots('x,42.1'), /lot "x"/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water: ${tests.length} passed`);
