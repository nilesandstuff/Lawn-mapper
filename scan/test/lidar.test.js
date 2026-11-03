/**
 * scan/lib/lidar.js (carried from water/lib/ar-lidar.js, H68): a made-up lot with a house, a fence and three trees on
 * a 6% slope; a phone that sees what stands within 6 m of its walk, in a frame turned and shifted from the map's.
 * The water session's own test (water/test/ar-lidar.test.js) is the fuller one; this proves the carried copy.
 *   node scan/test/lidar.test.js
 */
import assert from 'node:assert/strict';
import { buildGrids, register, sample } from '../lib/lidar.js';

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ground = (e, n) => 100 + 0.06 * e + 0.01 * n;

function lot() {
  const E = [], N = [], Z = [], C = [];
  const add = (e, n, z, c) => { E.push(e); N.push(n); Z.push(z); C.push(c); };
  for (let e = -30; e <= 30; e += 0.5) for (let n = -30; n <= 30; n += 0.5) add(e + rnd() * 0.3, n + rnd() * 0.3, ground(e, n) + (rnd() - 0.5) * 0.04, 2);
  for (let e = -12.5; e <= 2.5; e += 0.5) for (let n = 3.5; n <= 13.5; n += 0.5) add(e, n, ground(e, n) + 6, 6);
  for (let e = -20; e <= 10; e += 0.25) for (const h of [0.6, 1.2, 1.7]) add(e, -12 + rnd() * 0.05, ground(e, -12) + h, 1);
  for (const [te, tn] of [[8, 3], [15, -5], [-18, -3]]) {
    for (let k = 0; k < 40; k++) add(te + (rnd() - 0.5) * 0.4, tn + (rnd() - 0.5) * 0.4, ground(te, tn) + 0.5 + rnd() * 1.8, 4);
    for (let k = 0; k < 200; k++) { const a = rnd() * 6.283, r = rnd() * 3; add(te + r * Math.cos(a), tn + r * Math.sin(a), ground(te, tn) + 4 + rnd() * 5, 5); }
  }
  return { e: Float64Array.from(E), n: Float64Array.from(N), z: Float32Array.from(Z), cls: Uint8Array.from(C) };
}
const G = buildGrids(lot(), [-30, -30, 30, 30]);
const TH = (63 * Math.PI) / 180, SH = [5, -7];
const toAR = ([e, n]) => { const a = e - SH[0], b = n - SH[1]; return [Math.cos(-TH) * a - Math.sin(-TH) * b, Math.sin(-TH) * a + Math.cos(-TH) * b]; };
function seen(path, { reach = 6, noise = 0.03 } = {}) {
  const near = (e, n) => path.some(([pe, pn]) => Math.hypot(e - pe, n - pn) < reach);
  const stand = [], gr = [];
  const walls = [[[-12, 4], [2, 4]], [[2, 4], [2, 13]], [[-12, 4], [-12, 13]], [[-20, -12], [10, -12]]];
  for (const [[e0, n0], [e1, n1]] of walls) { const len = Math.hypot(e1 - e0, n1 - n0); for (let t = 0; t <= len; t += 0.1) { const e = e0 + ((e1 - e0) * t) / len, n = n0 + ((n1 - n0) * t) / len; if (near(e, n)) stand.push([e + (rnd() - 0.5) * noise, n + (rnd() - 0.5) * noise]); } }
  for (const [te, tn] of [[8, 3], [15, -5], [-18, -3]]) for (let k = 0; k < 40; k++) { const a = rnd() * 6.283; const e = te + 0.2 * Math.cos(a), n = tn + 0.2 * Math.sin(a); if (near(e, n)) stand.push([e, n]); }
  for (const [pe, pn] of path) for (let k = 0; k < 20; k++) { const a = rnd() * 6.283, r = 0.5 + rnd() * 4; const e = pe + r * Math.cos(a), n = pn + r * Math.sin(a); gr.push([e, n, ground(e, n) - 100 + (rnd() - 0.5) * noise]); }
  return { stand: stand.map((p) => toAR(p)), ground: gr.map(([e, n, y]) => [...toAR([e, n]), y - 1.3]) };
}
const truthAt = (T, p) => { const c = Math.cos(T.theta) * T.s, s = Math.sin(T.theta) * T.s; return [c * p[0] - s * p[1] + T.tx, s * p[0] + c * p[1] + T.ty]; };
const offAt = (T, mapPt) => { const g = truthAt(T, toAR(mapPt)); return Math.hypot(g[0] - mapPt[0], g[1] - mapPt[1]); };

// the grids
assert.ok(Math.abs(sample(G, G.dem, 10, -20) - ground(10, -20)) < 0.1, 'the slope');
assert.ok(sample(G, G.dist, -12, 8) < 0.3, 'a wall');
assert.ok(sample(G, G.dist, -5, 8) > 2, 'inside the house is not solid');
assert.ok(sample(G, G.dist, 0, -12) < 0.3, 'the fence');
assert.ok(sample(G, G.dist, 22, 20) > 3, 'open lawn');
assert.ok(G.occTop && G.bld, 'the tops and the roof mask come back for the overlay');
{
  const k = (e, n) => Math.floor((30 - n) / G.cell) * G.W + Math.floor((e + 30) / G.cell);
  const fenceTop = Math.max(G.occTop[k(0, -12)], G.occTop[k(0, -11.9)], G.occTop[k(0, -12.1)]);
  assert.ok(fenceTop > 1.5 && fenceTop < 2, `the fence's top: ${fenceTop}`);
  assert.equal(G.bld[k(-5, 8)], 1, 'under the roof');
  assert.equal(G.bld[k(20, 20)], 0, 'open lawn is not roof');
}
// past the house and a tree, from a GPS guess 8 m off and any turn: found to a few centimetres
{
  const path = [[-6, -1], [-2, -1], [2, -1], [6, -1], [8, -2]];
  const { stand, ground: gr } = seen(path);
  const fix = register(G, stand, gr, { at: [path[2][0] + 5, path[2][1] - 6], phone: toAR(path[2]), radiusM: 12 });
  assert.ok(fix.ok, `a fix: ${fix.why}`);
  for (const p of [[0, 0], [-12, 4], [15, -5]]) assert.ok(offAt(fix.T, p) < 0.15, `${p} within 15 cm: ${offAt(fix.T, p).toFixed(3)}`);
  assert.ok(fix.hits > 0.8, `most points land: ${fix.hits}`);
  // from that fix, a small search a few steps on
  const next = seen([[6, -1], [8, -2], [10, -4]]);
  const fix2 = register(G, next.stand, next.ground, { T: fix.T }, { searchM: 1.5, searchDeg: 6 });
  assert.ok(fix2.ok && offAt(fix2.T, [0, 0]) < 0.15, 'the next fix from the last');
}
// a straight fence alone: two places fit, refused
{
  const { stand, ground: gr } = seen([[-10, -9], [-6, -9], [-2, -9]], { reach: 4 });
  const fix = register(G, stand, gr, { at: [-6 + 3, -9 - 4], phone: toAR([-6, -9]), radiusM: 10 });
  assert.ok(!fix.ok, `refused: ${fix.why}`);
}
console.log('lidar: ok');
