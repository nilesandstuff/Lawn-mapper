import assert from 'node:assert/strict';
import { colourEdges } from './colour-edges.js';

const w = 200, h = 120, F = 3, mpp = 0.15;
let s = 12345;
const noise = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };

// The true edge is at x = 100: grass (green) left, a driveway (grey) right.
const cheap = new Float32Array(w * h * F);
const truth = new Uint8Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * w + x, lawn = x < 100;
  truth[i] = lawn ? 1 : 0;
  cheap[i * F] = (lawn ? 0.6 : 0.1) + 0.1 * noise();   // excess green
  cheap[i * F + 1] = (lawn ? 0.4 : 0.6) + 0.1 * noise(); // brightness
  cheap[i * F + 2] = noise();                              // nothing
}
// The decoder put the edge 6 cells (0.9 m) too far into the driveway.
const mask = new Uint8Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < 106; x++) mask[y * w + x] = 1;

const wrong = (m) => m.reduce((a, v, i) => a + (v !== truth[i] ? 1 : 0), 0);
const r = colourEdges(mask, cheap, F, { w, h, mpp });
assert.equal(r.fitted, true);
assert.ok(wrong(r.mask) < wrong(mask) * 0.2, `wrong ${wrong(mask)} -> ${wrong(r.mask)}`);
console.log(`PASS  colour pulls a 0.9 m overshoot back to the true edge (${wrong(mask)} -> ${wrong(r.mask)} cells wrong)`);

// Nothing beyond the band moves: a cell 3 m inside the lawn stays as it was.
{
  const far = 60 * w + 70;   // 36 cells = 5.4 m from the edge
  const m2 = Uint8Array.from(mask); m2[far] = 1;
  cheap[far * F] = 0.1;     // looks like driveway, but far from the edge
  const r2 = colourEdges(m2, cheap, F, { w, h, mpp });
  assert.equal(r2.mask[far], 1);
  console.log('PASS  ground far from the edge is never re-decided');
}

// Under the canopy, colour is a tree: the band there is left alone.
{
  const canopy = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 95; x < 115; x++) canopy[y * w + x] = 1;
  const r3 = colourEdges(mask, cheap, F, { w, h, mpp, canopy });
  for (let y = 0; y < h; y++) for (let x = 95; x < 115; x++) assert.equal(r3.mask[y * w + x], mask[y * w + x]);
  console.log('PASS  canopy cells are left as the decoder said');
}

// Too few examples of one side: nothing changes.
{
  const all = new Uint8Array(w * h).fill(1);
  const r4 = colourEdges(all, cheap, F, { w, h, mpp });
  assert.equal(r4.fitted, false);
  assert.equal(r4.changed, 0);
  console.log('PASS  with nothing to learn from, the mask is returned as it was');
}
