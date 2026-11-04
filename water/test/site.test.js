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
  // the core session's drains and water (docs/WATER-LAYERS.md), read through this Worker
  assert.equal(upstreamFor(u('/api/water/layers?box=1,2,3,4'), L), 'https://lawnmap.example.com/api/water/layers?box=1,2,3,4');
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
  // like Cloudflare's assets (html_handling auto-trailing-slash): /x.html is a 307 to /x, which serves x.html
  ASSETS: { fetch: async (r) => { const u = new URL(r.url ?? r); return u.pathname.endsWith('.html') ? new Response(null, { status: 307, headers: { Location: u.pathname.replace(/(index)?\.html$/, '') } }) : new Response('<html>page</html>', { headers: { 'Content-Type': 'text/html' } }); } }, ...extra,
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
  // the AR test page stays the admin's even with the site open (FINDINGS H64)
  const open = env('up', { ADMIN_ONLY: '0' });
  for (const p of ['/ar', '/ar.html', '/ar.js']) assert.equal((await get(p, '', open)).status, 404, p);
  assert.equal((await get('/ar', 'lm_session=admin', open)).status, 200);
  assert.equal((await get('/ar.html', 'lm_session=admin', open)).status, 200);
  assert.equal((await get('/admin', 'lm_session=admin', open)).status, 200);
  assert.equal((await get('/admin.html', 'lm_session=admin', open)).status, 200);
  assert.match((await get('/ar', 'lm_session=admin', open)).headers.get('Cache-Control'), /no-store/);
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

/** A D1 stand-in for the moisture tables: the statements src/moisture.js sends, on two arrays. */
function moistureDb() {
  const visits = [], rdgs = [], checks = [];
  const cols = (sql) => sql.match(/\(([^)]+)\) VALUES/)[1].split(', ');
  const exec = (sql, args) => {
    if (/^INSERT OR REPLACE INTO moisture_visits/.test(sql)) { const row = Object.fromEntries(cols(sql).map((c, k) => [c, args[k]])); const k = visits.findIndex((v) => v.id === row.id); if (k >= 0) visits[k] = row; else visits.push(row); }
    else if (/^INSERT INTO moisture_readings/.test(sql)) rdgs.push(Object.fromEntries(cols(sql).map((c, k) => [c, args[k]])));
    else if (/^DELETE FROM moisture_readings WHERE visit_id/.test(sql)) { for (let k = rdgs.length - 1; k >= 0; k--) if (rdgs[k].visit_id === args[0]) rdgs.splice(k, 1); }
    else if (/^DELETE FROM moisture_visits/.test(sql)) { const k = visits.findIndex((v) => v.id === args[0]); if (k >= 0) visits.splice(k, 1); }
    else if (/^INSERT OR REPLACE INTO moisture_checks/.test(sql)) { const row = { visit_id: args[0], checked: args[1], rho: args[2], n: args[3], detail: args[4] }; const k = checks.findIndex((v) => v.visit_id === row.visit_id); if (k >= 0) checks[k] = row; else checks.push(row); }
    else throw new Error(`unexpected ${sql}`);
  };
  const query = (sql, args) => {
    if (/FROM moisture_visits WHERE parcel_pin/.test(sql)) return visits.filter((v) => v.parcel_pin === args[0]).sort((a, b) => a.at - b.at);
    if (/FROM moisture_visits WHERE map_id/.test(sql)) return visits.filter((v) => v.map_id === args[0]).sort((a, b) => a.at - b.at);
    if (/FROM moisture_visits ORDER BY/.test(sql)) return visits.slice().sort((a, b) => b.at - a.at);
    if (/FROM moisture_readings WHERE visit_id IN/.test(sql)) return rdgs.filter((r) => args.includes(r.visit_id)).sort((a, b) => a.n - b.n);
    if (/JOIN moisture_visits/.test(sql)) return rdgs.map((r) => { const v = visits.find((x) => x.id === r.visit_id); return { ...r, visit_at: v.at, parcel_pin: v.parcel_pin, county: v.county, map_id: v.map_id, meter: v.meter, unit: v.unit, depth_in: v.depth_in }; });
    throw new Error(`unexpected ${sql}`);
  };
  return {
    visits, rdgs, checks,
    prepare(sql) { let args = []; const st = { sql, bind: (...a) => { args = a; return st; }, run: async () => exec(sql, args), all: async () => ({ results: query(sql, args) }), get args() { return args; } }; return st; },
    batch: async (list) => { for (const st of list) exec(st.sql, st.args); return []; },
  };
}

