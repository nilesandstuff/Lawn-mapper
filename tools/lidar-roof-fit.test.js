// tools/lidar-roof-fit.js: the roof rule on a grid, the edge points, the lawn share, and a roof slid onto a photo's edges.
import assert from 'node:assert/strict';
import { roofMask, edgePoints, lawnUnderRoof, fitRoof, ROOF_CELL_M, FIT_CELL_M } from './lidar-roof-fit.js';

const g = { w: 40, h: 30, cell: 1, x0: 0, y1: 30, lat: 0 };
const N = g.w * g.h;
const r = { n: new Uint16Array(N).fill(5), nGround: new Uint16Array(N).fill(3), zTop: new Float32Array(N).fill(100), zMin: new Float32Array(N).fill(100), zGround: new Float32Array(N).fill(100) };
// a 12 x 8 m roof, 6 m up, flat, no ground return under it, cols 10-21, rows 10-17
for (let y = 10; y < 18; y++) for (let x = 10; x < 22; x++) { const i = y * g.w + x; r.nGround[i] = 0; r.zGround[i] = NaN; r.zTop[i] = 106; r.zMin[i] = 105.5; }
// a lone tree top 4 m up with no ground return: one cell, dropped as a lone cell
{ const i = 3 * g.w + 3; r.nGround[i] = 0; r.zGround[i] = NaN; r.zTop[i] = 104; r.zMin[i] = 103; }
// a chimney-like spike: tall spread, inside the roof -> not roof by the rule but filled by the close
{ const i = 13 * g.w + 15; r.zTop[i] = 108; r.zMin[i] = 105.5; }
const m = roofMask(r, g);
let on = 0; for (let i = 0; i < N; i++) on += m[i];
assert.equal(on, 12 * 8, `the roof and nothing else (${on})`);
assert.equal(m[3 * g.w + 3], 0, 'the lone tree top is not a roof');
assert.equal(m[13 * g.w + 15], 1, 'the chimney cell is closed over');

const pts = edgePoints(m, g.w, g.h, ROOF_CELL_M / FIT_CELL_M);
assert.equal(pts.length, 2 * 12 + 2 * 8 - 4, 'the ring of edge cells');
const west = pts.find(([x, y]) => Math.abs(x - 10.5 * 4) < 1e-9 && Math.abs(y - 13.5 * 4) < 1e-9);
assert.ok(west && Math.abs(Math.abs(west[2]) - 1) < 1e-9 && Math.abs(west[3]) < 1e-9, 'a west-edge cell faces east-west');

// the traced lawn: the roof's east half is (wrongly) traced as lawn
const labels = { width: 40, height: 30, data: new Uint8Array(N * 4) };
for (let y = 0; y < 30; y++) for (let x = 16; x < 40; x++) labels.data[(y * 40 + x) * 4] = 255;
const share = lawnUnderRoof(m, g, labels);
assert.ok(Math.abs(share - (6 * 8) / (24 * 30)) < 1e-9, `lawn under the roof ${share}`);

// the photo: a dark roof on bright, textured grass, drawn 2 m east and 1 m south of where the lidar
// has it (the texture matters: photo-fit.js scales the gradients by the picture's own 95th
// percentile, and a picture with no texture at all has no scale)
let seed = 7;
const noise = (a) => { seed = (seed * 1103515245 + 12345) % 2147483648; return ((seed / 2147483648) - 0.5) * a; };
const Wg = 160, Hg = 120, grey = new Float32Array(Wg * Hg);
for (let i = 0; i < grey.length; i++) grey[i] = 180 + noise(40);
for (let y = (10 + 1) * 4; y < (18 + 1) * 4; y++) for (let x = (10 + 2) * 4; x < (22 + 2) * 4; x++) grey[y * Wg + x] = 60 + noise(20);
const f = fitRoof(m, g, grey, Wg, Hg, 1);
assert.ok(f, 'a fit');
assert.ok(Math.abs(f.east - 2) <= 0.5 && Math.abs(f.north + 1) <= 0.5, `moved 2 m east, 1 m south: E ${f.east} N ${f.north}`);
assert.ok(f.confident && f.peak > 1.35, `a clear peak (${f.peak})`);
assert.equal(fitRoof(new Uint8Array(N), g, grey, Wg, Hg, 1), null, 'no roof: nothing to fit');
console.log('lidar-roof-fit: ok');
