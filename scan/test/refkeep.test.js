// Keep what is good of a walk, and build on it (lib/refkeep.js).
import assert from 'node:assert/strict';
import { goodPart, partOf, mergeRef, agreement, AGREE_M, allowedOf } from '../lib/refkeep.js';

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

// THE SHAPE, AND WHERE IT IS, KEPT APART (2026-11-16)
{ const { compose, invert, placementOf, updateRef } = await import('../lib/refkeep.js');
  const { place, encodeRef, decodeRef } = await import('../lib/walkref.js');
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
  const A = { theta: 0.4, tx: 3, ty: -2 }, B = { theta: -1.1, tx: 0.5, ty: 7 };
  { const p = place(compose(A, B), 2, 5), q = place(A, ...place(B, 2, 5)); assert.ok(near(p[0], q[0]) && near(p[1], q[1]), 'compose: B, then A'); }
  { const p = place(compose(invert(A), A), 2, 5); assert.ok(near(p[0], 2) && near(p[1], 5), 'invert undoes'); }
  { const P = placementOf([{ theta: 0.1, tx: 1, ty: 0, w: 1 }, { theta: 0.3, tx: 3, ty: 0, w: 1 }]); assert.ok(near(P.theta, 0.2) && near(P.tx, 2), 'the middle of two readings'); }

  // a yard: a grid of standing points and ground, as a first walk saw it (its own frame turned and shifted)
  const yard = []; for (let x = 0; x < 12; x += 0.5) for (let y = 0; y < 8; y += 0.5) yard.push([x, y]);
  const W1 = { theta: 0.3, tx: 5, ty: 1 };                       // walk 1's frame -> the map (true)
  const inWalk = (W, pts) => pts.map(([e, n]) => { const q = place(invert(W), e, n); return [q[0], q[1], 1]; });
  const part1 = { stand: inWalk(W1, yard), ground: inWalk(W1, yard).map((p) => [p[0], p[1], 0]) };
  const first = updateRef(null, part1, { C: W1, at: 1 });
  assert.equal(first.how, 'made'); assert.equal(first.ref.seen.length, 1);
  assert.equal(updateRef(null, part1, {}).ref, null, 'no reference and no corners: nothing to make one from');
  // it survives being written and read
  const back = decodeRef(encodeRef(first.ref));
  assert.equal(back.stand.length, first.ref.stand.length); assert.deepEqual(back.P, first.ref.P); assert.equal(back.seen.length, 1); assert.ok(back.pivot);

  // walk 2: matched to the shape exactly (F), but its corners put it 0.6 m east of where walk 1's did
  const W2 = { theta: -0.8, tx: -2, ty: 4 };
  const part2 = { stand: inWalk(W2, yard), ground: [] };
  const F = W2;                                                   // the shape frame is the map frame of walk 1, so the true match is W2
  const C = { theta: W2.theta, tx: W2.tx + 0.6, ty: W2.ty };
  const u = updateRef(back, part2, { C, F, at: 2 });
  assert.equal(u.how, 'shape and place');
  // THE SHAPE DID NOT MOVE: its points are where they were (walk 2 saw the same things in the same places)
  { const a = [...back.stand].slice(0, 30), b = [...u.ref.stand]; assert.ok(a.every((v, i) => i % 3 === 2 || b.some((x) => Math.abs(x - v) < 0.26)), 'the shape is the shape'); }
  // WHERE IT IS moved half way: two readings, 0.6 m apart
  assert.ok(near(u.movedM, 0.3, 1e-3), `the place moved to the middle of the two readings (${u.movedM})`);
  assert.equal(u.ref.seen.length, 2); assert.equal(u.ref.walks, 2);
  // walk 3: matched to the shape, no corners: the shape may gain, the place does not move
  const s = updateRef(u.ref, part2, { F, at: 3 });
  assert.equal(s.how, 'shape only'); assert.deepEqual(s.ref.P, u.ref.P); assert.equal(s.ref.seen.length, 2);
  // walk 4: corners, no match: put on the shape through its place, filling only what the shape lacked
  const far = { stand: inWalk(W2, [[40, 40], [40.5, 40]]), ground: [] };
  const f = updateRef(u.ref, far, { C: W2, at: 4 });
  assert.equal(f.how, 'filled in through its place'); assert.equal(f.replaced, 0); assert.equal(f.added, 2); assert.deepEqual(f.ref.P, u.ref.P);
  assert.equal(updateRef(u.ref, far, {}).ref, null);
  // a version 1 reference (points already on the map): reads as "no turn, no shift", and can be built on
  const v1 = new Uint8Array(24 + 12); { const dv = new DataView(v1.buffer); dv.setUint32(0, 0x46455257, true); dv.setUint32(4, 1, true); dv.setUint32(8, 1, true); new Float32Array(v1.buffer, 24).set([1, 2, 3]); }
  const d1 = decodeRef(v1); assert.deepEqual([...d1.stand], [1, 2, 3]); assert.deepEqual(d1.P, { theta: 0, tx: 0, ty: 0 }); }
