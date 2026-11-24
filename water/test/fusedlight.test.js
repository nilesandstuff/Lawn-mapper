/**
 * THE SHADE MAP'S LIGHT WORKER ON A MODEL FILE AT TWO GRAINS (2026-11-24): the water map gives it the fused model, on
 * a grid twice as fine as its own, and asks for places in that finer grid's cells (public/analyse.js lightSession).
 * A made-up yard: one 4 m block 6 m tall. The same places, asked at 1 m and at half a metre, are shaded alike.
 */
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAT = 42, LNG = -85, K = Math.cos((LAT * Math.PI) / 180), X0 = -9462156, Y1 = 5160980;
function modelFile(cellM) {
  const n = Math.round(40 / cellM), nz = 12, dz = 1, mu = new Float32Array(n * n * nz), kind = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const e = (c + 0.5) * cellM, s = (r + 0.5) * cellM; // metres east, and south of the top edge
    if (e > 18 && e < 22 && s > 18 && s < 22) { kind[r * n + c] = 1; for (let l = 0; l < 6; l++) mu[(r * n + c) * nz + l] = 50; }
  }
  return { meta: { at: 'test', grid: { w: n, h: n, x0: X0, y1: Y1, cell: cellM / K, lat: LAT }, layers: { z0: 200, dz, nz } }, arrays: { mu, ground: new Float32Array(n * n).fill(200), kind } };
}
function session() {
  const w = new Worker(join(ROOT, 'builder/boot-worker.mjs'), { workerData: { file: join(ROOT, 'lib/shade/light-worker.js'), root: ROOT } });
  let waiting = null;
  w.on('message', (m) => { if (!waiting || m.type === 'progress') return; const k = waiting; waiting = null; if (m.type === 'error') k.reject(new Error(m.message)); else k.resolve(m); });
  w.on('error', (e) => { if (waiting) { waiting.reject(e); waiting = null; } });
  return { ask: (msg) => new Promise((resolve, reject) => { waiting = { resolve, reject }; w.postMessage(msg); }), close: () => w.terminate() };
}

const NOON = Date.UTC(2026, 5, 21, 17, 42); // the sun about 71 degrees up, due south
// metres east, metres south of the top edge: just north of the block (in its shadow), well north, south, beside
const PLACES = [[20, 17.2], [20, 12], [20, 26], [30, 20]];
const shadeAt = async (cellM) => {
  const s = session();
  try {
    const b = await s.ask({ type: 'model', file: modelFile(cellM), lat: LAT, lng: LNG, lot: [], lawn: [], canopy: 'measured' });
    assert.equal(b.w, Math.round(40 / cellM));
    const pts = new Float64Array(PLACES.length * 3);
    PLACES.forEach(([e, so], k) => { pts[3 * k] = e / cellM; pts[3 * k + 1] = so / cellM; pts[3 * k + 2] = NOON; });
    return Array.from((await s.ask({ type: 'samples', pts, heightM: 0.1 })).T);
  } finally { s.close(); }
};
const coarse = await shadeAt(1), fine = await shadeAt(0.5);
assert.ok(coarse[0] < 0.1 && fine[0] < 0.1, `just north of the block is in its shadow at both grains (${coarse[0]}, ${fine[0]})`);
for (const k of [1, 2, 3]) assert.ok(coarse[k] > 0.9 && fine[k] > 0.9, `place ${k} is in the sun at both grains (${coarse[k]}, ${fine[k]})`);
console.log('ok  a model file at 1 m and at half a metre: the same places shaded alike, asked in each grid\'s own cells');
console.log('\n1 passed');
