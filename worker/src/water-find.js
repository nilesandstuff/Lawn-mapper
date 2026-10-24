/**
 * FINDING WATER LAYERS: the pure parts shared by the nightly catalogue
 * (tools/water-layers.js, workflow 44) and the live search a visit starts
 * (discoverWaterAt, below). Moved here from the tool on 2026-10-24 so both
 * read a server the same way; the tool re-exports them.
 *
 * Nothing here stores an address: servers, layers, boxes, and the ~10 km
 * cell a search was made in.
 */

import { classifyLayer, geometryWord, KINDS, codebookOf } from './water-layers.js';

/** The /rest/services root of a service URL, or null. */
export function rootOf(serviceUrl) {
  const m = String(serviceUrl || '').match(/^(https?:\/\/.+?\/rest\/services)(\/|$)/i);
  return m ? m[1] : null;
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

/*
 * A codebook small enough to store (2026-10-24). Maryland SHA's layers carry
 * 1.5 MB of "codes": a field with hundreds of values is a list of names or
 * ids, not a code list, and one command can hold about 128 KB. Such fields
 * are left out, and a book still too big is not kept (the route then sends
 * the layer's values as served).
 */
export const MAX_CODES_PER_FIELD = 300;
export const MAX_CODEBOOK_CHARS = 60000;
export function keptCodebook(book) {
  const trim = (fields) => Object.fromEntries(Object.entries(fields || {}).filter(([, codes]) => Object.keys(codes).length <= MAX_CODES_PER_FIELD));
  const kept = {
    ...book,
    book: trim(book?.book),
    bySubtype: Object.fromEntries(Object.entries(book?.bySubtype || {}).map(([t, fields]) => [t, trim(fields)])),
  };
  return JSON.stringify(kept).length <= MAX_CODEBOOK_CHARS ? kept : null;
}

/**
 * The water layers of one service's /layers listing: leaves only (no group
 * layers), classified by name and geometry.
 */
export function waterLayersOf(serviceUrl, layersJson, seedKinds = {}) {
  const out = [];
  for (const l of layersJson?.layers || []) {
    if (l.type && !/feature layer/i.test(l.type)) continue;
    if (Array.isArray(l.subLayers) && l.subLayers.length) continue;
    /* A seed may name what a plainly named layer is ("Pipes" in a state's
       storm-drain inventory), or drop one; its geometry must still fit. */
    const said = seedKinds?.[`${serviceUrl}/${l.id}`];
    const fits = (k) => k && KINDS[k] && (KINDS[k].geometry === 'any' || KINDS[k].geometry === geometryWord(l.geometryType));
    const kind = said === null ? null : fits(said) ? said : classifyLayer(l.name, l.geometryType);
    if (!kind) continue;
    /* Its names for its codes, from the same description (subtypes, domains,
       and its map style's labels), kept so the route need not ask again. */
    const book = keptCodebook(codebookOf(l));
    const named = book && (Object.keys(book.book).length || Object.keys(book.bySubtype).length);
    out.push({
      url: `${serviceUrl}/${l.id}`, kind, title: l.name, geometry: geometryWord(l.geometryType), extent: l.extent || null,
      codebook: named ? JSON.stringify(book) : null,
    });
  }
  return out;
}

/* ------------------------------------------------- the ArcGIS Online search */

/*
 * SEARCHING BY PLACE (owner, 2026-10-24: "go ahead with #1 ... and it sounds
 * like #2 should be a part of that"). The registry knows each county's own
 * server, and storm sewers are often a city's or a township's, on a server of
 * their own or hosted on ArcGIS Online. So, at each place people have saved a
 * map: ArcGIS Online's public catalogue is asked for drainage services whose
 * own extent covers that spot. Each one found is read for its water layers at
 * once, and the server it lives on joins the sweep (water_roots), so the
 * rest of that city's layers are found too.
 */
const SEARCH_TERMS = '(storm OR stormwater OR "storm sewer" OR "storm drain" OR "catch basin" OR inlet OR inlets OR outfall OR '
  + 'outfalls OR culvert OR culverts OR drain OR drains OR drainage OR MS4 OR "drain commission" OR sewer OR hydrology OR "surface water")';
const SEARCH_TYPES = '(type:"Feature Service" OR type:"Map Service")';

/** ArcGIS Online's catalogue, near one point, for drainage services. */
export function agolWaterSearchUrl(lng, lat, start = 1) {
  const d = 0.001;
  return 'https://www.arcgis.com/sharing/rest/search?' + new URLSearchParams({
    q: `${SEARCH_TERMS} AND ${SEARCH_TYPES}`,
    bbox: [lng - d, lat - d, lng + d, lat + d].join(','),
    f: 'json', num: '100', start: String(start),
  });
}

/*
 * Never a local server: Esri's own national layers and live feeds, the
 * national sources the route already asks, and ArcGIS Online's key-holding
 * proxy (its services need the owner's credentials).
 */
export const NATIONAL_HOST = /\/\/(services|server)\.arcgisonline\.com\/|\/\/(utility|tiledbasemaps|basemaps)\.arcgis\.com\/|\/\/hazards\.fema\.gov\/|\/\/hydro\.nationalmap\.gov\/|\/\/fwspublicservices\.wim\.usgs\.gov\/|\/P3ePLMYs2RVChkJx\/|\/RHVPKKiFTONKtxq3\/|mapservices\.weather\.noaa\.gov/i;

/**
 * The search results worth reading at this point: a map or feature service
 * (not one of its layers), local (its extent under `maxArea` square degrees,
 * so a county's or a state's, not the nation's), covering the point.
 */
export function agolWaterKeep(results, lng, lat, maxArea = 4) {
  const out = [];
  for (const r of results || []) {
    if (!r?.url || !Array.isArray(r.extent) || r.extent.length !== 2) continue;
    const [[x0, y0], [x1, y1]] = r.extent;
    if (!((x1 - x0) * (y1 - y0) <= maxArea)) continue;
    if (!(lng >= x0 && lng <= x1 && lat >= y0 && lat <= y1)) continue;
    const m = String(r.url).match(/^(https?:\/\/.+?\/(?:FeatureServer|MapServer))(?:\/\d+)?\/?$/i);
    if (!m || NATIONAL_HOST.test(m[1]) || !rootOf(m[1])) continue;
    out.push({ service: m[1], root: rootOf(m[1]), title: String(r.title || '').slice(0, 120) });
  }
  return out;
}

/*
 * BY NAME, TOO. Searching by the point alone ranks ArcGIS Online's
 * nationwide items first: around Grand Rapids it returned 10,000 items and
 * the city's own stormwater service was not in the first 300. Searching by
 * the place's names finds it at once. The names come from the Census
 * Bureau's free geocoder (county, incorporated place, township), and a
 * result is kept only if its own extent covers one of the saved maps that
 * gave the name -- so "Wyoming" finds Wyoming, Michigan's and not the state's.
 */
export function censusUrl(lng, lat) {
  return 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates?' + new URLSearchParams({
    x: String(lng), y: String(lat), benchmark: 'Public_AR_Current', vintage: 'Current_Current',
    layers: 'Counties,Incorporated Places,County Subdivisions', format: 'json',
  });
}

