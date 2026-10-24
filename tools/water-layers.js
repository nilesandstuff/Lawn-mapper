/**
 * THE WATER-LAYER CATALOGUE (owner, 2026-10-23: "look into adding new layers
 * that we collect from county gis servers, to make them available to the
 * water map: storm drains and any other water collection, water bodies").
 *
 * Walks the ArcGIS servers the parcel registry already knows (every county's
 * parcel service lives on its county's GIS server, and that server usually
 * publishes the rest of the county's layers beside it), lists every map and
 * feature service on each, and keeps every layer whose name and geometry say
 * it is water: storm inlets, manholes, mains, culverts, outfalls, detention
 * basins, drain districts and easements, open drains, lakes, streams,
 * wetlands, flood zones, watersheds (worker/src/water-layers.js
 * classifyLayer). Each kept layer is asked once for its count and its extent
 * in degrees, and written to the water_layers table, which
 * GET /api/water/layers reads beside the national layers.
 *
 * 727 servers are too many for one six-hour job, so the sweep is resumable:
 * water_sweep remembers each server it finished, and a run takes the ones
 * not looked at in RECHECK_DAYS, those under people's saved maps first.
 *
 *   ROOTS_LIMIT=40 TIME_BUDGET_MIN=300 DRY_RUN=1 node tools/water-layers.js
 *   COUNTIES=mi-kent node tools/water-layers.js     (only these registry keys)
 *
 * Nothing printed or stored names an address: servers, layers and boxes only.
 */

import { writeFileSync } from 'node:fs';
import { ALL_COUNTIES } from '../worker/src/counties.js';
import { classifyLayer, geometryWord, KINDS, codebookOf } from '../worker/src/water-layers.js';

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const ROOTS_LIMIT = Number(process.env.ROOTS_LIMIT || 60);
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 300) * 60000;
const RECHECK_DAYS = Number(process.env.RECHECK_DAYS || 90);
const MAX_SERVICES = Number(process.env.MAX_SERVICES || 150);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 20000);
const POOL = Number(process.env.POOL || 6);
const REPORT = process.env.REPORT || 'water-layers-report.json';

/* ------------------------------------------------------------ pure parts */

/** The /rest/services root of a service URL, or null. */
export function rootOf(serviceUrl) {
  const m = String(serviceUrl || '').match(/^(https?:\/\/.+?\/rest\/services)(\/|$)/i);
  return m ? m[1] : null;
}

/** Every server root in the registry, with the counties on it. */
export function registryRoots(counties = ALL_COUNTIES, only = null) {
  const roots = new Map();
  for (const [key, e] of Object.entries(counties)) {
    if (only && !only.includes(key)) continue;
    for (const s of [e.service, ...(e.fallbacks || []).map((f) => f.service)]) {
      const r = rootOf(s);
      if (!r) continue;
      if (!roots.has(r)) roots.set(r, { root: r, keys: [], boxes: [] });
      const row = roots.get(r);
      if (!row.keys.includes(key)) { row.keys.push(key); if (e.box) row.boxes.push(e.box); }
    }
  }
  return [...roots.values()];
}

/** Does a registry box hold this point? */
export const boxHolds = (b, lng, lat) => Array.isArray(b) && lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

/**
 * The order to sweep in: roots under saved maps first (most maps first), then
 * the rest, skipping any finished within RECHECK_DAYS.
 */
export function sweepOrder(roots, points = [], done = new Map(), now = Date.now(), recheckDays = RECHECK_DAYS) {
  const fresh = (r) => {
    const at = done.get(r.root);
    return at && now - Date.parse(at) < recheckDays * 86400000;
  };
  const under = (r) => points.filter(([lng, lat]) => r.boxes.some((b) => boxHolds(b, lng, lat))).length;
  return roots.filter((r) => !fresh(r))
    .map((r) => ({ ...r, maps: under(r) }))
    .sort((a, b) => b.maps - a.maps || a.root.localeCompare(b.root));
}

/** Web Mercator metres to degrees. */
export function mercToLngLat(x, y) {
  const R = 6378137;
  return [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)];
}

/** An ArcGIS extent as [w,s,e,n] in degrees when it can be read without a projection library, else null. */
export function extentDegrees(ext) {
  if (!ext || ![ext.xmin, ext.ymin, ext.xmax, ext.ymax].every(Number.isFinite)) return null;
  const wkid = Number(ext.spatialReference?.latestWkid || ext.spatialReference?.wkid);
  if (wkid === 4326 || wkid === 4269) return [ext.xmin, ext.ymin, ext.xmax, ext.ymax];
  if (wkid === 3857 || wkid === 102100 || wkid === 102113 || wkid === 900913) {
    const [w, s] = mercToLngLat(ext.xmin, ext.ymin);
    const [e, n] = mercToLngLat(ext.xmax, ext.ymax);
    return [w, s, e, n];
  }
  return null;
}

