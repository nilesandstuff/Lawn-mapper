// The map's reference over the site's route (scan/src/twin.js reference): a map's id as admin saves have them.
import assert from 'node:assert/strict';
import { reference, MAP } from '../src/twin.js';

const objs = new Map();
const TWIN = {
  put: async (k, v) => { objs.set(k, v instanceof ArrayBuffer ? new Uint8Array(v) : v); },
  get: async (k) => (objs.has(k) ? { body: objs.get(k), uploaded: new Date(), customMetadata: {} } : null),
  head: async (k) => (objs.has(k) ? { size: 3, uploaded: new Date(), customMetadata: {} } : null),
};
const env = { TWIN };
const call = (q, method = 'GET', body) => reference(new Request(`https://scan.example.com/api/scan/reference?${q}`, { method, body }), env, new URL(`https://scan.example.com/api/scan/reference?${q}`), { isAdmin: async () => true });

// THE OWNER'S HOME MAP (2026-11-16): an admin save's id, 86 characters with |, spaces and commas, was refused ("which
// map?") and the page called it "no signal". Made up here, the same kinds of characters.
const id = 'user|12345|Somewhere Rd, Sometown, ST 00000|' + 'x'.repeat(40);
assert.ok(MAP.test(id), 'such an id is a map');
const q = `map=${encodeURIComponent(id)}`;
assert.equal((await call(q)).status, 404, 'none yet');
const put = await call(`${q}&walk=1794780697283`, 'PUT', new Uint8Array([1, 2, 3]));
assert.equal(put.status, 200, 'kept');
assert.ok(objs.has(`refs/${id}.bin`), 'under refs/<id>.bin, as reference-build.mjs writes it');
assert.equal((await call(q)).status, 200, 'read back');
assert.equal((await call(`${q}&meta=1`)).status, 200, 'and its meta');
assert.equal((await call(`map=${encodeURIComponent('a/b')}`)).status, 400, 'a slash is still refused');
assert.equal((await call('map=')).status, 400, 'and no map');
console.log('reference route (any map id): ok');

// THE THINGS PLACED ON A MAP (src/twin.js things): none reads as an empty list; a list is kept and read back; the one
// it replaces is backed up; rubbish is refused; not the admin: not found.
{ const { things } = await import('../src/twin.js');
  const at = (q, method = 'GET', body, admin = true) => things(new Request(`https://scan.example.com/api/scan/things?${q}`, { method, body }), env, new URL(`https://scan.example.com/api/scan/things?${q}`), { isAdmin: async () => admin });
  assert.deepEqual(await (await at(q)).json(), { v: 1, things: [] });
  const list = { v: 1, things: [{ id: 't1', kind: 'sprinkler', at: [3, 4], h: 0, grade: 'corners3', seen: [] }, { id: 't2', kind: 'nonsense', at: [1, 1] }] };
  assert.equal((await at(`${q}&walk=1`, 'PUT', JSON.stringify(list))).status, 200);
  const back = await (await at(q)).json();
  assert.equal(back.things.length, 1, 'a kind the site does not know is dropped'); assert.equal(back.things[0].id, 't1');
  assert.equal((await at(q, 'PUT', JSON.stringify({ v: 1, things: [] }))).status, 200);
  assert.ok([...objs.keys()].some((k) => k.startsWith(`things/backup/${id}-`)), 'the list it replaced is kept');
  assert.equal((await at(q, 'PUT', 'not json')).status, 400);
  assert.equal((await at(q, 'GET', undefined, false)).status, 404);
  console.log('things route: ok'); }
