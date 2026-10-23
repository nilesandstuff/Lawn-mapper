/**
 * The water site's Worker and build, and the property-on-the-grid pieces
 * (water session).   node water/test/site.test.js
 */

import assert from 'node:assert/strict';

import worker, { upstreamFor, isAdmin } from '../src/index.js';
import { readings, cleanReading, toCsv } from '../src/readings.js';
import { waterDomainFor, wranglerFor } from '../tools/prepare.mjs';
import { gridFor } from '../lib/surface.js';
import { maskOf, boundsOf } from '../lib/geo.js';
import { toMerc, mercScale } from '../lib/ept.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the Worker passes on the account routes and five property reads, nothing else', () => {
  const u = (p) => new URL(`https://water.example.com${p}`);
  const L = 'lawnmap.example.com';
  assert.equal(upstreamFor(u('/api/geocode?q=1+Main'), L), 'https://lawnmap.example.com/api/geocode?q=1+Main');
  assert.equal(upstreamFor(u('/api/shade/lidar?lng=1&lat=2'), L), 'https://lawnmap.example.com/api/shade/lidar?lng=1&lat=2');
  assert.equal(upstreamFor(u('/api/maps/one?id=abc'), L), 'https://lawnmap.example.com/api/maps/one?id=abc');
  assert.equal(upstreamFor(u('/api/maps/tool?id=abc&tool=water'), L, 'POST'), 'https://lawnmap.example.com/api/maps/tool?id=abc&tool=water');
  assert.equal(upstreamFor(u('/api/auth/me'), L), 'https://lawnmap.example.com/api/auth/me');
  assert.equal(upstreamFor(u('/api/tools'), L), 'https://lawnmap.example.com/api/tools');
  for (const p of ['/api/segment', '/api/admin/users', '/api/shade/readings', '/api/mapsx', '/api/config']) {
    assert.equal(upstreamFor(u(p), L), null, p);
  }
  assert.equal(upstreamFor(u('/api/geocode?q=x'), L, 'POST'), null, 'property reads are GET only');
  assert.equal(upstreamFor(u('/api/geocode?q=x'), ''), null);
});

test('the domain comes from CUSTOM_DOMAIN, never from the repository', () => {
  assert.equal(waterDomainFor('lawnmap.example.com'), 'water.example.com');
  assert.equal(waterDomainFor('a.b.example.co.uk'), 'water.b.example.co.uk');
  assert.equal(waterDomainFor('example.com'), null);
  const toml = wranglerFor('water.example.com', 'lawnmap.example.com');
  assert.match(toml, /pattern = "water\.example\.com"\ncustom_domain = true/);
  assert.match(toml, /LAWNMAP_HOST = "lawnmap\.example\.com"/);
  assert.match(toml, /\[\[services\]\]\nbinding = "LAWNMAP"\nservice = "lawn-mapper"/);
});

test('a property line lands on the right cells, holes and all', () => {
  const lat = 43, k = mercScale(lat);
  const [x0, y0] = toMerc([-85, lat]);
  const bbox = [x0, y0, x0 + 40 / k, y0 + 40 / k];
  const g = gridFor(bbox, lat);
  // a 20 m square 10-30 m east and north of the corner, with a 4 m hole in the middle
  const deg = (m) => m / 111320;
  const lng0 = -85, e = (m) => lng0 + deg(m) / Math.cos(lat * Math.PI / 180), n = (m) => lat + deg(m);
  const sq = (a, b) => [[e(a), n(a)], [e(b), n(a)], [e(b), n(b)], [e(a), n(b)], [e(a), n(a)]];
  const mask = maskOf(g, { type: 'Feature', geometry: { type: 'Polygon', coordinates: [sq(10, 30), sq(18, 22)] } });
  const cells = mask.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(cells - (400 - 16)) <= 30, `${cells} cells, expected about 384`);
  assert.deepEqual(boundsOf({ type: 'Polygon', coordinates: [sq(10, 30)] }).map((v) => +v.toFixed(6)), [e(10), n(10), e(30), n(30)].map((v) => +v.toFixed(6)));
});

/** A Lawn Mapper stand-in: answers /api/auth/me from the cookie, and anything else with 200. */
const lawnmap = (who) => ({
  fetch: async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/api/auth/me') {
      if (who === 'down') throw new Error('unreachable');
      const c = req.headers.get('Cookie') || '';
      return new Response(JSON.stringify({ user: c.includes('admin') ? { admin: true } : c.includes('user') ? { admin: false } : null }));
    }
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  },
});
const env = (who, extra = {}) => ({
  LAWNMAP: lawnmap(who), LAWNMAP_HOST: 'lawnmap.example.com', ADMIN_ONLY: '1',
  ASSETS: { fetch: async () => new Response('<html>page</html>', { headers: { 'Content-Type': 'text/html' } }) }, ...extra,
});
const get = (path, cookie = '', e = env()) => worker.fetch(new Request(`https://water.example.com${path}`, { headers: { Cookie: cookie } }), e);

