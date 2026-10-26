// The Mapbox meter: counted as Mapbox bills, refused before the cap, never uncounted.
import assert from 'node:assert/strict';
import { api } from '../src/index.js';
import { CAP, meter, report, resetsOn } from '../src/usage.js';
import { testDb } from './d1.js';

const pts = Array.from({ length: 30 }, (_, i) => [-85.7 + i * 0.001, 42.8 + i * 0.001]);
let sent = { geocode: 0, matrix: 0, directions: 0 };
let rateLimitOnce = false;
async function mapbox(url) {
  const u = new URL(url);
  if (rateLimitOnce) { rateLimitOnce = false; return new Response('slow down', { status: 429 }); }
  const ids = u.pathname.split('/').pop().split(';');
  if (u.pathname.includes('/geocode/')) {
    sent.geocode += 1;
    return Response.json({ features: [{ geometry: { coordinates: [-85.7, 42.8] }, properties: { full_address: 'x' } }] });
  }
  if (u.pathname.includes('matrix')) {
    const S = u.searchParams.get('sources').split(';');
    const D = u.searchParams.get('destinations').split(';');
    sent.matrix += S.length * D.length;
    return Response.json({ code: 'Ok', durations: S.map(() => D.map(() => 1)), distances: S.map(() => D.map(() => 1)) });
  }
  sent.directions += 1;
  return Response.json({ code: 'Ok', routes: [{ legs: ids.slice(1).map(() => ({ duration: 1, distance: 1 })), geometry: { coordinates: [[0, 0]] } }] });
}

const env = { MAPBOX_TOKEN: 'pk.test', USAGE: testDb() };
const go = (path, body, e = env) => {
  const url = new URL(`https://route.example.com${path}`);
  return api(new Request(url, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}), e, url, mapbox);
};
const used = async () => Object.fromEntries(Object.entries((await report(env)).apis).map(([k, v]) => [k, v.used]));

// counted exactly as sent: a geocode, a 30-point matrix (900 elements), a 30-point route (2 calls)
assert.equal((await go('/api/geocode?q=1%20Test%20St')).status, 200);
assert.equal((await go('/api/matrix', { points: pts })).status, 200);
assert.equal((await go('/api/route', { points: pts })).status, 200);
assert.deepEqual(await used(), { geocode: 1, matrix: 900, directions: 2 });
assert.deepEqual(sent, { geocode: 1, matrix: 900, directions: 2 });
// only the pairs asked for
await go('/api/matrix', { points: pts, sources: [0, 1], destinations: [5, 6, 7] });
assert.equal((await used()).matrix, 906);
// a retry after Mapbox's rate limit is counted too
rateLimitOnce = true;
await go('/api/geocode?q=2%20Test%20St');
assert.equal((await used()).geocode, 3, 'the call and its retry');

// the page's figure: the smallest share left
let r = await (await go('/api/usage')).json();
assert.equal(r.counting, true);
assert.equal(r.left, Math.floor((1 - 906 / CAP.matrix) * 1000) / 10);
assert.match(r.resets, /^\d{4}-\d{2}-01$/);

// near the cap: what fits goes, what does not is refused and NOT sent
env.USAGE.raw.prepare('UPDATE usage SET used = ?1 WHERE api = ?2').run(CAP.matrix - 900, 'matrix');
sent = { geocode: 0, matrix: 0, directions: 0 };
assert.equal((await go('/api/matrix', { points: pts })).status, 200, 'exactly to the cap is allowed');
const refused = await go('/api/matrix', { points: pts.slice(0, 2) });
assert.equal(refused.status, 429);
const why = await refused.json();
assert.equal(why.limit, 'matrix');
assert.match(why.error, /drive times is used up\. It resets [A-Z][a-z]{2} 1\./);
assert.match(why.resets, /^\d{4}-\d{2}-01$/);
assert.equal(sent.matrix, 900, 'the refused call never reached Mapbox');
assert.equal((await go('/api/geocode?q=3%20Test%20St')).status, 200, 'each allowance on its own');
assert.equal((await (await go('/api/usage')).json()).left, 0);

// no meter, nothing sent
sent = { geocode: 0, matrix: 0, directions: 0 };
const bare = { MAPBOX_TOKEN: 'pk.test' };
assert.equal((await go('/api/geocode?q=1%20Test%20St', null, bare)).status, 429);
assert.equal((await go('/api/matrix', { points: pts }, bare)).status, 429);
assert.deepEqual(sent, { geocode: 0, matrix: 0, directions: 0 });
assert.equal((await (await go('/api/usage', null, bare)).json()).counting, false);

// two plans at once cannot both slip under the cap
const e2 = { MAPBOX_TOKEN: 'pk.test', USAGE: testDb() };
const m = meter(e2);
await m.reserve('directions', CAP.directions - 3);
const results = await Promise.allSettled([m.reserve('directions', 2), m.reserve('directions', 2)]);
assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
assert.equal((await report(e2)).apis.directions.used, CAP.directions - 1);

// a new month starts from nothing
const nov = Date.UTC(2026, 10, 2);
assert.equal((await report(e2, nov)).apis.directions.used, 0);
assert.equal(resetsOn(Date.UTC(2026, 11, 15)), '2027-01-01');

console.log('route usage: ok');
