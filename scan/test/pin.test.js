import assert from 'node:assert/strict';
import { pinPlan, levels, lidarGroundAt } from '../lib/pin.js';

// a walk over a gentle slope whose height drifts 15 cm between its first and second visit to the same ground
{
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pts = [];
  for (let i = 0; i < 12000; i++) {
    const second = i >= 6000, odo = (i / 12000) * 80, e = second ? 40 - (odo - 40) : odo, n = rnd();
    const truth = 100 + e * 0.02, drift = second ? 0.15 : 0;
    pts.push({ e, n, t: i * 0.05, odo, dist: 1 + rnd() * 2, y: truth - 100 + 3 + drift + (rnd() - 0.5) * 0.04, lidar: truth + (rnd() - 0.5) * 0.1 });
  }
  const before = levels(pts.map((p) => ({ ...p, h: p.y })));
  const P = pinPlan(pts);
  const after = levels(pts.map((p) => ({ ...p, h: p.y - P.off(p.odo) })));
  assert.ok(before.visits > 0.1, 'the two visits disagree by the drift before');
  assert.ok(after.visits < 0.04, `pinned, they agree (${after.visits.toFixed(3)})`);
  assert.ok(P.pinned >= 5 && Math.abs(P.drift - 0.15) < 0.04, 'the drift found is the drift put in');
  assert.equal(pinPlan([]).off(10), 0, 'a walk with no ground is left as it is');
}
// between four columns the lidar's ground is the mean of them
{
  const g = Float32Array.from([1, 2, 3, 4]), sg = { x0: 0, y1: 2, cell: 1, w: 2, h: 2 };
  assert.ok(Math.abs(lidarGroundAt(g, sg, 0, 0, 1, 1, 1) - 2.5) < 1e-6);
  assert.ok(Number.isNaN(lidarGroundAt(g, sg, 0, 0, 1, 50, 50)));
}
console.log('pin: ok');
