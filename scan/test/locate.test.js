// scan/lib/locate.js: the fix's bookkeeping. node scan/test/locate.test.js
import assert from 'node:assert/strict';
import { newLocate, mark, refFit, noteGround, addDepth, recent, nextAsk, answer, fitFor, fitSource, priorFor, mapOf, sessionOf, checkError, status, summaryOf, FIX_REACH, MIN_STAND } from '../lib/locate.js';

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
  pts.push({ x: 1, y: 4, z: -5 }); // a branch: neither
  const kept = addDepth(L, pts, 10);
  assert.equal(kept, 150);
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
  const f = answer(L, { ok: true, T: { theta: TH, tx: SH[0], ty: SH[1], s: 1 }, hits: 0.8, cost: 0.01 }, ask2.id);
  assert.ok(f && L.fixes.length === 1);
  assert.equal(fitSource(L, 10), 'fix');
  assert.equal(fitSource(L, 10 + FIX_REACH + 1), null, 'a fix stands for FIX_REACH metres');
  assert.equal(priorFor(L, 12).from, 'the last fix');
  assert.equal(priorFor(L, 12).searchM, 1.5);
  assert.match(status(L, 12), /lidar fix, 2 m ago, 80% landed/);
  const sum = summaryOf(L);
  assert.equal(sum.fixes, 1); assert.equal(sum.asks, 2); assert.deepEqual(sum.fixFrom, { GPS: 1 });
  assert.ok(!JSON.stringify(sum).includes('"at"'), 'no positions in the copy');
  // too few standing points: the ask explains
  const L2 = newLocate(); noteGround(L2, 0); L2.gps = { at: [0, 0], phone: [0, 0], acc: 5, t: 0 };
  addDepth(L2, [{ x: 1, y: 1.2, z: -1 }], 0);
  assert.match(nextAsk(L2, 0, 10000).why, new RegExp(`1 points .* \\(${MIN_STAND} wanted\\)`));
}
console.log('locate: ok');
