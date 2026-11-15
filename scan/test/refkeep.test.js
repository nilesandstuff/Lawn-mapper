// Keep what is good of a walk, and build on it (lib/refkeep.js).
import assert from 'node:assert/strict';
import { goodPart, partOf, mergeRef, agreement, AGREE_M } from '../lib/refkeep.js';

// a walk turned 30 degrees and shifted from the map
const th = 0.5, c = Math.cos(th), s = Math.sin(th);
const toAr = ([e, n], dx = 0, dy = 0) => { const x = e - 12, y = n + 7; return [c * x + s * y + dx, -s * x + c * y + dy]; };
const M = (id, map, odo, dx = 0, dy = 0) => ({ id, map, ar: toAr(map, dx, dy), odo, by: 'ROOF' });

// every mark agrees: the whole walk
{ const g = goodPart([M('a', [0, 0], 5), M('b', [10, 0], 20), M('c', [10, 8], 40)]);
  assert.ok(g.ok && g.n === 3 && g.whole && g.left.length === 0, 'all three');
  assert.ok(g.worstM < 0.01);
  assert.deepEqual([g.lo, g.hi], [-Infinity, Infinity]); }

// THE OWNER'S WALK: the phone's tracking jumped 2.7 m after the first corner, so the first disagrees with the two after
{ const marks = [M('R1', [0, 0], 10), M('R2', [10, 0], 30, 2.7, 0), M('R3', [10, 8], 55, 2.7, 0)];
  assert.ok(agreement(marks).worst > 1, 'the three together are far out');
  const g = goodPart(marks, [22]);
  assert.ok(g.ok && !g.whole, 'a part is kept');
  assert.deepEqual(g.ids, ['R2', 'R3'], 'the two that agree');
  assert.deepEqual(g.left, ['R1']);
  assert.equal(g.lo, 22, 'from the jump'); assert.equal(g.hi, Infinity, 'to the walk\'s end');
  assert.ok(g.worstM <= AGREE_M);
  // with no jump recorded: from half way between the mark that disagrees and the part's first
  assert.equal(goodPart(marks).lo, 20);
  // a jump after the part's last mark ends it
  assert.equal(goodPart(marks, [22, 80]).hi, 80);
  // the points of that stretch only
  const pts = [[0, 0, 0, 5], [1, 1, 0, 25], [2, 2, 0, 60], [3, 3, 0]];
  assert.deepEqual(partOf(pts, g.lo, g.hi).map((p) => p[0]), [1, 2], 'walked after the jump; one with no reading left out');
  assert.equal(partOf(pts, -Infinity, Infinity).length, 4, 'the whole walk keeps them all'); }

// two groups the same size: the later one
{ const g = goodPart([M('a', [0, 0], 5), M('b', [10, 0], 15), M('c', [10, 8], 40, 3, 0), M('d', [0, 8], 60, 3, 0)]);
  assert.deepEqual(g.ids, ['c', 'd']); assert.equal(g.lo, (15 + 40) / 2); }

// nothing agrees; too close together; too few
assert.equal(goodPart([M('a', [0, 0], 5), M('b', [10, 0], 20, 4, 0)]).ok, false);
assert.equal(goodPart([M('a', [0, 0], 5), M('b', [2, 0], 20)]).ok, false, 'two corners 2 m apart cannot turn a walk');
assert.equal(goodPart([M('a', [0, 0], 5)]).ok, false);
// a point marked twice: its latest mark
{ const g = goodPart([M('a', [0, 0], 5, 5, 5), M('a', [0, 0], 50), M('b', [10, 0], 60)]); assert.ok(g.ok && g.n === 2); }

// merging: a part placed by roof corners corrects where it saw; the rest of the old reference stays
{ const F = (...p) => Float32Array.from(p.flat());
  const old = { stand: F([0.1, 0.1, 1], [5.1, 5.1, 1], [20.5, 20.5, 1]), ground: F([0.5, 0.5, 0], [30.5, 30.5, 0]), at: 1 };
  const add = { stand: F([0.3, 0.2, 1.4], [5.6, 5.6, 1]), ground: F([0.7, 0.4, 0.05]), at: 2 };
  const m = mergeRef(old, add, 'correct');
  assert.equal(m.replaced, 3, 'the old points in the squares the new part saw');
  assert.equal(m.kept, 2); assert.equal(m.added, 3);
  assert.equal(m.ref.stand.length / 3, 3, 'two new, one old far away');
  assert.ok([...m.ref.stand].includes(20.5) && ![...m.ref.stand].some((v) => Math.abs(v - 5.1) < 1e-6), 'the old point at 5.1 gave way');
  assert.equal(m.ref.at, 2);
  // a part placed only by the old reference's shape: fills what was empty, changes nothing that was there
  const add2 = { stand: F([0.3, 0.2, 1.4], [40.5, 40.5, 1]), ground: F([41.5, 40.5, 0]), at: 3 };
  const e = mergeRef(old, add2, 'extend');
  assert.equal(e.replaced, 0); assert.equal(e.added, 2, 'only the squares the reference had nothing in');
  assert.equal(e.ref.stand.length / 3, 4);
  // no earlier reference: the part is the reference
  assert.equal(mergeRef(null, add).added, 3); }
console.log('refkeep: ok');
