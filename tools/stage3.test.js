/**
 * The geometry under the trees does what the plan says and nothing else.
 *
 *   node tools/stage3.test.js
 */

import assert from 'node:assert/strict';
import { clumps, clearCanopy, reach, bridge, stage3 } from './stage3.js';

const grid = (rows) => {
  const h = rows.length, w = rows[0].length;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = rows[y][x] === '#' ? 1 : 0;
  return { mask: out, w, h };
};
const show = (mask, w, h) => {
  const lines = [];
  for (let y = 0; y < h; y++) lines.push([...mask.subarray(y * w, (y + 1) * w)].map((v) => (v ? '#' : '.')).join(''));
  return lines.join('\n');
};

/* ------------------------------------------------------------- clumps */
{
  const { mask, w, h } = grid([
    '##..#',
    '#...#',
    '..#..',
    '.....',
    '#...#',
  ]);
  const { labels, count } = clumps(mask, w, h);
  assert.equal(count, 5, 'diagonal touches join, gaps split');
  assert.equal(labels[0], labels[w + 0], 'the top-left pair is one clump');
  assert.notEqual(labels[0], labels[4]);
}

/* -------------------------------------------------------- clearCanopy */
{
  const lawn = grid(['###', '###']).mask;
  const canopy = grid(['.#.', '.#.']).mask;
  assert.deepEqual([...clearCanopy(lawn, canopy)], [1, 0, 1, 1, 0, 1]);
}

/* -------------------------------------------------------------- reach */
{
  /* Lawn on the left, a strip of canopy, then a driveway, then more canopy:
     the reach crosses the first strip only as far as `cells`, and never the
     driveway to the second. */
  const w = 12, h = 3;
  const lawn = grid(['###.........', '###.........', '###.........']).mask;
  const canopy = grid(['...####.####', '...####.####', '...####.####']).mask;
  const r2 = reach(lawn, canopy, w, h, 2);
  assert.equal(show(r2, w, h).split('\n')[1], '#####.......', '2 cells into the canopy');
  const r9 = reach(lawn, canopy, w, h, 9);
  assert.equal(show(r9, w, h).split('\n')[1], '#######.....', 'stops at the driveway however far the reach');
  const r0 = reach(lawn, canopy, w, h, 0);
  assert.deepEqual([...r0], [...lawn]);
  /* Stage 1 lawn UNDER canopy is not a starting point: it is cleared first. */
  const under = grid(['...#........', '............', '............']).mask;
  const rr = reach(clearCanopy(under, canopy), canopy, w, h, 3);
  assert.equal(rr.reduce((a, b) => a + b, 0), 0, 'no visible lawn, nothing reached');
}

/* ------------------------------------------------------------- bridge */
{
  /* A tree in the middle of a lawn: rim all grass, filled. A tree at the
     edge of a lawn against a driveway: half grass, not filled at 0.5, filled
     at 0.4. A tree in the woods: no grass on the rim, never filled. */
  const w = 9, h = 9;
  const lawn = grid([
    '#########',
    '#########',
    '#########',
    '#########',
    '#########',
    '.........',
    '.........',
    '.........',
    '.........',
  ]).mask;
  const canopy = grid([
    '.........',
    '.##......',
    '.##......',
    '.........',
    '....##...',
    '....##...',
    '.........',
    '.......##',
    '.......##',
  ]).mask;
  const b = bridge(lawn, canopy, w, h, { minRing: 0.5 });
  assert.equal(b.clumps, 3);
  assert.equal(b.filled, 1, 'only the tree in the middle of the lawn');
  assert.equal(b.mask[w + 1], 1);
  /* (bridge does not clear: row 4 of the edge tree was lawn in the input and
     stays so; row 5 is what the rule decided, and it decided no.) */
  assert.equal(b.mask[5 * w + 4], 0, 'the edge tree is half grass, not more than half');
  assert.equal(b.mask[7 * w + 7], 0, 'the woods tree has no grass round it');
  const b4 = bridge(lawn, canopy, w, h, { minRing: 0.4 });
  assert.equal(b4.filled, 2, 'a looser rule takes the edge tree too');
  assert.equal(b4.mask[7 * w + 7], 0, 'and still never the woods');
  /* The input is not modified. */
  assert.equal(lawn[w + 1], 1);
}

/* ------------------------------------------------------------- stage3 */
{
  const w = 10, h = 6;
  /* Visible lawn left, canopy strip in the middle running off into woods
     on the right, and stage 1 said lawn under a bit of the woods (noise). */
  const lawn = grid([
    '####......',
    '####......',
    '####.....#',
    '####......',
    '####......',
    '####......',
  ]).mask;
  const canopy = grid([
    '....######',
    '....######',
    '....######',
    '....######',
    '....######',
    '....######',
  ]).mask;
  const s = stage3(lawn, canopy, w, h, { mpp: 0.15, reachM: 0.3, minRing: 0.5 });
  assert.equal(s.cells, 2);
  assert.equal(show(s.mask, w, h).split('\n')[2], '######....',
    'two cells of reach, the noise under the woods cleared, the woods not bridged');
  /* A rule set of nothing gives back the cleared mask. */
  const none = stage3(lawn, canopy, w, h, { mpp: 0.15, reachM: 0, minRing: 1 });
  assert.deepEqual([...none.mask], [...clearCanopy(lawn, canopy)]);
}

console.log('stage 3: ok');
