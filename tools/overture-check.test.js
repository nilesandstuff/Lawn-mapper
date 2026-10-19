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

// The editor's layer (public/lib/overture-layer.js).
const { overtureGeoJSON, bandWidth, covers } = await import('../public/lib/overture-layer.js');
const fc = overtureGeoJSON({
  roads: [{ cls: 'residential', sub: null, width: 8, walk: false, lines: [[[0, 0], [0.001, 0]], [[1, 1]]] },
    { cls: 'footway', sub: 'sidewalk', width: 1.5, walk: true, lines: [[[0, 0], [0, 0.001]]] }],
  buildings: [[[[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0]]], [[[0, 0], [1, 1]]]],
});
assert.deepEqual(fc.features.map((f) => f.properties.kind), ['road', 'walk', 'building'], 'one-point lines and degenerate rings dropped');
assert.equal(fc.features[0].properties.w, 8);
// 8 m at the equator at zoom 20: 8 / (40075016.686 / (512 * 2^20)) px
const ex = bandWidth(0);
assert.ok(Math.abs(ex[4][2] - (512 * 2 ** 14) / 40075016.686) < 1e-9 && Math.abs(ex[6][2] / ex[4][2] - 1024) < 1e-6, 'doubles each zoom');
assert.ok(covers([0, 0, 2, 2], [0.5, 0.5, 1, 1]) && !covers([0, 0, 2, 2], [0.5, 0.5, 3, 1]) && !covers(null, [0, 0, 1, 1]));
console.log('overture-layer: ok');