/** The names worth searching for, from the Census answer: "Kent County", "Grand Rapids", "Byron Township". */
export function placeNames(geographies) {
  const out = new Set();
  for (const g of Object.values(geographies || {})) {
    for (const x of g || []) {
      const name = String(x?.NAME || '').trim();
      if (!name || /^county subdivisions not defined/i.test(name)) continue;
      const m = name.match(/^(.*?)\s+(city|village|town|borough|CDP)$/i);
      if (m) out.add(m[1]);
      else if (/\s+township$/i.test(name)) out.add(name.replace(/\s+township$/i, ' Township'));
      else out.add(name);
    }
  }
  return [...out];
}

/** ArcGIS Online's catalogue, by one place's name, for drainage services. */
export function agolWaterNameUrl(name, start = 1) {
  return 'https://www.arcgis.com/sharing/rest/search?' + new URLSearchParams({
    q: `${SEARCH_TERMS} AND ${SEARCH_TYPES} AND "${String(name).replace(/"/g, '')}"`,
    f: 'json', num: '100', start: String(start),
  });
}

/** A source to show for a layer found on a server the registry does not know. */
export const sourceOfRoot = (root) => {
  const host = (String(root).match(/^https?:\/\/([^/]+)/) || [])[1] || 'county GIS';
  return /^services\d*\.arcgis\.com$/i.test(host) ? 'ArcGIS Online' : host;
};

