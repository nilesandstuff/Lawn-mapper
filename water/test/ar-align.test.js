/**
 * Lining the phone's AR tracking up with the map (lib/ar-align.js, FINDINGS H64). Made-up marks.
 *   node water/test/ar-align.test.js
 */
import assert from 'node:assert/strict';
import { toLocal, fromLocal, arLevel, fitRigid, apply, headingOf, baseline, fitAt, walkWeight, fitMixed, fitMixedAt, edgeOff, pairScale, fitDrift } from '../lib/ar-align.js';

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

test('an AR that measures 4% short: holding scale at 1 leaves every reference about equally off; fitting it puts them right', () => {
  const K = 0.96; // AR reads 96% of the true distance
  const refs = [[0, 0], [30, 4], [12, 40], [-8, 22]];
  const pairs = refs.map((m) => { const a = m[0] - SH[0], b = m[1] - SH[1]; return { kind: 'pt', map: m, ar: [K * (Math.cos(-TH) * a - Math.sin(-TH) * b), K * (Math.sin(-TH) * a + Math.cos(-TH) * b)] }; });
  const rigid = fitMixed(pairs), sim = fitMixed(pairs, { scale: 'fit' });
  assert.ok(Math.min(...rigid.residuals) > 0.3, `${rigid.residuals}`);
  assert.ok(sim.rms < 1e-6 && Math.abs(sim.s - 1 / K) < 1e-6, `${sim.rms} ${sim.s}`);
  // a known scale held fixed does as well
  assert.ok(fitMixed(pairs, { scale: 1 / K }).rms < 1e-6);
  assert.ok(Math.abs(rigid.scale - 1 / K) < 1e-6, 'the points-only spread ratio still reports it');
});

test('edges: a mark anywhere along a driveway edge pulls the fit onto the line, not onto one spot', () => {
  const toAR = (m) => { const a = m[0] - SH[0], b = m[1] - SH[1]; return [Math.cos(-TH) * a - Math.sin(-TH) * b, Math.sin(-TH) * a + Math.cos(-TH) * b]; };
  // two references marked with errors that turn the fit; a long edge far off fixes the turn
  const pts = [{ kind: 'pt', map: [0, 0], ar: toAR([0, 0.3]) }, { kind: 'pt', map: [10, 0], ar: toAR([10, -0.3]) }];
  const edge = { a: [0, 40], b: [30, 40] };
  const edgeMarks = [[3, 40], [17, 40], [26, 40]].map((m) => ({ kind: 'edge', ...edge, ar: toAR(m), w: 0.5 }));
  const head = [20, 35], seen = toAR(head);
  const off = (T) => { const g = apply(T, seen); return Math.hypot(g[0] - head[0], g[1] - head[1]); };
  const without = fitMixed(pts), withEdges = fitMixed([...pts, ...edgeMarks]);
  assert.ok(off(withEdges) < off(without), `${off(withEdges)} vs ${off(without)}`);
  assert.ok(withEdges.residuals.slice(2).every((r) => r < 0.3));
  assert.ok(Math.abs(edgeOff(edge, [5, 41.5]) - 1.5) < 1e-9);
  // a mark on the line, wherever along it, has no residual
  const T = fitMixed([{ kind: 'pt', map: [0, 0], ar: toAR([0, 0]) }, { kind: 'pt', map: [10, 0], ar: toAR([10, 0]) }, { kind: 'edge', ...edge, ar: toAR([123, 40]) }]);
  assert.ok(T.residuals[2] < 1e-6);
});

test('mixed fits weighted by the walk, and too little to fit', () => {
  assert.equal(fitMixed([{ kind: 'pt', map: [0, 0], ar: [0, 0] }, { kind: 'edge', a: [0, 5], b: [5, 5], ar: [0, 5] }]), null);
  const cons = [{ kind: 'pt', map: [0, 0], ar: [0, 0], odo: 0 }, { kind: 'pt', map: [10, 0], ar: [10, 0], odo: 0 }];
  const T = fitMixedAt(cons, 50);
  assert.ok(Math.abs(T.theta) < 1e-9 && T.rms < 1e-9);
});

