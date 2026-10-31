/**
 * Lining the phone's AR tracking up with the map (lib/ar-align.js, FINDINGS H64). Made-up marks.
 *   node water/test/ar-align.test.js
 */
import assert from 'node:assert/strict';
import { toLocal, fromLocal, arLevel, fitRigid, apply, headingOf, baseline, fitAt, walkWeight } from '../lib/ar-align.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// the AR frame: turned 37 degrees and shifted from the map's
const TH = (37 * Math.PI) / 180, SH = [12.5, -4.2];
const toMap = ([u, v]) => [Math.cos(TH) * u - Math.sin(TH) * v + SH[0], Math.sin(TH) * u + Math.cos(TH) * v + SH[1]];

test('local metres round a point and back', () => {
  const o = [-85.6, 42.9], p = [-85.5995, 42.9003];
  const [e, n] = toLocal(o, p);
  assert.ok(Math.abs(e - 40.8) < 0.2 && Math.abs(n - 33.4) < 0.2, `${e} ${n}`);
  const back = fromLocal(o, [e, n]);
  assert.ok(Math.abs(back[0] - p[0]) < 1e-9 && Math.abs(back[1] - p[1]) < 1e-9);
});

test('two references fix the turn and the shift exactly; a third point lands where it should', () => {
  const a = [[0, 0], [15, 3]];
  const T = fitRigid(a.map((ar) => ({ ar, map: toMap(ar) })));
  assert.ok(Math.abs(T.theta - TH) < 1e-9 && Math.abs(T.scale - 1) < 1e-9 && T.rms < 1e-9);
  const q = [7, -9], got = apply(T, q), want = toMap(q);
  assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 1e-9);
});

test('marks a few centimetres off: the fit spreads the error, and each reference reports its own', () => {
  const pts = [[0, 0], [18, 2], [9, 14], [-4, 10]];
  const noise = [[0.03, -0.02], [-0.04, 0.01], [0.02, 0.05], [-0.01, -0.04]];
  const T = fitRigid(pts.map((ar, i) => ({ ar, map: toMap(ar).map((v, k) => v + noise[i][k]) })));
  assert.ok(Math.abs(T.theta - TH) < 0.005, `${(T.theta * 180) / Math.PI}`);
  assert.equal(T.residuals.length, 4); assert.ok(T.rms > 0.01 && T.rms < 0.06, `${T.rms}`);
  assert.ok(Math.abs(T.scale - 1) < 0.01);
  assert.ok(Math.abs(baseline(pts.map((ar) => ({ ar, map: toMap(ar) }))) - Math.hypot(22, 8)) < 1e-6);
});

test('too few, or all at one spot: no fit', () => {
  assert.equal(fitRigid([{ ar: [0, 0], map: [1, 1] }]), null);
  assert.equal(fitRigid([{ ar: [1, 1], map: [5, 5] }, { ar: [1, 1], map: [5, 5] }]), null);
});

test('AR level coordinates and the phone\'s heading on the map', () => {
  assert.deepEqual(arLevel({ x: 2, y: 0.1, z: -3 }), [2, 3]);
  const T = { theta: 0, tx: 0, ty: 0 };
  // no rotation: the camera looks along -z, which is north here
  assert.ok(Math.abs(headingOf(T, { x: 0, y: 0, z: 0, w: 1 }) - 0) < 1e-9);
  // turned 90 degrees to the right (clockwise seen from above, about -y): looking east
  const h = Math.sqrt(0.5);
  assert.ok(Math.abs(headingOf(T, { x: 0, y: -h, z: 0, w: h }) - 90) < 1e-6, `${headingOf(T, { x: 0, y: -h, z: 0, w: h })}`);
  // and the map's turn added
  assert.ok(Math.abs(headingOf({ theta: -Math.PI / 2, tx: 0, ty: 0 }, { x: 0, y: 0, z: 0, w: 1 }) - 90) < 1e-6);
});

let failed = 0;
test('equal weights change nothing; a weight of nearly nothing leaves a mark out', () => {
  const a = [[0, 0], [15, 3], [4, 11]];
  const pairs = a.map((ar) => ({ ar, map: toMap(ar) }));
  pairs[2].map = [pairs[2].map[0] + 1.5, pairs[2].map[1]]; // one mark 1.5 m out
  const T1 = fitRigid(pairs), T2 = fitRigid(pairs.map((p) => ({ ...p, w: 3 })));
  assert.ok(Math.abs(T1.theta - T2.theta) < 1e-12 && Math.abs(T1.tx - T2.tx) < 1e-9 && Math.abs(T1.rms - T2.rms) < 1e-9);
  const T3 = fitRigid(pairs.map((p, i) => ({ ...p, w: i === 2 ? 1e-9 : 1 })));
  assert.ok(Math.abs(T3.theta - TH) < 1e-6 && T3.residuals[0] < 1e-6, `${T3.theta} ${T3.residuals}`);
});

test('after a long walk the phone has drifted: marks made since then win, and the old ones do not drag it off', () => {
  // the first 10 m of walking in the true frame; by 60 m ARCore's frame has slid 2 m and turned 4 degrees
  const D = (4 * Math.PI) / 180, SL = [2, -1.2];
  const drifted = ([u, v]) => [Math.cos(-D) * (u - SL[0]) - Math.sin(-D) * (v - SL[1]), Math.sin(-D) * (u - SL[0]) + Math.cos(-D) * (v - SL[1])];
  const truthAR = (m) => { // the AR reading of a map point in the frame as it began
    const a = m[0] - SH[0], b = m[1] - SH[1];
    return [Math.cos(-TH) * a - Math.sin(-TH) * b, Math.sin(-TH) * a + Math.cos(-TH) * b];
  };
  const R1 = [0, 0], R2 = [18, 2], R3 = [30, 25];
  const marks = [
    { map: R1, ar: truthAR(R1), odo: 0 }, { map: R2, ar: truthAR(R2), odo: 8 },
    { map: R3, ar: drifted(truthAR(R3)), odo: 60 }, { map: R1, ar: drifted(truthAR(R1)), odo: 64 },
  ];
  const head = [26, 20], seen = drifted(truthAR(head));
  const off = (T) => { const g = apply(T, seen); return Math.hypot(g[0] - head[0], g[1] - head[1]); };
  const all = fitRigid(marks), now = fitAt(marks, 66);
  assert.ok(off(now) < 0.35 * off(all), `walked-weighted ${off(now).toFixed(2)} m, all alike ${off(all).toFixed(2)} m`);
  assert.ok(off(now) < 0.5, `${off(now)}`);
  // and a head placed back at the start is still placed by the early marks
  const early = [3, 1], g = apply(fitAt(marks, 2), truthAR(early));
  assert.ok(Math.hypot(g[0] - early[0], g[1] - early[1]) < 0.5);
  assert.equal(walkWeight(0), 1); assert.ok(walkWeight(12) === 0.5 && walkWeight(-12) === 0.5);
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water AR alignment: ${tests.length} passed`);
