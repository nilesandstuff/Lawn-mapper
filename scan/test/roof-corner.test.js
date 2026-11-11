// scan/lib/roof-corner.js: which roof corners, and marking one by two aims. node scan/test/roof-corner.test.js
import assert from 'node:assert/strict';
import { roofCorners, newSight, sight, crossing, lookOf, HOLD_MS } from '../lib/roof-corner.js';
import { lidarMarks } from '../lib/lidar-marks.js';
import { referenceFit, place } from '../lib/walkref.js';

const rng = (seed) => { let sd = seed; return () => { sd = (sd + 0x6d2b79f5) | 0; let t = Math.imul(sd ^ (sd >>> 15), 1 | sd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// WHICH CORNERS: a house 12 x 10 m with eaves 3 m up, and a tall barn (eaves 6 m), lawn round the house only
{
  const r = rng(4), P = [];
  for (let i = 0; i < 60 * 40 * 4; i++) {
    const e = r() * 60, n = r() * 40;
    const house = e >= 10 && e <= 22 && n >= 10 && n <= 20, barn = e >= 40 && e <= 50 && n >= 10 && n <= 20;
    P.push({ e, n, h: house ? 5.5 - 2.5 * Math.abs(n - 15) / 5 + (r() - 0.5) * 0.05 : barn ? 9 - 3 * Math.abs(n - 15) / 5 : (r() - 0.5) * 0.05, kind: house || barn ? 1 : 0 });
  }
  const pts = { n: P.length, e: (i) => P[i].e, nn: (i) => P[i].n, hag: (i) => P[i].h, bright: () => 0, kind: (i) => P[i].kind };
  const M = lidarMarks([0, 0, 60, 40], pts);
  const lawn = [[[2, 2], [30, 2], [30, 22], [22.5, 22], [22.5, 8], [9.5, 8], [9.5, 22], [2, 22]]]; // a U round the house's south
  const all = roofCorners(M, pts, []), near = roofCorners(M, pts, lawn);
  const at = (c, w) => Math.hypot(c.at[0] - w[0], c.at[1] - w[1]);
  console.log(`corners offered: ${all.length} with no lawn, ${near.length} by the lawn: ${near.map((c) => `${c.label} (eave ${c.eaveM} m, ${c.lawnM} m from the lawn${c.sure ? ', sure' : ''})`).join('; ')}`);
  assert.equal(all.length, 4, 'the house\'s four corners; none of the barn\'s (its eaves are 6 m up)');
  for (const w of [[10, 10], [22, 10], [22, 20], [10, 20]]) assert.ok(all.some((c) => at(c, w) < 0.4), `the corner at ${w} within 0.4 m`);
  assert.ok(all.every((c) => Math.abs(c.eaveM - 3) < 0.6), `eaves about 3 m (${all.map((c) => c.eaveM)})`);
  assert.ok(all.find((c) => at(c, [22, 20]) < 0.4).label === 'north-east corner' && all.find((c) => at(c, [10, 10]) < 0.4).label === 'south-west corner', 'named by where they are on the house');
  assert.ok(near.length >= 2 && near.length <= 4 && near.every((c) => c.lawnM <= 4.57), 'only those within 15 ft of a lawn edge');
}

// MARKING ONE: a corner at (5, 3, -8) in the session (3 m over ground at y = 0); the phone 1.4 m up
const C = [5, 3, -8];
const quatTo = (from, to, wob = [0, 0]) => {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], yaw = Math.atan2(-d[0], -d[2]) + wob[0], pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) + wob[1];
  const qy = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], qx = [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)];
  const [ax, ay, az, aw] = qy, [bx, by, bz, bw] = qx;
  return { x: aw * bx + ax * bw + ay * bz - az * by, y: aw * by - ax * bz + ay * bw + az * bx, z: aw * bz + ax * by - ay * bx + az * bw, w: aw * bw - ax * bx - ay * by - az * bz };
};
{
  const l = lookOf(quatTo([0, 1.4, 0], C)), d = [C[0], C[1] - 1.4, C[2]], n = Math.hypot(...d);
  assert.ok(Math.hypot(l[0] - d[0] / n, l[1] - d[1] / n, l[2] - d[2] / n) < 1e-9, 'a camera turned toward a point looks at it');
  const X = crossing([{ o: [0, 0, 0], d: [1, 0, 0] }, { o: [3, -2, 0], d: [0, 1, 0] }]);
  assert.ok(Math.hypot(X.p[0] - 3, X.p[1], X.p[2]) < 1e-9 && Math.max(...X.miss) < 1e-9, 'two lines that cross, cross where they cross');
}
/** A walk: stand at each place for `ms`, aiming at `aim` with a hand's tremor; between places, walk there in 2 s. */
function run(S, places, { tremorDeg = 0.15, seed = 1 } = {}) {
  const r = rng(seed); let t = 0; const said = [];
  const frame = (pos, aim) => { const tw = (tremorDeg * Math.PI) / 180; sight(S, { t, pos: { x: pos[0], y: pos[1], z: pos[2] }, quat: quatTo(pos, aim, [(r() - 0.5) * tw, (r() - 0.5) * tw]), tracking: 'normal' }); if (said[said.length - 1] !== S.say) said.push(S.say); t += 33; };
  let at = places[0].pos;
  for (const p of places) {
    for (let k = 1; k <= 60 && !S.done; k++) frame(at.map((v, i) => v + (p.pos[i] - v) * k / 60), [C[0], 0.5, C[2]]); // walking: the phone down at the wall's foot
    at = p.pos;
    for (let ms = 0; ms < p.ms && !S.done; ms += 33) frame(at, p.aim);
  }
  return { said, t };
}
{
  // the plain case: aim, step 5 m round, aim
  const S = newSight({ eaveM: 3, groundY: 0 });
  const { said, t } = run(S, [{ pos: [0, 1.4, 0], aim: C, ms: 1500 }, { pos: [5.5, 1.4, -1], aim: C, ms: 1500 }]);
  console.log(`said: ${said.join(' | ')}`);
  assert.ok(S.done?.ok, `marked (${S.done?.why || ''})`);
  const off = Math.hypot(S.done.position.x - C[0], S.done.position.z - C[2]);
  console.log(`marked ${(off * 39.37).toFixed(1)} in from the corner on the level, from ${S.done.sights} aims ${S.done.turnDeg.toFixed(0)} degrees apart, the lines ${(S.done.missM * 39.37).toFixed(1)} in apart, in ${(t / 1000).toFixed(1)} s`);
  assert.ok(off < 0.08, 'within 3 in of the corner');
  assert.ok(said.some((s) => /sideways/.test(s)) && said[said.length - 1] === 'Marked');
  assert.ok(t < 2 * 2000 + 2 * (HOLD_MS + 800), 'no waiting beyond the two holds');
}
{
  // walking about with the phone low marks nothing; nor does a hold too short
  const S = newSight({ eaveM: 3, groundY: 0 });
  run(S, [{ pos: [0, 1.4, 0], aim: [3, 0, -3], ms: 3000 }, { pos: [1, 1.4, 0], aim: C, ms: 400 }]);
  assert.equal(S.rays.length, 0, 'nothing taken');
}
{
  // the second aim on the WRONG corner (the next one along, 4 m off): refused, a third aim asked for, then marked
  const S = newSight({ eaveM: 3, groundY: 0 }), W = [C[0] + 4, 3, C[2]];
  const { said } = run(S, [{ pos: [0, 1.4, 0], aim: C, ms: 1500 }, { pos: [5.5, 1.4, -1], aim: W, ms: 1500 }, { pos: [8.5, 1.4, -4], aim: C, ms: 1500 }, { pos: [1, 1.4, -3], aim: C, ms: 1500 }]);
  console.log(`a wrong aim: ${said.join(' | ')}`);
  assert.ok(said.some((s) => /Once more/.test(s)), 'it asks again');
  if (S.done?.ok) assert.ok(Math.hypot(S.done.position.x - C[0], S.done.position.z - C[2]) < 0.1, 'and what it marks is the right corner');
  else console.log(`  (not marked by the end: ${S.done?.why || S.say})`); // still asking, or gave up saying why: never a wrong mark
}
{
  // aiming at the gutter of a roof 6 m up when this corner's eave is 3 m: never marked
  const S = newSight({ eaveM: 3, groundY: 0 }), H = [5, 6, -8];
  run(S, [{ pos: [0, 1.4, 0], aim: H, ms: 1500 }, { pos: [5.5, 1.4, -1], aim: H, ms: 1500 }, { pos: [9, 1.4, -5], aim: H, ms: 1500 }, { pos: [2, 1.4, -2], aim: H, ms: 1500 }, { pos: [7, 1.4, -1], aim: H, ms: 1500 }]);
  assert.ok(!S.done?.ok, 'a corner at the wrong height is not this corner');
}
{
  // a shakier hand (0.5 degrees): still marked, a little less exactly
  const offs = [];
  for (let seed = 1; seed <= 6; seed++) { const S = newSight({ eaveM: 3, groundY: 0 }); run(S, [{ pos: [0, 1.4, 0], aim: C, ms: 2500 }, { pos: [5.5, 1.4, -1], aim: C, ms: 2500 }, { pos: [8, 1.4, -4], aim: C, ms: 2500 }], { tremorDeg: 0.5, seed }); assert.ok(S.done?.ok, `seed ${seed}: marked (${S.done?.why || S.say})`); offs.push(Math.hypot(S.done.position.x - C[0], S.done.position.z - C[2])); }
  console.log(`a shakier hand, 6 tries: ${offs.map((v) => (v * 39.37).toFixed(1)).join(', ')} in off`);
  assert.ok(Math.max(...offs) < 0.12);
}
// MAY A WALK BE THE REFERENCE? (walkref.js referenceFit)
{
  const T0 = { theta: 0.6, tx: 12, ty: -7 }, inv = (m) => { const c = Math.cos(-T0.theta), s2 = Math.sin(-T0.theta), x = m[0] - T0.tx, y = m[1] - T0.ty; return [c * x - s2 * y, s2 * x + c * y]; };
  const mk = (id, map, by, off = [0, 0]) => { const a = inv(map); return { id, map, ar: [a[0] + off[0], a[1] + off[1]], by }; };
  const two = referenceFit([mk('a', [0, 0], 'ROOF'), mk('b', [12, 5], 'ROOF')]);
  assert.ok(two.ok && two.roof && two.n === 2, 'two roof corners the right distance apart: kept');
  const p = place(two.T, ...inv([6, 2])); assert.ok(Math.hypot(p[0] - 6, p[1] - 2) < 1e-6, 'and they place the walk');
  assert.ok(!referenceFit([mk('a', [0, 0], 'ROOF'), mk('b', [12, 5], 'ROOF', [0.5, 0])]).ok, 'two corners marked 0.5 m too far apart: not kept');
  assert.ok(!referenceFit([mk('a', [0, 0], 'ROOF'), mk('b', [1.5, 1], 'ROOF')]).ok, 'two corners 6 ft apart: too close to turn by');
  assert.ok(!referenceFit([mk('a', [0, 0], 'ROOF')]).ok && !referenceFit([mk('a', [0, 0], 'DEPTH'), mk('b', [9, 3], 'DEPTH')]).ok, 'one corner, or two ground marks: not kept');
  assert.ok(referenceFit([mk('a', [0, 0], 'DEPTH'), mk('b', [9, 3], 'DEPTH'), mk('c', [2, 11], 'DEPTH')]).ok, 'three marks that agree: kept');
  assert.ok(!referenceFit([mk('a', [0, 0], 'ROOF'), mk('b', [9, 3], 'ROOF'), mk('c', [2, 11], 'ROOF', [1, 0])]).ok, 'three corners, one a metre out: not kept');
  // a corner marked again: the later mark counts; ground marks are left out when two roof corners are there
  assert.ok(referenceFit([mk('a', [0, 0], 'ROOF', [2, 0]), mk('a', [0, 0], 'ROOF'), mk('b', [12, 5], 'ROOF'), mk('c', [4, 4], 'DEPTH', [3, 3])]).ok, 'the later mark of a corner, and no ground marks');
}
// THE TIERS: with the original rules giving fewer than three, the looser distances' corners follow as tier 2
{
  const r = rng(8), P = [];
  for (let i = 0; i < 40 * 40 * 4; i++) { const e = r() * 40, n = r() * 40, house = e >= 10 && e <= 24 && n >= 12 && n <= 24; P.push({ e, n, h: house ? 6.5 - 1.6 * Math.abs(n - 18) / 6 + (r() - 0.5) * 0.05 : (r() - 0.5) * 0.05, kind: house ? 1 : 0 }); }
  const pts = { n: P.length, e: (i) => P[i].e, nn: (i) => P[i].n, hag: (i) => P[i].h, bright: () => 0, kind: (i) => P[i].kind };
  const C = roofCorners(lidarMarks([0, 0, 40, 40], pts), pts, []);
  console.log(`a house with eaves 16 ft up: ${C.length} corners, tiers ${C.map((c) => c.tier).join(', ')}`);
  assert.ok(C.length >= 3 && C.every((c) => c.tier === 2), 'none under 15 ft, so the 18 ft tier is offered');
}
console.log('roof-corner: ok');