/** A box that is a real place on Earth, not a placeholder extent. */
export const sensibleBox = (b) => Array.isArray(b) && b.every(Number.isFinite)
  && b[0] < b[2] && b[1] < b[3] && b[0] >= -180 && b[2] <= 180 && b[1] >= -85 && b[3] <= 85
  && (b[2] - b[0]) < 30 && (b[3] - b[1]) < 30;

/** The service URLs a root's listing (and its folders' listings) name. */
export function servicesFrom(root, listing) {
  return (listing?.services || [])
    .filter((s) => s.type === 'MapServer' || s.type === 'FeatureServer')
    .map((s) => `${root}/${s.name}/${s.type}`);
}

/**
 * The water layers of one service's /layers listing: leaves only (no group
 * layers), classified by name and geometry.
 */
export function waterLayersOf(serviceUrl, layersJson) {
  const out = [];
  for (const l of layersJson?.layers || []) {
    if (l.type && !/feature layer/i.test(l.type)) continue;
    if (Array.isArray(l.subLayers) && l.subLayers.length) continue;
    const kind = classifyLayer(l.name, l.geometryType);
    if (!kind) continue;
    /* Its names for its codes, from the same description (subtypes, domains,
       and its map style's labels), kept so the route need not ask again. */
    const book = codebookOf(l);
    const named = Object.keys(book.book).length || Object.keys(book.bySubtype).length;
    out.push({
      url: `${serviceUrl}/${l.id}`, kind, title: l.name, geometry: geometryWord(l.geometryType), extent: l.extent || null,
      codebook: named ? JSON.stringify(book) : null,
    });
  }
  return out;
}

/** SQL for one row, quoted. */
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
export function upsertSql(row) {
  const cols = ['url', 'kind', 'title', 'service', 'geometry', 'county_key', 'source', 'west', 'south', 'east', 'north', 'features', 'ok', 'checked_at', 'codebook'];
  const vals = cols.map((c) => q(row[c]));
  return `INSERT INTO water_layers (${cols.join(', ')}) VALUES (${vals.join(', ')}) `
    + `ON CONFLICT(url) DO UPDATE SET ${cols.filter((c) => c !== 'url').map((c) => `${c} = excluded.${c}`).join(', ')};`;
}

/* ------------------------------------------------------------- network */

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'f=json', { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (d?.error) throw new Error(d.error.message || `error ${d.error.code}`);
    return d;
  } finally { clearTimeout(t); }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => ({ error: String(e?.message || e) })); }
  }));
  return out;
}

