// Where a walk and the lidar model disagree (lib/disagree.js): a fence the lidar lacks, a phantom the phone saw
// through, grass outside the traced lawn; and nothing where they agree.
import assert from 'node:assert/strict';
import { disagree, lines } from '../lib/disagree.js';

const pts = [];
const many = (e, n, h, label, k = 20) => { for (let i = 0; i < k; i++) pts.push({ e: e + 0.1 + 0.04 * i, n: n + 0.5, h, label, conf: 0.9 }); };
// a wall the model has (x 0..5, y 10): the phone sees it
for (let x = 0; x < 5; x++) many(x, 10, 1.2, 'building');
// a fence the model lacks (x 0..8, y 20)
for (let x = 0; x < 8; x++) many(x, 20, 1.0, 'structure');
// the model's phantom at (20, 20): the phone saw only ground there
many(20, 20, 0.02, 'terrain');
// grass seen at (30..33, 5), outside the traced lawn (the lawn is e < 12); paving seen at (3, 3), inside it
for (let x = 30; x < 34; x++) many(x, 5, 0.01, 'terrain');
many(3, 3, 0.0, 'sidewalk');
// grass inside the lawn: fine
many(6, 3, 0.0, 'terrain');

const model = {
  solid: (e, n) => (n >= 10 && n < 11 && e >= 0 && e < 5) || (Math.floor(e) === 20 && Math.floor(n) === 20),
  kind: (e, n) => (Math.floor(e) === 20 ? 'structure' : 'building'),
  lawn: (e) => e < 12,
};
const r = disagree(pts, model);
assert.equal(r.stood, 13); assert.equal(r.agree, 5, 'the wall both have');
assert.equal(r.extra.cells, 8); assert.deepEqual(r.extra.by, { structure: 8 });
assert.equal(r.extra.patches.length, 1); assert.ok(r.extra.patches[0].line && Math.abs(r.extra.patches[0].lengthM - Math.hypot(8, 1)) < 0.1, 'one long thin patch: a fence');
assert.equal(r.missing.cells, 1); assert.deepEqual(r.missing.by, { structure: 1 }, 'solid in the model where the phone saw the ground');
assert.equal(r.lawn.grassOutside, 5, 'the four, and the ground seen at the phantom'); assert.equal(r.lawn.paveInside, 1); assert.equal(r.lawn.grassCells, 6);
// a standing thing one cell from the model's is agreement (a walk is placed to a foot at best)
assert.equal(disagree([...Array(10)].map(() => ({ e: 0.5, n: 11.5, h: 1, label: 'building', conf: 1 })), model).extra.cells, 0);
// too few points in a cell: not looked at
assert.equal(disagree([{ e: 50.5, n: 50.5, h: 1, label: 'tree', conf: 1 }], model).looked, 0);
const text = lines(r).join('\n');
assert.match(text, /27 ft structure/); assert.ok(!/\d+\.\d{4}/.test(text), 'no coordinate-like numbers');

// heights over the ground the walk itself saw
{
  const { heights } = await import('../lib/disagree.js');
  const recs = [];
  // a slope the kept ground height missed by half a metre: every point is ground
  for (let i = 0; i < 400; i++) { const e = (i % 20) * 0.1, n = Math.floor(i / 20) * 0.1; recs.push({ e, n, y: 0.5 + 0.1 * e, t: 1, ground: 0 }); }
  // a fence over it: 1.2 m of points above the slope at e = 1
  for (let i = 0; i < 200; i++) recs.push({ e: 1.02, n: (i % 20) * 0.1, y: 0.6 + 0.1 + 1.2 * ((i % 10) / 10), t: 1, ground: 0 });
  // the same slope seen again a minute later, 0.6 m higher (drift): still ground
  for (let i = 0; i < 400; i++) { const e = (i % 20) * 0.1, n = Math.floor(i / 20) * 0.1; recs.push({ e, n, y: 1.1 + 0.1 * e, t: 70, ground: 0 }); }
  // a point with nothing round it keeps the kept ground
  recs.push({ e: 50, n: 50, y: 2, t: 1, ground: 1.5 });
  const h = heights(recs);
  assert.ok(h.slice(0, 400).every((v) => Math.abs(v) < 0.2), 'the slope is ground, though the kept height put it half a metre up');
  assert.ok([...h.slice(400, 600)].filter((v) => v > 0.4).length > 100, 'the fence still stands over it');
  assert.ok(h.slice(600, 1000).every((v) => Math.abs(v) < 0.2), 'the second pass, drifted up, is ground too');
  assert.equal(h[1000], 0.5, 'alone: the kept ground height');
}
console.log('disagree: ok');
