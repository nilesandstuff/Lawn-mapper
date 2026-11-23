// The fused model made when a walk's side changes (scan/lib/fuse-walk.js), through the fusing's one module
// (public/shade/fuse.js), against a stand-in for the main site's /api/maps/model. node scan/test/fuse-walk.test.js
import assert from 'node:assert/strict';
import { fuseWalk, madeFromOf } from '../lib/fuse-walk.js';
import * as F from '../../public/shade/fuse.js';
import { modelFiles } from '../../public/shade/model-out.js';
import { loadModel, packModel, unpackModel } from '../../public/lib/lidar-model.js';
import { toMerc, fromMerc, mercScale } from '../../public/shade/ept.js';
import { gridOver } from '../../public/shade/grid.js';

// a 30 m lot: a lidar tree, and a walk that saw a hedge the lidar never did (as tools/shade.test.js makes them)
const lat = 43, k = mercScale(lat), [bx, by] = toMerc([-85, lat]);
const g = gridOver([bx, by, bx + 30 / k, by + 30 / k], 1, lat);
const W = g.w, H = g.h, nz = 15, z0 = 98, dz = 1;
const ground = new Float32Array(W * H).fill(100), kind = new Uint8Array(W * H), mu = new Float32Array(W * H * nz);
const colAt = (e, n) => Math.floor(H - n) * W + Math.floor(e);
for (let e = 0.5; e < 30; e++) for (let n = 0.5; n < 30; n++) {
  const c = colAt(e, n);
  if (Math.hypot(e - 10, n - 15) <= 3) { kind[c] = 2; for (let z = 1.5; z <= 9; z++) mu[c * nz + Math.floor(100 + z - z0)] = 1.0; }
}
const meta = { v: 1, at: 'L', grid: { w: W, h: H, x0: g.x0, y1: g.y1, cell: g.cell, cellY: g.cellY || g.cell, lat }, layers: { z0, dz, nz }, fences: [] };
const origin = fromMerc([g.x0, g.y1 - H * (g.cellY || g.cell)]);
const cm = 0.3048, boxes = [];
for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) { const e = (i + 0.5) * cm, n = (j + 0.5) * cm; if (e > 2 && e < 6 && n > 24 && n < 25) boxes.push([i, j, 0, 15]); }
const plants = { v: 1, cellM: cm, boxes, walk: 'w1', at: '2026-11-23T12:00:00.000Z' };

// the main site, standing in: objects by url, each with its time and what it was made from
const store = new Map();
const lidarBytes = new Uint8Array(await packModel(meta, { ground, kind, mu, muOn: Float32Array.from(mu) }));
store.set('lidar', { bytes: lidarBytes, at: '2026-11-23T10:00:00.000Z' });
let puts = 0, gets = 0;
const fetchFn = async (url, init = {}) => {
  const u = new URL(url, 'https://x'), key = u.searchParams.get('file') === 'fused' ? `fused${u.searchParams.get('part') ? `.${u.searchParams.get('part')}` : ''}` : `lidar${u.searchParams.get('part') ? `.${u.searchParams.get('part')}` : ''}`;
  const method = init.method || 'GET';
  if (method === 'PUT') { puts++; if (key.startsWith('lidar')) throw new Error('THE LIDAR FILE WAS WRITTEN'); store.set(key, { bytes: new Uint8Array(init.body), at: `put-${puts}`, madeFrom: init.headers?.['X-Model-Made-From'] || null }); return new Response('{}', { status: 200 }); }
  const o = store.get(key);
  if (!o) return new Response(null, { status: 404 });
  if (method === 'GET') gets++;
  const headers = { 'X-Model-At': o.at, ...(o.madeFrom ? { 'X-Model-Made-From': o.madeFrom } : {}) };
  return new Response(method === 'HEAD' ? null : o.bytes, { status: 200, headers });
};
const args = { fetchFn, map: 'm', plants, origin, F, loadModel, modelFiles };

// the first time: fused, and kept beside the lidar with what it was made from
const r1 = await fuseWalk(args);
assert.equal(r1.made, true, JSON.stringify(r1));
assert.equal(store.get('fused').madeFrom, madeFromOf('2026-11-23T10:00:00.000Z', plants.at, F.FUSE_VERSION));
assert.ok(r1.stats.added > 0, 'the hedge the lidar never saw is in it');
const fused = await unpackModel(store.get('fused').bytes.buffer);
assert.equal(fused.meta.grid.w, W * 2, 'a half-metre grid');
assert.ok(store.get('lidar').bytes === lidarBytes && store.get('lidar').at === '2026-11-23T10:00:00.000Z', 'the lidar file is as it was');
// again with nothing changed: nothing downloaded, nothing written
const p0 = puts, g0 = gets;
const r2 = await fuseWalk(args);
assert.equal(r2.made, false); assert.match(r2.why, /already made/); assert.equal(puts, p0); assert.equal(gets, g0);
// the walk's side changed: made again
const r3 = await fuseWalk({ ...args, plants: { ...plants, at: '2026-11-24T09:00:00.000Z' } });
assert.equal(r3.made, true); assert.ok(puts > p0);
// the lidar rebuilt: made again; no lidar model: said so; no plants: said so; the page moved on: given up, nothing written
store.get('lidar').at = '2026-11-25T08:00:00.000Z';
assert.equal((await fuseWalk({ ...args, plants: { ...plants, at: '2026-11-24T09:00:00.000Z' } })).made, true);
const p1 = puts;
assert.match((await fuseWalk({ ...args, plants: { ...plants, at: 'later' }, still: () => false })).why, /given up/); assert.equal(puts, p1);
assert.match((await fuseWalk({ ...args, plants: { ...plants, boxes: [] } })).why, /no plants/);
store.delete('lidar');
assert.match((await fuseWalk({ ...args, plants: { ...plants, at: 'x' } })).why, /no lidar model/);
console.log('fuse-walk: ok');
