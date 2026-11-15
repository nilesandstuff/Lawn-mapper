// A map's thermal walks read back (src/thermal.js, dev only): which walks belong to a map, the runner's grid with the
// walker's notes laid over it, the admin only.
import assert from 'node:assert/strict';
import { thermal, noteWalk, walkOf } from '../src/thermal.js';

const objs = new Map();
const TWIN = {
  put: async (k, v) => { objs.set(k, typeof v === 'string' ? v : new TextDecoder().decode(v)); },
  get: async (k) => (objs.has(k) ? { text: async () => objs.get(k) } : null),
  list: async ({ prefix }) => ({ objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
};
const env = { TWIN };
const call = (path, admin = true, method = 'GET') => thermal(new Request(`https://scan.example.com${path}`, { method }), env, new URL(`https://scan.example.com${path}`), { isAdmin: async () => admin });
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));

assert.equal(await call('/api/scan/twin'), null, 'not its route');
assert.equal((await call('/api/scan/thermal?map=m1', false)).status, 404, 'not the admin: nothing');
assert.equal((await call('/api/scan/thermal?map=../x')).status, 400);
assert.deepEqual((await (await call('/api/scan/thermal?map=m1')).json()).walks, [], 'a map with no thermal walk');

assert.equal(await noteWalk(env, '1763000000000', enc({ map: '../x' })), null, 'a map named strictly');
assert.equal(await noteWalk(env, '1763000000000', enc({ map: 'm1', origin: [-85.5, 42.5] })), 'm1');
assert.equal(await noteWalk(env, '1763000900000', enc({ map: 'm1' })), 'm1');
assert.equal(await noteWalk(env, 'w', new Uint8Array([1, 2])), null, 'not JSON: nothing, and no throw');

// before the runner has been: listed as not converted, and the walk itself says so
let list = (await (await call('/api/scan/thermal?map=m1')).json()).walks;
assert.deepEqual(list.map((w) => w.walk), ['1763000900000', '1763000000000'], 'newest first');
assert.equal(list[0].error, 'not converted yet');
assert.equal((await call('/api/scan/thermal?map=m1&walk=1763000000000')).status, 404);
assert.equal((await call('/api/scan/thermal?map=m2&walk=1763000000000')).status, 404, 'another map\'s walk is not this map\'s');

// the runner's grid and status, and the walker's notes
objs.set('twins/1763000000000/thermal/grid.json', JSON.stringify({ started: 1, ended: 2, emissivity: 0.98, sky: { kind: 'sweep', T: -30, cloud_fraction: 0.2 }, cut: { maxAngle: 80 }, camera: 'usb-thermal', records: [{ e: 1, n: 2, tm: 5, T: 21.5, band: '0-60' }] }));
objs.set('twins/1763000000000/thermal/status.json', JSON.stringify({ ok: true, records: 1, at: 9, version: 3 }));
objs.set('twins/1763000000000/thermal-notes.json', JSON.stringify({ air: [{ T: 20.1, at: 1 }, { T: null, at: 2 }], wet: true, sprinklers: false, cloud: 'hazy' }));
const w = await (await call('/api/scan/thermal?map=m1&walk=1763000000000')).json();
assert.equal(w.walk, '1763000000000'); assert.equal(w.map, 'm1');
assert.deepEqual(w.origin, [-85.5, 42.5], 'the map\'s point as the walk kept it, for the main site to make the frame');
assert.equal(w.records.length, 1); assert.equal(w.sky.cloud_fraction, 0.2); assert.equal(w.emissivity, 0.98);
assert.deepEqual(w.air, [{ T: 20.1, at: 1, unit: 'C' }], 'air in C, said so; an empty reading left out');
assert.equal(w.wet, true); assert.equal(w.sprinklers, false); assert.equal(w.cloud, null, 'only the three words');
assert.equal(w.status.ok, true);
list = (await (await call('/api/scan/thermal?map=m1')).json()).walks;
assert.equal(list.find((x) => x.walk === '1763000000000').records, 1);

// no notes at all: the walk still reads
const bare = walkOf('w1', 'm1', { records: [] }, null, null);
assert.deepEqual([bare.air, bare.wet, bare.sprinklers, bare.cloud, bare.status], [[], null, null, null, null]);
// a failed conversion is said
objs.set('twins/1763000900000/thermal/status.json', JSON.stringify({ ok: false, error: 'tables differ' }));
const bad = await call('/api/scan/thermal?map=m1&walk=1763000900000');
assert.equal(bad.status, 404); assert.equal((await bad.json()).error, 'tables differ');
assert.equal((await call('/api/scan/thermal?map=m1', true, 'POST')).status, 405);
console.log('thermal: ok');
