import assert from 'node:assert/strict';
import { edgeBand, edgeDistance } from './edge-band.js';

const w = 20, h = 20;
const square = (x0, y0, x1, y1) => {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
};

// Truth a 10x10 square; prediction the same square one cell wider on the right:
// every wrong cell touches the edge.
{
  const truth = square(5, 5, 15, 15);
  const got = square(5, 5, 16, 15);
  const r = edgeBand({ truth, got, within: null, w, h, radii: [0, 3] });
  assert.equal(r.wrong, 10);
  assert.deepEqual(r.near, [10, 10]);
}

// A blob far from the edge counts as wrong but not near it.
{
  const truth = square(0, 0, 4, 4);
  const got = square(0, 0, 4, 4);
  got[15 * w + 15] = 1;
  const r = edgeBand({ truth, got, within: null, w, h, radii: [2] });
  assert.equal(r.wrong, 1);
  assert.deepEqual(r.near, [0]);
}

// The property line is not a lawn edge: truth running up to the parcel's
// boundary gives no edge cells there.
{
  const within = square(0, 0, 10, 20);
  const truth = square(0, 0, 10, 20);
  const d = edgeDistance({ truth, within, w, h, cap: 5 });
  assert.equal(d[5 * w + 9], 0xffff);
}

console.log('edge-band: 3 checks passed');

// A prediction shifted two cells right is found, and undone, by bestShift.
{
  const { bestShift } = await import('./edge-band.js');
  const truth = square(5, 5, 12, 12);
  const got = square(7, 5, 14, 12);
  const s = bestShift({ truth, got, within: null, w, h, reach: 3 });
  assert.equal(s.dx, -2);
  assert.equal(s.dy, 0);
  assert.equal(s.wrong, 0);
  assert.ok(s.wrongAtZero > 0);
  console.log('edge-band: bestShift finds a 2-cell offset');
}
