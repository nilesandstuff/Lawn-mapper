/**
 * "You are here" from the lidar (lib/ar-lidar.js, FINDINGS H68). A made-up lot: a house, a fence, three trees and a
 * 6% slope; a phone that sees what stands within 6 m of its walk, in a frame turned and shifted from the map's.
 *   node water/test/ar-lidar.test.js
 */
import assert from 'node:assert/strict';
import { buildGrids, register, placementCost, unproject, sample } from '../lib/ar-lidar.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// a seeded random, so a failure repeats
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ground = (e, n) => 100 + 0.06 * e + 0.01 * n;

/** The lot as lidar points. */
function lot() {
  const E = [], N = [], Z = [], C = [];
  const add = (e, n, z, c) => { E.push(e); N.push(n); Z.push(z); C.push(c); };
  for (let e = -30; e <= 30; e += 0.5) for (let n = -30; n <= 30; n += 0.5) add(e + rnd() * 0.3, n + rnd() * 0.3, ground(e, n) + (rnd() - 0.5) * 0.04, 2);
  // the house: 14 x 9 m, its roof 6 m up (building points over its footprint)
  for (let e = -12.5; e <= 2.5; e += 0.5) for (let n = 3.5; n <= 13.5; n += 0.5) add(e, n, ground(e, n) + 6, 6); // its roof 0.5 m past its walls
  // a fence along n = -12 from e = -20 to 10, 1.8 m tall
  for (let e = -20; e <= 10; e += 0.25) for (const h of [0.6, 1.2, 1.7]) add(e, -12 + rnd() * 0.05, ground(e, -12) + h, 1);
  // three trees: a trunk (low points) and a crown (high)
  for (const [te, tn] of [[8, 3], [15, -5], [-18, -3]]) {
    for (let k = 0; k < 40; k++) add(te + (rnd() - 0.5) * 0.4, tn + (rnd() - 0.5) * 0.4, ground(te, tn) + 0.5 + rnd() * 1.8, 4);
    for (let k = 0; k < 200; k++) { const a = rnd() * 6.283, r = rnd() * 3; add(te + r * Math.cos(a), tn + r * Math.sin(a), ground(te, tn) + 4 + rnd() * 5, 5); }
  }
  return { e: Float64Array.from(E), n: Float64Array.from(N), z: Float32Array.from(Z), cls: Uint8Array.from(C) };
}
const L = lot();
const G = buildGrids(L, [-30, -30, 30, 30]);

/** What the phone sees standing at chest height and on the ground along a walk, in a frame turned TH and shifted SH (AR = R(-TH) (map - SH) / s). */
const TH = (63 * Math.PI) / 180, SH = [5, -7];
const toAR = ([e, n], s = 1) => { const a = e - SH[0], b = n - SH[1]; return [(Math.cos(-TH) * a - Math.sin(-TH) * b) / s, (Math.sin(-TH) * a + Math.cos(-TH) * b) / s]; };
function seen(path, { s = 1, reach = 6, noise = 0.03 } = {}) {
  const near = (e, n) => path.some(([pe, pn]) => Math.hypot(e - pe, n - pn) < reach);
  const stand = [], gr = [];
  // the house's walls, the fence, the trunks: sampled surfaces
  const walls = [[[-12, 4], [2, 4]], [[2, 4], [2, 13]], [[-12, 4], [-12, 13]], [[-20, -12], [10, -12]]];
  for (const [[e0, n0], [e1, n1]] of walls) { const len = Math.hypot(e1 - e0, n1 - n0); for (let t = 0; t <= len; t += 0.1) { const e = e0 + ((e1 - e0) * t) / len, n = n0 + ((n1 - n0) * t) / len; if (near(e, n)) stand.push([e + (rnd() - 0.5) * noise, n + (rnd() - 0.5) * noise]); } }
  for (const [te, tn] of [[8, 3], [15, -5], [-18, -3]]) for (let k = 0; k < 40; k++) { const a = rnd() * 6.283; const e = te + 0.2 * Math.cos(a), n = tn + 0.2 * Math.sin(a); if (near(e, n)) stand.push([e, n]); }
  for (const [pe, pn] of path) for (let k = 0; k < 20; k++) { const a = rnd() * 6.283, r = 0.5 + rnd() * 4; const e = pe + r * Math.cos(a), n = pn + r * Math.sin(a); gr.push([e, n, ground(e, n) - 100 + (rnd() - 0.5) * noise]); }
  return { stand: stand.map((p) => toAR(p, s)), ground: gr.map(([e, n, y]) => [...toAR([e, n], s), y - 1.3]) };
}
const truthAt = (T, p) => { const c = Math.cos(T.theta) * T.s, s = Math.sin(T.theta) * T.s; return [c * p[0] - s * p[1] + T.tx, s * p[0] + c * p[1] + T.ty]; };
const offAt = (T, mapPt) => { const g = truthAt(T, toAR(mapPt)); return Math.hypot(g[0] - mapPt[0], g[1] - mapPt[1]); };

