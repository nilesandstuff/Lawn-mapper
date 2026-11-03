/**
 * scan/lib/minimap.js: the mini map's view and the arrows to points out of the picture.
 *   node scan/test/minimap.test.js
 */
import assert from 'node:assert/strict';
import { viewToFit, followView, toScreen, fromScreen, zoomAt, pan, edgeArrow, FOLLOW_SPAN_M } from '../lib/minimap.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
// every point in view, with room to spare
const pts = [[-30, 10], [40, -5], [10, 60]];
const v = viewToFit(pts, 200, 200);
for (const p of pts) { const [x, y] = toScreen(v, p, 200, 200); assert.ok(x >= 17 && x <= 183 && y >= 17 && y <= 183, `${p} in view: ${x},${y}`); }
const [sx, sy] = toScreen(v, [40, -5], 200, 200); const back = fromScreen(v, [sx, sy], 200, 200);
near(back[0], 40, 1e-9, 'round trip e'); near(back[1], -5, 1e-9, 'round trip n');
assert.ok(toScreen(v, [10, 60], 200, 200)[1] < toScreen(v, [40, -5], 200, 200)[1], 'north is up');
// one point: a 20 m span, not a zoom to nothing
assert.ok(viewToFit([[3, 3]], 200, 200).mpp >= 0.1);
// the lock: the phone in the middle, FOLLOW_SPAN_M across
const f = followView([5, 7], 200, 300);
near(f.mpp * 200, FOLLOW_SPAN_M, 1e-9, 'span'); assert.deepEqual(toScreen(f, [5, 7], 200, 300), [100, 150]);
// zoom about a finger keeps that spot under it; a drag moves the map with the finger
const z = zoomAt(v, 2, [50, 60], 200, 200);
near(z.mpp, v.mpp / 2, 1e-12, 'twice as close');
const under = fromScreen(v, [50, 60], 200, 200), under2 = fromScreen(z, [50, 60], 200, 200);
near(under[0], under2[0], 1e-9, 'held e'); near(under[1], under2[1], 1e-9, 'held n');
const pd = pan(v, 10, -20), was = toScreen(v, [0, 0], 200, 200), now = toScreen(pd, [0, 0], 200, 200);
near(now[0] - was[0], 10, 1e-9, 'drag x'); near(now[1] - was[1], -20, 1e-9, 'drag y');

// arrows: a camera at the origin looking down -z, a 90 degree square view
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const n = 0.1, fr = 100, P = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(fr + n) / (fr - n), -1, 0, 0, -2 * fr * n / (fr - n), 0];
assert.equal(edgeArrow({ x: 0, y: 0, z: -5 }, I, P, 400, 800), null, 'straight ahead: in the picture, no arrow');
const right = edgeArrow({ x: 10, y: 0, z: -2 }, I, P, 400, 800);
assert.ok(right && right.x > 350 && Math.abs(right.y - 400) < 1 && Math.abs(right.angle) < 1e-6, `to the right: ${JSON.stringify(right)}`);
const left = edgeArrow({ x: -10, y: 0, z: -2 }, I, P, 400, 800);
assert.ok(left.x < 50 && Math.abs(Math.abs(left.angle) - Math.PI) < 1e-6, 'to the left');
const behind = edgeArrow({ x: 1, y: 0, z: 5 }, I, P, 400, 800);
assert.ok(behind && behind.x > 200, `behind and a little right: turn right ${JSON.stringify(behind)}`);
const below = edgeArrow({ x: 0, y: -10, z: -2 }, I, P, 400, 800);
assert.ok(below.y > 700 && Math.abs(below.angle - Math.PI / 2) < 1e-6, 'below: the arrow at the bottom, pointing down');
console.log('minimap: ok');
