import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkPairs, acrossWalks, cornerLean, cornerKey, scaleOf, shareCorners } from '../lib/corners.js';

// three corners on the map; the roof's real corner C is 0.4 m farther along x than the map has it
const MAP = { A: [0, 0], B: [10, 0], C: [10, 8] };
const REAL = { A: [0, 0], B: [10, 0], C: [10.4, 8] };
const turn = (p, th, t) => [Math.cos(th) * p[0] - Math.sin(th) * p[1] + t[0], Math.sin(th) * p[0] + Math.cos(th) * p[1] + t[1]];
const walk = (th, t, noise = 0) => Object.keys(MAP).map((k, i) => ({ id: k, map: MAP[k], ar: turn([REAL[k][0] + noise * (i - 1), REAL[k][1]], th, t), odo: 5 + 20 * i, by: 'ROOF' }));

test('a pair is the same distance however the phone frame is turned', () => {
  const p = walkPairs(walk(1.1, [30, -7])).pairs;
  assert.equal(p.length, 3);
  const ab = p.find((x) => x.a === cornerKey({ map: MAP.A }) && x.b === cornerKey({ map: MAP.B }));
  assert.ok(Math.abs(ab.diffM) < 1e-9);
  assert.equal(ab.walkedM, 20);
});

test('the same difference in every walk is the map\'s; a differing one is the phone\'s', () => {
  const A = acrossWalks([walkPairs(walk(0.2, [1, 2])), walkPairs(walk(-2, [9, 9])), walkPairs(walk(3, [0, 0]))]);
  const v = Object.fromEntries(A.map((x) => [`${x.a}|${x.b}`, x.verdict]));
  const k = (a, b) => `${cornerKey({ map: MAP[a] })}|${cornerKey({ map: MAP[b] })}`;
  assert.equal(v[k('A', 'B')], 'agree');
  assert.equal(v[k('A', 'C')], 'map');
  const lean = cornerLean(A);
  assert.ok(lean.get(cornerKey({ map: MAP.C })).meanM > lean.get(cornerKey({ map: MAP.B })).meanM);
  const P = acrossWalks([walkPairs(walk(0, [0, 0], 0)), walkPairs(walk(0, [0, 0], 0.6))]);
  assert.ok(P.some((x) => x.verdict === 'phone'));
});

test('a corner marked twice: the nearest marks make the pair, and the move between its marks is told', () => {
  const m = walk(0, [0, 0]);
  m.push({ id: 'A2', map: MAP.A, ar: [1.5, 0], odo: 200, by: 'ROOF' });
  const r = walkPairs(m);
  assert.equal(r.corners.length, 3);
  assert.equal(r.again.length, 1);
  assert.ok(Math.abs(r.again[0].movedM - 1.5) < 1e-9);
  assert.equal(r.again[0].walkedM, 195);
  assert.equal(walkPairs([{ id: 1, map: [0, 0], ar: [NaN, 0], odo: 1 }]).pairs.length, 0);
});

test('a phone that measures 3% short is a scale, and nothing is left once it is taken out', () => {
  const m = Object.keys(MAP).map((k, i) => ({ id: k, map: MAP[k], ar: turn([MAP[k][0] * 0.97, MAP[k][1] * 0.97], 0.7, [4, 4]), odo: 10 * i, by: 'ROOF' }));
  const sc = walkPairs(m).scale;
  assert.ok(Math.abs(sc.k - 0.97) < 1e-9);
  assert.ok(sc.rmsM < 1e-9 && sc.rawRmsM > 0.2);
  assert.equal(scaleOf([{ mapM: 5, phoneM: 5, diffM: 0 }]), null);
});

test('a corner a few inches off in another walk is the same corner', () => {
  const a = walkPairs(walk(0.2, [1, 2])), m2 = walk(-1, [3, 3]).map((m) => ({ ...m, map: [m.map[0] + 0.07, m.map[1] - 0.05] })), b = walkPairs(m2);
  assert.equal(shareCorners([a, b]), 3);
  assert.ok(acrossWalks([a, b]).every((p) => p.n === 2));
});
