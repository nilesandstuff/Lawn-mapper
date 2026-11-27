// scan/lib/planes.js: every plane the walk saw is kept. node scan/test/planes.test.js
import assert from 'node:assert/strict';
import { mergePlanes } from '../lib/planes.js';

const wall = (id, x, t = 0) => [id, 2, t, [x, 0, 0, x, 1, 0, x, 1, 1]];
let k = mergePlanes(null, [wall(1, 0), wall(2, 5)]);
assert.equal(k.length, 2);
k = mergePlanes(k, [wall(2, 6), [3, 0, 0, [0, 0, 0, 1, 0, 0, 1, 0, 1]]]);   // plane 1 dropped by ARCore, plane 2 grew
assert.deepEqual(k.map((p) => p[0]).sort(), [1, 2, 3], 'a plane ARCore dropped is kept');
assert.equal(k.find((p) => p[0] === 1)[2], 2, 'marked no longer held');
assert.equal(k.find((p) => p[0] === 2)[3][0], 6, 'the latest outline of an id');
assert.equal(k.find((p) => p[0] === 2)[2], 0);
k = mergePlanes(k, [wall(1, 1)]);
assert.equal(k.find((p) => p[0] === 1)[2], 0, 'seen again: held again');
assert.equal(mergePlanes(k, [null, [9]]).length, 3, 'broken entries ignored');
console.log('planes: ok');
