// The shift search in tools/overture-check.js: it must find a known shift, and prefer no shift on a tie.
import assert from 'node:assert/strict';
import { bestShift, median } from './overture-check.js';

const W = 40, H = 30, P = 6, S = 4, BW = W + 2 * P;
const ref = new Uint8Array(W * H), big = new Uint8Array(BW * (H + 2 * P));
for (let r = 10; r < 20; r++) for (let c = 12; c < 25; c++) ref[r * W + c] = 1;
// The same square in the padded grid, 3 cells west and 2 cells north of where it should be.
for (let r = 10; r < 20; r++) for (let c = 12; c < 25; c++) big[(r + P - 2) * BW + (c + P - 3)] = 1;
const f = bestShift(big, ref, W, H, P, S);
assert.equal(f.best.dx, 3, 'east');
assert.equal(f.best.dy, 2, 'south');
assert.equal(f.best.iou, 1);
assert.ok(f.zero.iou < 0.7);

// Nothing to match: no shift, not the corner of the search.
const none = bestShift(new Uint8Array(BW * (H + 2 * P)), ref, W, H, P, S);
assert.equal(none.best.dx, 0);
assert.equal(none.best.dy, 0);

assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 2, NaN, 3]), 2.5);
console.log('overture-check: ok');

// The editor's layer (public/lib/overture-layer.js): lines only (owner, 2026-10-20).
const { overtureGeoJSON, covers } = await import('../public/lib/overture-layer.js');
const fc = overtureGeoJSON({
  roads: [{ cls: 'residential', sub: null, width: 8, walk: false, lines: [[[0, 0], [0.001, 0]], [[1, 1]]] },
    { cls: 'footway', sub: 'sidewalk', width: 1.5, walk: true, lines: [[[0, 0], [0, 0.001]]] }],
  buildings: [[[[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0]]]],
});
assert.deepEqual(fc.features.map((f) => f.properties.kind), ['road', 'walk'], 'one-point lines dropped; buildings not drawn');
assert.ok(!('w' in fc.features[0].properties), 'no width: the band is gone');
assert.ok(covers([0, 0, 2, 2], [0.5, 0.5, 1, 1]) && !covers([0, 0, 2, 2], [0.5, 0.5, 3, 1]) && !covers(null, [0, 0, 1, 1]));
console.log('overture-layer: ok');

// The photo fit (tools/overture-check.js edgeFit, leanFit).
const { edgeFit, leanFit } = await import('./overture-check.js');
{
  const Wg = 80, Hg = 60, gx = new Float32Array(Wg * Hg), gy = new Float32Array(Wg * Hg);
  // a bright square from (30,20) to (50,40): its edges, as gradients, 3 cells east and 2 south of the outline below
  for (let r = 23; r <= 42; r++) { gx[r * Wg + 33] = 1; gx[r * Wg + 53] = -1; }
  for (let c = 33; c <= 53; c++) { gy[22 * Wg + c] = 1; gy[42 * Wg + c] = -1; }
  const pts = [];
  for (let t = 0.5; t < 20; t += 1) { pts.push([30 + t, 20, 0, 1], [30 + t, 40, 0, 1], [30, 20 + t, 1, 0], [50, 20 + t, 1, 0]); }
  const f = edgeFit(pts, gx, gy, Wg, Hg, 8);
  assert.equal(f.dx, 3); assert.equal(f.dy, 2); assert.ok(f.peak > 2);
}
{
  // shift = (0.5, -0.2) + (0.3, 0.1) * h, exactly, plus one stray
  const rows = [3, 5, 7, 9, 4].map((h) => ({ h, s: [0.5 + 0.3 * h, -0.2 + 0.1 * h] }));
  rows.push({ h: 6, s: [9, 9] });
  const lf = leanFit(rows);
  assert.ok(Math.abs(lf.g[0] - 0.5) < 1e-6 && Math.abs(lf.L[0] - 0.3) < 1e-6 && Math.abs(lf.L[1] - 0.1) < 1e-6, 'the stray is trimmed');
}
console.log('photo fit: ok');

