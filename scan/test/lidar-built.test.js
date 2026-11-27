// The lidar's built things on the walks' 1 ft squares (scan/tools/lidar-built.mjs): a lidar building 4 m east of the
// map's point lands 4 m east on the squares, a low structure keeps its kind and top, and trees are left out.
import assert from 'node:assert/strict';
import { lidarOnSquares, localToMerc, mercToLocal } from '../tools/lidar-built.mjs';

const origin = [-80, 35];
for (const p of [[0, 0], [12.5, -40], [-200, 150]]) {
  const back = mercToLocal(origin, localToMerc(origin, p));
  assert.ok(Math.abs(back[0] - p[0]) < 1e-6 && Math.abs(back[1] - p[1]) < 1e-6, 'local to 3857 and back');
}
// a 20 x 20 grid of 1 m (in 3857 units, scaled by 1/cos lat) whose corner is 10 m west and 10 m north of the point
const k = 1 / Math.cos((origin[1] * Math.PI) / 180);
const [ox, oy] = localToMerc(origin, [-10, 10]);
const w = 20, h = 20, kind = new Uint8Array(w * h), top = new Float32Array(w * h).fill(NaN);
for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
  if (c >= 14 && c < 18 && r >= 8 && r < 12) { kind[r * w + c] = 1; top[r * w + c] = 6.2; }   // a building 4-8 m east, 2 m south to 2 m north
  if (c >= 2 && c < 4 && r >= 2 && r < 4) { kind[r * w + c] = 4; top[r * w + c] = 1.1; }    // a shed
  if (c >= 6 && c < 8 && r >= 14 && r < 16) kind[r * w + c] = 2;                          // a tree
}
const model = { meta: { grid: { w, h, x0: ox, y1: oy, cell: k, cellY: k } }, arrays: { kind, top } };
const g = lidarOnSquares(model, origin);
const at = (e, n) => { const c = Math.floor(e / g.cellM) - g.i0, r = Math.floor(n / g.cellM) - g.j0; return [g.kinds[r * g.w + c], g.tops[r * g.w + c]]; };
assert.deepEqual(at(6, 0), [1, 62], 'the building, 6 m east, its top 6.2 m');
assert.deepEqual(at(3, 0)[0], 0, '3 m east: west of the building');
assert.deepEqual(at(-7.5, 7.5), [4, 11], 'the shed');
assert.equal(at(-3.5, -4.5)[0], 0, 'the tree is not a built thing');
console.log('lidar-built: ok');
