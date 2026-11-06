// Shared split routes: kept under an unguessable id for 30 days, served at /s/<id>.
import assert from 'node:assert/strict';
import worker, { api } from '../src/index.js';
import { KEEP_DAYS, newId } from '../src/share.js';

const data = new Map();
const kv = {
  get: async (k) => data.get(k)?.value ?? null,
  put: async (k, value, opts) => { data.set(k, { value, opts }); },
  delete: async (k) => { data.delete(k); },
};
const env = { ROUTE: kv };
const call = (path, init = {}) => {
  const url = new URL(`https://route.example.com${path}`);
  return api(new Request(url, init), env, url, async () => new Response('no'));
};
const plan = { shop: { label: 'Shop', lng: -85.7, lat: 42.8 }, people: [{ stops: [{ address: '1 Elm St', lng: -85.71, lat: 42.81, minutes: 20 }], legs: [{ duration: 600, distance: 5000 }] }] };

let res = await call('/api/share', { method: 'POST', body: JSON.stringify({ plan }), headers: { 'Content-Type': 'application/json' } });
assert.equal(res.status, 201);
const { id } = await res.json();
assert.match(id, /^[A-Za-z0-9]{12}$/);
assert.equal(data.get(`share:${id}`).opts.expirationTtl, KEEP_DAYS * 86400);
const back = await (await call(`/api/share/${id}`)).json();
assert.deepEqual(back.plan, plan);
assert.ok(back.at);
assert.equal((await call('/api/share/ZZZZZZZZZZZZ')).status, 404);
assert.equal((await call('/api/share', { method: 'POST', body: '{"plan":{}}' })).status, 400);
assert.equal((await call('/api/share', { method: 'POST', body: JSON.stringify({ plan: { people: [{ x: 'y'.repeat(500000) }] } }) })).status, 413);
assert.equal((await call('/api/share', { method: 'POST', body: JSON.stringify({ plan }), headers: { Origin: 'https://evil.example' } })).status, 403);
assert.notEqual(newId(), newId());

// /s/<id> is the share page
const served = [];
const assets = { fetch: async (req) => { served.push(new URL(req.url).pathname); return new Response('page'); } };
await worker.fetch(new Request(`https://route.example.com/s/${id}`), { ...env, ASSETS: assets });
await worker.fetch(new Request('https://route.example.com/s/../index'), { ...env, ASSETS: assets });
assert.deepEqual(served, ['/share.html', '/index']);
console.log('route share: ok');
