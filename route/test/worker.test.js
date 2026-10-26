// The route Worker: blocks of the matrix put back together, routes joined, bad calls refused.
import assert from 'node:assert/strict';
import { api } from '../src/index.js';
import { matrixBlocks, routeChunks } from '../src/mapbox.js';

// a fake Mapbox: seconds between points i and j are 100*i + j, metres 10x that
const pts = Array.from({ length: 30 }, (_, i) => [-85.7 + i * 0.001, 42.8 + i * 0.001]);
const index = (s) => pts.findIndex((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}` === s);
const calls = [];
async function fakeMapbox(url) {
  const u = new URL(url);
  calls.push(u.pathname);
  assert.equal(u.searchParams.get('access_token'), 'pk.test');
  if (u.pathname.startsWith('/directions-matrix/')) {
    const ids = u.pathname.split('/').pop().split(';').map(index);
    assert.ok(ids.length <= 25, 'at most 25 points a call');
    const src = u.searchParams.get('sources').split(';').map((k) => ids[Number(k)]);
    const dst = u.searchParams.get('destinations').split(';').map((k) => ids[Number(k)]);
    const durations = src.map((i) => dst.map((j) => (i === j ? 0 : 100 * i + j)));
    return Response.json({ code: 'Ok', durations, distances: durations.map((r) => r.map((x) => x * 10)) });
  }
  if (u.pathname.startsWith('/directions/v5/')) {
    assert.equal(u.searchParams.get('continue_straight'), 'false', 'U-turns allowed at stops');
    const ids = u.pathname.split('/').pop().split(';').map(index);
    assert.ok(ids.length <= 25);
    const legs = ids.slice(1).map((j, k) => ({ duration: 100 * ids[k] + j, distance: 1 }));
    return Response.json({ code: 'Ok', routes: [{ legs, geometry: { coordinates: ids.map((i) => pts[i]) } }] });
  }
  if (u.pathname.startsWith('/search/geocode/v6/forward')) {
    if (u.searchParams.get('q').startsWith('nowhere')) return Response.json({ features: [] });
    assert.equal(u.searchParams.get('proximity'), '-85.700000,42.800000');
    return Response.json({ features: [{ geometry: { coordinates: [-85.71, 42.81] }, properties: { full_address: '1 Test St, Town, Michigan', match_code: { confidence: 'exact' } } }] });
  }
  return new Response('no', { status: 404 });
}

const env = { MAPBOX_TOKEN: 'pk.test' };
const call = (path, init = {}) => {
  const url = new URL(`https://route.example.com${path}`);
  return api(new Request(url, init), env, url, fakeMapbox);
};
const post = (path, body, headers = {}) => call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });

// 30 points: 3 x 3 blocks, every pair filled in
let res = await post('/api/matrix', { points: pts });
assert.equal(res.status, 200);
const m = await res.json();
for (let i = 0; i < 30; i += 1) for (let j = 0; j < 30; j += 1) {
  assert.equal(m.durations[i][j], i === j ? 0 : 100 * i + j);
  assert.equal(m.distances[i][j], i === j ? 0 : (100 * i + j) * 10);
}
assert.equal(calls.filter((c) => c.startsWith('/directions-matrix/')).length, 9);
assert.equal(matrixBlocks(62).length, 36, 'the biggest day stays under 50 calls');

// only some pairs: the rows asked for are filled, the rest left null
calls.length = 0;
res = await post('/api/matrix', { points: pts, sources: [3, 17], destinations: pts.map((_, i) => i) });
const part = await res.json();
assert.equal(part.durations[3][20], 320);
assert.equal(part.durations[17][2], 1702);
assert.equal(part.durations[5][6], null, 'not asked, not filled');
assert.equal(part.durations[5][5], 0);
assert.equal(calls.length, 3, 'two sources against 30 destinations: 3 calls of 12');
assert.equal((await post('/api/matrix', { points: pts, sources: [1, 1] })).status, 400, 'repeats refused');
assert.equal((await post('/api/matrix', { points: pts, sources: [30] })).status, 400, 'out of range refused');
assert.equal((await post('/api/matrix', { points: pts, destinations: [] })).status, 400);

// 30 points along a route: two calls sharing a point, legs in order, the line joined once
res = await post('/api/route', { points: pts });
const r = await res.json();
assert.equal(r.legs.length, 29);
r.legs.forEach((l, k) => assert.equal(l.duration, 100 * k + k + 1));
assert.equal(r.geometry.length, 30);
assert.deepEqual(routeChunks(30), [[0, 24], [24, 29]]);
assert.deepEqual(routeChunks(25), [[0, 24]]);

