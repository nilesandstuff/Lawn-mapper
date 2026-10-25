/**
 * The ground in 3D (public/view3d.js groundMesh): the mesh made from the analysis grid.
 *   node water/test/view3d.test.js
 */

import assert from 'node:assert/strict';
import { groundMesh } from '../public/view3d.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a plane rising 2% to the east: heights above the lowest, normals leaning west, the texture spread over the grid', () => {
  const W = 50, H = 40, cell = 1, z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) z[r * W + c] = 200 + 0.02 * c;
  const m = groundMesh({ W, H, cell, z, uv: (c, r) => [c / (W - 1), r / (H - 1)] });
  assert.equal(m.w, 50); assert.equal(m.h, 40); assert.equal(m.idx.length, 49 * 39 * 6);
  assert.ok(Math.abs(m.zRange - 0.02 * 48) < 0.03, `${m.zRange}`); // the 1st to 99th percentile
  const k = 20 * 50 + 25;
  assert.ok(Math.abs(m.norm[k * 3] - -0.02 / Math.hypot(0.02, 1)) < 1e-4, 'the normal leans away from the rise');
  assert.ok(Math.abs(m.norm[k * 3 + 1]) < 1e-6);
  assert.deepEqual([...m.uv.slice(0, 2)], [0, 0]); assert.deepEqual([...m.uv.slice(-2)], [1, 1]);
  // x east and y north about the middle
  assert.equal(m.pos[0], -24.5); assert.equal(m.pos[1], 19.5);
});

test('holes take the ground round them; a big grid is drawn every few cells', () => {
  const W = 30, H = 30, z = new Float32Array(W * H).fill(100);
  for (let r = 10; r < 13; r++) for (let c = 10; c < 13; c++) z[r * W + c] = NaN; // a roof
  const m = groundMesh({ W, H, cell: 1, z, uv: () => [0, 0] });
  assert.ok([...m.pos].every(Number.isFinite));
  const big = groundMesh({ W: 1000, H: 600, cell: 1, z: new Float32Array(600000).fill(5), uv: () => [0, 0] });
  assert.ok(big.w <= 250 && big.step === 4, `${big.w} x ${big.h}, every ${big.step}`);
  assert.ok(big.idx instanceof Uint16Array || big.idx instanceof Uint32Array);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water 3D: ${tests.length} passed`);
