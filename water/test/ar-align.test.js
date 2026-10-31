/**
 * Lining the phone's AR tracking up with the map (lib/ar-align.js, FINDINGS H64). Made-up marks.
 *   node water/test/ar-align.test.js
 */
import assert from 'node:assert/strict';
import { toLocal, fromLocal, arLevel, fitRigid, apply, headingOf, baseline } from '../lib/ar-align.js';

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
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water AR alignment: ${tests.length} passed`);