// geocoding, nearest the shop
res = await call('/api/geocode?q=1%20Test%20St%2C%20Town&near=-85.7,42.8');
assert.deepEqual(await res.json(), { lng: -85.71, lat: 42.81, label: '1 Test St, Town, Michigan', accuracy: 'exact' });
assert.equal((await call('/api/geocode?q=nowhere%20at%20all')).status, 404);
assert.equal((await call('/api/geocode?q=ab')).status, 400);

// refused: another site's page, bad points, too many, no token
assert.equal((await post('/api/matrix', { points: pts }, { Origin: 'https://evil.example' })).status, 403);
assert.equal((await post('/api/matrix', { points: pts.slice(0, 1) })).status, 400);
assert.equal((await post('/api/matrix', { points: Array(63).fill(pts[0]) })).status, 400);
assert.equal((await post('/api/route', { points: [[1, 2], ['x', 3]] })).status, 400);
assert.equal((await post('/api/matrix', { points: pts }, { Origin: 'https://route.example.com' })).status, 200);
const none = new URL('https://route.example.com/api/geocode?q=1%20Test%20St');
assert.equal((await api(new Request(none), {}, none, fakeMapbox)).status, 503);
assert.equal((await call('/api/nothing')).status, 404);

console.log('route worker: ok');

// ------------------------------------------------ the shop and the first document (src/store.js)
{
  const { createHash } = await import('node:crypto');
  const kvData = new Map();
  const kv = {
    get: async (k, o) => (kvData.has(k) ? (o?.type === 'stream' ? new ReadableStream({ start(c) { c.close(); } }) : kvData.get(k)) : null),
    put: async (k, v) => { kvData.set(k, v); },
    delete: async (k) => { kvData.delete(k); },
  };
  const KEY = 'test-key';
  const e = { MAPBOX_TOKEN: 'pk.test', ROUTE: kv, ROUTE_KEY_SHA256: createHash('sha256').update(KEY).digest('hex') };
  const hit = (path, init = {}) => {
    const url = new URL(`https://route.example.com${path}`);
    return api(new Request(url, init), e, url, fakeMapbox);
  };
  const body = (o) => ({ body: JSON.stringify(o), headers: { 'Content-Type': 'application/json' } });

  assert.equal((await hit('/api/shop')).status, 404);
  assert.equal((await hit('/api/shop', { method: 'PUT', ...body({ address: '1 Shop Rd, Town' }) })).status, 403, 'setting the shop needs the key');
  const put = await hit('/api/shop', { method: 'PUT', body: JSON.stringify({ address: '1 Shop Rd, Town' }), headers: { 'X-Route-Key': KEY } });
  assert.equal(put.status, 200);
  assert.deepEqual(await (await hit('/api/shop')).json(), { address: '1 Shop Rd, Town' });

  // the first document is kept; the second is not; only the key reads or deletes it
  assert.equal((await hit('/api/catalog', { method: 'POST', ...body({ name: 'a.docx', base64: 'AAAA', parsed: [] }) })).status, 201);
  assert.equal((await hit('/api/catalog', { method: 'POST', ...body({ name: 'b.docx', base64: 'BBBB' }) })).status, 409);
  assert.equal((await hit('/api/catalog')).status, 403);
  assert.equal((await hit('/api/catalog', { headers: { 'X-Route-Key': 'wrong' } })).status, 403);
  const kept = await (await hit('/api/catalog', { headers: { 'X-Route-Key': KEY } })).json();
  assert.equal(kept.name, 'a.docx');
  assert.ok(kept.at);
  assert.equal((await hit('/api/catalog', { method: 'POST', ...body({ name: 'x' }) })).status, 409);
  assert.equal((await hit('/api/catalog', { method: 'DELETE', headers: { 'X-Route-Key': KEY } })).status, 200);
  assert.equal((await hit('/api/catalog', { method: 'POST', ...body({ name: 'x' }) })).status, 400, 'a document needs its bytes');
  assert.equal((await hit('/api/catalog', { method: 'POST', body: 'x'.repeat(10), headers: { 'Content-Length': String(9e6) } })).status, 413);
  // no storage bound: refused cleanly, routing unaffected
  const bare = new URL('https://route.example.com/api/shop');
  assert.equal((await api(new Request(bare), { MAPBOX_TOKEN: 'pk.test' }, bare, fakeMapbox)).status, 503);
  console.log('route store: ok');
}
