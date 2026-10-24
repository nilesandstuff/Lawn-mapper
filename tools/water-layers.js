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
import { KINDS } from '../worker/src/water-layers.js';
import {
  rootOf, mercToLngLat, extentDegrees, sensibleBox, servicesFrom, keptCodebook, MAX_CODES_PER_FIELD, MAX_CODEBOOK_CHARS, agolWaterSearchUrl, NATIONAL_HOST, agolWaterKeep, censusUrl, placeNames, agolWaterNameUrl, sourceOfRoot,
  waterLayersOf as readWaterLayers, oneCopyEach,
} from '../worker/src/water-find.js';

export {
  rootOf, mercToLngLat, extentDegrees, sensibleBox, servicesFrom, keptCodebook, MAX_CODES_PER_FIELD, MAX_CODEBOOK_CHARS, agolWaterSearchUrl, NATIONAL_HOST, agolWaterKeep, censusUrl, placeNames, agolWaterNameUrl, sourceOfRoot,
};

/** The water layers of one service's listing, with the state seeds' named kinds. */
export const waterLayersOf = (serviceUrl, layersJson, seedKinds = SEED_KINDS) => readWaterLayers(serviceUrl, layersJson, seedKinds);

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const ROOTS_LIMIT = Number(process.env.ROOTS_LIMIT || 60);
const TIME_BUDGET_MS = Number(process.env.TIME_BUDGET_MIN || 300) * 60000;
const RECHECK_DAYS = Number(process.env.RECHECK_DAYS || 90);
const MAX_SERVICES = Number(process.env.MAX_SERVICES || 150);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 20000);
const POOL = Number(process.env.POOL || 6);
const REPORT = process.env.REPORT || 'water-layers-report.json';
/* The ArcGIS Online search before the sweep (on unless SEARCH=0), from at most this many places. */
const SEARCH = !/^(0|false|no|off)$/i.test(process.env.SEARCH || '');
const SEARCH_POINTS = Number(process.env.SEARCH_POINTS || 120);

/* ------------------------------------------------------------ pure parts */


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
    const at = done.get(r.key || r.root);
    return at && now - Date.parse(at) < recheckDays * 86400000;
  };
  const under = (r) => points.filter(([lng, lat]) => r.boxes.some((b) => boxHolds(b, lng, lat))).length;
  return roots.filter((r) => !fresh(r))
    .map((r) => ({ ...r, maps: under(r) }))
    .sort((a, b) => b.maps - a.maps || a.root.localeCompare(b.root));
}



/** The places to search from: saved maps, rounded to about 2 km so a street of maps is asked once. */
export function searchPoints(points, step = 0.02, max = 120) {
  const seen = new Map();
  for (const [lng, lat] of points) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const k = `${Math.round(lng / step)},${Math.round(lat / step)}`;
    if (!seen.has(k)) seen.set(k, [Math.round(lng / step) * step, Math.round(lat / step) * step]);
  }
  return [...seen.values()].slice(0, max);
}


/*
 * STATEWIDE DRAINAGE INVENTORIES, named here because a search near a saved
 * map cannot be relied on to find them (2026-10-24; owner: "add other
 * statewide inventories like New Jersey's"). New Jersey's DEP collects every
 * town's MS4 storm-sewer map, and its ArcGIS Online listings carry a broken
 * extent (metres in the degrees field), so the search's "does it cover this
 * map" test throws them out. The rest are a state agency's own inventory,
 * mostly a highway department's drainage along state roads: those are
 * real pipes and inlets, but only along the state's roads, not a town's.
 *
 * Only the services named are swept, not the rest of the agency's server:
 * what else a state publishes is mostly the natural water the national
 * layers already give. `kinds` names what a plainly named layer is ("Pipes"
 * in a storm-drain inventory), or drops one (null). Counts as of 2026-10-24.
 *
 * Looked at and left out: Montana DOT's MS4 outfalls (token required),
 * Connecticut DEEP's MS4 layers (the server's certificate does not verify),
 * Florida's stormwater facilities (permit records with owners' phone numbers
 * and emails, not drains), WisDOT's "possible" culvert locations (modelled,
 * not surveyed), and the fish-passage barrier lists (barriers, not drains).
 */
