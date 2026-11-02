// scan/lib/align.js: the reference fit. node scan/test/align.test.js
import assert from 'node:assert/strict';
import { fitRigid, apply, unapply, fitAt, walkWeight, leftOut } from '../lib/align.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
// a session turned 40 degrees and shifted (12, -7) from the map
const TH = (40 * Math.PI) / 180, SH = [12, -7];
const toAR = ([e, n]) => { const a = e - SH[0], b = n - SH[1]; return [Math.cos(-TH) * a - Math.sin(-TH) * b, Math.sin(-TH) * a + Math.cos(-TH) * b]; };
const refs = [[0, 0], [15, 3], [4, 20], [-10, 8]];
{
  const T = fitRigid(refs.slice(0, 2).map((m) => ({ ar: toAR(m), map: m })));
  near(T.theta, TH, 1e-9, 'the turn from two points');
  near(T.scale, 1, 1e-9, 'the scale reported as 1');
  const back = apply(T, toAR([7, 7]));
  near(back[0], 7, 1e-9, 'a third point lands'); near(back[1], 7, 1e-9, 'y');
  const inv = unapply(T, [7, 7]);
  near(inv[0], toAR([7, 7])[0], 1e-9, 'unapply is the inverse'); near(inv[1], toAR([7, 7])[1], 1e-9, 'v');
  assert.equal(fitRigid([{ ar: [0, 0], map: [0, 0] }]), null, 'one point is not a fit');
  assert.equal(fitRigid([{ ar: [0, 0], map: [0, 0] }, { ar: [0, 0], map: [0, 0] }]), null, 'two at one spot is not a fit');
}
// a session 4% short reports it, without using it
{
  const T = fitRigid(refs.map((m) => ({ ar: toAR(m).map((v) => v * 0.96), map: m })));
  near(T.scale, 1 / 0.96, 1e-6, 'photo over AR');
  near(T.theta, TH, 1e-6, 'the turn still right');
}
// the walk weighting: a mark far back in the walk counts for little, and the fit for a moment follows the near marks
{
  near(walkWeight(0), 1, 1e-12, 'now');
  near(walkWeight(12), 0.5, 1e-12, 'at L');
  assert.ok(walkWeight(60) < 0.002, 'five L away');
  // marks: two early, two late, the late ones after a 1 m slide of the frame
  const slide = ([u, v]) => [u + 1, v];
  const marks = [
    { id: 'a', ar: toAR(refs[0]), map: refs[0], odo: 0 }, { id: 'b', ar: toAR(refs[1]), map: refs[1], odo: 2 },
    { id: 'c', ar: slide(toAR(refs[2])), map: refs[2], odo: 80 }, { id: 'd', ar: slide(toAR(refs[3])), map: refs[3], odo: 82 },
  ];
  const early = apply(fitAt(marks, 1), toAR([5, 5])), late = apply(fitAt(marks, 81), slide(toAR([5, 5])));
  near(early[0], 5, 0.02, 'early fit, early point'); near(late[0], 5, 0.02, 'late fit, slid point');
  assert.equal(fitAt([marks[0], { ...marks[0], odo: 5 }], 3), null, 'one reference marked twice is still one place');
  // a reference placed 2 m wrong on the photo shows up when the others line it up (four marks close in the walk)
  const close = refs.map((m, i) => ({ id: 'abcd'[i], ar: toAR(m), map: m, odo: i * 2 }));
  const bad = close.map((m) => (m.id === 'b' ? { ...m, map: [m.map[0] + 2, m.map[1]] } : m));
  near(leftOut(bad, 'b'), 2, 0.05, 'the wrong one stands out');
  assert.ok(leftOut(bad, 'a') < 1.2, `the right ones less so: ${leftOut(bad, 'a')}`);
  assert.equal(leftOut(marks.slice(0, 1), 'a'), null, 'nothing to line it up with');
}
console.log('align: ok');
