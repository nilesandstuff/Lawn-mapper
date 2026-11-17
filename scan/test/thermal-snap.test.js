// DEV ONLY: single thermal photos kept and read back (src/thermal-snap.js): listed once their notes arrive, read with
// the converter's answer and where the owner placed them, and placed with their spot checked.
import assert from 'node:assert/strict';
import { noteSnap, snapOf, snapsList, snapPng, placeSnap, checkPlace, SNAP_ID } from '../src/thermal-snap.js';
import { PART } from '../src/twin.js';

const objs = new Map();
const TWIN = {
  put: async (k, v) => { objs.set(k, typeof v === 'string' ? v : new TextDecoder().decode(v)); },
  get: async (k) => (objs.has(k) ? { text: async () => objs.get(k), arrayBuffer: async () => new TextEncoder().encode(objs.get(k)).buffer } : null),
  head: async (k) => (objs.has(k) ? { uploaded: new Date() } : null),
  list: async ({ prefix }) => ({ objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
};
const env = { TWIN };
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));

assert.ok(SNAP_ID.test('snap-1763400000000') && !SNAP_ID.test('1763400000000') && !SNAP_ID.test('snap-../x'), 'an id a walk cannot have');
assert.ok(PART.test('thermal-snap.json') && !PART.test('thermal-snap-place.json'), 'the notes go up as a twin part; the placement only by the site');

assert.equal(await noteSnap(env, '1763400000000', enc({ at: 1763400000000 })), null, 'not a photo id');
assert.equal(await noteSnap(env, 'snap-1763400000000', new Uint8Array([1])), null, 'not JSON: nothing, no throw');
// the notes arrive only once thermal.bin is whole (the app sends them after it)
for (const [id, map] of [['snap-1763400000000', null], ['snap-1763400600000', 'm1'], ['snap-1763300000000', 'm2']]) {
  objs.set(`twins/${id}/thermal-snap.json`, JSON.stringify({ kind: 'snap', at: Number(id.slice(5)), map, label: 'front', air_C: 18.5, emissivity: 0.98, rotation: { q: [1, 0, 0, 0], display_rotation: 0 } }));
  assert.equal(await noteSnap(env, id, enc({ at: Number(id.slice(5)), map })), id);
}
let list = await snapsList(env);
assert.deepEqual(list.map((s) => s.id), ['snap-1763400600000', 'snap-1763400000000', 'snap-1763300000000'], 'newest first');
assert.ok(list.every((s) => !s.placed && !s.converted));
assert.deepEqual((await snapsList(env, { map: 'm1' })).map((s) => s.id), ['snap-1763400600000', 'snap-1763400000000'], 'the map\'s, and those tied to no map yet');
assert.deepEqual((await snapsList(env, { map: 'm1', loose: false })).map((s) => s.id), ['snap-1763400600000']);
assert.deepEqual((await snapsList(env, { since: 1763350000000 })).length, 2, 'a day\'s');

let one = await snapOf(env, 'snap-1763400000000');
assert.equal(one.snap, null, 'not converted yet'); assert.equal(one.place, null); assert.equal(one.air_C, 18.5); assert.deepEqual(one.rotation.q, [1, 0, 0, 0]);
assert.equal(await snapOf(env, 'snap-1999999999999'), null);

// placed: the spot checked, then the photo is that map's
assert.match(checkPlace({ lng: 200, lat: 1 }).error, /lng and lat/);
assert.match(checkPlace({ lng: 1, lat: 1, heading: 400 }).error, /heading/);
assert.match(checkPlace({ lng: 1, lat: 1, map: 'a/b' }).error, /map/);
assert.equal((await placeSnap(env, 'snap-1999999999999', { lng: 1, lat: 1 })).error, 'Not found');
const pl = await placeSnap(env, 'snap-1763400000000', { lng: -85.6, lat: 42.9, heading: 270, map: 'm2' });
assert.ok(pl.ok); assert.equal(pl.place.heading, 270);
assert.deepEqual((await snapsList(env, { map: 'm2', loose: false })).map((s) => s.id), ['snap-1763400000000', 'snap-1763300000000'], 'placed on m2, it is m2\'s');
// the converter's answer and preview
objs.set('twins/snap-1763400000000/thermal/snap.json', JSON.stringify({ kind: 'snap', T: [[20.1]], emissivity: 0.98 }));
objs.set('twins/snap-1763400000000/thermal/status.json', JSON.stringify({ ok: true, at: 5 }));
objs.set('twins/snap-1763400000000/thermal/snap.png', 'PNG');
one = await snapOf(env, 'snap-1763400000000');
assert.equal(one.snap.T[0][0], 20.1); assert.equal(one.status.ok, true); assert.equal(one.place.lng, -85.6);
assert.ok((await snapsList(env, { map: 'm2' })).find((s) => s.id === 'snap-1763400000000').converted);
assert.equal((await snapPng(env, 'snap-1763400000000')).type, 'image/png');
assert.equal(await snapPng(env, '../x'), null);
console.log('thermal-snap: ok');