test('the grids: the slope, the house and the fence stand where they are, open lawn is far from anything', () => {
  assert.ok(Math.abs(sample(G, G.dem, 10, -20) - ground(10, -20)) < 0.1);
  assert.ok(sample(G, G.dist, -12, 8) < 0.3, 'a wall'); // the west wall
  assert.ok(sample(G, G.dist, -5, 8) > 2, 'inside the house is not solid');
  assert.ok(sample(G, G.dist, 0, -12) < 0.3); // the fence
  assert.ok(sample(G, G.dist, 22, 20) > 3); // open lawn
});

test('walking past the house and a tree from a GPS guess 8 m off and any turn: found to a few centimetres', () => {
  const path = [[4, 0], [4, 1.5], [5, 3], [6, 4.5], [7, 6]];
  const { stand, ground: gr } = seen(path);
  const phone = toAR(path[path.length - 1]);
  const r = register(G, stand, gr, { at: [path[4][0] + 6, path[4][1] - 5], phone, radiusM: 10 });
  assert.ok(r.ok, r.why);
  const head = [10, 10];
  assert.ok(offAt(r.T, head) < 0.15, `a head 5 m on lands ${offAt(r.T, head).toFixed(2)} m off`);
  assert.ok(Math.abs(Math.atan2(Math.sin(r.T.theta - TH), Math.cos(r.T.theta - TH))) < (1 * Math.PI) / 180);
});

test('from a reference fit 2 m and 8 degrees off: put right', () => {
  const path = [[-16, -7], [-14, -8], [-12, -9]]; // the fence and a tree
  const { stand, ground: gr } = seen(path);
  const T0 = { theta: TH + (8 * Math.PI) / 180, tx: SH[0] + 1.5, ty: SH[1] - 1.3, s: 1 };
  const r = register(G, stand, gr, { T: T0 });
  assert.ok(r.ok, r.why);
  assert.ok(offAt(r.T, [-10, -5]) < 0.15, `${offAt(r.T, [-10, -5]).toFixed(2)} m`);
});

test('AR 4% short: with the scale held it still lines up', () => {
  const path = [[4, 0], [4, 1.5], [5, 3], [6, 4.5], [7, 6]];
  const { stand, ground: gr } = seen(path, { s: 1.04 });
  const phone = toAR(path[4], 1.04);
  const r = register(G, stand, gr, { at: path[4], phone, radiusM: 6 }, { s: 1.04 });
  assert.ok(r.ok, r.why);
  const g = truthAt(r.T, toAR([10, 10], 1.04));
  assert.ok(Math.hypot(g[0] - 10, g[1] - 10) < 0.2, `${Math.hypot(g[0] - 10, g[1] - 10).toFixed(2)} m`);
});

test('out on open lawn with nothing in reach: no fix, said why', () => {
  const { stand, ground: gr } = seen([[22, 22], [24, 22]]);
  const r = register(G, stand, gr, { at: [23, 22], phone: toAR([24, 22]), radiusM: 8 });
  assert.equal(r.ok, false);
  assert.match(r.why, /standing points/);
});

test('one straight fence alone slides along itself: refused as two places fitting alike', () => {
  const path = [[-10, -10], [-8, -10]]; // within 6 m of the fence only
  const { stand, ground: gr } = seen(path);
  const flat = gr.map(([u, v]) => [u, v, 0]); // and no slope to tell
  const r = register(G, stand, flat, { T: { theta: TH, tx: SH[0] + 2, ty: SH[1], s: 1 } }, { minStand: 20 });
  assert.equal(r.ok, false, `fixed ${JSON.stringify(r.T)} hits ${r.hits}`);
});

test('a depth sample back to a point: a camera at the origin looking along -z', () => {
  // a symmetric projection, 90 degrees across: P[0] = P[5] = 1
  const P = new Float32Array(16); P[0] = 1; P[5] = 1; P[10] = -1; P[11] = -1; P[14] = -0.2;
  const I = new Float32Array(16); I[0] = I[5] = I[10] = I[15] = 1;
  assert.deepEqual(unproject(0.5, 0.5, 3, P, I).map((v) => +v.toFixed(6)), [0, 0, -3]);
  assert.deepEqual(unproject(1, 0, 2, P, I).map((v) => +v.toFixed(6)), [2, 2, -2]); // the top right corner
  // the camera 1.5 m up, turned 90 degrees left (looking along -x)
  const M = new Float32Array(16); M[0] = 0; M[2] = -1; M[5] = 1; M[8] = 1; M[10] = 0; M[13] = 1.5; M[15] = 1;
  assert.deepEqual(unproject(0.5, 0.5, 4, P, M).map((v) => +v.toFixed(6)), [-4, 1.5, 0]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`water AR lidar: ${tests.length - failed} passed${failed ? `, ${failed} failed` : ''}`);
if (failed) process.exit(1);