/** Every map and feature service on a root, its folders included (one level, as ArcGIS nests them). */
async function listServices(root) {
  const top = await getJson(root);
  let urls = servicesFrom(root, top);
  const folders = (top.folders || []).filter((f) => !/^(utilities|system|hosted)$/i.test(f));
  const nested = await pool(folders, POOL, (f) => getJson(`${root}/${f}`));
  for (const listing of nested) urls = urls.concat(servicesFrom(root, listing));
  return [...new Set(urls)].slice(0, MAX_SERVICES);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A count and an extent over a whole county layer can take a server several
   seconds, and some (Kent County's) answer one at a time but fail several at
   once: so measuring goes two at a time, and each ask is tried twice. */
async function twice(url) {
  try { return await getJson(url); } catch { await sleep(1500); return getJson(url); }
}

/** How many features a layer has and where, in degrees; count null when it never answered. */
async function measure(layer) {
  try {
    const d = await twice(`${layer.url}/query?where=1%3D1&returnCountOnly=true&returnExtentOnly=true&outSR=4326`);
    const ext = d.extent ? extentDegrees({ ...d.extent, spatialReference: d.extent.spatialReference || { wkid: 4326 } }) : null;
    if (Number.isFinite(Number(d.count))) return { count: Number(d.count), box: ext || extentDegrees(layer.extent) };
  } catch { /* the two halves apart, below */ }
  const c = await twice(`${layer.url}/query?where=1%3D1&returnCountOnly=true`).catch(() => null);
  const e = await twice(`${layer.url}/query?where=1%3D1&returnExtentOnly=true&outSR=4326`).catch(() => null);
  return {
    count: Number.isFinite(Number(c?.count)) ? Number(c.count) : null,
    box: (e?.extent && extentDegrees({ ...e.extent, spatialReference: e.extent.spatialReference || { wkid: 4326 } })) || extentDegrees(layer.extent),
  };
}

/* ---------------------------------------------------------------- main */

async function db() {
  const { query, wrangler, resolveDatabase, flatSql } = await import('./corpus-db.js');
  let id = null;
  const exec = (sql) => {
    if (DRY_RUN) return;
    id = id || resolveDatabase(true);
    wrangler(['d1', 'execute', id, '--remote', '--command', flatSql(sql)]);
  };
  return { query, exec };
}

const ENSURE = [
  `CREATE TABLE IF NOT EXISTS water_layers (url TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, service TEXT, geometry TEXT,
     county_key TEXT, source TEXT, west REAL, south REAL, east REAL, north REAL, features INTEGER, ok INTEGER NOT NULL DEFAULT 0, checked_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS water_layers_box ON water_layers (west, east, south, north)',
  'CREATE TABLE IF NOT EXISTS water_sweep (root TEXT PRIMARY KEY, services INTEGER, found INTEGER, error TEXT, checked_at TEXT)',
];
/* The column a deploy's migrations add; the sweep may run before that deploy. */
const ADD_CODEBOOK = 'ALTER TABLE water_layers ADD COLUMN codebook TEXT';

async function main() {
  const started = Date.now();
  const only = (process.env.COUNTIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const live = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  const { query, exec } = live ? await db() : { query: () => [], exec: () => {} };
  for (const sql of ENSURE) exec(sql);
  try { exec(ADD_CODEBOOK); } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  const done = new Map();
  let points = [];
  if (live) {
    for (const r of query('SELECT root, checked_at FROM water_sweep')) done.set(r.root, r.checked_at);
    points = query('SELECT lng, lat FROM maps WHERE lng IS NOT NULL AND lat IS NOT NULL').map((r) => [Number(r.lng), Number(r.lat)]);
  }
  const order = sweepOrder(registryRoots(ALL_COUNTIES, only.length ? only : null), points, only.length ? new Map() : done);
  const todo = order.slice(0, ROOTS_LIMIT);
  console.log(`${order.length} server(s) due; this run takes ${todo.length}${DRY_RUN ? ' (dry run: nothing written)' : ''}.`);

  const report = { roots: [], byKind: {}, layers: 0, ok: 0 };
  for (const r of todo) {
    if (Date.now() - started > TIME_BUDGET_MS) { console.log('Time budget spent; the next run carries on.'); break; }
    const row = { root: r.root, counties: r.keys, maps: r.maps, services: 0, found: [], error: null };
    try {
      const services = await listServices(r.root);
      row.services = services.length;
      const listed = await pool(services, POOL, async (s) => waterLayersOf(s, await getJson(`${s}/layers`)));
      const found = listed.flatMap((x, i) => (Array.isArray(x) ? x.map((l) => ({ ...l, service: services[i] })) : []));
      const measured = await pool(found, 2, measure);
      const now = new Date().toISOString();
      found.forEach((l, i) => {
        const m = measured[i] || {};
        const box = sensibleBox(m.box) ? m.box : (r.boxes.length === 1 ? r.boxes[0] : null);
        const rec = {
          url: l.url, kind: l.kind, title: l.title, service: l.service, geometry: l.geometry,
          county_key: r.keys.length === 1 ? r.keys[0] : r.keys.slice(0, 3).join(','),
          source: `${r.keys.length === 1 ? (ALL_COUNTIES[r.keys[0]]?.name || r.keys[0]) : 'county GIS'}`,
          west: box?.[0] ?? null, south: box?.[1] ?? null, east: box?.[2] ?? null, north: box?.[3] ?? null,
          features: Number.isFinite(m.count) ? m.count : null,
          ok: box && m.count > 0 ? 1 : 0,
          checked_at: now,
          codebook: l.codebook,
        };
        exec(upsertSql(rec));
        row.found.push({ kind: rec.kind, title: rec.title, features: rec.features, ok: rec.ok });
        report.layers++;
        if (rec.ok) { report.ok++; report.byKind[rec.kind] = (report.byKind[rec.kind] || 0) + 1; }
      });
    } catch (e) {
      row.error = String(e?.message || e).slice(0, 200);
    }
    exec(`INSERT INTO water_sweep (root, services, found, error, checked_at) VALUES (${q(r.root)}, ${row.services}, ${row.found.length}, ${q(row.error)}, ${q(new Date().toISOString())})
          ON CONFLICT(root) DO UPDATE SET services = excluded.services, found = excluded.found, error = excluded.error, checked_at = excluded.checked_at;`);
    report.roots.push(row);
    const okHere = row.found.filter((f) => f.ok).length;
    console.log(`${row.error ? 'FAILED' : 'looked '} ${r.root} (${r.keys.slice(0, 2).join(', ')}${r.keys.length > 2 ? ', ...' : ''}): `
      + `${row.services} service(s), ${okHere} water layer(s)${row.error ? ` -- ${row.error}` : ''}`);
  }
  writeFileSync(REPORT, JSON.stringify(report, null, 1));

  /* Said at the end, where a phone reader looks. */
  const kinds = Object.entries(report.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${KINDS[k]?.label || k} ${n}`).join(', ');
  console.log(`\nWater layers: ${report.ok} usable of ${report.layers} found on ${report.roots.length} server(s)`
    + `${report.roots.filter((x) => x.error).length ? `, ${report.roots.filter((x) => x.error).length} server(s) did not answer` : ''}.`);
  console.log(kinds ? `By kind: ${kinds}.` : 'No water layers on these servers.');
  console.log(`${Math.max(0, order.length - report.roots.length)} server(s) still due for a later run.`);
}

if (process.argv[1] && process.argv[1].endsWith('water-layers.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
