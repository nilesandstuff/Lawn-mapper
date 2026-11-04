// scan/lib/locate.js: the fix's bookkeeping. node scan/test/locate.test.js
import assert from 'node:assert/strict';
import { newLocate, mark, refFit, noteGround, addDepth, recent, nextAsk, answer, fitFor, fitSource, priorFor, mapOf, sessionOf, checkError, nearestNamed, disagreement, groundUnder, agreement, status, summaryOf, FIX_REACH, MIN_STAND, REF_TOL_M } from '../lib/locate.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const TH = (30 * Math.PI) / 180, SH = [5, 5];
const toAR = ([e, n]) => { const a = e - SH[0], b = n - SH[1]; return [Math.cos(-TH) * a - Math.sin(-TH) * b, Math.sin(-TH) * a + Math.cos(-TH) * b]; };
const hitAt = (map, y = 0) => { const [u, v] = toAR(map); return { position: { x: u, y, z: -v }, type: 'DEPTH', distance: 1.5 }; };

// references: two marks line the session up; a check point's error reads zero when all is true
{
  const L = newLocate();
  assert.equal(refFit(L, 0), null);
  mark(L, { id: 'r1', kind: 'ref', map: [0, 0] }, hitAt([0, 0]), 0);
  assert.equal(refFit(L, 0), null, 'one reference is not a fit');
  mark(L, { id: 'r2', kind: 'ref', map: [12, 4] }, hitAt([12, 4]), 10);
  const T = refFit(L, 10);
  near(T.theta, TH, 1e-9, 'the turn');
  assert.equal(fitSource(L, 10), 'refs');
  const m = mapOf(L, hitAt([7, -3]).position, 10);
  near(m[0], 7, 1e-9, 'a point on the map'); near(m[1], -3, 1e-9, 'n');
  const s = sessionOf(L, [7, -3], 10, 0);
  near(s.x, toAR([7, -3])[0], 1e-9, 'back to the session'); near(-s.z, toAR([7, -3])[1], 1e-9, 'v');
  const c = checkError(L, { id: 'c1', kind: 'check', map: [20, 20] }, hitAt([20, 20.3]), 12);
  near(c.errorM, 0.3, 1e-9, 'the check is 0.3 m off'); assert.equal(c.by, 'refs');
  assert.match(status(L, 10), /2 reference marks/);
}
// the depth cloud: ground and standing points kept by cell, old ones dropped, the recent ones offered
{
  const L = newLocate();
  assert.equal(addDepth(L, [{ x: 0, y: 0, z: -2 }], 0), 0, 'no ground level yet, nothing classed');
  noteGround(L, 0); noteGround(L, 0.1);
  near(L.groundY, 0.01, 1e-9, 'a slow average');
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push({ x: i * 0.05, y: 0.02, z: -3 }); // the ground, many in one cell
  for (let i = 0; i < 50; i++) pts.push({ x: 2 + i * 0.25, y: 1.2, z: -4 }); // a fence
  pts.push({ x: 1, y: 4, z: -5 }); // 4 m up: a high point, matched against the roof's edges
  pts.push({ x: 1, y: 14, z: -5 }); // 14 m up: nothing (above the highest roof edge we look for)
  const kept = addDepth(L, pts, 10);
  assert.equal(kept, 151);
  assert.equal(recent(L, 10).high.length, 1, 'one high point');
  const r = recent(L, 10);
  assert.equal(r.stand.length, 50, 'the fence, one point a cell');
  assert.ok(r.ground.length >= 20 && r.ground.length <= 30, `the ground thinned to cells: ${r.ground.length}`);
  assert.deepEqual(r.stand[0], [2, 4], 'level coordinates: u = x, v = -z');
  assert.equal(recent(L, 10 + 26).stand.length, 0, 'too old for a match');
  // nothing to start from: the ask says why
  assert.match(nextAsk(L, 10, 5000).why, /waiting for GPS/);
  L.gps = { at: [3, 3], phone: [0, 0], acc: 8, t: 5000 };
  const ask = nextAsk(L, 10, 6000);
  assert.equal(ask.prior.from, 'GPS'); assert.equal(ask.stand.length, 50); assert.equal(ask.id, 1);
  assert.match(nextAsk(L, 10, 6100).why, /running/);
  assert.equal(answer(L, { ok: false, why: 'only 12% of what the phone sees lands on the lidar' }, 1), null);
  assert.deepEqual(L.refused, { 'only #% of what the phone sees lands on the lidar': 1 });
  assert.match(nextAsk(L, 10, 6200).why, /too soon/);
  const ask2 = nextAsk(L, 10, 9000);
  assert.equal(answer(L, { ok: true, T: { theta: TH, tx: SH[0], ty: SH[1], s: 1 }, hits: 0.55, cost: 0.01 }, ask2.id), null, 'no references and barely over the bar: refused');
  assert.ok(Object.keys(L.refused).some((k) => /no references to check it against/.test(k)));
  const ask3 = nextAsk(L, 10, 12000);
  const f = answer(L, { ok: true, T: { theta: TH, tx: SH[0], ty: SH[1], s: 1 }, hits: 0.8, cost: 0.01 }, ask3.id);
  assert.ok(f && L.fixes.length === 1);
  assert.equal(fitSource(L, 10), 'fix');
  assert.equal(fitSource(L, 10 + FIX_REACH + 1), null, 'a fix stands for FIX_REACH metres');
  assert.equal(priorFor(L, 12).from, 'the last fix');
  assert.equal(priorFor(L, 12).searchM, 1.5);
  assert.match(status(L, 12), /lidar fix, 2 m ago, 80% landed/);
  const sum = summaryOf(L);
  assert.equal(sum.fixes, 1); assert.equal(sum.asks, 3); assert.deepEqual(sum.fixFrom, { GPS: 1 });
  assert.ok(!JSON.stringify(sum).includes('"at"'), 'no positions in the copy');
  // too few standing points: the ask explains
  const L2 = newLocate(); noteGround(L2, 0); L2.gps = { at: [0, 0], phone: [0, 0], acc: 5, t: 0 };
  addDepth(L2, [{ x: 1, y: 1.2, z: -1 }], 0);
  assert.match(nextAsk(L2, 0, 10000).why, new RegExp(`1 points .* \\(${MIN_STAND} wanted\\)`));
}
// the references are the judge: a fix that disagrees with them is refused; one that agrees is kept with its agreement
{
  const L = newLocate(); noteGround(L, 0);
  mark(L, { id: 'r1', kind: 'ref', map: [0, 0] }, hitAt([0, 0]), 0);
  mark(L, { id: 'r2', kind: 'ref', map: [12, 4] }, hitAt([12, 4]), 10);
  for (let i = 0; i < 50; i++) addDepth(L, [{ x: 2 + i * 0.25, y: 1.2, z: -4 }], 10);
  const me = hitAt([3, 3]).position;
  const ask = nextAsk(L, 10, 20000, me);
  assert.equal(ask.prior.from, 'the references');
  const wrong = { theta: TH, tx: SH[0] + 8, ty: SH[1] + 3, s: 1 };
  assert.equal(answer(L, { ok: true, T: wrong, hits: 0.7 }, ask.id), null, 'a fix 8.5 m from the references is refused');
  assert.ok(Object.keys(L.refused).some((k) => /disagrees with the references by # m/.test(k)), JSON.stringify(L.refused));
  assert.equal(fitSource(L, 10), 'refs', 'the references still rule');
  const ask2 = nextAsk(L, 10, 30000, me);
  const close = { theta: TH + 0.01, tx: SH[0] + 0.3, ty: SH[1] - 0.2, s: 1 };
  const f = answer(L, { ok: true, T: close, hits: 0.55 }, ask2.id);
  assert.ok(f, 'a fix that agrees is kept, whatever its score');
  assert.ok(f.agreeM < REF_TOL_M && f.agreeM > 0.3, `agreement kept: ${f.agreeM}`);
  const d = disagreement(wrong, close, [0, 0]);
  assert.ok(d.m > 8 && d.deg < 1, 'disagreement measured where the phone is');
  // a check reports both numbers
  const c = checkError(L, { id: 'c1', kind: 'check', map: [20, 20] }, hitAt([20, 20]), 11);
  assert.equal(c.by, 'fix');
  assert.ok(c.errorFixM > 0.05 && c.errorFixM < 1, `by the fix: ${c.errorFixM}`);
  near(c.errorRefsM, 0, 1e-9, 'by the references: true');
  // a pin's nearest named point
  const n = nearestNamed(L, hitAt([20.5, 20]).position, 11, [{ name: 'C1', map: [20, 20] }, { name: 'R1', map: [0, 0] }]);
  assert.equal(n.name, 'C1'); near(n.byRefsM, 0.5, 1e-9, 'by the references'); assert.ok(n.m < 1.5);
  assert.equal(nearestNamed(L, me, 11, []), null);
}
// the ground per column: a drop of 1.8 m is still ground; a wall's foot is standing even where the crosshair's ground is higher; the asks are logged
{
  const L = newLocate(); noteGround(L, 0);
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push({ x: 10 + (i % 6) * 0.3, y: -1.8, z: -(10 + Math.floor(i / 6) * 0.3) }); // the back yard, 1.8 m down
  pts.push({ x: 10.5, y: -0.6, z: -10.5 }); // a 1.2 m post standing on it
  pts.push({ x: 30, y: 1.3, z: -30 }); // a wall point far off, nothing lower seen near it
  addDepth(L, pts, 5);
  near(groundUnder(L, { x: 10.5, y: 0, z: -10.5 }), -1.8, 0.03, 'the column floor (to the histogram bin)');
  near(groundUnder(L, { x: 30, y: 0, z: -30 }), 0, 1e-9, 'a lone high point is not a floor: the crosshair ground');
  const r = recent(L, 5);
  assert.equal(r.stand.length, 2, 'the post and the wall point stand');
  assert.ok(r.ground.length >= 4, 'the back yard is ground');
  L.gps = { at: [0, 0], phone: [0, 0], acc: 5, t: 0 };
  for (let i = 0; i < 40; i++) addDepth(L, [{ x: i * 0.3, y: 1.2, z: -3 }], 5);
  const ask = nextAsk(L, 5, 10000, { x: 0, y: 1.5, z: 0 });
  answer(L, { ok: false, why: 'two places fit about as well', hits: 0.3, cost: 0.2, runnerUp: { cost: 0.21, apartM: 4, apartDeg: 90 } }, ask.id, 10400);
  const s = summaryOf(L);
  assert.equal(s.asksLog.length, 1);
  assert.equal(s.asksLog[0].ms, 400); assert.equal(s.asksLog[0].from, 'GPS'); assert.equal(s.asksLog[0].kept, false);
  assert.equal(s.asksLog[0].runnerUp.ratio, 1.05);
  assert.match(s.asksLog[0].why, /two places/);
  assert.ok(!JSON.stringify(s.asksLog).includes('"at"'), 'no positions');
  // agreement: with a fit, the standing points sorted by the lidar's distance grid
  mark(L, { id: 'r1', kind: 'ref', map: [0, 0] }, hitAt([0, 0]), 0);
  mark(L, { id: 'r2', kind: 'ref', map: [12, 4] }, hitAt([12, 4]), 10);
  const dist = { box: [-50, -50, 50, 50], cell: 1, W: 100, H: 100, data: new Float32Array(10000).fill(5) };
  const ag = agreement(L, 5, dist);
  assert.equal(ag.on.length, 0); assert.ok(ag.off.length >= 40);
  dist.data.fill(0.1);
  const ag2 = agreement(L, 5, dist);
  assert.ok(ag2.on.length >= 40 && ag2.off.length === 0, 'all on when everything is near a solid cell');
  assert.deepEqual(agreement(newLocate(), 0, dist), { on: [], off: [] });
}
// SCAN-H7: the floor is a low percentile, not the lowest noisy point; far standing points are not kept
{
  const L = newLocate(); noteGround(L, 0);
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push({ x: 0.5, y: (i % 10 === 0 ? -0.7 : 0) + (i % 3) * 0.02, z: -1.5 }); // the ground, with a noisy tail 0.7 m under it
  pts.push({ x: 0.5, y: 0.45, z: -1.6 }); // 45 cm up: a low thing (would have read 1.15 m over the lowest point)
  addDepth(L, pts, 0, { x: 0, y: 1.4, z: 0 });
  const col = L.cols.get('0,-2');
  assert.ok(col && col.y > -0.1 && col.y < 0.1, `the floor at the ground, not the tail: ${col && col.y}`);
  const r = recent(L, 0);
  assert.ok(r.ground.length >= 1 && r.stand.length === 1, `ground and one standing: ${r.ground.length} ${r.stand.length}`);
  // a standing point 5 m away is not kept; the same point 3 m away is
  const L2 = newLocate(); noteGround(L2, 0);
  addDepth(L2, [{ x: 0, y: 0, z: -5 }, { x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: -3 }, { x: 0.3, y: 1, z: -3 }], 0, { x: 0, y: 1.4, z: 0 });
  const r2 = recent(L2, 0);
  assert.equal(r2.stand.length, 1, `one standing point kept (the near one): ${r2.stand.length}`);
  assert.deepEqual(r2.stand[0], [0.3, 3]);
  assert.equal(r2.ground.length, 2, 'ground points within 6 m kept');
}
// SKEPTICAL OF A JUMP (owner, 2026-11-03): a fix far from the last kept one waits for a second to agree with it
{
  const L = newLocate(); noteGround(L, 0); L.gps = { at: [0, 0], phone: [0, 0], acc: 5, t: 0 };
  const fence = []; for (let i = 0; i < 60; i++) fence.push({ x: i * 0.25, y: 1.2, z: -4 });
  addDepth(L, fence, 0);
  const pos = { x: 0, y: 1.4, z: 0 }, A = { theta: TH, tx: SH[0], ty: SH[1], s: 1 }, B = { ...A, tx: SH[0] + 3 };
  let now = 1000;
  const ask = () => { now += 2000; const a = nextAsk(L, 2, now, pos); assert.ok(a.id, a.why); return a; };
  assert.ok(answer(L, { ok: true, T: A, hits: 0.8, cost: 0.01 }, ask().id, now), 'the first fix');
  assert.equal(answer(L, { ok: true, T: B, hits: 0.9, cost: 0.005 }, ask().id, now), null, 'a 3 m jump is held');
  assert.match(L.log.at(-1).why, /jumps 3\.0 m from the last fix/);
  const wide = ask();
  assert.equal(wide.prior.searchM, 4, 'the next search reaches both');
  assert.ok(answer(L, { ok: true, T: { ...A, tx: SH[0] + 0.1 }, hits: 0.8, cost: 0.01 }, wide.id, now), 'a fix by the old one is kept');
  assert.equal(L.candidate, null, 'and the jump forgotten');
  assert.equal(ask().prior.searchM, 1.5, 'the search narrow again');
  // the world did move (ARCore corrected its map): two fixes agree on the new place, and the second is taken
  assert.equal(answer(L, { ok: true, T: B, hits: 0.9, cost: 0.005 }, L.pending.id, now), null);
  const f = answer(L, { ok: true, T: { ...B, tx: B.tx + 0.2 }, hits: 0.9, cost: 0.005 }, ask().id, now);
  assert.ok(f, 'a second fix agreeing with the jump is kept');
  assert.equal(L.log.at(-1).confirmedJump, true);
  const s = summaryOf(L);
  assert.equal(s.jumpsHeld, 2); assert.equal(s.jumpsTaken, 1);
}
console.log('locate: ok');
