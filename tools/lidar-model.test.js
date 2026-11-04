import assert from 'node:assert/strict';
import { encodeModel, decodeModel, columnAt, modelUsable } from '../public/lib/lidar-model.js';

const grid = { w: 3, h: 2, x0: 100, y1: 200, cell: 1, cellY: 1.2, lat: 42 };
const meta = { tool: 'shade', at: '2026-11-04T00:00:00Z', grid, layers: { z0: 90, dz: 1, nz: 2 } };
const ground = Float32Array.from([1, 2, 3, 4, 5, 6]), kind = Uint8Array.from([0, 1, 2, 3, 4, 5]);
const mu = Float32Array.from({ length: 12 }, (_, i) => i / 10), why = Uint8Array.from([0, 1, 4, 5, 8, 9]);
const buf = encodeModel(meta, { ground, kind, why, mu, missing: null });
const m = decodeModel(buf);
assert.equal(m.meta.v, 1); assert.equal(m.meta.tool, 'shade'); assert.deepEqual(m.meta.grid, grid);
assert.deepEqual([...m.arrays.ground], [...ground]); assert.deepEqual([...m.arrays.kind], [...kind]);
assert.deepEqual([...m.arrays.mu], [...mu]); assert.ok(m.arrays.ground instanceof Float32Array && m.arrays.kind instanceof Uint8Array);
assert.equal(m.arrays.missing, undefined, 'a null array is left out');
assert.ok(m.arrays.ground.byteOffset === 0, 'copies, aligned');
// odd lengths keep every later array on a 4-byte boundary
const odd = decodeModel(encodeModel(meta, { kind: Uint8Array.from([1, 2, 3]), ground: Float32Array.from([7.5]) }));
assert.equal(odd.arrays.ground[0], 7.5);
// a Uint8Array view over the same bytes decodes too
assert.equal(decodeModel(new Uint8Array(buf)).arrays.kind[3], 3);
assert.throws(() => decodeModel(new ArrayBuffer(16)), /not a lidar model/);
assert.equal(columnAt(grid, 100.5, 199.5), 0); assert.equal(columnAt(grid, 102.5, 198.5), 5); assert.equal(columnAt(grid, 99, 199), -1);
assert.ok(modelUsable(m)); assert.ok(!modelUsable({ meta: { grid }, arrays: { ground } }));
console.log('lidar-model: ok');