test('moisture readings: the admin keeps a visit, saves it again whole, reads a property\'s visits back, and nobody else can', async () => {
  const { moisture, cleanVisit } = await import('../src/moisture.js');
  const env = { DB: moistureDb() };
  const u = (q = '') => new URL(`https://water.example.com/api/water/moisture${q}`);
  const post = (body) => new Request(u(), { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const admin = { isAdmin: async () => true }, nobody = { isAdmin: async () => false };
  const visit = { id: 'visit-0001', at: Date.now() - 6e4, lng: -85.6, lat: 42.8, parcel_pin: '41-00-00-000-001', county: 'kent', unit: 'vwc', depth_in: 3, meter: 'test meter', weather: { lastTwoDays: 'none' },
    readings: [{ n: 1, spot: 's1', lng: -85.60001, lat: 42.80001, value: 21.5 }, { n: 2, spot: 's2', lng: -85.60002, lat: 42.80002, value: 34 }], address: '1 Any Street' };
  // not the admin: nothing, either way
  assert.equal((await moisture(post(visit), env, u(), nobody)).status, 404);
  assert.equal((await moisture(new Request(u()), env, u(), nobody)).status, 404);
  // bad ones
  assert.equal((await moisture(post({ ...visit, readings: [] }), env, u(), admin)).status, 400);
  assert.equal((await moisture(post({ ...visit, readings: [{ lng: -85.6, lat: 42.8, value: 140 }] }), env, u(), admin)).status, 400, 'over 100% is no moisture');
  assert.equal((await moisture(post({ ...visit, id: 'x' }), env, u(), admin)).status, 400);
  // kept, and no street address anywhere
  assert.equal((await moisture(post(visit), env, u(), admin)).status, 200);
  assert.equal(env.DB.visits.length, 1); assert.equal(env.DB.rdgs.length, 2);
  assert.ok(!JSON.stringify(env.DB.visits).includes('Any Street'));
  // saved again with a third reading: replaced, not doubled
  await moisture(post({ ...visit, readings: [...visit.readings, { n: 3, spot: 's3', lng: -85.60003, lat: 42.80003, value: 18 }] }), env, u(), admin);
  assert.equal(env.DB.visits.length, 1); assert.equal(env.DB.rdgs.length, 3);
  // a property's visits back, with their readings
  const back = await (await moisture(new Request(u('?pin=41-00-00-000-001')), env, u('?pin=41-00-00-000-001'), admin)).json();
  assert.equal(back.visits.length, 1); assert.equal(back.visits[0].readings.length, 3); assert.deepEqual(back.visits[0].weather, { lastTwoDays: 'none' });
  const csv = await (await moisture(new Request(u('?format=csv')), env, u('?format=csv'), admin)).text();
  assert.match(csv.split('\n')[0], /^visit_id,visit_at,parcel_pin/); assert.equal(csv.trim().split('\n').length, 4);
  // taken off whole
  await moisture(new Request(u('?id=visit-0001'), { method: 'DELETE' }), env, u('?id=visit-0001'), admin);
  assert.equal(env.DB.visits.length + env.DB.rdgs.length, 0);
  // no database yet: 503
  assert.equal((await moisture(post(visit), {}, u(), admin)).status, 503);
  assert.equal(await moisture(new Request('https://water.example.com/api/other'), env, new URL('https://water.example.com/api/other'), admin), null);
  // the meter's own scale may go past 100
  assert.ok(cleanVisit({ ...visit, unit: 'scale', readings: [{ lng: 1, lat: 1, value: 250 }] }).visit);
});

test('the water map\'s check of the model against a visit: by map id for the admin, and only numbers kept', async () => {
  const { moisture } = await import('../src/moisture.js');
  const env = { DB: moistureDb() };
  const u = (q = '', path = '/api/water/moisture') => new URL(`https://water.example.com${path}${q}`);
  const admin = { isAdmin: async () => true }, nobody = { isAdmin: async () => false };
  const visit = { id: 'visit-0002', at: Date.now() - 6e4, map_id: 'map-abc', unit: 'scale', readings: [{ n: 1, spot: 's1', lng: -85.6, lat: 42.8, value: 30 }] };
  await moisture(new Request(u(), { method: 'POST', body: JSON.stringify(visit) }), env, u(), admin);
  const back = await (await moisture(new Request(u('?map=map-abc')), env, u('?map=map-abc'), admin)).json();
  assert.equal(back.visits.length, 1); assert.equal(back.visits[0].readings.length, 1);
  assert.equal((await (await moisture(new Request(u('?map=other')), env, u('?map=other'), admin)).json()).visits.length, 0);
  const cu = u('', '/api/water/moisture/check');
  const check = { visit_id: 'visit-0002', rho: 0.41, n: 12, map_id: 'map-abc', spots: [{ n: 1, value: 30, wet: 0.92, zone: 0, kind: 1, need: 180, lng: -85.6, lat: 42.8, note: 'by the porch' }], settings: { date: '2026-11-03', depth_in: 3, where: 'somewhere' } };
  assert.equal((await moisture(new Request(cu, { method: 'POST', body: JSON.stringify(check) }), env, cu, nobody)).status, 404);
  assert.equal((await moisture(new Request(cu, { method: 'POST', body: JSON.stringify(check) }), env, cu, admin)).status, 200);
  assert.equal((await moisture(new Request(cu, { method: 'POST', body: JSON.stringify(check) }), env, cu, admin)).status, 200);
  assert.equal(env.DB.checks.length, 1, 'checked again: replaced');
  const kept = JSON.stringify(env.DB.checks);
  for (const bad of ['-85.6', '42.8', 'porch', 'map-abc', 'somewhere']) assert.ok(!kept.includes(bad), `no ${bad} kept`);
  assert.equal(env.DB.checks[0].rho, 0.41);
  assert.equal((await moisture(new Request(cu, { method: 'POST', body: JSON.stringify({ ...check, visit_id: 'x' }) }), env, cu, admin)).status, 400);
});

test('the moisture page is the admin\'s only, open site or not', async () => {
  const open = env('ok', { ADMIN_ONLY: '0' });
  for (const p of ['/moisture', '/moisture.html', '/moisture.js']) assert.equal((await get(p, '', open)).status, 404, p);
  for (const p of ['/moisture', '/moisture.html', '/moisture.js']) assert.equal((await get(p, 'lm_session=user', open)).status, 404, p);
  assert.equal((await get('/moisture', 'lm_session=admin', open)).status, 200);
  assert.equal((await get('/moisture.html', 'lm_session=admin', open)).status, 200);
  assert.match((await get('/moisture', 'lm_session=admin', open)).headers.get('Cache-Control'), /no-store/);
  assert.equal((await get('/api/water/moisture', 'lm_session=user', open)).status, 404);
});

test('the paper\'s shade map part: the shade session\'s Markdown, escaped, put between the markers', async () => {
  const { mdToHtml, withShadePart } = await import('../tools/md.mjs');
  const md = `Light comes from **lidar** and the *sun's path* [S1].\n\n### How light is worked out\n\n- one\n- two with [a link](https://example.com/x)\n\nTechnical note: k = 0.5 <script>alert(1)</script>\n\n### References\n\nS1. Someone (2020). A paper. Journal 1: 2.\nS2. Other (2021). Another.`;
  const html = mdToHtml(md);
  assert.match(html, /<p>Light comes from <strong>lidar<\/strong> and the <em>sun's path<\/em> \[S1\]\.<\/p>/);
  assert.match(html, /<h3>How light is worked out<\/h3>/);
  assert.match(html, /<ul><li>one<\/li><li>two with <a href="https:\/\/example.com\/x">a link<\/a><\/li><\/ul>/);
  assert.match(html, /<div class="tech"><strong>Technical note<\/strong>k = 0.5 &lt;script&gt;/);
  assert.ok(!html.includes('<script>'), 'no HTML of the file\'s own runs');
  assert.match(html, /<ul class="refs srefs"><li>S1\. Someone \(2020\)\. A paper\. Journal 1: 2\.<\/li><li>S2\./);
  assert.ok(!mdToHtml('[x](javascript:alert(1))').includes('href'), 'only http(s) or site links');
  const paper = '<p>before</p>\n<!--SHADE-MAP-PART-->\n<p>holding</p>\n<!--/SHADE-MAP-PART-->\n<p>after</p>';
  const out = withShadePart(paper, md);
  assert.ok(!out.includes('holding') && out.includes('<h3>How light') && out.includes('<p>after</p>'));
  assert.equal(withShadePart(paper, ''), paper, 'no file yet: the holding line stays');
  // a technical note followed by list lines with no blank line: the note, then its own list
  assert.equal(mdToHtml('Technical note: x = 1.\n- **a.** one\n- b'), '<div class="tech"><strong>Technical note</strong>x = 1.</div>\n<ul><li><strong>a.</strong> one</li><li>b</li></ul>');
  // the live paper has the markers, so the part has somewhere to go
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../public/paper.html', import.meta.url), 'utf8'), /<!--SHADE-MAP-PART-->[\s\S]*<!--\/SHADE-MAP-PART-->/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok  ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`water site: ${tests.length} passed`);