/*
 * ONE COPY OF EACH LAYER (2026-10-24): Grand Rapids publishes its catch
 * basins in 13 services and its gravity mains in a dozen, the same layer each
 * time, some a snapshot a few features apart, some a filtered view of ten.
 * On one server, layers of the same kind and name are kept once: the copy
 * with the most features. And the same data under another name (Grand
 * Rapids' lakes at eight map scales, 7,262 features each): a layer of the
 * same kind with the identical count, 50 or more, on the same server, is the
 * same layer. Returns the indexes to keep.
 */
export function oneCopyEach(found, counts) {
  const serverOf = (l) => rootOf(l.service || l.url) || '';
  const best = new Map();
  found.forEach((l, i) => {
    const k = `${serverOf(l)}|${l.kind}|${String(l.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    const n = Number(counts[i]) || 0;
    if (!best.has(k) || n > best.get(k).n) best.set(k, { i, n });
  });
  const byCount = new Map();
  for (const b of best.values()) {
    const k = `${serverOf(found[b.i])}|${found[b.i].kind}|${b.n}`;
    if (b.n < 50 || !byCount.has(k)) byCount.set(b.n < 50 ? `${k}|${b.i}` : k, b);
  }
  return new Set([...byCount.values()].map((b) => b.i));
}

/* ------------------------------------------------------ the live search */

/*
 * SEARCHING WHERE PEOPLE LOOK (owner, 2026-10-24: "put something together
 * that looks for the layers available in an area, if we don't have it
 * already, whenever an address is entered on the site in lawn map, shade
 * map, or water map ... hopefully the layers get found by the time the water
 * map needs it").
 *
 * All three ask /api/parcel once an address is picked, and the water map
 * asks /api/water/layers, so both start this in waitUntil: after the answer,
 * never in front of it. It is the nightly search, cut to what fits the
 * ~30 s a Worker has after answering: ArcGIS Online by the point and by the
 * place's names (the Census geocoder), the services found that the
 * catalogue does not have yet, at most LIVE_SERVICES of them read and
 * LIVE_LAYERS layers counted, and written to water_layers at once. Every
 * server found joins water_roots, so the nightly sweep reads the rest of it,
 * and the place joins the nightly's list of places to search properly.
 *
 * Once per ~10 km cell (ASK_CELL_DEG) every ASK_AGAIN_DAYS, and at most
 * ASKS_PER_HOUR new cells an hour across the site, so a crawler cannot turn
 * it into a flood of requests to counties' servers. Only the cell is kept,
 * never the address or the point.
 */
export const ASK_CELL_DEG = 0.1;
export const ASK_AGAIN_DAYS = 30;
export const ASKS_PER_HOUR = 40;
export const LIVE_SERVICES = 8;
export const LIVE_LAYERS = 30;
export const LIVE_BUDGET_MS = 24000;
const STALE_CLAIM_MS = 10 * 60000;

/** The ~10 km cell a point is in, by its centre, as the key kept. */
export function askCell(lng, lat, step = ASK_CELL_DEG) {
  const x = Math.round(lng / step) * step, y = Math.round(lat / step) * step;
  return { key: `${x.toFixed(1)},${y.toFixed(1)}`, lng: Number(x.toFixed(1)), lat: Number(y.toFixed(1)) };
}

const DRAINAGE_KINDS = new Set(['storm_inlet', 'storm_manhole', 'storm_main', 'culvert', 'outfall', 'open_drain', 'drain_district', 'drain_easement', 'detention_basin']);
const STORMY = /storm|drain|sewer|inlet|catch|culvert|outfall|ms4|hydro|water/i;

/** Services worth reading first: a storm-sounding name before a general one. */
export function liveOrder(hits) {
  return [...hits].sort((a, b) => (STORMY.test(b.title) - STORMY.test(a.title)) || a.service.localeCompare(b.service));
}

/**
 * Search one place now. Resolves to what it did ({cell, skipped} or
 * {cell, services, layers, stored}); never throws, so a caller in
 * waitUntil needs no guard.
 */
export async function discoverWaterAt(env, lng, lat, { fetcher = fetch, now = Date.now(), budgetMs = LIVE_BUDGET_MS } = {}) {
  if (!env?.DB || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return { skipped: 'no-place' };
  const cell = askCell(lng, lat);
  const iso = (t) => new Date(t).toISOString();
  const db = env.DB;
  try {
    const prior = await db.prepare('SELECT asked_at, status FROM water_asks WHERE cell = ?').bind(cell.key).first();
    if (prior && now - Date.parse(prior.asked_at) < ASK_AGAIN_DAYS * 86400000
        && !(prior.status === 'searching' && now - Date.parse(prior.asked_at) > STALE_CLAIM_MS)) return { cell: cell.key, skipped: 'recent' };
    const hour = await db.prepare('SELECT COUNT(*) AS n FROM water_asks WHERE asked_at > ?').bind(iso(now - 3600000)).first();
    if (Number(hour?.n) >= ASKS_PER_HOUR) return { cell: cell.key, skipped: 'busy' };
    /* The claim: only one visit searches a cell, however many arrive at once. */
    const claim = await db.prepare(
      `INSERT INTO water_asks (cell, lng, lat, asked_at, status) VALUES (?1, ?2, ?3, ?4, 'searching')
       ON CONFLICT(cell) DO UPDATE SET asked_at = excluded.asked_at, status = 'searching'
       WHERE water_asks.asked_at < ?5 OR (water_asks.status = 'searching' AND water_asks.asked_at < ?6)`,
    ).bind(cell.key, cell.lng, cell.lat, iso(now), iso(now - ASK_AGAIN_DAYS * 86400000), iso(now - STALE_CLAIM_MS)).run();
    if (!claim?.meta?.changes) return { cell: cell.key, skipped: 'taken' };
  } catch {
    return { cell: cell.key, skipped: 'no-table' };
  }

  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  const get = async (u, ms = 8000) => {
    const wait = Math.min(ms, left());
    if (wait < 500) throw new Error('out of time');
    const res = await fetcher(u + (u.includes('?') ? '&' : '?') + 'f=json', { signal: AbortSignal.timeout(wait) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (d?.error) throw new Error(d.error.message || 'error');
    return d;
  };
  const pool = async (items, n, fn) => {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch(() => null); }
    }));
    return out;
  };
  const finish = async (status, extra = {}) => {
    try {
      await db.prepare('UPDATE water_asks SET status = ?2, services = ?3, layers = ?4, done_at = ?5 WHERE cell = ?1')
        .bind(cell.key, status, extra.services || 0, extra.stored || 0, new Date().toISOString()).run();
    } catch { /* the layers, if any, are stored already */ }
    return { cell: cell.key, status, ...extra };
  };

  /* 1. The search, by the point and by the place's names, at once. */
  const hits = new Map();
  const add = (results) => { for (const k of agolWaterKeep(results, lng, lat)) if (!hits.has(k.service)) hits.set(k.service, k); };
  const [byPoint, census] = await Promise.all([
    get(agolWaterSearchUrl(lng, lat, 1)).catch(() => null),
    get(censusUrl(lng, lat)).catch(() => null),
  ]);
  add(byPoint?.results);
  const names = placeNames(census?.result?.geographies).slice(0, 4);
  for (const j of await Promise.all(names.map((n) => get(agolWaterNameUrl(n, 1)).catch(() => null)))) add(j?.results);
  if (!hits.size) return finish('none');

  /* 2. Every server found joins the nightly sweep, whatever is read now. */
  const roots = new Map();
  for (const h of hits.values()) {
    if (!roots.has(h.root)) roots.set(h.root, []);
    roots.get(h.root).push(h.service);
  }
  try {
    await db.batch([...roots].map(([root, services]) => db.prepare(
      `INSERT INTO water_roots (root, services, maps, found_at) VALUES (?1, ?2, 1, ?3) ON CONFLICT(root) DO NOTHING`,
    ).bind(root, JSON.stringify(services.slice(0, 40)), new Date().toISOString())));
  } catch { /* the nightly search finds them again */ }

  /* 3. The services the catalogue does not have yet, storm-sounding first. */
  const candidates = liveOrder(hits.values()).slice(0, 90);
  let known = new Set();
  try {
    const { results } = await db.prepare(`SELECT DISTINCT service FROM water_layers WHERE service IN (${candidates.map((_, i) => `?${i + 1}`).join(',')})`)
      .bind(...candidates.map((c) => c.service)).all();
    known = new Set((results || []).map((r) => r.service));
  } catch { /* read them all */ }
  const fresh = candidates.filter((c) => !known.has(c.service)).slice(0, LIVE_SERVICES);
  if (!fresh.length) return finish('known', { services: 0 });

  /* 4. Their water layers, drainage first, counted and boxed. */
  const listed = await pool(fresh, 4, (c) => get(`${c.service}/layers`));
  let found = listed.flatMap((j, i) => (j ? waterLayersOf(fresh[i].service, j).map((l) => ({ ...l, service: fresh[i].service, root: fresh[i].root })) : []));
  found.sort((a, b) => (DRAINAGE_KINDS.has(b.kind) - DRAINAGE_KINDS.has(a.kind)));
  found = found.slice(0, LIVE_LAYERS);
  const measured = await pool(found, 6, async (l) => {
    const d = await get(`${l.url}/query?where=1%3D1&returnCountOnly=true&returnExtentOnly=true&outSR=4326`);
    const box = d.extent ? extentDegrees({ ...d.extent, spatialReference: d.extent.spatialReference || { wkid: 4326 } }) : extentDegrees(l.extent);
    return { count: Number.isFinite(Number(d.count)) ? Number(d.count) : null, box };
  });
  const keepIdx = oneCopyEach(found, measured.map((m) => m?.count));
  const at = new Date().toISOString();
  const rows = [];
  found.forEach((l, i) => {
    const m = measured[i];
    if (!keepIdx.has(i) || !m) return;
    const box = sensibleBox(m.box) ? m.box : null;
    rows.push(db.prepare(
      `INSERT INTO water_layers (url, kind, title, service, geometry, county_key, source, west, south, east, north, features, ok, checked_at, codebook)
       VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
       ON CONFLICT(url) DO UPDATE SET kind = excluded.kind, title = excluded.title, service = excluded.service, geometry = excluded.geometry,
         source = excluded.source, west = excluded.west, south = excluded.south, east = excluded.east, north = excluded.north,
         features = excluded.features, ok = excluded.ok, checked_at = excluded.checked_at, codebook = excluded.codebook`,
    ).bind(l.url, l.kind, l.title, l.service, l.geometry, sourceOfRoot(l.root),
      box?.[0] ?? null, box?.[1] ?? null, box?.[2] ?? null, box?.[3] ?? null,
      m.count, box && m.count > 0 ? 1 : 0, at, l.codebook || null));
  });
  let stored = 0;
  try { if (rows.length) { await db.batch(rows); stored = rows.length; } } catch { stored = 0; }
  return finish('done', { services: fresh.length, layers: found.length, stored });
}
