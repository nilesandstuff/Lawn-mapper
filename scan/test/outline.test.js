/**
 * scan/lib/outline.js: straight things made straight. A house turned 20 degrees, put on 1 m columns the way the shade
 * map's model has it, comes back with straight sides and corners within a few centimetres of the truth; an L-shaped
 * house keeps its six corners; a thin wall becomes one line; a trunk one point.
 *   node scan/test/outline.test.js
 */
import assert from 'node:assert/strict';
import { ringsOfMask, straighten, offsetRing, fillRings, lineOfPatch, postOf, patchesOf, areaOf, drawSegment } from '../lib/outline.js';

const inPoly = (poly, x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
// a polygon in metres (x east, y north) on a w x h grid of 1 m columns whose top-left corner is (0, h)
function columns(poly, w, h) {
  const m = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (inPoly(poly, c + 0.5, h - r - 0.5)) m[r * w + c] = 1;
  return m;
}
const toM = (h) => (ring) => ring.map(([x, y]) => [x, h - y]); // grid units (y down) to metres (y up)
const nearestCorner = (ring, p) => Math.min(...ring.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));

// a 14 x 9 m house turned 20 degrees
{
  const th = (20 * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th), cx = 20, cy = 15;
  const truth = [[-7, -4.5], [7, -4.5], [7, 4.5], [-7, 4.5]].map(([x, y]) => [cx + c * x - s * y, cy + s * x + c * y]);
  const W = 40, H = 30, mask = columns(truth, W, H);
  const rings = ringsOfMask(mask, W, H).map(toM(H));
  assert.equal(rings.length, 1, 'one outline');
  const stairs = rings[0], straight = straighten(stairs);
  assert.equal(straight.length, 4, `four corners: ${straight.length}`);
  for (const p of truth) assert.ok(nearestCorner(straight, p) < 0.3, `a corner within 30 cm: ${nearestCorner(straight, p).toFixed(2)}`);
  const worst = Math.max(...truth.map((p) => nearestCorner(stairs, p)));
  assert.ok(worst > 0.3, `the staircase alone is worse: ${worst.toFixed(2)}`);
  // its sides are square to each other
  const dir = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  for (let i = 0; i < 4; i++) { const d = Math.abs(((dir(straight[i], straight[(i + 1) % 4]) - dir(straight[(i + 1) % 4], straight[(i + 2) % 4])) * 180) / Math.PI) % 180; assert.ok(Math.abs(d - 90) < 0.01, `square: ${d}`); }
  // 2 ft in: the walls
  const walls = offsetRing(straight, 0.61);
  assert.ok(Math.abs(Math.abs(areaOf(walls)) - (14 - 1.22) * (9 - 1.22)) < 2.5, `the walls' area: ${Math.abs(areaOf(walls)).toFixed(1)}`);
  // filled on a 0.25 m grid: the inside in, the outside out
  const box = [0, 0, 40, 30], fine = fillRings([straight], box, 0.25), at = (x, y) => fine[Math.floor((30 - y) / 0.25) * 160 + Math.floor(x / 0.25)];
  assert.equal(at(cx, cy), 1); assert.equal(at(2, 2), 0);
  let n = 0; for (const v of fine) n += v;
  assert.ok(Math.abs(n * 0.0625 - 126) < 4, `126 m2 filled: ${(n * 0.0625).toFixed(1)}`);
}
// an L-shaped house, square to the grid: six corners
{
  const truth = [[5, 5], [21, 5], [21, 12], [12, 12], [12, 20], [5, 20]];
  const W = 30, H = 25, rings = ringsOfMask(columns(truth, W, H), W, H).map(toM(H));
  const straight = straighten(rings[0]);
  assert.equal(straight.length, 6, `six corners: ${straight.length}`);
  for (const p of truth) assert.ok(nearestCorner(straight, p) < 0.05, `on the corner: ${nearestCorner(straight, p)}`);
}
// two patches touching only at a corner stay two outlines
{
  const m = new Uint8Array(16); m[0] = m[1] = m[4] = m[5] = 1; m[10] = m[11] = m[14] = m[15] = 1;
  assert.equal(ringsOfMask(m, 4, 4).length, 2);
}
// a stone wall 9 columns long and one wide, turned: one segment through its middle; a shed's square patch: none
{
  const pts = []; for (let i = 0; i < 9; i++) pts.push([10 + i * 0.94, 5 + i * 0.34]);
  const seg = lineOfPatch(pts);
  assert.ok(seg, 'a line');
  assert.ok(Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]) > 8.5, 'as long as the wall');
  const shed = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) shed.push([i, j]);
  assert.equal(lineOfPatch(shed), null);
  const m = drawSegment(new Uint8Array(40 * 40), [0, 0, 10, 10], 0.25, [1, 5.1], [9, 5.1]);
  let n = 0; for (const v of m) n += v;
  assert.ok(n >= 32 && n <= 34, `a one-cell-wide line: ${n} cells`);
}
// a trunk on two columns, most of its returns in the east one: the post leans east
{
  const p = postOf([[10.5, 5.5], [11.5, 5.5]], [1, 3]);
  assert.ok(Math.abs(p[0] - 11.25) < 1e-9 && Math.abs(p[1] - 5.5) < 1e-9);
  assert.deepEqual(postOf([[1, 1], [3, 1]]), [2, 1]);
}
// patches, eight-connected
{
  const m = new Uint8Array(25); m[0] = m[6] = m[12] = 1; m[4] = 1;
  assert.equal(patchesOf(m, 5, 5).length, 2);
}
console.log('outline: ok');