export const STATE_SEEDS = [
  { state: 'NJ', source: 'New Jersey DEP (town storm sewers)', root: 'https://mapsdep.nj.gov/arcgis/rest/services',
    /* 77,613 inlets, 73,793 outfalls, 592 culverts, and the basins. */
    services: ['https://mapsdep.nj.gov/arcgis/rest/services/Applications/MS4_Map/MapServer'] },
  { state: 'MD', source: 'Maryland MDE (county storm drains)', root: 'https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services',
    /* The counties' own storm-drain maps, gathered by the state: 100,711
       structures and 91,503 pipes in one county's set alone. */
    services: ['https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services/Stormdrain_Data_MD_Statewide_Dec_24_WFL1/FeatureServer'],
    kinds: Object.fromEntries([[10, 'storm_main'], [20, 'storm_manhole'], [24, 'culvert'], [25, 'culvert'], [35, 'culvert'], [44, 'storm_manhole'], [45, 'storm_main']]
      .map(([id, k]) => [`https://services.arcgis.com/njFNhDsUCentVYJW/arcgis/rest/services/Stormdrain_Data_MD_Statewide_Dec_24_WFL1/FeatureServer/${id}`, k])) },
  { state: 'MD', source: 'Maryland SHA (state roads)', root: 'https://maps.roads.maryland.gov/arcgis/rest/services',
    /* 180,991 structures, 148,643 pipes and channels, 15,664 SWM facilities. */
    services: ['https://maps.roads.maryland.gov/arcgis/rest/services/NPDES/Structures_NPDES_Maryland_MDOTSHA/MapServer',
      'https://maps.roads.maryland.gov/arcgis/rest/services/NPDES/Conveyance_NPDES_Maryland_MDOTSHA/MapServer',
      'https://maps.roads.maryland.gov/arcgis/rest/services/NPDES/SWMFAC_NPDES_Maryland_MDOTSHA/MapServer'],
    kinds: {
      'https://maps.roads.maryland.gov/arcgis/rest/services/NPDES/Structures_NPDES_Maryland_MDOTSHA/MapServer/0': 'storm_manhole',
      'https://maps.roads.maryland.gov/arcgis/rest/services/NPDES/Conveyance_NPDES_Maryland_MDOTSHA/MapServer/0': 'storm_main',
      'https://maps.roads.maryland.gov/arcgis/rest/services/NPDES/SWMFAC_NPDES_Maryland_MDOTSHA/MapServer/0': 'detention_basin',
    } },
  { state: 'NC', source: 'NCDOT (state roads)', root: 'https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services',
    /* 368,204 inlets, 28,729 pipes. */
    /* Pipes first: it did not answer on the first sweep, and a seed is
       remembered by its first service, so this makes it due again. */
    services: ['https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT_Storm_Drainage_Pipes_Public_View/FeatureServer',
      'https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT_Inlets_Public_View_(Draft)/FeatureServer'],
    kinds: { 'https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT_Storm_Drainage_Pipes_Public_View/FeatureServer/0': null } },
  { state: 'VA', source: 'VDOT (state roads)', root: 'https://services.arcgis.com/p5v98VHDX9Atv3l7/arcgis/rest/services',
    /* 28,996 outfalls. */
    services: ['https://services.arcgis.com/p5v98VHDX9Atv3l7/arcgis/rest/services/OutFalls_and_PODs_06_2016_view/FeatureServer'] },
  { state: 'MA', source: 'MassDOT (state roads)', root: 'https://gis.massdot.state.ma.us/arcgis/rest/services',
    /* 143,158 inlets, 145,769 manholes, 22,838 discharge points, the pipes, 6,043 culverts. */
    services: ['https://gis.massdot.state.ma.us/arcgis/rest/services/Assets/Stormwater/FeatureServer',
      'https://gis.massdot.state.ma.us/arcgis/rest/services/Assets/Culverts/FeatureServer'],
    kinds: { 'https://gis.massdot.state.ma.us/arcgis/rest/services/Assets/Stormwater/FeatureServer/5': 'storm_main' } },
  { state: 'CT', source: 'CTDOT (state roads)', root: 'https://services1.arcgis.com/FCaUeJ5SOVtImake/arcgis/rest/services',
    /* 99,120 inlets, 39,304 headwalls, 12,327 manholes, 8,720 culverts, the pipes and ditches. */
    services: ['https://services1.arcgis.com/FCaUeJ5SOVtImake/arcgis/rest/services/CTDOT_Drainage_Network/FeatureServer'],
    kinds: Object.fromEntries([[1, 'storm_main'], [2, 'open_drain'], [11, null], [12, null]]
      .map(([id, k]) => [`https://services1.arcgis.com/FCaUeJ5SOVtImake/arcgis/rest/services/CTDOT_Drainage_Network/FeatureServer/${id}`, k])) },
  { state: 'NH', source: 'New Hampshire SADES (town storm drains)', root: 'https://services3.arcgis.com/mB6GMjOL4lVKAyZO/arcgis/rest/services',
    /* The towns' stormwater asset exchange: 59,877 outlets, 41,021 inlets, the structures and pipes. */
    services: ['https://services3.arcgis.com/mB6GMjOL4lVKAyZO/arcgis/rest/services/SADES_CCDS_PUBLIC_VIEW/FeatureServer'],
    kinds: {
      'https://services3.arcgis.com/mB6GMjOL4lVKAyZO/arcgis/rest/services/SADES_CCDS_PUBLIC_VIEW/FeatureServer/2': 'storm_manhole',
      'https://services3.arcgis.com/mB6GMjOL4lVKAyZO/arcgis/rest/services/SADES_CCDS_PUBLIC_VIEW/FeatureServer/3': 'storm_main',
    } },
  { state: 'VT', source: 'Vermont ANR (town storm drains)', root: 'https://anrmaps.vermont.gov/arcgis/rest/services',
    /* The towns' mapped stormwater: 119,308 lines, the points and areas, the
       stormsheds; and the road-erosion programme's outlets to water (4,021). */
    services: ['https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASSTORMWATER_WM_NOCACHE/MapServer'],
    kinds: Object.fromEntries([[5, 'storm_inlet'], [7, 'detention_basin'], [12, 'watershed'], [23, null], [24, null]]
      .map(([id, k]) => [`https://anrmaps.vermont.gov/arcgis/rest/services/map_services/MAP_ANR_ANRATLASSTORMWATER_WM_NOCACHE/MapServer/${id}`, k])) },
  { state: 'VT', source: 'VTrans (state roads)', root: 'https://maps.vtrans.vermont.gov/arcgis/rest/services',
    /* 48,830 culverts, 21,414 drop inlets, the access holes. */
    services: ['https://maps.vtrans.vermont.gov/arcgis/rest/services/HWY/AMP_SmallCulvertInventory/FeatureServer'],
    kinds: { 'https://maps.vtrans.vermont.gov/arcgis/rest/services/HWY/AMP_SmallCulvertInventory/FeatureServer/2': 'storm_manhole' } },
  { state: 'ME', source: 'MaineDOT (state roads)', root: 'https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services',
    /* 2,380 catch basins, 672 outfalls, the culverts and ditches. */
    services: ['https://services1.arcgis.com/RbMX0mRVOFNTdLzd/arcgis/rest/services/MAINEDOT_MS4_MAP/FeatureServer'] },
  { state: 'WA', source: 'WSDOT (state highways)', root: 'https://data.wsdot.wa.gov/arcgis/rest/services',
    /* Office and field inventories: 43,334 inlets, 13,894 discharge points,
       55,267 pipes, 22,130 ditches, 13,941 culverts. */
    services: ['https://data.wsdot.wa.gov/arcgis/rest/services/Shared/StormwaterFeaturesInventoryField/FeatureServer',
      'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/StormwaterFeaturesInventoryOffice/FeatureServer'] },
  { state: 'UT', source: 'UDOT (state roads)', root: 'https://services.arcgis.com/pA2nEVnB6tquxgOW/arcgis/rest/services',
    /* 106,087 catch basins, 47,862 manholes, 155,367 pipes, 4,045 outfalls, 1,832 detention basins. */
    services: ['https://services.arcgis.com/pA2nEVnB6tquxgOW/arcgis/rest/services/Statewide_Stormwater_Drainage_Features/FeatureServer'] },
  { state: 'CA', source: 'Caltrans (state highways)', root: 'https://services.arcgis.com/kpMKjjLr8H1rZ4XO/arcgis/rest/services',
    /* 185,735 culverts and drain pipes. */
    services: ['https://services.arcgis.com/kpMKjjLr8H1rZ4XO/arcgis/rest/services/Caltrans_Culvert_System/FeatureServer'],
    kinds: { 'https://services.arcgis.com/kpMKjjLr8H1rZ4XO/arcgis/rest/services/Caltrans_Culvert_System/FeatureServer/3': 'culvert' } },
  { state: 'MI', source: 'MDOT (state roads)', root: 'https://services2.arcgis.com/67lKNkQ2TO1I3lhR/arcgis/rest/services',
    /* 40,029 culverts. */
    services: ['https://services2.arcgis.com/67lKNkQ2TO1I3lhR/arcgis/rest/services/MdotCulvertAncillaryStructuresOpenData/FeatureServer'] },
  { state: 'IA', source: 'Iowa DOT (state roads)', root: 'https://gis.iowadot.gov/agshost/rest/services',
    /* 80,408 culverts (the flowlines and subdrains are the same culverts again). */
    services: ['https://gis.iowadot.gov/agshost/rest/services/Maintenance/Culverts_Data/FeatureServer'],
    kinds: { 'https://gis.iowadot.gov/agshost/rest/services/Maintenance/Culverts_Data/FeatureServer/1': null,
      'https://gis.iowadot.gov/agshost/rest/services/Maintenance/Culverts_Data/FeatureServer/4': null } },
];