test('admin only: the admin gets the page and the data, nobody else gets either', async () => {
  assert.equal((await get('/', 'lm_session=admin')).status, 200);
  assert.equal((await get('/api/geocode?q=x', 'lm_session=admin')).status, 200);
  for (const c of ['', 'lm_session=user', 'lm_guest=g']) {
    const page = await get('/', c);
    assert.equal(page.status, 404, `page for "${c}"`);
    assert.match(await page.text(), /isn't open yet/);
    assert.equal((await get('/lib/site.js', c)).status, 404);
    assert.equal((await get('/api/maps/one?id=1', c)).status, 404);
    assert.equal((await get('/api/shade/lidar?lng=1&lat=2', c)).status, 404);
  }
  // sign-in itself is never gated
  assert.equal((await get('/api/auth/me', '')).status, 200);
  // the gated page is never cached for someone else
  assert.match((await get('/', 'lm_session=admin')).headers.get('Cache-Control'), /no-store/);
});

test('admin only fails closed, and opens when ADMIN_ONLY is not "1"', async () => {
  assert.equal(await isAdmin(new Request('https://w/', { headers: { Cookie: 'admin' } }), env('down')), false);
  assert.equal(await isAdmin(new Request('https://w/', { headers: { Cookie: 'admin' } }), { LAWNMAP_HOST: 'x' }), false);
  assert.equal((await get('/', 'lm_session=admin', env('down'))).status, 404);
  assert.equal((await get('/', '', env('up', { ADMIN_ONLY: '0' }))).status, 200);
  // open to everyone since 2026-10-23; the gate is still there to close it again
  assert.match(wranglerFor('water.example.com', 'lawnmap.example.com'), /ADMIN_ONLY = "0"/);
  assert.match(wranglerFor('water.example.com', 'lawnmap.example.com', true), /ADMIN_ONLY = "1"/);
  // without this Cloudflare serves the files before the Worker, past the gate
  assert.match(wranglerFor('water.example.com', 'lawnmap.example.com'), /run_worker_first = true/);
});

test('the barometer fit takes out the hopper height and the weather, and keeps the shape', async () => {
  const { detrend, corr, highPass } = await import('../tools/baro.mjs');
  const t = [...Array(300).keys()];
  const g = t.map((x) => 0.5 * Math.sin(x / 40));
  const h = g.map((v, i) => v + 1.27 + 0.002 * i); // a hopper 1.27 m up, the weather 12 cm/min
  const f = detrend(t, h, g);
  assert.ok(Math.abs(f.a - 1.27) < 1e-6 && Math.abs(f.b - 0.002) < 1e-6, `a ${f.a} b ${f.b}`);
  assert.ok(Math.max(...f.resid.map(Math.abs)) < 1e-9);
  assert.ok(corr(g, h.map((v, i) => v - f.a - f.b * t[i])) > 0.999);
  // a running mean leaves a step's edges and takes out the slow wave
  const hp = highPass(t, g, 20);
  assert.ok(Math.max(...hp.slice(15, -15).map(Math.abs)) < 0.02, 'a 250 s wave is nearly gone at 20 s, away from the ends');
});

/** A D1 stand-in: enough of prepare/bind/run/all for the readings table. */
function fakeDb() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      let args = [];
      const st = {
        bind: (...a) => { args = a; return st; },
        run: async () => {
          if (/^INSERT/.test(sql)) { const cols = sql.match(/\(([^)]+)\) VALUES/)[1].split(', '); rows.push(Object.fromEntries(cols.map((c, k) => [c, args[k]]))); }
          if (/^DELETE/.test(sql)) { const k = rows.findIndex((r) => r.id === args[0]); if (k >= 0) rows.splice(k, 1); }
          return { success: true };
        },
        all: async () => ({ results: rows.slice().sort((a, b) => b.at - a.at) }),
      };
      return st;
    },
  };
}

test('gauge readings: a signed-in visitor keeps one; only the admin reads them back, as JSON or CSV, and can take one off', async () => {
  const env = { DB: fakeDb() };
  const u = (q = '') => new URL(`https://water.example.com/api/water/readings${q}`);
  const post = (body) => new Request(u(), { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const signedIn = { isAdmin: async () => false, who: async () => ({ id: 'u1' }) };
  const admin = { isAdmin: async () => true, who: async () => ({ id: 'a' }) };
  // signed out: no
  assert.equal((await readings(post({ measured_psi: 40, method: 'pitot' }), env, u(), { isAdmin: async () => false, who: async () => null })).status, 401);
  // a bad one: no
  assert.equal((await readings(post({ measured_psi: 400, method: 'pitot' }), env, u(), signedIn)).status, 400);
  assert.equal((await readings(post({ measured_psi: 40, method: 'guess' }), env, u(), signedIn)).status, 400);
  const ok = await readings(post({ measured_psi: 41.5, method: 'pitot', predicted_psi: 43.2, map_id: 'm1', head_id: 'h1', zone: 2, detail: { worksheet: { gauge: 60 } } }), env, u(), signedIn);
  assert.equal(ok.status, 200);
  assert.equal(env.DB.rows.length, 1); assert.equal(env.DB.rows[0].measured_psi, 41.5); assert.equal(env.DB.rows[0].typical_pvb, 0);
  // reading them back: the admin only
  assert.equal((await readings(new Request(u()), env, u(), signedIn)).status, 404);
  const back = await (await readings(new Request(u()), env, u(), admin)).json();
  assert.equal(back.readings[0].predicted_psi, 43.2);
  const csv = await (await readings(new Request(u('?format=csv')), env, u('?format=csv'), admin)).text();
  assert.match(csv.split('\n')[0], /^id,at,map_id/); assert.match(csv.split('\n')[1], /41\.5/);
  await readings(new Request(u(`?id=${back.readings[0].id}`), { method: 'DELETE' }), env, u(`?id=${back.readings[0].id}`), admin);
  assert.equal(env.DB.rows.length, 0);
  // no database yet: 503, never a crash
  assert.equal((await readings(post({ measured_psi: 40, method: 'pitot' }), {}, u(), signedIn)).status, 503);
  assert.equal(await readings(new Request('https://water.example.com/api/other'), env, new URL('https://water.example.com/api/other'), admin), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water site: ${tests.length} passed`);
