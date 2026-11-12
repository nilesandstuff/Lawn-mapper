// node scan/test/guide.test.js
import assert from 'node:assert/strict';
import { whereIs, resnap } from '../lib/guide.js';

// looking down -z (ARCore's forward), targets around
const cam = [0, 1.5, 0], fwd = [0, 0, -1];
assert.equal(whereIs(cam, fwd, [0, 3, -10]).word, 'straight ahead');
assert.equal(whereIs(cam, fwd, [10, 3, 0]).word, 'to your right');
assert.equal(whereIs(cam, fwd, [-10, 3, 0]).word, 'to your left');
assert.equal(whereIs(cam, fwd, [0, 3, 10]).word, 'behind you');
assert.equal(whereIs(cam, fwd, [6, 3, -6]).word, 'ahead and to your right');
assert.equal(whereIs(cam, fwd, [-6, 3, 6]).word, 'behind and to your left');
assert.equal(whereIs(cam, fwd, [0, 9, -10]).ft, 33, 'the distance is on the level, in feet');
assert.ok(whereIs(cam, fwd, [3, 3, -10]).facing && !whereIs(cam, fwd, [10, 3, 2]).facing);
assert.equal(whereIs(cam, [0, -1, 0], [5, 0, 0]).word, 'right here', 'looking straight down: no direction to give');

// a point put on a corner follows the corner; one placed by hand stays
const pts = [
  { name: 'R1', map: [10, 10], snap: { kind: 'corner', of: 3 } },
  { name: 'R2', map: [30, 5], roof: { eaveM: 3, label: 'east corner' } },
  { name: 'R3', map: [50, 50] },
  { name: 'R4', map: [70, 70], snap: { kind: 'corner', of: 9 } },
];
const corners = [{ at: [10.4, 9.7], kind: 'corner', of: 7, sure: true, within: 0.1 }, { at: [10.1, 10.1], kind: 'middle', of: 8 }, { at: [50.2, 50.1], kind: 'corner', of: 5 }, { at: [75, 70], kind: 'corner', of: 2 }];
const roofs = [{ at: [30.3, 5.2], eaveM: 3.1, label: 'east corner', sure: true, within: 0.2 }];
const r = resnap(pts, corners, roofs);
assert.deepEqual(pts[0].map, [10.4, 9.7], 'R1 back on its corner (a corner, not the nearer middle)');
assert.equal(pts[0].snap.of, 7);
assert.deepEqual(pts[1].map, [30.3, 5.2]); assert.equal(pts[1].roof.eaveM, 3.1);
assert.deepEqual(pts[2].map, [50, 50], 'a point placed by hand stays');
assert.deepEqual(pts[3].map, [70, 70], 'no corner within reach: it stays');
assert.deepEqual(r.moved.map((m) => m.name), ['R1', 'R2']);
assert.equal(resnap(pts, corners, roofs).moved.length, 0, 'a second pass moves nothing');
console.log('guide: ok');