test("the phone's scale from references marked one after the other, not across a long walk", () => {
  const K = 0.96, toAR = (m, slide = 0) => [K * m[0] + slide, K * m[1]];
  const marks = [
    { id: 'R1', map: [0, 0], ar: toAR([0, 0]), odo: 0 },
    { id: 'R2', map: [30, 0], ar: toAR([30, 0]), odo: 32 },
    { id: 'R3', map: [30, 40], ar: toAR([30, 40], 3), odo: 300 }, // after a long walk, 3 m of drift
    { id: 'R1', map: [0, 0], ar: toAR([0, 0], 3.1), odo: 352 },
  ];
  const sc = pairScale(marks);
  assert.ok(sc && Math.abs(sc.k - 1 / K) < 0.01, JSON.stringify(sc));
  assert.equal(sc.n, 2); // R1-R2 at the start; R3-R1 at the end (R2-R3 and the rest are a long walk apart)
  assert.equal(pairScale([{ id: 'a', map: [0, 0], ar: [0, 0], odo: 0 }, { id: 'b', map: [3, 0], ar: [3, 0], odo: 3 }]), null);
});

test('a slide is not a turn: after a long walk one fresh reference puts heads right across the lawn', () => {
  const toAR = (m, slide) => { const a = m[0] - SH[0], b = m[1] - SH[1]; return [Math.cos(-TH) * a - Math.sin(-TH) * b + slide[0], Math.sin(-TH) * a + Math.cos(-TH) * b + slide[1]]; };
  const S0 = [0, 0], S1 = [1.4, -0.9]; // the frame has slid 1.7 m by the end
  const cons = [
    { kind: 'pt', id: 'R1', map: [0, 0], ar: toAR([0, 0], S0), odo: 0 },
    { kind: 'pt', id: 'R2', map: [30, 0], ar: toAR([30, 0], S0), odo: 33 },
    { kind: 'pt', id: 'R3', map: [10, 60], ar: toAR([10, 60], S1), odo: 200 },
  ];
  const head = [35, 10], seen = toAR(head, S1); // placed 40 m on from R3, 60 m from it
  const off = (T) => { const g = apply(T, seen); return Math.hypot(g[0] - head[0], g[1] - head[1]); };
  const rigid = fitMixedAt(cons, 240), drift = fitDrift(cons, 240);
  assert.equal(drift.turnFrom, 'pairs');
  assert.ok(off(drift) < 0.2, `slide-aware ${off(drift).toFixed(2)} m`);
  assert.ok(off(rigid) > 0.8, `one rigid fit ${off(rigid).toFixed(2)} m`);
});

test('an edge marked twice a few steps apart gives the turn; marked once, only the position across it', () => {
  const toAR = (m) => { const a = m[0] - SH[0], b = m[1] - SH[1]; return [Math.cos(-TH) * a - Math.sin(-TH) * b, Math.sin(-TH) * a + Math.cos(-TH) * b]; };
  const edge = { a: [0, 40], b: [30, 40] };
  // two references marked far apart in the walk (no pair), so only the edge can give the turn
  const cons = [
    { kind: 'pt', id: 'R1', map: [0, 0], ar: toAR([0, 0.4]), odo: 0 },
    { kind: 'pt', id: 'R2', map: [10, 0], ar: toAR([10, -0.4]), odo: 500 },
    { kind: 'edge', id: 'E1', ...edge, ar: toAR([5, 40]), odo: 600, w: 0.5 },
    { kind: 'edge', id: 'E1', ...edge, ar: toAR([20, 40]), odo: 616, w: 0.5 },
  ];
  const T = fitDrift(cons, 620);
  assert.equal(T.turnFrom, 'pairs');
  assert.ok(Math.abs(Math.atan2(Math.sin(T.theta - TH), Math.cos(T.theta - TH))) < 1e-6, `${T.theta} ${TH}`);
  assert.ok(T.residuals[2] < 0.02 && T.residuals[3] < 0.02, `${T.residuals}`);
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water AR alignment: ${tests.length} passed`);
