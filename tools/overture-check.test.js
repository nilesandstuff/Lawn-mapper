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
