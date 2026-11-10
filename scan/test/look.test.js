// scan/lib/look.js: how the lidar looks in the camera (for the eye only). node scan/test/look.test.js
import assert from 'node:assert/strict';
import { lookGrids, heightMesh, lookMeshes, LOOK, SHOW_CELL } from '../lib/look.js';

// a 6 m x 4 m patch on 0.25 m cells: a 3 m x 2 m house (roof 3 m at the eaves, 4 m at the ridge), its walls a ring one
// cell in from the roof's edge; a shed (object) and a trunk post outside it; a tree column over the trunk
const cell = 0.25, W = 24, H = 16, N = W * H;
const G = { box: [0, 0, 6, 4], cell, W, H, dem: new Float32Array(N).fill(10), occ: new Uint8Array(N), occTop: new Float32Array(N), bld: new Uint8Array(N) };
const roofH = new Float32Array(N).fill(NaN);
for (let r = 4; r < 12; r++) for (let c = 4; c < 16; c++) {
  const k = r * W + c; G.bld[k] = 1; roofH[k] = 13 + (1 - Math.abs(r - 7.5) / 4);           // a ridge along the middle rows
  if (r === 5 || r === 10 || c === 5 || c === 14) if (r >= 5 && r <= 10 && c >= 5 && c <= 14) { G.occ[k] = 1; G.occTop[k] = 3; }
}
for (let r = 2; r < 4; r++) for (let c = 19; c < 22; c++) { const k = r * W + c; G.occ[k] = 1; G.occTop[k] = 1.2; }   // the shed
{ const k = 13 * W + 20; G.occ[k] = 1; G.occTop[k] = 2.4; }                                                              // the trunk
// the shade map's columns, 1 m: 6 x 4, the tree in the column over the trunk (east 5-6, north 0-1 -> row 3, col 5)
const cols = { w: 6, h: 4, e0: 0, n1: 4, cellE: 1, cellN: 1, tree: new Uint8Array(24), lo: new Float32Array(24).fill(NaN), hi: new Float32Array(24).fill(NaN) };
cols.tree[3 * 6 + 5] = 1; cols.lo[3 * 6 + 5] = 12.4; cols.hi[3 * 6 + 5] = 18;
cols.tree[3 * 6 + 4] = 1; cols.lo[3 * 6 + 4] = 13; cols.hi[3 * 6 + 4] = 17;

const show = lookGrids(G, (k) => roofH[k], cols);
assert.equal(show.cell, SHOW_CELL); assert.equal(show.W, 12); assert.equal(show.H, 8);
const at = (g, R, C) => [g.lo[R * show.W + C], g.hi[R * show.W + C]];
const count = (g) => g.hi.reduce((s, v) => s + (Number.isNaN(v) ? 0 : 1), 0);
assert.equal(count(show.roof), 6 * 4, 'the roof is the cells under the building, on 0.5 m');
assert.ok(at(show.roof, 3, 4)[1] > at(show.roof, 2, 4)[1], 'the ridge stands over the eaves');
assert.ok(Math.abs(at(show.roof, 2, 4)[1] - at(show.roof, 2, 4)[0] - 0.25) < 1e-6, 'a thin sheet');
assert.ok(count(show.wall) > 8 && count(show.wall) < 24, 'walls are a ring, not the whole footprint');
for (let j = 0; j < show.W * show.H; j++) if (!Number.isNaN(show.wall.hi[j])) { assert.equal(show.wall.lo[j], 10); assert.ok(show.wall.hi[j] <= show.roof.lo[j] + 1e-6, 'a wall stops under its roof'); }
assert.equal(count(show.object), 2, 'the shed: two 0.5 m cells'); assert.deepEqual(at(show.object, 1, 10).map((v) => +v.toFixed(2)), [10, 11.2]);
assert.equal(count(show.trunk), 1, 'the trunk is a tree\'s, not an object'); assert.deepEqual(at(show.trunk, 6, 10).map((v) => +v.toFixed(2)), [10, 12.4]);
assert.equal(count(show.canopy), 8, 'two tree columns of 1 m: eight 0.5 m cells'); assert.deepEqual(at(show.canopy, 7, 11).map((v) => +v.toFixed(1)), [12.4, 18]);

// one kind as a smooth surface: a corner shared by cells stands at their mean; sides only at the kind's edge
const g2 = { cell: 0.5, W: 2, H: 1, e0: 0, n1: 1 };
const m = heightMesh(g2, Float32Array.from([0, 0]), Float32Array.from([2, 4]), { bottom: true });
assert.equal(m.top.length, 2 * 6 * 3); assert.equal(m.bottom.length, 2 * 6 * 3);
assert.equal(m.ns.length, 4 * 6 * 3, 'north and south of both cells'); assert.equal(m.ew.length, 2 * 6 * 3, 'the two ends only: no side between the cells');
const ys = []; for (let i = 1; i < m.top.length; i += 3) ys.push(m.top[i]);
assert.deepEqual([...new Set(ys)].sort(), [2, 3, 4], 'the shared corners at the mean of 2 and 4');
// east, height, north: the first cell's north-west corner is at (0, 2, 1)
assert.deepEqual(m.top.slice(0, 3), [0, 2, 1]);
assert.equal(heightMesh(g2, Float32Array.from([NaN, NaN]), Float32Array.from([NaN, NaN])).top.length, 0);

// every kind with its colour: black roofs, white walls, orange objects, green trees
const parts = lookMeshes(show);
const col = (kind) => parts.find((p) => p.kind === kind && p.part === 'top').color;
assert.ok(col('roof').slice(0, 3).every((v) => v < 0.1), 'roofs black');
assert.ok(col('wall').slice(0, 3).every((v) => v > 0.9), 'walls white');
assert.ok(col('object')[0] > 0.9 && col('object')[2] < 0.3, 'objects orange');
assert.ok(col('canopy')[1] > col('canopy')[0] && col('canopy')[1] > col('canopy')[2], 'trees green');
assert.ok(Object.values(LOOK).every((k) => Object.values(k).every((c) => c[3] >= 0.6)), 'drawn solidly, not faint');
assert.ok(parts.every((p) => p.verts.length % 9 === 0));
console.log('look: ok');