/** Every seed's named kinds, by layer URL. */
export const SEED_KINDS = Object.assign({}, ...STATE_SEEDS.map((s) => s.kinds || {}));

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

/** The kinds that are a drainage network, not natural water: named per server in the log. */
const DRAINAGE = new Set(['storm_inlet', 'storm_manhole', 'storm_main', 'culvert', 'outfall', 'open_drain', 'drain_district', 'drain_easement', 'detention_basin']);

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
  const { query, wrangler, resolveDatabase, reasonFrom } = await import('./corpus-db.js');
  let id = null;
  /* Lines joined, nothing else: flatSql drops everything after a "--" as a
     comment, even inside a quoted value (a code named "-- none --", or an
     error that quotes "npx --no-install"). These statements carry none. */
  const exec = (sql) => {
    if (DRY_RUN) return;
    id = id || resolveDatabase(true);
    wrangler(['d1', 'execute', id, '--remote', '--command', String(sql).replace(/\s*\n\s*/g, ' ').trim()]);
  };
  return { query, exec, reasonFrom };
}

const ENSURE = [
  `CREATE TABLE IF NOT EXISTS water_layers (url TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT, service TEXT, geometry TEXT,
     county_key TEXT, source TEXT, west REAL, south REAL, east REAL, north REAL, features INTEGER, ok INTEGER NOT NULL DEFAULT 0, checked_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS water_layers_box ON water_layers (west, east, south, north)',
  'CREATE TABLE IF NOT EXISTS water_sweep (root TEXT PRIMARY KEY, services INTEGER, found INTEGER, error TEXT, checked_at TEXT)',
  'CREATE TABLE IF NOT EXISTS water_roots (root TEXT PRIMARY KEY, services TEXT, maps INTEGER, found_at TEXT)',
  'CREATE TABLE IF NOT EXISTS water_asks (cell TEXT PRIMARY KEY, lng REAL, lat REAL, asked_at TEXT NOT NULL, status TEXT, services INTEGER, layers INTEGER, done_at TEXT)',
];
/* The column a deploy's migrations add; the sweep may run before that deploy. */
const ADD_CODEBOOK = 'ALTER TABLE water_layers ADD COLUMN codebook TEXT';

async function main() {
  const started = Date.now();
  const only = (process.env.COUNTIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const live = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  const { query, exec, reasonFrom } = live ? await db() : { query: () => [], exec: () => {}, reasonFrom: null };
  /* A failure as one short line, safe to store: no SQL quoted back. */
  const why = (e) => String((reasonFrom ? reasonFrom(e) : null) || e?.message || e).replace(/\s+/g, ' ').slice(0, 200);
  for (const sql of ENSURE) exec(sql);
  try { exec(ADD_CODEBOOK); } catch (e) {
    if (!/duplicate column/i.test(String(e?.message || e))) throw e;
  }

  const done = new Map();
  let points = [];
  if (live) {
    for (const r of query('SELECT root, checked_at FROM water_sweep')) done.set(r.root, r.checked_at);
    points = query('SELECT lng, lat FROM maps WHERE lng IS NOT NULL AND lat IS NOT NULL').map((r) => [Number(r.lng), Number(r.lat)]);
    /* And the places people have looked at lately (water_asks, a ~10 km cell
       each, from the live search): searched properly here, and their
       counties' servers swept first. */
    try {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      points = points.concat(query(`SELECT lng, lat FROM water_asks WHERE asked_at > '${since}'`).map((r) => [Number(r.lng), Number(r.lat)]));
    } catch { /* no asks yet */ }
  }
  /* For a trial without the database: TEST_POINTS="lng,lat;lng,lat". */
  if (!points.length && process.env.TEST_POINTS) {
    points = process.env.TEST_POINTS.split(';').map((p) => p.split(',').map(Number)).filter((p) => p.length === 2);
  }
  /* 1. THE SEARCH: drainage services on ArcGIS Online over saved maps, and
        the servers they are on, kept in water_roots for the sweep. */
  const searched = new Map();
  if (SEARCH && !only.length) {
    const spots = searchPoints(points, 0.02, SEARCH_POINTS);
    const keep = (results, spot, here) => {
      for (const k of agolWaterKeep(results, spot[0], spot[1])) {
        if (!searched.has(k.root)) searched.set(k.root, { services: new Set(), maps: 0 });
        searched.get(k.root).services.add(k.service);
        here.add(k.root);
      }
    };
    /* Each place's names, and the spots that gave each name. */
    const byName = new Map();
    const reach = new Map(spots.map((p) => [p.join(','), new Set()]));
    for (const spot of spots) {
      const here = reach.get(spot.join(','));
      /* By the point: one page, for items whose extent is tight around it. */
      try { keep((await getJson(agolWaterSearchUrl(spot[0], spot[1], 1))).results, spot, here); } catch { /* the names below */ }
      try {
        const g = (await getJson(censusUrl(spot[0], spot[1])))?.result?.geographies;
        for (const name of placeNames(g)) {
          if (!byName.has(name)) byName.set(name, []);
          byName.get(name).push(spot);
        }
      } catch { /* no names here: the point search above stands */ }
      await sleep(250);
    }
    /* By name: two pages a name, each result kept at every spot it covers. */
    for (const [name, at] of byName) {
      for (let start = 1, page = 0; page < 2 && start > 0; page++) {
        let j;
        try { j = await getJson(agolWaterNameUrl(name, start)); } catch { break; }
        for (const spot of at) keep(j.results, spot, reach.get(spot.join(',')));
        start = j.nextStart > 0 ? j.nextStart : 0;
        await sleep(250);
      }
    }
    for (const here of reach.values()) for (const root of here) searched.get(root).maps++;
    console.log(`Place names searched: ${byName.size} (counties, cities and townships under saved maps).`);
    /* Each found server, with how many places it was found near (the order). */
    for (const [root, e] of searched) {
      exec(`INSERT INTO water_roots (root, services, maps, found_at) VALUES (${q(root)}, ${q(JSON.stringify([...e.services].slice(0, 40)))}, ${e.maps}, ${q(new Date().toISOString())})
            ON CONFLICT(root) DO UPDATE SET services = excluded.services, maps = excluded.maps, found_at = excluded.found_at;`);
    }
    console.log(`Searched ArcGIS Online at ${spots.length} place(s) with saved maps: ${searched.size} server(s) with drainage services, `
      + `${[...searched.values()].reduce((n, e) => n + e.services.size, 0)} service(s).`);
  }
  /* The servers found by any search so far, beside the registry's. */
  const extra = new Map();
  if (live && !only.length) {
    for (const r of query('SELECT root, services, maps FROM water_roots')) {
      let services = [];
      try { services = JSON.parse(r.services || '[]'); } catch { services = []; }
      extra.set(r.root, { services, maps: Number(r.maps) || 1 });
    }
  }
  for (const [root, e] of searched) if (!extra.has(root)) extra.set(root, { services: [...e.services], maps: e.maps || 1 });
  const registry = registryRoots(ALL_COUNTIES, only.length ? only : null);
  const known = new Set(registry.map((r) => r.root));
  const found = [...extra].filter(([root]) => !known.has(root))
    .map(([root, e]) => ({ root, keys: [], boxes: [], services: e.services, searched: true, weight: e.maps }));
  for (const r of registry) if (extra.has(r.root)) r.services = extra.get(r.root).services;

  /* 2. THE SWEEP: searched servers first (they are under saved maps by
        construction), then the registry's, those under saved maps first. */
  /* The state inventories: only their own services, under the agency's
     name, each remembered by its first service rather than by the server it
     sits on, so a seed added is due at once even on a server a search swept
     today. */
  const seeds = only.length ? [] : STATE_SEEDS.map((x) => ({
    root: x.root, key: x.services[0], keys: [], boxes: [], services: x.services, searched: true, weight: 1, alone: true, source: x.source,
  }));
  const order = [
    ...sweepOrder(seeds, [], done).map((r) => ({ ...r, maps: r.weight })),
    ...sweepOrder(found, [], only.length ? new Map() : done).map((r) => ({ ...r, maps: r.weight })),
    ...sweepOrder(registry, points, only.length ? new Map() : done),
  ];
  const todo = order.slice(0, ROOTS_LIMIT);
  console.log(`${order.length} server(s) due; this run takes ${todo.length}${DRY_RUN ? ' (dry run: nothing written)' : ''}.`);

  const report = { roots: [], byKind: {}, layers: 0, ok: 0 };
  for (const r of todo) {
    if (Date.now() - started > TIME_BUDGET_MS) { console.log('Time budget spent; the next run carries on.'); break; }
    const row = { root: r.root, counties: r.keys, maps: r.maps, services: 0, found: [], error: null };
    try {
      /* The services a search found come first, so a big organisation's
         other hundreds cannot crowd them out of MAX_SERVICES. */
      const services = [...new Set([...(r.services || []), ...(r.alone ? [] : await listServices(r.root).catch((e) => {
        if (r.services?.length) return [];
        throw e;
      }))])].slice(0, MAX_SERVICES);
      row.services = services.length;
      const listed = await pool(services, POOL, async (s) => waterLayersOf(s, await getJson(`${s}/layers`)));
      /* A state seed with a service that did not answer is not marked done,
         so the next night tries it again (NCDOT's pipes, 2026-10-24). */
      row.unanswered = listed.filter((x) => !Array.isArray(x)).length;
      const found = listed.flatMap((x, i) => (Array.isArray(x) ? x.map((l) => ({ ...l, service: services[i] })) : []));
      const measured = await pool(found, 2, measure);
      /* One copy of each layer on a server (water-find.js oneCopyEach). */
      const keepIdx = oneCopyEach(found, measured.map((m) => m?.count));
      const dup = found.map((_, i) => !keepIdx.has(i));
      const now = new Date().toISOString();
      found.forEach((l, i) => {
        if (dup[i]) return;
        const m = measured[i] || {};
        const box = sensibleBox(m.box) ? m.box : (r.boxes.length === 1 ? r.boxes[0] : null);
        const rec = {
          url: l.url, kind: l.kind, title: l.title, service: l.service, geometry: l.geometry,
          county_key: r.keys.length === 1 ? r.keys[0] : r.keys.slice(0, 3).join(','),
          source: r.source || (r.searched ? sourceOfRoot(r.root) : null) || `${r.keys.length === 1 ? (ALL_COUNTIES[r.keys[0]]?.name || r.keys[0]) : 'county GIS'}`,
          west: box?.[0] ?? null, south: box?.[1] ?? null, east: box?.[2] ?? null, north: box?.[3] ?? null,
          features: Number.isFinite(m.count) ? m.count : null,
          ok: box && m.count > 0 ? 1 : 0,
          checked_at: now,
          codebook: l.codebook,
        };
        /* One layer the database refuses is that layer's failure, not its server's. */
        try { exec(upsertSql(rec)); } catch (e) { row.refused = (row.refused || 0) + 1; console.log(`  not stored: ${rec.url} -- ${why(e)}`); return; }
        row.found.push({ kind: rec.kind, title: rec.title, features: rec.features, ok: rec.ok });
        report.layers++;
        if (rec.ok) { report.ok++; report.byKind[rec.kind] = (report.byKind[rec.kind] || 0) + 1; }
      });
    } catch (e) {
      row.error = why(e);
    }
    if (!(r.alone && row.unanswered)) exec(`INSERT INTO water_sweep (root, services, found, error, checked_at) VALUES (${q(r.key || r.root)}, ${row.services}, ${row.found.length}, ${q(row.error)}, ${q(new Date().toISOString())})
          ON CONFLICT(root) DO UPDATE SET services = excluded.services, found = excluded.found, error = excluded.error, checked_at = excluded.checked_at;`);
    report.roots.push(row);
    const okHere = row.found.filter((f) => f.ok).length;
    /* The drainage kinds by name, so "which places got storm drains" is
       answered by the log itself (owner, 2026-10-24). */
    const drainage = Object.entries(row.found.filter((f) => f.ok && DRAINAGE.has(f.kind))
      .reduce((m, f) => ({ ...m, [f.kind]: (m[f.kind] || 0) + 1 }), {}))
      .map(([k, n]) => `${KINDS[k]?.label || k} ${n}`).join(', ');
    console.log(`${row.error ? 'FAILED' : 'looked '} ${r.source ? `${r.source}: ${r.key}` : r.root} (${r.keys.slice(0, 2).join(', ')}${r.keys.length > 2 ? ', ...' : ''}): `
      + `${row.services} service(s), ${okHere} water layer(s)${drainage ? `; drainage: ${drainage}` : ''}${row.error ? ` -- ${row.error}` : ''}`);
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