console.log('refkeep (shape and place): ok');

// PLANNING IN THE OUTLINE'S ERROR (the owner, 2026-11-16): a corner 0.75 m from where the outline puts it, the size
// of an outline's own error on a sparse flight. Held to a flat 1.5 ft it is thrown out as a bad aim; allowed its own
// corner's uncertainty (0.5 m: 0.7 x the owner's 0.72 m return spacing) it is kept. A corner 3 m off is out either way.
{ const T = (m, tol) => ({ ...m, tol });
  // (corners under 15 m apart: no scale is fitted, so this is the corners' own allowance alone)
  const flat = [M('a', [0, 0], 5), M('b', [11, 0], 20), M('c', [11, 8], 40, 0.75, 0)];
  const g0 = goodPart(flat);
  assert.ok(g0.ok && !g0.whole && g0.left.length === 1, `with no uncertainty the three cannot all agree, one is left out: ${JSON.stringify(g0.left)}`);
  const g1 = goodPart(flat.map((m) => T(m, 0.5)));
  assert.ok(g1.ok && g1.whole && g1.left.length === 0, `allowed its corner's uncertainty it is kept: ${JSON.stringify(g1.left)} worst ${g1.worstM?.toFixed(2)}`);
  const far = [M('a', [0, 0], 5), M('b', [11, 0], 20), M('c', [11, 8], 40, 3, 0)].map((m) => T(m, 0.5));
  const g2 = goodPart(far);
  assert.ok(g2.ok && !g2.whole && g2.left.length === 1 && g2.left[0] === 'c', `a corner 3 m off is still out: ${JSON.stringify(g2.left)}`);
  assert.equal(allowedOf({}), AGREE_M, 'no uncertainty known: 1.5 ft, as before');
  assert.equal(allowedOf({ tol: 0.1 }), AGREE_M, 'never less than 1.5 ft');
  console.log(`refkeep (each corner its own uncertainty): ok (0.75 m off: one left out at a flat 1.5 ft, all kept at ${allowedOf({ tol: 0.5 }).toFixed(2)} m)`);
}

// THE PHONE'S OWN SCALE (the owner's walk, 2026-11-16: three roof corners 21, 38 and 52 m apart, every distance 2-4%
// SHORTER as walked than on the lidar outline). Fitted, within 7%, with three or more corners spread 15 m or more: the
// three agree, with no allowance at all. Held to turn-and-shift, as before, they did not.
{ const { fitRigid, fitSimilar } = await import('../lib/walkref.js');
  const k = 0.97, th2 = 0.4, c2 = Math.cos(th2), s2 = Math.sin(th2);
  const ar = ([e, n]) => [k * (c2 * e + s2 * n) + 3, k * (-s2 * e + c2 * n) - 2];      // the map, turned, shifted and 3% short
  const S = (id, map, odo) => ({ id, map, ar: ar(map), odo, by: 'ROOF' });
  const marks = [S('R1', [0, 0], 5), S('R2', [21, 3], 60), S('R3', [-10, 50], 170)];
  const g = goodPart(marks);
  assert.ok(g.ok && g.whole && g.left.length === 0, `3% short, all three agree: ${JSON.stringify(g.left)} ${g.why || ''}`);
  assert.ok(Math.abs(g.T.s - 1 / k) < 0.005, `the phone's scale found: ${g.T.s}`);
  const rigid = fitRigid(marks.map((m) => m.ar), marks.map((m) => m.map));
  const worstRigid = Math.max(...marks.map((m) => { const c = Math.cos(rigid.theta), s = Math.sin(rigid.theta); const p = [c * m.ar[0] - s * m.ar[1] + rigid.tx, s * m.ar[0] + c * m.ar[1] + rigid.ty]; return Math.hypot(p[0] - m.map[0], p[1] - m.map[1]); }));
  assert.ok(worstRigid > AGREE_M, `turn-and-shift alone leaves ${worstRigid.toFixed(2)} m: why they were thrown out`);
  // close together, no scale (noise); and never past 7%
  assert.equal(fitSimilar([[0, 0], [5, 0], [0, 5]], [[0, 0], [5.5, 0], [0, 5.5]]).s, 1, 'corners within 15 m: no scale');
  const far2 = fitSimilar([[0, 0], [50, 0], [0, 50]], [[0, 0], [60, 0], [0, 60]]);
  assert.ok(Math.abs(far2.s - 1.07) < 1e-9, `held at 7%: ${far2.s}`);
  console.log(`refkeep (the phone's own scale): ok (3% short: found ${((g.T.s - 1) * 100).toFixed(1)}%; turn-and-shift alone left ${(worstRigid * 3.281).toFixed(1)} ft)`);
}

