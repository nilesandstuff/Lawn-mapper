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
  // noisy ground, as the phone's depth is: a wide patch with heights scattered 10 cm about level and one point in
  // twenty well below it; none of it may read as standing
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const n0 = recs.length;
  for (let i = 0; i < 4000; i++) recs.push({ e: 100 + rnd() * 5, n: rnd() * 5, y: 3 + 0.1 * gauss() - (i % 20 === 0 ? 0.6 * rnd() : 0), t: 1, ground: 3 });
  const h = heights(recs);
  { const up = [...h.slice(n0, n0 + 4000)].filter((v) => v > 0.4).length; assert.ok(up < 20, `noisy ground stays ground (${up} of 4000 read as standing)`); }
  assert.ok(h.slice(0, 400).every((v) => Math.abs(v) < 0.2), 'the slope is ground, though the kept height put it half a metre up');
  assert.ok([...h.slice(400, 600)].filter((v) => v > 0.4).length > 100, 'the fence still stands over it');
  assert.ok(h.slice(600, 1000).every((v) => Math.abs(v) < 0.2), 'the second pass, drifted up, is ground too');
  assert.equal(h[1000], 0.5, 'alone: the kept ground height');
}

// seen from more than one place: a wall seen from two stretches is confirmed; a clump read short in one stretch,
// which the other stretch's lines pass through on their way to the wall, is seen past
{
  const { carve, seenPast, confirmed, groundLooks } = await import('../lib/disagree.js');
  const L = [];
  for (let i = 0; i < 2400; i++) { const z = (i % 60) * 0.05, y = Math.floor(i / 60) * 0.025; L.push({ c: [0, 1.4, 1], p: [10, y, z], t: 1 }); L.push({ c: [0, 1.4, 2], p: [10, y + 0.03, z + 0.03], t: 30 }); }
  const n0 = L.length;
  for (let i = 0; i < 60; i++) L.push({ c: [0, 1.4, 1], p: [5, 0.8 + (i % 6) * 0.05, 1.6 + Math.floor(i / 6) * 0.05], t: 2 });   // the clump: half the distance, one stretch
  const c = carve(L);
  let ok = 0; for (let i = 0; i < n0; i++) if (confirmed(c, i)) ok++;
  assert.ok(ok > 0.9 * n0, `the wall, seen twice, is confirmed (${ok} of ${n0})`);
  let past = 0; for (let i = n0; i < L.length; i++) if (seenPast(c, i)) past++;
  assert.ok(past > 40, `the clump is seen past (${past} of 60)`);
  // the ground by more than one look: two looks 4 cm apart, a third square seen once
  const R = [];
  for (let i = 0; i < 40; i++) { R.push({ e: 0.1, n: 0.1, y: 1 + (i % 4) * 0.01, t: 1 }); R.push({ e: 0.1, n: 0.1, y: 1.04 + (i % 4) * 0.01, t: 50 }); R.push({ e: 3, n: 3, y: 2, t: 1 }); }
  const g = groundLooks(R);
  assert.deepEqual([g.squares, g.one, g.two, g.more], [2, 1, 1, 0]);
  assert.ok(g.spread.length === 2 && Math.abs(g.spread[0] - 0.02) < 0.011, `two looks 4 cm apart: each 2 cm from the middle (${g.spread})`);
}
console.log('disagree: ok');
