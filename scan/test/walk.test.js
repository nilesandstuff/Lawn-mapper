// scan/lib/walk.js: a walk's bookkeeping. node scan/test/walk.test.js
import assert from 'node:assert/strict';
import { newWalk, step, dropPin, checkPin, measure, tapeFor, undo, far, summary, STEP, LOSS_WALK, RESET_WALK } from '../lib/walk.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const Q = { x: 0, y: 0, z: 0, w: 1 };
const at = (x, z, y = 1.5) => ({ x, y, z });

// the hand's sway is not walking; steps of STEP or more are
{
  const w = newWalk({ engine: 'webxr' });
  let t = 0;
  for (let i = 0; i < 200; i++) step(w, { t: (t += 16), pos: at(0.04 * Math.sin(i), 0.04 * Math.cos(i)), quat: Q, tracking: 'normal' });
  near(w.stats.walked, 0, 1e-9, 'sway counts nothing');
  for (let i = 1; i <= 20; i++) step(w, { t: (t += 500), pos: at(0, -i * STEP), quat: Q, tracking: 'normal' });
  near(w.stats.walked, 20 * STEP, 0.1, 'ten metres walked (from wherever the sway left it)');
  assert.equal(w.stats.fastTurns, 0);
}
// losing tracking, finding it, a frame reset
{
  const w = newWalk({ engine: 'webxr' });
  step(w, { t: 0, pos: at(0, 0), quat: Q, tracking: 'normal' });
  const lost = step(w, { t: 16, pos: null, quat: null, tracking: 'lost' });
  assert.deepEqual(lost, ['lost']);
  assert.equal(w.stats.losses, 1);
  near(w.odo, LOSS_WALK, 1e-9, 'a loss adds to the walk');
  step(w, { t: 32, pos: null, quat: null, tracking: 'lost' });
  assert.equal(w.stats.losses, 1, 'staying lost is one loss');
  const found = step(w, { t: 48, pos: at(5, 5), quat: Q, tracking: 'normal' });
  assert.deepEqual(found, ['found']);
  near(w.stats.walked, 0, 1e-9, 'the jump on finding its place is not walking');
  const reset = step(w, { t: 64, pos: at(5, 5), quat: Q, tracking: 'normal', reset: true });
  assert.ok(reset.includes('reset'));
  assert.equal(w.stats.resets, 1);
  near(w.odo, LOSS_WALK + RESET_WALK, 1e-9, 'a reset adds a kilometre');
  assert.equal(w.stats.frames, 5);
  assert.equal(w.stats.trackedFrames, 3);
}
// a fast turn is counted once per turn
{
  const w = newWalk({ engine: '8thwall' });
  const s = Math.SQRT1_2;
  step(w, { t: 0, pos: at(0, 0), quat: Q, tracking: 'normal' });
  const r = step(w, { t: 100, pos: at(0, 0), quat: { x: 0, y: s, z: 0, w: s }, tracking: 'normal' }); // 90 degrees in 0.1 s
  assert.deepEqual(r, ['fast']);
  step(w, { t: 200, pos: at(0, 0), quat: { x: 0, y: 1, z: 0, w: 0 }, tracking: 'normal' }); // still turning fast
  assert.equal(w.stats.fastTurns, 1);
  step(w, { t: 2200, pos: at(0, 0), quat: { x: 0, y: 1, z: 0, w: 0 }, tracking: 'normal' });
  step(w, { t: 2300, pos: at(0, 0), quat: { x: 0, y: s, z: 0, w: -s }, tracking: 'normal' });
  assert.equal(w.stats.fastTurns, 2, 'a second fast turn after a slow spell');
}
// pins, checks, measures, the tape, undo
{
  const w = newWalk({ engine: 'webxr' });
  step(w, { t: 0, pos: at(0, 0), quat: Q, tracking: 'normal' });
  const hitA = { position: { x: 0, y: 0, z: -1.2 }, type: 'SURFACE', distance: 1.9 };
  const p = dropPin(w, hitA);
  assert.equal(p.name, 'P1');
  assert.equal(p.aim, 1.9);
  for (let i = 1; i <= 40; i++) step(w, { t: i * 500, pos: at(0, -i * 0.5), quat: Q, tracking: 'normal' });
  const c = checkPin(w, p, { position: { x: 0.12, y: 0.02, z: -1.25 }, type: 'SURFACE', distance: 1.1 });
  near(c.offLevelM, 0.13, 1e-9, 'the pin is 13 cm off on the level');
  near(c.walkedSinceM, 20, 1e-9, '20 m walked since');
  assert.equal(measure(w, { position: { x: 0, y: 0, z: 0 }, distance: 1 }), null, 'the first tap waits');
  assert.ok(w.pendingMeasure);
  const m = measure(w, { position: { x: 9.6, y: 0.3, z: 0 }, distance: 1.2 });
  near(m.m, 9.6, 1e-9, 'the level distance');
  near(m.m3, Math.hypot(9.6, 0.3), 1e-9, 'the 3D distance');
  const r = tapeFor(m, 10);
  near(r.shortBy, 0.04, 1e-9, '4% short of the tape');
  assert.equal(tapeFor(m, 0), null);
  assert.equal(far({ distance: 3.6 }), true);
  assert.equal(far({ distance: 2 }), false);
  measure(w, { position: { x: 1, y: 0, z: 1 }, distance: 1 });
  assert.equal(undo(w), 'measure', 'undo clears a pending first mark first');
  assert.equal(undo(w), 'pin');
  assert.equal(w.pins.length, 0);
  assert.equal(undo(w), null);
}
// the copy holds distances and counts, never a position
{
  const w = newWalk({ engine: '8thwall', phone: 'test' });
  step(w, { t: 0, pos: at(3, -4), quat: Q, tracking: 'normal', points: 120 });
  step(w, { t: 100, pos: at(3, -4), quat: Q, tracking: 'normal', points: 80 });
  const p = dropPin(w, { position: { x: 3, y: 0, z: -5 }, type: 'ESTIMATED_SURFACE', distance: 1.8 });
  checkPin(w, p, { position: { x: 3.1, y: 0, z: -5 }, distance: 1 });
  measure(w, { position: { x: 0, y: 0, z: 0 }, distance: 1 }); measure(w, { position: { x: 5, y: 0, z: 0 }, distance: 1 });
  const s = summary(w, { features: ['slam'] });
  const text = JSON.stringify(s);
  assert.ok(!/"at"|"position"|"x":|"lng"|"lat"/.test(text), `no positions in the copy: ${text.slice(0, 200)}`);
  assert.equal(s.pins[0].checks[0].offLevelM, 0.1);
  assert.equal(s.measures[0].metres, 5);
  assert.equal(s.points.maxAtOnce, 120);
  assert.equal(s.points.perTrackedFrame, 100);
  assert.deepEqual(s.features, ['slam']);
  assert.equal(s.engine, '8thwall');
}
console.log('walk: ok');
