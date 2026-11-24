// How much of the lidar's crown sits in air a walk saw empty in any season (scan/lib/clear-measure.js).
// node scan/test/clear-measure.test.js
import assert from 'node:assert/strict';
import { lidarInClear } from '../lib/clear-measure.js';

// a 6 x 6 lidar of 1 m columns, layers of 1 m from the ground (100) up; two tree clumps and a roof
const W = 6, H = 6, nz = 20, z0 = 100, dz = 1;
const ground = new Float32Array(W * H).fill(100), kind = new Uint8Array(W * H), mu = new Float32Array(W * H * nz), muOn = new Float32Array(W * H * nz);
const crown = (s, from, to, v = 1) => { kind[s] = 2; for (let l = from; l < to; l++) { mu[s * nz + l] = v; muOn[s * nz + l] = v; } };
crown(0, 3, 12); crown(1, 3, 12);                 // clump A: two columns, crown 3-12 m
crown(5 * W + 5, 4, 8);                            // clump B: one column, crown 4-8 m
kind[3 * W + 3] = 1; for (let l = 0; l < 6; l++) mu[(3 * W + 3) * nz + l] = 50;   // a roof to 6 m
muOn[1 * nz + 5] = 2;                              // column 1, layer 5 (5-6 m) denser in summer: a deciduous crown
const lidar = { meta: { grid: { w: W, h: H }, layers: { z0, dz, nz } }, arrays: { ground, kind, mu, muOn } };
const sub = 2, w = W * sub, h = H * sub;
const lo = new Float32Array(w * h).fill(NaN), hi = new Float32Array(w * h).fill(NaN);
const band = (c, r, a, b) => { lo[r * w + c] = a; hi[r * w + c] = b; };
// all four half-metre cells of clump B's column cleared from 2.5 to 9 m: its whole crown is in empty air
for (const [c, r] of [[10, 10], [11, 10], [10, 11], [11, 11]]) band(c, r, 2.5, 9);
// one half-metre cell of clump A's first column cleared 4-6 m (two layers: 4-5, 5-6); the roof's cells cleared 3-4 m
band(0, 0, 4, 6);
band(6, 6, 3, 4);
// column 1 cell: 5-6 m cleared (the deciduous layer)
band(2, 0, 5, 6);
const q = lidarInClear(lidar, { lo, hi }, sub);
assert.equal(q.cells, 7);
assert.equal(q.crown, 4 * 4 + 2 + 1, 'clump B 4 cells x 4 layers, clump A 2 + 1');
assert.equal(q.crownDecid, 1);
assert.equal(q.roof, 1);
assert.equal(q.clumps.n, 2);
assert.equal(q.clumps.hist.over90, 1, 'clump B is all in empty air');
assert.equal(q.clumps.mostlyClear[0].cols, 1);
assert.equal(q.clumps.hist.under25, 1, 'clump A barely');
console.log('clear-measure: ok');
