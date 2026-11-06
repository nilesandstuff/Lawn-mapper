// Shared days, live: created from a plan, ticked from any phone, re-split without overwriting each other.
import assert from 'node:assert/strict';
import worker, { api } from '../src/index.js';
import { newId } from '../src/share.js';
import { testDb } from './d1.js';

const data = new Map();
const kv = { get: async (k) => data.get(k) ?? null, put: async (k, v) => { data.set(k, v); }, delete: async (k) => data.delete(k) };
const env = { ROUTE: kv, USAGE: testDb() };
const call = (path, init = {}) => {
  const url = new URL(`https://route.example.com${path}`);
  return api(new Request(url, init), env, url, async () => new Response('no'));
};
const send = (path, method, body) => call(path, { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const stop = (i) => ({ address: `${i} Elm St`, city: 'Town', minutes: 20, lng: -85.7 + i / 100, lat: 42.8 });
const plan = { at: 1, shop: { label: 'Shop', lng: -85.7, lat: 42.8 }, people: [{ name: 'Pat', stops: [stop(1), stop(2), stop(3)], legs: [{ duration: 600, distance: 5000 }, { duration: 300, distance: 2000 }, { duration: 900, distance: 8000 }] }] };

let res = await send('/api/share', 'POST', { plan });
assert.equal(res.status, 201);
const { id } = await res.json();
assert.match(id, /^[A-Za-z0-9]{12}$/);
let doc = await (await call(`/api/share/${id}`)).json();
assert.equal(doc.version, 1);
assert.deepEqual(doc.people[0].stops, ['s1', 's2', 's3']);
assert.equal(doc.people[0].name, 'Pat');

// ticked from one phone, seen by another
res = await send(`/api/share/${id}/tick`, 'POST', { stop: 's1', done: true, by: 'Pat' });
doc = await res.json();
assert.equal(doc.version, 2);
assert.equal(doc.stops.s1.done.by, 'Pat');
assert.equal((await (await call(`/api/share/${id}`)).json()).stops.s1.done.by, 'Pat');
res = await send(`/api/share/${id}/tick`, 'POST', { stop: 's1', done: false });
assert.equal((await res.json()).stops.s1.done, null, 'untick');
assert.equal((await send(`/api/share/${id}/tick`, 'POST', { stop: 's9', done: true })).status, 400);

// a helper joins and takes a stop: saved over the version it read
doc = await (await call(`/api/share/${id}`)).json();
const people = structuredClone(doc.people);
people[0].stops = ['s1', 's2'];
people.push({ id: 'h1', name: 'Sam', stops: ['s3'], into: { s3: { duration: 120, distance: 900 } }, back: { duration: 900, distance: 8000 }, readyAt: 5, start: { lng: -85.6, lat: 42.9, label: 'x' }, free: true, helper: true, evil: 'dropped' });
res = await send(`/api/share/${id}`, 'PUT', { version: doc.version, people, events: ['Sam took 1 stop (1 from Pat)'] });
assert.equal(res.status, 200);
const after = await res.json();
assert.equal(after.people[1].name, 'Sam');
assert.equal(after.people[1].evil, undefined, 'only the fields a person has');
assert.equal(after.events.at(-1).text, 'Sam took 1 stop (1 from Pat)');
assert.equal(after.version, doc.version + 1);

// a second phone, still on the old version: refused, and handed the doc as it is now
res = await send(`/api/share/${id}`, 'PUT', { version: doc.version, people: doc.people });
assert.equal(res.status, 409);
assert.equal((await res.json()).doc.version, after.version);
// an update that loses a stop: refused
const lose = structuredClone(after.people);
lose[1].stops = [];
res = await send(`/api/share/${id}`, 'PUT', { version: after.version, people: lose });
assert.equal(res.status, 400);
// a tick does not lose a re-split, nor the other way round: each re-reads
await send(`/api/share/${id}/tick`, 'POST', { stop: 's3', done: true, by: 'Sam' });
const final = await (await call(`/api/share/${id}`)).json();
assert.deepEqual(final.people[1].stops, ['s3']);
assert.ok(final.stops.s3.done);

// a day shared before days went live (KV, a plan): moved over when opened
data.set('share:OLDOLDOLD123', JSON.stringify({ plan, at: 'x' }));
const moved = await (await call('/api/share/OLDOLDOLD123')).json();
assert.deepEqual(moved.people[0].stops, ['s1', 's2', 's3']);
assert.equal((await call('/api/share/ZZZZZZZZZZZZ')).status, 404);
assert.equal((await send('/api/share', 'POST', { plan: {} })).status, 400);
assert.equal((await call('/api/share', { method: 'POST', body: JSON.stringify({ plan }), headers: { Origin: 'https://evil.example' } })).status, 403);
assert.notEqual(newId(), newId());

// /s/<id> is the share page (/share: the asset server redirects .html away)
const served = [];
const assets = { fetch: async (req) => { served.push(new URL(req.url).pathname); return new Response('page'); } };
await worker.fetch(new Request(`https://route.example.com/s/${id}`), { ...env, ASSETS: assets });
assert.deepEqual(served, ['/share']);
console.log('route share (live): ok');
