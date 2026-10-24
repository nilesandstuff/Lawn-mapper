/**
 * The live water search (worker/src/water-find.js discoverWaterAt): against
 * a real SQLite database built from worker/schema.sql, and a stand-in for
 * ArcGIS Online, the Census geocoder and one city's server.
 *
 *   node tools/water-find.test.js
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { discoverWaterAt, askCell, oneCopyEach, liveOrder, ASKS_PER_HOUR } from '../worker/src/water-find.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failures++; if (detail) console.log(`      ${detail}`); }
};

function d1() {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
  const take = (name) => {
    const at = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
    return schema.slice(at, schema.indexOf(');', at) + 2);
  };
  for (const t of ['water_layers', 'water_roots', 'water_asks']) db.exec(take(t));
  const prepare = (sql) => {
    const st = db.prepare(sql);
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      first: async () => st.get(...args) ?? null,
      run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }),
      all: async () => ({ results: st.all(...args) }),
    };
    return api;
  };
  return { raw: db, prepare, batch: async (list) => Promise.all(list.map((p) => p.run())) };
}

/* A city 1 km across around the point, with one storm service of two layers. */
const LNG = -85.67, LAT = 42.96;
const CITY = 'https://gis.example-city.gov/arcgis/rest/services';
const SVC = `${CITY}/Stormwater/MapServer`;
let asked = [];
const fetcher = async (u) => {
  asked.push(u);
  const reply = (j) => ({ ok: true, json: async () => j });
  if (u.startsWith('https://www.arcgis.com/sharing/rest/search')) {
    const byName = /Example/.test(decodeURIComponent(u));
    return reply({ results: [
      { url: `${SVC}/0`, title: 'Storm Sewer', extent: [[LNG - 0.05, LAT - 0.05], [LNG + 0.05, LAT + 0.05]] },
      /* The nation's: too big to be local. */
      { url: 'https://services.arcgis.com/abc/arcgis/rest/services/US_Rivers/FeatureServer', title: 'Rivers', extent: [[-125, 25], [-66, 49]] },
      ...(byName ? [{ url: `${CITY}/Parks/MapServer`, title: 'Parks', extent: [[LNG - 0.05, LAT - 0.05], [LNG + 0.05, LAT + 0.05]] }] : []),
    ] });
  }
  if (u.startsWith('https://geocoding.geo.census.gov/')) {
    return reply({ result: { geographies: { Counties: [{ NAME: 'Example County' }], 'Incorporated Places': [{ NAME: 'Example city' }] } } });
  }
  if (u.startsWith(`${SVC}/layers`)) {
    return reply({ layers: [
      { id: 0, name: 'Catch Basins', type: 'Feature Layer', geometryType: 'esriGeometryPoint' },
      { id: 1, name: 'Storm Mains', type: 'Feature Layer', geometryType: 'esriGeometryPolyline' },
      { id: 2, name: 'Water Mains', type: 'Feature Layer', geometryType: 'esriGeometryPolyline' },
    ] });
  }
  if (u.startsWith(`${CITY}/Parks/MapServer/layers`)) return reply({ layers: [{ id: 0, name: 'Park Pond', type: 'Feature Layer', geometryType: 'esriGeometryPolygon' }] });
  if (u.includes('/query?')) {
    const n = u.includes('/Parks/') ? 3 : u.includes('/0/query') ? 1200 : 480;
    return reply({ count: n, extent: { xmin: LNG - 0.04, ymin: LAT - 0.04, xmax: LNG + 0.04, ymax: LAT + 0.04, spatialReference: { wkid: 4326 } } });
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const env = { DB: d1() };
const now = Date.parse('2026-10-24T18:00:00Z');

const first = await discoverWaterAt(env, LNG, LAT, { fetcher, now });
const rows = env.DB.raw.prepare('SELECT url, kind, source, ok, features FROM water_layers ORDER BY url').all();
check('a place is searched and its storm layers stored at once',
  first.status === 'done' && rows.length === 3
  && rows.find((r) => r.url === `${SVC}/0`)?.kind === 'storm_inlet' && rows.find((r) => r.url === `${SVC}/1`)?.kind === 'storm_main'
  && rows.every((r) => r.ok === 1), JSON.stringify({ first, rows }));
check('drinking-water mains are not kept', !rows.some((r) => r.url === `${SVC}/2`));
check('the national search hit is not read', !asked.some((u) => u.includes('US_Rivers')));
check('the server joins the nightly sweep',
  env.DB.raw.prepare('SELECT root FROM water_roots').all().map((r) => r.root).join() === CITY);
const ask = env.DB.raw.prepare('SELECT * FROM water_asks').all();
check('only the ~10 km cell is kept, never the point',
  ask.length === 1 && ask[0].cell === askCell(LNG, LAT).key && ask[0].lng === -85.7 && ask[0].lat === 43 && ask[0].status === 'done' && ask[0].done_at,
  JSON.stringify(ask));

asked = [];
const again = await discoverWaterAt(env, LNG + 0.01, LAT + 0.01, { fetcher, now: now + 3600000 });
check('the same cell is not searched again within the month', again.skipped === 'recent' && asked.length === 0, JSON.stringify(again));

const later = await discoverWaterAt(env, LNG, LAT, { fetcher, now: now + 31 * 86400000 });
check('a month later it is searched again, and services already kept are not re-read',
  later.status === 'known' && !asked.some((u) => u.startsWith(`${SVC}/layers`)), JSON.stringify(later));

{
  const busy = { DB: d1() };
  for (let i = 0; i < ASKS_PER_HOUR; i++) {
    busy.DB.raw.prepare("INSERT INTO water_asks (cell, lng, lat, asked_at, status) VALUES (?, 0, 0, ?, 'done')").run(`c${i}`, new Date(now - 60000).toISOString());
  }
  asked = [];
  const r = await discoverWaterAt(busy, LNG, LAT, { fetcher, now });
  check('at most ASKS_PER_HOUR new places an hour, site-wide', r.skipped === 'busy' && asked.length === 0, JSON.stringify(r));
}
{
  const slow = { DB: d1() };
  slow.DB.raw.prepare("INSERT INTO water_asks (cell, lng, lat, asked_at, status) VALUES (?, 0, 0, ?, 'searching')").run(askCell(LNG, LAT).key, new Date(now - 60000).toISOString());
  const r = await discoverWaterAt(slow, LNG, LAT, { fetcher, now });
  check('a cell another visit is searching is left to it', r.skipped === 'recent' || r.skipped === 'taken', JSON.stringify(r));
  const stale = await discoverWaterAt(slow, LNG, LAT, { fetcher, now: now + 20 * 60000 });
  check('a search that died is taken over after ten minutes', stale.status === 'done', JSON.stringify(stale));
}
check('no database, no search, no throw', (await discoverWaterAt({}, LNG, LAT, { fetcher })).skipped === 'no-place');
check('a nonsense point is not searched', (await discoverWaterAt(env, NaN, 3, { fetcher })).skipped === 'no-place');
{
  const failing = async () => { throw new Error('offline'); };
  const r = await discoverWaterAt({ DB: d1() }, LNG, LAT, { fetcher: failing, now });
  check('a search that reaches nothing finishes quietly', r.status === 'none', JSON.stringify(r));
}

/* ---------------------------------------------------------- pure parts */
check('cells are ~10 km and named by their centre', askCell(-85.6712, 42.9649).key === '-85.7,43.0' && askCell(-85.64, 42.94).key === '-85.6,42.9');
{
  const found = [
    { service: `${CITY}/A/MapServer`, kind: 'storm_inlet', title: 'Catch Basins' },
    { service: `${CITY}/B/MapServer`, kind: 'storm_inlet', title: 'Catch_Basins' },
    { service: `${CITY}/C/MapServer`, kind: 'water_body', title: 'Lakes 1K' },
    { service: `${CITY}/D/MapServer`, kind: 'water_body', title: 'Lakes 24K' },
    { service: 'https://other.gov/arcgis/rest/services/E/MapServer', kind: 'storm_inlet', title: 'Catch Basins' },
  ];
  const keep = oneCopyEach(found, [100, 120, 7262, 7262, 90]);
  check('one copy of each layer per server: the fullest, and one of identical counts',
    [...keep].sort().join() === '1,2,4', [...keep].join());
}
check('storm-sounding services are read first',
  liveOrder([{ service: 'b', title: 'Parks' }, { service: 'a', title: 'Zoning' }, { service: 'c', title: 'Storm Sewer' }]).map((h) => h.service).join() === 'c,a,b');

if (failures) { console.log(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nwater find: ok');
