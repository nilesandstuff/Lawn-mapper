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
