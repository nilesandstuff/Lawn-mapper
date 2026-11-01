// scan/lib/frames.js: frames and matrices for the yard AR tool. node scan/test/frames.test.js
import assert from 'node:assert/strict';
import { toLocal, fromLocal, level, levelDist, yawOf, turnBetween, matFromPose, invertRigid, multiply, transform, cameraOf } from '../lib/frames.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const O = [-85.70712, 42.83547];

// lng/lat <-> local metres round-trips, and a degree of latitude is about 111 km
{
  const p = fromLocal(O, [40, -25]);
  const back = toLocal(O, p);
  near(back[0], 40, 1e-6, 'east back'); near(back[1], -25, 1e-6, 'north back');
  near(toLocal(O, [O[0], O[1] + 1])[1], 111319.5, 1, 'a degree north');
}
// the level: x right, -z ahead; a tape on the ground ignores height
{
  assert.deepEqual(level({ x: 1, y: 5, z: -2 }), [1, 2]);
  near(levelDist({ x: 0, y: 0, z: 0 }, { x: 3, y: 9, z: -4 }), 5, 1e-9, 'level distance');
}
// yaw: looking ahead is 0; a quarter turn to the left (about +y) is -90; turns wrap
{
  near(yawOf({ x: 0, y: 0, z: 0, w: 1 }), 0, 1e-9, 'ahead');
  const s = Math.SQRT1_2;
  near(yawOf({ x: 0, y: s, z: 0, w: s }), -90, 1e-6, 'a quarter turn left');
  near(yawOf({ x: 0, y: -s, z: 0, w: s }), 90, 1e-6, 'a quarter turn right');
  assert.equal(turnBetween(170, -170), 20);
  assert.equal(turnBetween(-170, 170), -20);
}
// a pose matrix, inverted, is a view matrix: the camera's position maps to the origin, and back
{
  const q = { x: 0.1, y: 0.7, z: -0.2, w: Math.sqrt(1 - 0.01 - 0.49 - 0.04) };
  const p = { x: 2, y: 1.5, z: -3 };
  const M = matFromPose(q, p), V = invertRigid(M);
  const I = multiply(V, M);
  for (let i = 0; i < 16; i++) near(I[i], i % 5 === 0 ? 1 : 0, 1e-5, `identity ${i}`);
  const c = transform(V, p);
  near(c.x, 0, 1e-5, 'camera at origin'); near(c.y, 0, 1e-5, 'y'); near(c.z, 0, 1e-5, 'z');
  const back = cameraOf(V);
  near(back.x, 2, 1e-5, 'camera x'); near(back.y, 1.5, 1e-5, 'camera y'); near(back.z, -3, 1e-5, 'camera z');
  // a point one metre ahead of an unturned camera is at z -1 in view space
  const V0 = invertRigid(matFromPose({ x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 1.5, z: 0 }));
  const ahead = transform(V0, { x: 0, y: 1.5, z: -1 });
  near(ahead.z, -1, 1e-9, 'ahead is -z'); near(ahead.y, 0, 1e-9, 'level');
}
console.log('frames: ok');
