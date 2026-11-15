/**
 * The ground-truth walks by property (water/src/truth.js), on a real SQLite database with the water schema, and
 * the weather of a moment (water/lib/momentweather.js) on a made-up station report.
 *   node water/test/truth.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { truth, cleanWalk } from '../src/truth.js';
import { parseAsosMoment, atMoment, parseOpenMeteo, cleanRows, weatherOfMoment } from '../lib/momentweather.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok  ${name}`); }

/** D1's surface over node:sqlite: prepare/bind/run/all/first and batch. */
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prep = (sql) => {
    let args = [];
    const st = {
      bind: (...a) => { args = a; return st; },
      run: async () => { db.prepare(sql).run(...args); return { success: true }; },
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      first: async () => db.prepare(sql).get(...args) ?? null,
    };
    return st;
  };
  return { prepare: prep, batch: async (sts) => { for (const s of sts) await s.run(); } };
}

const admin = { isAdmin: async () => true };
const call = (env, method, path, body, opts = admin) => truth(new Request(`https://water.test${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json' } }), env, new URL(`https://water.test${path}`), opts);
const T0 = Date.UTC(2026, 10, 20, 18, 0);

await test('a walk needs its map, an id and a start; kinds are kept to the known ones', async () => {
  assert.match(cleanWalk({ walk: 'w1', started: T0 }).error, /map_id/);
  assert.match(cleanWalk({ map_id: 'm', started: T0 }).error, /walk id/);
  assert.match(cleanWalk({ walk: 'w/1', map_id: 'm', started: T0 }).error, /walk id/);
  assert.equal(cleanWalk({ walk: 'w1', map_id: 'm', started: T0, kinds: ['surface', 'rocket', 'surface'] }).row.kinds, 'surface');
});

await test('not the admin: nothing (404); not a truth route: null', async () => {
  const env = { DB: d1() };
  const r = await call(env, 'GET', '/api/water/truth?map=m', null, { isAdmin: async () => false });
  assert.equal(r.status, 404);
  assert.equal(await truth(new Request('https://water.test/api/water/plan'), env, new URL('https://water.test/api/water/plan'), admin), null);
});

await test('walks kept by property: by map, and by parcel across the maps of it; results per model version', async () => {
  const env = { DB: d1() };
  assert.equal((await call(env, 'POST', '/api/water/truth/walk', { walk: 'w1', map_id: 'mapA', parcel_pin: 'P1', started: T0, ended: T0 + 6e5, kinds: ['surface'], notes: { air: [{ T: 12, at: T0 }] } })).status, 200);
  await call(env, 'POST', '/api/water/truth/walk', { walk: 'w2', map_id: 'mapB', parcel_pin: 'P1', started: T0 + 864e5, kinds: ['surface', 'moisture'] });
  await call(env, 'POST', '/api/water/truth/walk', { walk: 'w3', map_id: 'mapC', started: T0, kinds: ['wind'] });
  // seen again with no notes: the notes stay
  await call(env, 'POST', '/api/water/truth/walk', { walk: 'w1', map_id: 'mapA', started: T0, ended: T0 + 6e5, kinds: ['surface'] });
  await call(env, 'POST', '/api/water/truth/result', { walk: 'w1', model: 'surface-now 1', kind: 'surface', n: 400, bias: 0.8, rmse: 1.9, rho: 0.62, detail: { bands: { '0-60': { n: 300 } } } });
  await call(env, 'POST', '/api/water/truth/result', { walk: 'w1', model: 'surface-now 2', kind: 'surface', n: 400, bias: 0.2, rmse: 1.4, rho: 0.7 });
  const byMap = await (await call(env, 'GET', '/api/water/truth?map=mapA')).json();
  assert.deepEqual(byMap.walks.map((w) => w.walk), ['w1']);
  assert.equal(byMap.walks[0].notes.air[0].T, 12, 'the notes kept');
  assert.deepEqual(byMap.walks[0].results.map((r) => r.model), ['surface-now 1', 'surface-now 2']);
  assert.equal(byMap.walks[0].results[0].detail.bands['0-60'].n, 300);
  const byPin = await (await call(env, 'GET', '/api/water/truth?pin=P1&map=mapA')).json();
  assert.deepEqual(byPin.walks.map((w) => w.walk), ['w1', 'w2'], 'both maps of the parcel');
  assert.deepEqual(byPin.walks[1].kinds, ['surface', 'moisture']);
  await call(env, 'DELETE', '/api/water/truth?walk=w1');
  assert.equal((await (await call(env, 'GET', '/api/water/truth?map=mapA')).json()).walks.length, 0, 'deleted with its results');
});

await test('the weather is fetched once for a walk and frozen; refresh fetches again; the place is not kept', async () => {
  const env = { DB: d1(), ASSETS: { fetch: async () => new Response('[]') } };
  let calls = 0;
  const weatherFn = async (stations, lat, lng, t0, t1) => { calls++; return { sources: [{ name: 'ASOS TEST', km: 9.1, rows: 3 }], series: [{ t: t0, ta: 10 + calls, rh: 60, wind: 2, cloud: 0.5, ghi: null }] }; };
  const opts = { ...admin, weatherFn };
  await call(env, 'POST', '/api/water/truth/walk', { walk: 'w9', map_id: 'mapA', started: T0, ended: T0 + 6e5, kinds: ['surface'] });
  assert.equal((await call(env, 'GET', '/api/water/truth/weather?walk=w9', null, opts)).status, 404, 'not fetched yet');
  const a = await (await call(env, 'GET', '/api/water/truth/weather?walk=w9&lat=42.9&lng=-85.6', null, opts)).json();
  const b = await (await call(env, 'GET', '/api/water/truth/weather?walk=w9', null, opts)).json();
  assert.equal(a.frozen, false); assert.equal(b.frozen, true);
  assert.equal(b.series[0].ta, 11); assert.equal(calls, 1, 'fetched once');
  const c = await (await call(env, 'GET', '/api/water/truth/weather?walk=w9&lat=42.9&lng=-85.6&refresh=1', null, opts)).json();
  assert.equal(c.series[0].ta, 12); assert.equal(calls, 2);
  const kept = await env.DB.prepare('SELECT * FROM truth_weather').all();
  assert.ok(!/42\.9|85\.6/.test(JSON.stringify(kept.results)), 'no coordinates kept');
  assert.equal((await call(env, 'GET', '/api/water/truth/weather?walk=nope&lat=1&lng=1', null, opts)).status, 404);
});

await test('a station\'s reports read into a series; a moment in between is interpolated, the cloud the nearest', async () => {
  const csv = ['station,valid,tmpf,dwpf,relh,sknt,skyc1,skyc2,skyc3,skyc4',
    'TST,2026-11-20 17:53,50.0,40.0,68.0,10.0,FEW,BKN,,',
    'TST,2026-11-20 18:20,52.0,40.0,63.0,8.0,SCT,,,',
    'TST,2026-11-20 18:53,54.0,41.0,61.0,,OVC,,,'].join('\n');
  const s = parseAsosMoment(csv);
  assert.equal(s.length, 3);
  assert.ok(Math.abs(s[0].ta - 10) < 1e-9 && s[0].cloud === 0.75 && s[1].cloud === 0.5 && s[2].cloud === 1);
  assert.ok(Math.abs(s[0].wind - 10 * 0.514444 * 0.748) < 0.01, 'knots at 10 m to m/s at 2 m');
  const m = atMoment(s, Date.UTC(2026, 10, 20, 18, 6, 30));
  assert.ok(m.ta > s[0].ta && m.ta < s[1].ta, 'between the two reports');
  assert.equal(m.cloud, 0.75, 'the nearest report with a cloud');
  assert.ok(Math.abs(atMoment(s, Date.UTC(2026, 10, 20, 18, 40)).wind - s[1].wind) < 1e-9, 'a report with no wind: the last known wind');
});

await test('the page\'s Open-Meteo rows are kept with the station\'s, checked; each quantity from its best source', async () => {
  const env = { DB: d1(), ASSETS: { fetch: async () => new Response('[]') } };
  const t = T0 + 3e5;
  const station = async (stations, lat, lng, t0, t1, o) => weatherOfMoment([['TST', 'X', 42.9, -85.6, 2000, null, 'TEST']], lat, lng, t0, t1, { ...o, fetchFn: async () => new Response(['station,valid,tmpf,dwpf,relh,sknt,skyc1,skyc2,skyc3,skyc4', 'TST,2026-11-20 17:53,50,40,68,10,BKN,,,', 'TST,2026-11-20 18:53,54,41,61,8,SCT,,,'].join('\n')) });
  await call(env, 'POST', '/api/water/truth/walk', { walk: 'w5', map_id: 'mapA', started: T0, ended: T0 + 6e5, kinds: ['surface'] });
  const rows = [{ src: 'sat', t, ghi: 420 }, { src: 'hrrr', t, ta: 30, rh: 40, wind: 3, ghi: 500 }, { src: 'evil', t, ghi: 9 }, { src: 'sat', t: T0 + 864e5 * 5, ghi: 1 }, { src: 'sat', t, ghi: 99999 }];
  const r = await (await call(env, 'POST', '/api/water/truth/weather', { walk: 'w5', lat: 42.9, lng: -85.6, extra: { rows } }, { ...admin, weatherFn: station })).json();
  assert.equal(r.series.filter((x) => x.src === 'sat').length, 2, 'the out-of-window and unknown rows dropped');
  assert.equal(r.series.find((x) => x.src === 'sat' && x.ghi === null) ? 1 : 0, 1, 'a sunshine out of range kept as unknown');
  assert.ok(r.sources.some((x) => /satellite/.test(x.name)) && r.sources.some((x) => /ASOS/.test(x.name)));
  const m = atMoment(r.series, t);
  assert.equal(m.from.ghi, 'sat'); assert.equal(m.ghi, 420, 'the satellite before the model for sunshine');
  assert.equal(m.from.ta, 'asos'); assert.ok(m.ta < 13, 'the station before the model for the air');
  const frozen = await (await call(env, 'GET', '/api/water/truth/weather?walk=w5')).json();
  assert.equal(frozen.frozen, true); assert.equal(frozen.series.length, r.series.length);
});

await test('Open-Meteo answers read: the satellite\'s sunshine at its interval\'s middle, HRRR\'s wind to 2 m', async () => {
  const sat = parseOpenMeteo({ hourly: { time: ['2026-11-20T18:00', '2026-11-20T18:10'], shortwave_radiation: [300, 320] } }, 'sat');
  assert.equal(sat[0].t, Date.UTC(2026, 10, 20, 17, 55)); assert.equal(sat[1].ghi, 320);
  const h = parseOpenMeteo({ minutely_15: { time: ['2026-11-20T18:00'], temperature_2m: [11], relative_humidity_2m: [60], wind_speed_10m: [4], shortwave_radiation: [280] } }, 'hrrr');
  assert.ok(Math.abs(h.find((x) => x.ta === 11).wind - 4 * 0.748) < 0.01);
  assert.equal(h.find((x) => x.ghi === 280).t, Date.UTC(2026, 10, 20, 17, 52, 30));
  assert.deepEqual(cleanRows([{ src: 'sat', t: 5, ghi: 10 }], 0, 10).map((x) => x.ghi), [10]);
});

console.log(`\n${passed} passed`);
