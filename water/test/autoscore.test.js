/**
 * Walks scored with no page open (water/src/autoscore.js): the queue the main site's pushes fill, worked by the timer,
 * on a real SQLite database with the water schema; the main site and the water builder stood in for.
 *   node water/test/autoscore.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { enqueue } from '../src/jobs.js';
import { runQueue, sweep, waterBase } from '../src/autoscore.js';
import { MODEL_VERSION } from '../lib/surfacenow.js';
import { walkRecords } from '../lib/walkrecords.js';
import { siteOf, inputsOf } from '../lib/siteof.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok  ${name}`); }

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prep = (sql) => { let a = []; const st = { bind: (...x) => { a = x; return st; }, run: async () => { db.prepare(sql).run(...a); return {}; }, all: async () => ({ results: db.prepare(sql).all(...a) }), first: async () => db.prepare(sql).get(...a) ?? null }; return st; };
  return { prepare: prep, batch: async (sts) => { for (const s of sts) await s.run(); } };
}
const T0 = Date.UTC(2026, 10, 15, 19);
const record = { id: 'admin|1', adminSave: true, address: 'Test', lng: -85, lat: 42, shapes: [{ type: 'Polygon', coordinates: [[[-85.0002, 41.9998], [-84.9998, 41.9998], [-84.9998, 42.0002], [-85.0002, 42.0002], [-85.0002, 41.9998]]] }] };
const walkJson = { walk: 'w1', frame: { lng: -85, lat: 42 }, started: T0, ended: T0 + 6e5, air: [{ T: 12, at: T0, unit: 'C' }], sprinklers: false, records: [{ e: 1, n: 1, tm: T0 + 6e4, T: 14, band: '0-60' }, { e: 300, n: 300, tm: T0 + 6e4, T: 14, band: '0-60' }], status: { ok: true } };
function main({ converted = true, failed = false } = {}) {
  return {
    saveOf: async (id) => (id === 'admin|1' ? record : null),
    thermalOf: async (id, walk) => (walk === null ? { walks: [{ walk: 'w1', ok: converted ? true : null }] } : failed ? { error: 'x', status: { ok: false, error: 'USB errors' } } : converted ? walkJson : { error: 'not converted yet', status: { ok: null } }),
    adminSaves: async () => [{ id: 'admin|1', modelAt: 'x' }],
  };
}
function builder(calls) {
  return { fetch: async (u, init) => { const b = JSON.parse(init.body); calls.push(b); return new Response(JSON.stringify({ ok: true, placed: { started: T0, ended: T0 + 6e5, kinds: ['surface'], notes: { sprinklers: false }, offLawn: 1 }, weather: { sources: [{ name: 'ASOS TST', km: 9 }], series: [{ src: 'asos', t: T0, ta: 12 }] }, result: { model: MODEL_VERSION, n: 1, bias: 0.4, rmse: 0.9, rho: null, bands: {}, sunShade: {}, used: {}, open: {} } })); } };
}

await test('an admin save\'s id of any characters is queued (a narrower check once lost the pushes)', async () => {
  const env = { DB: d1() };
  assert.equal((await enqueue(env, 'model', 'admin|someone@example.com|lot 7', { modelAt: 'x' })).queued, true);
  assert.equal((await enqueue(env, 'walk', 'admin|a/b', { walk: '1794790000000' })).queued, true);
  assert.equal((await enqueue(env, 'walk', 'bad\nid', { walk: '1' })).queued, false);
});

await test('the water site\'s own origin from the main site\'s host', async () => {
  assert.equal(waterBase({ LAWNMAP_HOST: 'lawnmap.example.com' }), 'https://water.example.com');
});

await test('a pushed walk is scored by the builder and kept as a page keeps it; its weather frozen once', async () => {
  const calls = [], env = { DB: d1(), MAIN: main(), WATER_BUILDER: builder(calls), LAWNMAP_HOST: 'lawnmap.example.com' };
  await enqueue(env, 'walk', 'admin|1', { walk: 'w1' });
  const out = await runQueue(env);
  assert.deepEqual(out.map((o) => o.state), ['done']);
  assert.equal(calls[0].base, 'https://water.example.com'); assert.equal(calls[0].weather, null, 'nothing frozen yet');
  const r = await env.DB.prepare('SELECT * FROM truth_results').all();
  assert.equal(r.results[0].model, MODEL_VERSION); assert.equal(JSON.parse(r.results[0].detail).by, 'the water builder');
  assert.equal((await env.DB.prepare('SELECT * FROM truth_walks').all()).results[0].map_id, 'admin|1');
  assert.equal((await env.DB.prepare('SELECT * FROM truth_weather').all()).results.length, 1);
  // scored again: the frozen weather goes to the builder
  await enqueue(env, 'walk', 'admin|1', { walk: 'w1' });
  await runQueue(env);
  assert.equal(calls[1].weather.series[0].ta, 12);
});

await test('not converted yet: waits; failed conversion: kept as failed with its reason; no bindings: stays queued', async () => {
  const env = { DB: d1(), MAIN: main({ converted: false }), WATER_BUILDER: builder([]) };
  await enqueue(env, 'walk', 'admin|1', { walk: 'w1' });
  assert.equal((await runQueue(env))[0].state, 'wait');
  assert.equal((await env.DB.prepare('SELECT state FROM kit_jobs').first()).state, 'queued');
  const env2 = { DB: d1(), MAIN: main({ failed: true }), WATER_BUILDER: builder([]) };
  await enqueue(env2, 'walk', 'admin|1', { walk: 'w1' });
  await runQueue(env2);
  const j = await env2.DB.prepare('SELECT state, detail FROM kit_jobs').first();
  assert.equal(j.state, 'failed'); assert.match(j.detail, /USB errors/);
  const env3 = { DB: d1() };
  await enqueue(env3, 'walk', 'admin|1', { walk: 'w1' });
  assert.match((await runQueue(env3))[0].why, /not bound/);
});

await test('a changed shade model queues the map\'s converted walks again; the sweep queues what the model has not scored', async () => {
  const env = { DB: d1(), MAIN: main(), WATER_BUILDER: builder([]) };
  await enqueue(env, 'model', 'admin|1', { modelAt: 'x' });
  const out = await runQueue(env, { max: 0 });
  assert.equal(out[0].state, 'done');
  assert.equal((await env.DB.prepare("SELECT count(*) AS n FROM kit_jobs WHERE kind = 'walk' AND state = 'queued'").first()).n, 1);
  const env2 = { DB: d1(), MAIN: main(), WATER_BUILDER: builder([]) };
  const sw = await sweep(env2);
  assert.equal(sw.queued, 1); assert.equal(sw.saves, 1); assert.equal(sw.converted, 1);
});

await test('a walk scored before the station\'s second score is queued again; one carrying it is not', async () => {
  const { MODEL_VERSION, SCORING } = await import('../lib/surfacenow.js');
  const put = (env, detail) => env.DB.prepare('INSERT OR REPLACE INTO truth_results (walk, model, kind, checked, n, bias, rmse, rho, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind('w1', MODEL_VERSION, 'surface', 1, 5, 0, 1, 0.5, JSON.stringify(detail)).run();
  const old = { DB: d1(), MAIN: main(), WATER_BUILDER: builder([]) };
  await put(old, { bands: {} });
  assert.equal((await sweep(old)).queued, 1);
  const now = { DB: d1(), MAIN: main(), WATER_BUILDER: builder([]) };
  await put(now, { scoring: SCORING, station: { n: 5 } });
  const sw = await sweep(now);
  assert.equal(sw.queued, 0); assert.equal(sw.scored, 1);
});

await test('the shared walk placement and site: off-lawn records dropped, the settings read back', async () => {
  const site = siteOf(record, 'admin|1');
  const p = walkRecords(walkJson, site);
  assert.equal(p.records.length, 1); assert.equal(p.offLawn, 1); assert.deepEqual(p.kinds, ['surface']);
  assert.equal(inputsOf({ mode: 'deficit', species: ['nope'] }).mode, 'deficit');
  assert.deepEqual(inputsOf(null).species, []);
});

console.log(`\n${passed} passed`);