// EVERY WALK IS KEPT (2026-11-16, the 1:55 pm walk): R1 at 4 m walked, R2 at 32 m 1.7 m farther than the map has
// it (the phone drifted), R1 sighted again at 45 m. Nothing is cut: the whole walk is placed, each part by the marks
// sighted nearest it, so a post seen beside R1 at the start and the same post seen at the end land together.
{ const { keepPlan, placeWalk } = await import('../lib/refkeep.js');
  const R = (id, map, ar, odo) => ({ id, map, ar, odo, by: 'ROOF' });
  const marks = [R('R1', [0, 0], [0, 0], 4), R('R2', [19.6, 0], [21.3, 0], 32), R('R1', [0, 0], [1.7, 0], 45)];
  const k = keepPlan(marks);
  assert.ok(k.ok && k.use.length === 3, 'every mark places the walk, the first R1 too');
  const { pts: [early, late] } = placeWalk([[2, 1, 0.5, 4], [3.7, 1, 0.5, 46]], k.use, k.C);   // the post, seen at 4 m and at 46 m
  assert.ok(Math.hypot(early[0] - 2, early[1] - 1) < 0.15, `seen at the start, placed by the first R1: ${early}`);
  assert.ok(Math.hypot(late[0] - 2, late[1] - 1) < 0.15, `seen at the end, placed by the fresh R1: ${late}`);
  // two corners that disagree and were never sighted again: kept all the same
  const two = keepPlan([R('R1', [0, 0], [0, 0], 4), R('R2', [19.6, 0], [21.3, 0], 32)]);
  assert.ok(two.ok && !two.agree, 'kept, though its two corners disagree');
  // a corner far off the others, never sighted again (a wrong aim): it places nothing
  const M3 = [R('a', [0, 0], [2.7, 0.3], 10), R('b', [10, 0], [10, 0], 30), R('c', [10, 8], [10, 8], 68)];
  const k3 = keepPlan(M3);
  assert.ok(k3.ok && k3.use.every((m) => m.id !== 'a'), 'the wrong aim places nothing');
  assert.equal(keepPlan([R('a', [0, 0], [0, 0], 4)]).ok, false, 'one corner cannot place a walk');
  // a tracking jump at 60 m: the stretch after it has no corners of its own, so it is left out, not placed 8 ft off
  const j = placeWalk([[2, 1, 0.5, 10], [5, 5, 0.5, 70], [1, 1, 0.5, 80], [9, 9, 0.5, NaN]], k.use, k.C, [60]);
  assert.equal(j.pts.length, 1); assert.equal(j.left, 3, 'after the jump, and one with no reading, left out');
  // marks on both sides of the jump: each stretch by its own
  const J2 = [R('a', [0, 0], [0, 0], 5), R('b', [10, 0], [10, 0], 20), R('a', [0, 0], [3, 0], 70), R('b', [10, 0], [13, 0], 80)];
  const jp = placeWalk([[1, 0, 0, 10], [4, 0, 0, 75]], J2, null, [60]).pts;
  assert.ok(Math.abs(jp[0][0] - 1) < 1e-6 && Math.abs(jp[1][0] - 1) < 1e-6, `each stretch placed by its own corners: ${jp}`);
  const { matchUsable } = await import('../lib/refkeep.js');
  assert.equal(matchUsable(two), false, 'a walk that drifted is not placed whole by the shape match');
  assert.equal(matchUsable(k3, [60]), false, 'nor one whose frame jumped');
  assert.equal(matchUsable(k3), true);
  console.log('refkeep (every walk kept): ok'); }

// ENOUGH CORNERS, BEFORE THE WALK (2026-11-16)
{ const { cornersShort } = await import('../lib/refkeep.js');
  const C = (x, y) => ({ roof: { eaveM: 3 }, map: [x, y] });
  assert.match(cornersShort([]), /No roof corner/);
  assert.match(cornersShort([C(0, 0), { kind: 'ref', map: [9, 9] }]), /Only one roof corner/, 'a ground point is not a roof corner');
  assert.match(cornersShort([C(0, 0), C(1, 1)]), /only 5 ft apart/);
  assert.equal(cornersShort([C(0, 0), C(19.6, 0)]), null);
  console.log('refkeep (enough corners before the walk): ok'); }
