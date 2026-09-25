/**
 * The geometry under the trees does what the plan says and nothing else.
 *
 *   node tools/stage3.test.js
 */

import assert from 'node:assert/strict';
import { clumps, clearCanopy, reach, enclose, span, woods, bridge, stage3 } from './stage3.js';

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

/* ------------------------------------------------------------ enclose */
{
  /* THE TRADE H30 MEASURED. Lawn on the left against a straight wood edge,
     and a tree standing in the lawn. Reach fills both alike; a cell inside
     the wood edge has lawn in three of eight directions at most, the tree's
     cells have it all round. */
  const w = 12, h = 7;
  const lawn = grid([
    '########....',
    '########....',
    '########....',
    '########....',
    '########....',
    '########....',
    '########....',
  ]).mask;
  const canopy = grid([
    '........####',
    '........####',
    '..##....####',
    '..##....####',
    '........####',
    '........####',
    '........####',
  ]).mask;
  const cleared = clearCanopy(lawn, canopy);
  const reached = reach(cleared, canopy, w, h, 2);
  assert.equal(show(reached, w, h).split('\n')[3], '##########..', 'reach alone takes two cells of the woods');
  assert.equal(reached[3 * w + 2], 1, 'and the tree');

  const four = enclose(cleared, canopy, reached, w, h, 2, 4);
  assert.equal(show(four, w, h).split('\n')[3], '########....',
    'four sides: the wood edge is dropped (three directions at most), the tree stays');
  assert.equal(show(four, w, h).split('\n')[0], '########....', 'nothing under the woods anywhere');
  const eight = enclose(cleared, canopy, reached, w, h, 2, 8);
  for (const p of [2 * w + 2, 2 * w + 3, 3 * w + 2, 3 * w + 3]) {
    assert.equal(four[p], 1, `tree cell ${p} has lawn on four sides and stays`);
    assert.equal(eight[p], 1, `tree cell ${p} has lawn on all eight sides`);
  }
  for (let p = 0; p < w * h; p++) if (cleared[p]) assert.equal(four[p], 1, 'visible ground never changes');
  /* sides 0 is the reach H30 measured, unchanged. */
  assert.deepEqual([...enclose(cleared, canopy, reached, w, h, 2, 0)], [...reached]);
}

/* --------------------------------------------------------------- span */
{
  /* THE OWNER'S RULE: lawn under canopy joins the lawn that can be seen.
     Left to right: a lawn, a row of trees, more lawn, then a wood edge
     running off the frame. And a tree standing in the lawn. */
  const w = 16, h = 7;
  const lawn = grid([
    '####..####......',
    '####..####......',
    '####..####......',
    '####..####......',
    '####..####......',
    '####..####......',
    '####..####......',
  ]).mask;
  const canopy = grid([
    '....##....######',
    '....##....######',
    '.##.##....######',
    '.##.##....######',
    '....##....######',
    '....##....######',
    '....##....######',
  ]).mask;
  const cleared = clearCanopy(lawn, canopy);
  const s = span(cleared, canopy, w, h, 3);
  assert.equal(show(s, w, h).split('\n')[0], '##########......',
    'the row of trees between two lawns is filled; the wood edge is not');
  assert.equal(show(s, w, h).split('\n')[3], '##########......',
    'and the tree in the lawn is filled (lawn on both sides of it)');
  /* Too far apart for the span: nothing. */
  const s1 = span(cleared, canopy, w, h, 1);
  assert.equal(show(s1, w, h).split('\n')[0], '####..####......',
    'a gap wider than twice the span stays open (the tree row is 2 wide, 1 each way is not enough)');
  /* A driveway between the lawn and the tree stops the ray. */
  const drive = grid([
    '###...####......',
    '###...####......',
    '###...####......',
    '###...####......',
    '###...####......',
    '###...####......',
    '###...####......',
  ]).mask;
  const sd = span(clearCanopy(drive, canopy), canopy, w, h, 3);
  assert.equal(show(sd, w, h).split('\n')[0], '###...####......',
    'the ray leaves the canopy onto a driveway and does not count');
  /* Visible ground never changes; span 0 is a no-op. */
  for (let p = 0; p < w * h; p++) if (cleared[p]) assert.equal(s[p], 1);
  assert.deepEqual([...span(cleared, canopy, w, h, 0)], [...cleared]);

  /* Through stage3: span joins, a small reach goes a little beyond, and the
     wood edge still gets only that little. */
  const st = stage3(lawn, canopy, w, h, { mpp: 1, spanM: 3, reachM: 1, minRing: 1 });
  assert.equal(show(st.mask, w, h).split('\n')[0], '###########.....',
    'span filled the row, one cell of reach went beyond into the woods and no further');
  const none = stage3(lawn, canopy, w, h, { mpp: 1, spanM: 0, reachM: 0, minRing: 1 });
  assert.deepEqual([...none.mask], [...cleared], 'spanM 0 is the old stage 3');
}

/* -------------------------------------------------------------- woods */
{
  /* H34: the same lawn-and-tree-row grid as span, but the wood edge on the
     right is 9 m tall and the tree row 4 m. With the woods rule at 6 m the
     tall clump is woods: span still joins the row, and reach into the wood
     edge is stopped where before it went a cell in. */
  const w = 16, h = 7;
  const lawn = grid([
    '####..####......',
    '####..####......',
    '####..####......',
    '####..####......',
    '####..####......',
    '####..####......',
    '####..####......',
  ]).mask;
  const canopy = grid([
    '....##....######',
    '....##....######',
    '....##....######',
    '....##....######',
    '....##....######',
    '....##....######',
    '....##....######',
  ]).mask;
  const height = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const x = p % w;
    if (canopy[p]) height[p] = x >= 10 ? 9 : 4;
  }
  const tall = woods(canopy, height, w, h, 6);
  assert.equal(show(tall, w, h).split('\n')[0], '..........######', 'the tall clump is woods, the short row is not');
  assert.equal(woods(canopy, height, w, h, 12).reduce((a, b) => a + b, 0), 0, 'nothing is that tall');
  assert.equal(woods(canopy, null, w, h, 6).reduce((a, b) => a + b, 0), 0, 'no height, no woods');
  /* Tall AND big: the wood edge is 42 cells; a size floor above that makes
     it a tree, not a wood, however tall. */
  assert.equal(woods(canopy, height, w, h, 6, 42).reduce((a, b) => a + b, 0), 42, 'at the floor it is still woods');
  assert.equal(woods(canopy, height, w, h, 6, 43).reduce((a, b) => a + b, 0), 0, 'one cell over the floor and it is a tree');
  const sized = stage3(lawn, canopy, w, h, { mpp: 1, spanM: 3, reachM: 1, minRing: 1, height, tallM: 6, woodsM2: 100 });
  assert.equal(show(sized.mask, w, h).split('\n')[0], '###########.....', 'a 42 m² clump is under a 100 m² floor, so the reach enters it');

  const with_ = stage3(lawn, canopy, w, h, { mpp: 1, spanM: 3, reachM: 1, minRing: 1, height, tallM: 6 });
  assert.equal(show(with_.mask, w, h).split('\n')[0], '##########......',
    'the row is joined, and the reach does not enter the woods');
  const without = stage3(lawn, canopy, w, h, { mpp: 1, spanM: 3, reachM: 1, minRing: 1, height, tallM: 0 });
  assert.equal(show(without.mask, w, h).split('\n')[0], '###########.....', 'off, the reach goes one cell into the woods as before');
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
