// tools/lidar-roof-fit.js: the roof rule on a grid, the edge points, the lawn share, and a roof slid onto a photo's edges.
import assert from 'node:assert/strict';
import { roofMask, edgePoints, lawnUnderRoof, fitRoof, heightSurface, dropPoints, groundSurface, groundPoints, fitGround, ROOF_CELL_M, FIT_CELL_M } from './lidar-roof-fit.js';

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

// the height surface from the same grid: about 6 m over the roof, 0 on the ground, its drops the eaves
const hs = heightSurface(r, g);
assert.ok(Math.abs(hs[14 * g.w + 15] - 6) < 0.5 && Math.abs(hs[5 * g.w + 30]) < 1e-6, `height ${hs[14 * g.w + 15]} on the roof, ${hs[5 * g.w + 30]} on the ground`);
const drops = dropPoints(hs, g.w, g.h, ROOF_CELL_M / FIT_CELL_M);
assert.ok(drops.length >= 36 && drops.length <= 90, `the eaves as drop points, a pair either side (${drops.length})`);
assert.ok(drops.every(([, , nx, ny]) => Math.abs(Math.hypot(nx, ny) - 1) < 1e-9), 'unit directions');

// THE FIT, on the tool's own 0.5 m height cells: a 12 x 8 m roof 6 m up (cols 20-43, rows 20-35 of
// an 80 x 60 grid), its surface smoothed as heightSurface does, against a photo whose dark roof sits
// 2 m east and 1 m south of it, on bright, textured grass (the texture matters: photo-fit.js scales
// the gradients by the picture's own 95th percentile, and a picture with no texture has no scale)
const hg = { w: 80, h: 60, cell: 0.5, cellM: 0.5 };
const step = new Float32Array(hg.w * hg.h);
for (let y = 20; y < 36; y++) for (let x = 20; x < 44; x++) step[y * hg.w + x] = 6;
const h5 = new Float32Array(hg.w * hg.h);
for (let y = 0; y < hg.h; y++) for (let x = 0; x < hg.w; x++) {
  let t = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && xx >= 0 && yy < hg.h && xx < hg.w) { t += step[yy * hg.w + xx]; n++; } }
  h5[y * hg.w + x] = t / n;
}
let seed = 7;
const noise = (a) => { seed = (seed * 1103515245 + 12345) % 2147483648; return ((seed / 2147483648) - 0.5) * a; };
const Wg = 160, Hg = 120, grey = new Float32Array(Wg * Hg);
for (let i = 0; i < grey.length; i++) grey[i] = 180 + noise(40);
for (let y = 40 + 4; y < 72 + 4; y++) for (let x = 40 + 8; x < 88 + 8; x++) grey[y * Wg + x] = 60 + noise(20);
const f = fitRoof(h5, hg, grey, Wg, Hg, 1);
assert.ok(f, 'a fit');
assert.ok(Math.abs(f.east - 2) <= 0.3 && Math.abs(f.north + 1) <= 0.3, `moved 2 m east, 1 m south: E ${f.east} N ${f.north}`);
assert.ok(f.confident && f.peak > 1.35, `a clear peak (${f.peak})`);
assert.equal(fitRoof(new Float32Array(hg.w * hg.h), hg, grey, Wg, Hg, 1), null, 'flat ground: nothing to fit');

// THE GROUND FIT: open ground with a bright drive (lidar brightness 200 on 60) whose edge in the
// photo sits 1 m east and 0.5 m south of the lidar's; a house in the corner that must be kept out.
{
  const w = 80, hh = 60, cellM = 0.5, gg = { w, h: hh, cell: 0.5, cellM };
  const N = w * hh;
  const hgt = new Float32Array(N); // flat ground, a 10 x 8 m house 6 m up at cols 60-79, rows 0-15
  for (let y = 0; y < 16; y++) for (let x = 60; x < 80; x++) hgt[y * w + x] = 6;
  const iLow = new Float32Array(N).fill(60);
  for (let y = 0; y < hh; y++) for (let x = 20; x < 32; x++) iLow[y * w + x] = 200; // a 6 m wide bright drive, cols 20-31
  for (let y = 40; y < 46; y++) for (let x = 0; x < 60; x++) iLow[y * w + x] = 200; // and a 3 m path across, rows 40-45, so both axes are held
  const r2 = { iLow };
  const gs = groundSurface(r2, hgt, gg, 3);
  assert.equal(gs.ground[5 * w + 70], 0, 'the house is not ground');
  assert.equal(gs.ground[5 * w + 58], 0, 'nor the 1.5 m beside it');
  assert.equal(gs.ground[30 * w + 10], 1, 'open ground is');
  const pts = groundPoints(gs.bright, gs.ground, w, hh, cellM / FIT_CELL_M);
  assert.ok(pts.length > 50 && pts.every(([x, y]) => (x >= 18 * 2 && x <= 34 * 2) || (y >= 38 * 2 && y <= 48 * 2)), `the drive's and the path's edges are the strong brightness edges (${pts.length} points)`);
  let seed2 = 11;
  const noise2 = (a) => { seed2 = (seed2 * 1103515245 + 12345) % 2147483648; return ((seed2 / 2147483648) - 0.5) * a; };
  const Wg2 = 160, Hg2 = 120, grey2 = new Float32Array(Wg2 * Hg2);
  for (let i = 0; i < grey2.length; i++) grey2[i] = 90 + noise2(30);
  for (let y = 0; y < Hg2; y++) for (let x = 40 + 4; x < 64 + 4; x++) grey2[y * Wg2 + x] = 200 + noise2(20); // the drive in the photo, 1 m (4 cells) east
  for (let y = 80 + 2; y < 92 + 2; y++) for (let x = 0; x < 120 + 4; x++) grey2[y * Wg2 + x] = 200 + noise2(20); // the path, 0.5 m (2 cells) south
  const gf = fitGround(gs.bright, gs.ground, gg, grey2, Wg2, Hg2);
  assert.ok(gf && gf.confident, `a clear ground fit (${gf && gf.peak})`);
  assert.ok(Math.abs(gf.east - 1) <= 0.3 && Math.abs(gf.north + 0.5) <= 0.3, `moved 1 m east, 0.5 m south: E ${gf.east} N ${gf.north}`);
}
console.log('lidar-roof-fit: ok');
