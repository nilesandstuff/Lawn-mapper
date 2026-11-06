// Notifications: signed empty pushes to the people whose route changed, the message fetched by the phone.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { api, manifest } from '../src/index.js';
import { messagesFor, validEndpoint, vapidJwt } from '../src/push.js';
import { testDb } from './d1.js';

const subtle = webcrypto.subtle;
const b64u = (b) => Buffer.from(b).toString('base64url');
const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64u(await subtle.exportKey('raw', pair.publicKey));
const privateJwk = await subtle.exportKey('jwk', pair.privateKey);

const data = new Map();
const kv = { get: async (k) => data.get(k) ?? null, put: async (k, v) => { data.set(k, v); }, delete: async (k) => data.delete(k) };
const KEY = 'route-key';
const env = { ROUTE: kv, USAGE: testDb(), ROUTE_KEY_SHA256: createHash('sha256').update(KEY).digest('hex') };
const pushes = [];
let pushStatus = 201;
const fetcher = async (u, init) => { pushes.push({ url: u, init }); return new Response('', { status: pushStatus }); };
const call = (path, method = 'GET', body, headers = {}) => {
  const url = new URL(`https://route.example.com${path}`);
  return api(new Request(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json', ...headers } }), env, url, fetcher);
};

// keys: only with the route key; the public one for anyone
assert.equal((await call('/api/push/key')).status, 404);
assert.equal((await call('/api/push/config', 'PUT', { publicKey, privateJwk })).status, 403);
assert.equal((await call('/api/push/config', 'PUT', { publicKey, privateJwk }, { 'X-Route-Key': KEY })).status, 200);
assert.equal((await (await call('/api/push/key')).json()).publicKey, publicKey);

// a day, Pat on it, Pat's phone subscribed
const stop = (i) => ({ address: `${i} Elm St`, city: 'Town', minutes: 20, lng: -85.7 + i / 100, lat: 42.8 });
const plan = { at: 1, shop: { label: 'Shop', lng: -85.7, lat: 42.8 }, people: [{ name: 'Pat', stops: [stop(1), stop(2), stop(3), stop(4)], legs: [] }] };
const { id } = await (await call('/api/share', 'POST', { plan })).json();
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/pat-phone', keys: { p256dh: 'x', auth: 'y' } };
assert.equal((await call(`/api/share/${id}/subscribe`, 'POST', { person: 'p1', subscription: { endpoint: 'https://evil.example/x' } })).status, 400, 'only push services');
assert.equal((await call(`/api/share/${id}/subscribe`, 'POST', { person: 'nobody', subscription: sub })).status, 400);
assert.equal((await call(`/api/share/${id}/subscribe`, 'POST', { person: 'p1', subscription: sub })).status, 200);

// Sam joins and takes two of Pat's stops: Pat's phone gets an empty, signed push
let doc = await (await call(`/api/share/${id}`)).json();
const people = structuredClone(doc.people);
people[0].stops = ['s1', 's2'];
people.push({ id: 'h1', name: 'Sam', stops: ['s3', 's4'], into: {}, back: null, geometry: null, readyAt: 1, start: null, free: true, helper: true });
const res = await call(`/api/share/${id}`, 'PUT', { version: doc.version, people, events: ['Sam is helping now', 'Sam took 2 stops (2 from Pat)'], by: 'h1' });
assert.equal(res.status, 200);
assert.equal(pushes.length, 1, 'one phone told');
assert.equal(pushes[0].url, sub.endpoint);
const h = pushes[0].init.headers;
assert.equal(h['Content-Length'], '0', 'nothing in the push itself');
const m = h.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
assert.equal(m[2], publicKey);
const [hd, cl, sig] = m[1].split('.');
const claims = JSON.parse(Buffer.from(cl, 'base64url'));
assert.equal(claims.aud, 'https://fcm.googleapis.com');
assert.equal(claims.sub, 'https://route.example.com');
assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${hd}.${cl}`)), 'signed with the VAPID key');

// what the phone shows: fetched by its service worker
const shown = await (await call(`/api/push/latest?endpoint=${encodeURIComponent(sub.endpoint)}`)).json();
assert.equal(shown.title, 'Your route changed');
assert.match(shown.body, /^2 taken by someone else\. Next: 1 Elm St\. \(Sam is helping now\)$/);
assert.equal(shown.url, `/s/${id}?p=1`);

// a phone that has gone away is forgotten
pushStatus = 410;
doc = await (await call(`/api/share/${id}`)).json();
const back = structuredClone(doc.people);
back[0].stops = ['s1', 's2', 's3'];
back[1].stops = ['s4'];
await call(`/api/share/${id}`, 'PUT', { version: doc.version, people: back, events: [], by: 'h1' });
pushes.length = 0;
pushStatus = 201;
doc = await (await call(`/api/share/${id}`)).json();
const again = structuredClone(doc.people);
again[0].stops = ['s1', 's2'];
again[1].stops = ['s3', 's4'];
await call(`/api/share/${id}`, 'PUT', { version: doc.version, people: again, events: [], by: 'h1' });
assert.equal(pushes.length, 0, 'the gone phone is not pushed again');

// who hears what
const before = { stops: { a: { address: 'A', done: null }, b: { address: 'B', done: null } }, people: [{ id: 'p1', stops: ['a', 'b'] }, { id: 'p2', stops: [] }] };
const after = { stops: before.stops, people: [{ id: 'p1', stops: ['a'] }, { id: 'p2', stops: ['b'] }] };
assert.deepEqual(messagesFor(before, after, ['x'], { actor: 'p2', id: 'D' }).map((x) => x.person), ['p1'], 'never the one who did it');
assert.deepEqual(messagesFor(before, before, ['Lee is helping from 3:00 PM'], { id: 'D' }).map((x) => [x.person, x.title]), [['p1', 'Help is coming']]);
assert.ok(validEndpoint('https://web.push.apple.com/abc') && !validEndpoint('http://fcm.googleapis.com/x') && !validEndpoint('https://example.com/x'));
assert.match(await vapidJwt(privateJwk, 'https://a.b', 'https://c.d'), /^[\w-]+\.[\w-]+\.[\w-]+$/);

// the manifest starts where it was added from, and nowhere strange
const mf = async (s) => (await manifest(new URL(`https://route.example.com/app.webmanifest?start=${encodeURIComponent(s)}`)).json()).start_url;
assert.equal(await mf('/s/abcdefghjkmn?p=2'), '/s/abcdefghjkmn?p=2');
assert.equal(await mf('https://evil.example/'), '/');
assert.equal(await mf('/'), '/');
console.log('route push: ok');
