/**
 * The photo lined up on the lidar (water session, lib/photoshift.js).
 *   node water/test/photoshift.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measure, moved, fromNeighbours, roofFitOnFrame, inputsMoved, featuresMoved, SOURCE_MEDIAN, usable } from '../lib/photoshift.js';
import { gridForFrame } from '../lib/shade/grid.js';
import { mercScale } from '../lib/shade/ept.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const lots = JSON.parse(readFileSync(new URL('../lib/photo-shifts.json', import.meta.url), 'utf8')).lots;
const M_PER_DEG = (6371000 * Math.PI) / 180;

test('a point moved 3 m east and 4 m north is 5 m away, in the right directions', () => {
  const a = [-85.5, 43.1], b = moved(a, { east: 3, north: 4 });
  const e = (b[0] - a[0]) * M_PER_DEG * Math.cos((a[1] * Math.PI) / 180), n = (b[1] - a[1]) * M_PER_DEG;
  assert.ok(Math.abs(e - 3) < 1e-3 && Math.abs(n - 4) < 1e-3, `${e} ${n}`);
});

test("the core's table: Fargo's Mapbox lots agree (the photo about 2.9 m west of the lidar: move it east)", () => {
  const nb = fromNeighbours([-96.884, 46.811], 'mapbox', lots);
  assert.ok(nb && nb.lots >= 5, JSON.stringify(nb));
  assert.ok(nb.east > 2.4 && nb.east < 3.4, `east ${nb.east}`);
  assert.equal(fromNeighbours([-96.884, 46.811], 'mapbox', lots, 100), null, 'none within 100 m');
});

test('no photo and nothing measured near: the source median, and says so', () => {
  const frame = { lng: -100, lat: 40, zoom: 20, size: 640, height: 640 };
  const m = measure(null, frame, null, { source: 'mapbox', lots });
  assert.equal(m.method, 'source');
  assert.deepEqual([m.east, m.north], [SOURCE_MEDIAN.mapbox.east, SOURCE_MEDIAN.mapbox.north]);
  const c = measure(null, frame, null, { source: 'county', lots });
  assert.deepEqual([c.east, c.north], [SOURCE_MEDIAN.county.east, SOURCE_MEDIAN.county.north]);
});

/* A house 14 x 10 m, 6 m tall, on flat ground, every 0.4 m; its photo drawn with the roof `off` ground metres
   east and north of where the lidar has it. The fit must say to move the photo by -off. */
function scene(off) {
  const frame = { lng: -96.88, lat: 46.81, zoom: 20, size: 512, height: 512 };
  const g = gridForFrame(frame, 1, 1), k = mercScale(frame.lat), W = g.cell * k, x0 = g.x0, y1 = g.y1;
  const xs = [], ys = [], zs = [], cls = [];
  const house = (e, n) => (e > W / 2 - 7 && e < W / 2 + 7 && n > W / 2 - 5 && n < W / 2 + 5);
  const shed = (e, n) => (e > W / 2 + 12 && e < W / 2 + 18 && n > W / 2 - 14 && n < W / 2 - 8);
  for (let e = 0.2; e < W; e += 0.4) for (let n = 0.2; n < W; n += 0.4) {
    const up = house(e, n) || shed(e, n);
    xs.push(x0 + e / k); ys.push(y1 - (W - n) / k); zs.push(up ? 6 : 0); cls.push(up ? 6 : 2);
  }
  const N = xs.length;
  const cols = { n: N, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs), cls: Uint8Array.from(cls), intensity: new Uint16Array(N).fill(30000), ret: new Uint8Array(N).fill(1), nret: new Uint8Array(N).fill(1) };
  const P = 400, data = new Uint8ClampedArray(P * P * 4);
  for (let r = 0; r < P; r++) for (let c = 0; c < P; c++) {
    const e = ((c + 0.5) / P) * W - off.east, n = W - ((r + 0.5) / P) * W - off.north;
    const v = house(e, n) || shed(e, n) ? 200 : 80 + ((r * 7 + c * 13) % 9);
    data.set([v, v, v, 255], (r * P + c) * 4);
  }
  return { frame, cols, photo: { data, width: P, height: P } };
}

test('the roof edges find a photo 1.5 m east and 1 m south of the lidar, to a quarter metre', () => {
  const off = { east: 1.5, north: -1.0 };
  const { frame, cols, photo } = scene(off);
  const f = roofFitOnFrame(cols, frame, photo);
  assert.ok(f && f.confident, JSON.stringify(f));
  const m = measure(cols, frame, photo, { source: 'mapbox', lots: [] });
  assert.equal(m.method, 'roof', m.why);
  assert.ok(Math.abs(m.east + off.east) <= 0.3 && Math.abs(m.north + off.north) <= 0.3, `moved ${m.east}, ${m.north}`);
});

test("what was tapped moves with the photo; the GPS calibration is dropped; a trace's rings move", () => {
  const d = { east: 2, north: -1 };
  const w = {
    downspouts: [{ from: [-85.5, 43.1], to: [-85.50001, 43.1] }], gutters: [[[-85.5, 43.1], [-85.5001, 43.1]]], areas: [{ kind: 'deck', ring: [[-85.5, 43.1]] }],
    irrigation: { heads: [{ id: 1, at: [-85.5, 43.1], zone: 1 }], system: { pvb: { at: [-85.5, 43.1] }, boxes: [{ id: 'b', at: [-85.5, 43.1] }] }, gpsCal: { offset: [1, 2] } },
    topsoil: true,
  };
  const m = inputsMoved(w, d), p = moved([-85.5, 43.1], d);
  const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  for (const q of [m.downspouts[0].from, m.gutters[0][0], m.areas[0].ring[0], m.irrigation.heads[0].at, m.irrigation.system.pvb.at, m.irrigation.system.boxes[0].at]) assert.ok(near(q, p), JSON.stringify(q));
  assert.equal(m.irrigation.gpsCal, undefined);
  assert.equal(m.topsoil, true);
  assert.equal(w.irrigation.heads[0].at[0], -85.5, 'the original is left alone');
  const f = featuresMoved([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-85.5, 43.1], [-85.5, 43.2], [-85.4, 43.1], [-85.5, 43.1]]] } }], d);
  assert.ok(near(f[0].geometry.coordinates[0][0], p));
  assert.ok(usable({ east: 1, north: 2 }) && !usable({ east: 30, north: 0 }) && !usable(null));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`${tests.length} passed`);
