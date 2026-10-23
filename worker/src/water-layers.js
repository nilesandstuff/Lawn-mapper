/**
 * WATER LAYERS FOR THE WATER MAP (owner, 2026-10-23: "look into adding new
 * layers that we collect from county gis servers, to make them available to
 * the water map: storm drains and any other water collection, water bodies,
 * anything else you think might be relevant").
 *
 * Two kinds of source, answered together by GET /api/water/layers:
 *
 *   NATIONAL -- free, keyless, everywhere in the US: the USGS National
 *   Hydrography Dataset (water bodies, streams), the USFWS National Wetlands
 *   Inventory, and FEMA's National Flood Hazard Layer (flood zones). Fixed
 *   here, never catalogued.
 *
 *   COUNTY (and city) -- whatever a county's own GIS publishes: storm inlets
 *   and catch basins, manholes, storm mains and laterals, culverts, outfalls,
 *   detention and retention basins, drain districts and easements, open
 *   drains, and the county's own lakes, streams, wetlands and flood zones.
 *   Found ahead of time by tools/water-layers.js (workflow 44), which walks
 *   each registry county's ArcGIS server and keeps every layer whose NAME and
 *   GEOMETRY say what it is, with the box it covers, in the water_layers
 *   table. Coverage is patchy by nature: storm sewers are often a city's or
 *   a township's, and some are not public at all. Kent County, MI publishes
 *   its drain commission's whole network (DrainViewerUS).
 *
 * Every answer is GeoJSON in degrees, cut to the box asked for, each layer
 * labelled with its kind, its source and the service it came from. A layer
 * that does not answer in time is listed under `failed`, never silently left
 * out. Nothing is stored per address: the box is all that is asked, and the
 * answer is cached by the box alone.
 */

/* ---------------------------------------------------------------- kinds */

/**
 * What a layer can be, in the order a map would draw them (areas first).
 * `geometry` is what a layer of this kind must be: a "Water" layer of points
 * is a hydrant list, not a lake.
 */
export const KINDS = {
  flood_zone:      { label: 'Flood zone', geometry: 'polygon' },
  wetland:         { label: 'Wetland', geometry: 'polygon' },
  water_body:      { label: 'Water body (lake, pond)', geometry: 'polygon' },
  watershed:       { label: 'Watershed', geometry: 'polygon' },
  drain_district:  { label: 'Drain district', geometry: 'polygon' },
  drain_easement:  { label: 'Drain easement', geometry: 'polygon' },
  detention_basin: { label: 'Detention or retention basin', geometry: 'polygon' },
  stream:          { label: 'Stream or river', geometry: 'polyline' },
  open_drain:      { label: 'Open drain or ditch', geometry: 'polyline' },
  storm_main:      { label: 'Storm sewer pipe', geometry: 'polyline' },
  culvert:         { label: 'Culvert', geometry: 'any' },
  storm_inlet:     { label: 'Storm inlet or catch basin', geometry: 'point' },
  storm_manhole:   { label: 'Storm manhole', geometry: 'point' },
  outfall:         { label: 'Outfall', geometry: 'point' },
};

/*
 * Names that are never water collection, whatever else they say: the
 * drinking-water and sanitary networks, and the bookkeeping layers that
 * repeat a network (inspections, complaints, work orders, projects).
 */
const NEVER = /sanitary|\bsan\b|water ?main|hydrant|valve|meter|service ?line|potable|distribution|inspect|by year|complaint|work ?order|project|label|annotation|anno\b|grid|index|tile|footprint|outside of|draft|proposed|historic|\b(19|20)\d\d\b/i;

/* Name patterns, tried in order: the first that matches decides the kind. */
const RULES = [
  ['storm_inlet', /inlet|catch ?basin|curb ?box|drop ?structure|yard ?drain/i],
  ['storm_manhole', /(storm|drain).*man ?hole|man ?hole.*(storm|drain)|storm.*structure|^manholes?$/i],
  ['outfall', /outfall|out ?let|discharge ?point|headwall|end ?section/i],
  ['culvert', /culvert/i],
  ['detention_basin', /detention|retention|storm ?water ?(basin|pond)|bmp|bio ?retention|rain ?garden|infiltration/i],
  ['drain_district', /drain(age)? ?district|drainage ?(area|district)|drain ?assessment/i],
  ['drain_easement', /(drain|storm).*easement/i],
  ['storm_main', /storm.*(main|pipe|line|sewer|gravity|conduit|lateral)|storm ?sewer|storm ?drain|drain ?pipe|lateral/i],
  ['open_drain', /open ?drain|county ?drain|ditch|swale|channel/i],
  ['flood_zone', /flood ?(plain|zone|hazard|way)|fema|dfirm|firm ?zone|sfha/i],
  ['wetland', /wetland|marsh/i],
  ['watershed', /watershed|sub ?basin|catchment|huc/i],
  ['stream', /stream|creek|river|brook|flow ?line|drain ?line|waterway/i],
  ['water_body', /lake|pond|water ?bod|reservoir|hydro(graphy)?|surface ?water|^(all_?)?water$/i],
];

/** ArcGIS geometry type, as one of the three words KINDS uses. */
export function geometryWord(esriType) {
  const t = String(esriType || '').toLowerCase();
  if (t.includes('polygon') || t.includes('envelope')) return 'polygon';
  if (t.includes('polyline') || t.includes('line')) return 'polyline';
  if (t.includes('point')) return 'point';
  return '';
}

/**
 * The kind a layer is, from its name and geometry, or null. A layer whose
 * name fits a kind but whose geometry does not (a "Lakes" point layer) is not
 * that kind.
 */
export function classifyLayer(name, esriType) {
  const n = String(name || '').replace(/[_-]+/g, ' ').trim();
  if (!n || NEVER.test(n)) return null;
  const g = geometryWord(esriType);
  for (const [kind, re] of RULES) {
    if (!re.test(n)) continue;
    const want = KINDS[kind].geometry;
    if (want === 'any' || want === g) return kind;
  }
  return null;
}

/* -------------------------------------------------------------- national */

/** The national layers: everywhere, free, keyless. */
export const NATIONAL = [
  { kind: 'water_body', source: 'USGS National Hydrography Dataset', title: 'Waterbody - Large Scale',
    url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12', fields: ['GNIS_NAME', 'FTYPE', 'FCODE', 'AREASQKM'] },
  { kind: 'stream', source: 'USGS National Hydrography Dataset', title: 'Flowline - Large Scale',
    url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6', fields: ['GNIS_NAME', 'FTYPE', 'FCODE', 'FLOWDIR'] },
  { kind: 'wetland', source: 'USFWS National Wetlands Inventory', title: 'Wetlands',
    url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0', fields: ['ATTRIBUTE', 'WETLAND_TYPE', 'ACRES'] },
  { kind: 'flood_zone', source: 'FEMA National Flood Hazard Layer', title: 'Flood Hazard Zones',
    url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28', fields: ['FLD_ZONE', 'ZONE_SUBTY', 'SFHA_TF', 'STATIC_BFE'] },
];

/* ------------------------------------------------------------------ box */

/** The most ground one answer covers, each way, in metres. */
export const MAX_SPAN_M = 1200;
/** The most features one layer returns. */
export const MAX_FEATURES = 1000;

/**
 * The box asked for, in degrees, or an error string. Either `box`
 * (west,south,east,north) or a centre and a half-width `m` (default 150).
 */
export function boxFrom(params) {
  const get = (k) => (typeof params.get === 'function' ? params.get(k) : params[k]);
  let w, s, e, n;
  if (get('box')) {
    [w, s, e, n] = String(get('box')).split(',').map(Number);
  } else {
    const given = (k) => get(k) !== undefined && get(k) !== null && String(get(k)).trim() !== '';
    if (!given('lng') || !given('lat')) return 'lng and lat (and m, metres) or box=west,south,east,north';
    const lng = Number(get('lng')), lat = Number(get('lat'));
    const m = get('m') === undefined || get('m') === null || get('m') === '' ? 150 : Number(get('m'));
    if (![lng, lat, m].every(Number.isFinite) || m <= 0) return 'lng and lat (and m, metres) or box=west,south,east,north';
    const dLat = m / 111320;
    const dLng = m / (111320 * Math.cos((lat * Math.PI) / 180));
    [w, s, e, n] = [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  }
  if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n || Math.abs(s) > 85 || Math.abs(n) > 85 || Math.abs(w) > 180 || Math.abs(e) > 180) {
    return 'box must be west,south,east,north in degrees';
  }
  const midLat = (s + n) / 2;
  const spanM = Math.max((e - w) * 111320 * Math.cos((midLat * Math.PI) / 180), (n - s) * 111320);
  if (spanM > MAX_SPAN_M) return `the box is ${Math.round(spanM)} m across; ${MAX_SPAN_M} m is the most one answer covers`;
  const r = (x) => Math.round(x * 1e6) / 1e6;
  return [r(w), r(s), r(e), r(n)];
}

/* ------------------------------------------------------------- geometry */

const ringsToPolygons = (rings) => {
  /* ArcGIS rings: outer rings clockwise, holes anticlockwise. Each outer ring
     starts a polygon; each hole joins the polygon before it. */
  const area = (r) => {
    let a = 0;
    /* Positive for a clockwise ring (y up), which ArcGIS makes an outer one. */
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[i][0] - r[j][0]) * (r[i][1] + r[j][1]);
    return a / 2;
  };
  const polys = [];
  for (const ring of rings || []) {
    if (!Array.isArray(ring) || ring.length < 4) continue;
    if (area(ring) >= 0 || !polys.length) polys.push([ring]);
    else polys[polys.length - 1].push(ring);
  }
  return polys;
};

/** One ArcGIS JSON geometry as GeoJSON, or null. */
export function esriToGeoJSON(g) {
  if (!g) return null;
  const r = (p) => [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7];
  if (Number.isFinite(g.x) && Number.isFinite(g.y)) return { type: 'Point', coordinates: r([g.x, g.y]) };
  if (Array.isArray(g.points)) return { type: 'MultiPoint', coordinates: g.points.map(r) };
  if (Array.isArray(g.paths)) {
    const paths = g.paths.filter((p) => p.length >= 2).map((p) => p.map(r));
    if (!paths.length) return null;
    return paths.length === 1 ? { type: 'LineString', coordinates: paths[0] } : { type: 'MultiLineString', coordinates: paths };
  }
  if (Array.isArray(g.rings)) {
    const polys = ringsToPolygons(g.rings.map((ring) => ring.map(r)));
    if (!polys.length) return null;
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  return null;
}

/* Attributes worth sending: no ids, shapes or empties. */
const SKIP_FIELD = /^(objectid|fid|globalid|shape|shape_(length|area|leng)|st_(area|length)|.*\.(shape|objectid).*|created_|last_edited_|gdb_)/i;
export function tidyAttributes(attrs, keep = null) {
  const out = {};
  for (const [k, v] of Object.entries(attrs || {})) {
    if (keep && !keep.includes(k)) continue;
    if (SKIP_FIELD.test(k)) continue;
    if (v === null || v === undefined || v === '' || v === ' ' || v === -9999) continue;
    out[k] = typeof v === 'string' ? v.trim().slice(0, 200) : v;
  }
  return out;
}

/* ---------------------------------------------------------------- query */

/** The query URL for one layer over one box. */
export function queryUrl(layerUrl, box, { fields = null, max = MAX_FEATURES } = {}) {
  return `${layerUrl.replace(/\/+$/, '')}/query?` + new URLSearchParams({
    geometry: box.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: fields && fields.length ? fields.join(',') : '*',
    returnGeometry: 'true',
    /* About 10 cm at these latitudes: enough for a lawn, small enough to send. */
    geometryPrecision: '6',
    resultRecordCount: String(max),
    f: 'json',
  });
}

async function fetchJson(url, fetcher, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.error) throw new Error(data.error.message || `error ${data.error.code}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

/** One layer over one box, as a labelled FeatureCollection. */
export async function queryLayer(layer, box, { fetcher = fetch, timeoutMs = 12000 } = {}) {
  const data = await fetchJson(queryUrl(layer.url, box, { fields: layer.fields }), fetcher, timeoutMs);
  const features = [];
  for (const f of data.features || []) {
    const geometry = esriToGeoJSON(f.geometry);
    if (geometry) features.push({ type: 'Feature', geometry, properties: tidyAttributes(f.attributes, layer.fields || null) });
  }
  return {
    kind: layer.kind,
    label: KINDS[layer.kind]?.label || layer.kind,
    source: layer.source,
    title: layer.title,
    url: layer.url,
    truncated: Boolean(data.exceededTransferLimit) || features.length >= MAX_FEATURES,
    type: 'FeatureCollection',
    features,
  };
}

/* ------------------------------------------------------------- catalogue */

/** The catalogued county layers whose box meets this one (D1 water_layers). */
export async function countyLayersOver(env, box) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT url, kind, title, source, county_key FROM water_layers
        WHERE ok = 1 AND west <= ?3 AND east >= ?1 AND south <= ?4 AND north >= ?2
        ORDER BY kind, title LIMIT 60`,
    ).bind(box[0], box[1], box[2], box[3]).all();
    return (results || []).filter((r) => KINDS[r.kind]).map((r) => ({
      kind: r.kind, url: r.url, title: r.title, source: r.source || r.county_key || 'county GIS', fields: null,
    }));
  } catch {
    /* A database the schema has not reached yet still answers the national layers. */
    return [];
  }
}

/**
 * Every water layer over a box: the national ones and the county's own, all
 * asked at once. `failed` lists what did not answer, with why.
 */
export async function waterLayersAt(env, box, { fetcher = fetch, timeoutMs = 25000 } = {}) {
  const county = await countyLayersOver(env, box);
  const all = [...NATIONAL.map((l) => ({ ...l, from: 'national' })), ...county.map((l) => ({ ...l, from: 'county' }))];
  const settled = await Promise.allSettled(all.map((l) => queryLayer(l, box, { fetcher, timeoutMs })));
  const layers = [];
  const failed = [];
  settled.forEach((s, i) => {
    const l = all[i];
    if (s.status === 'fulfilled') {
      if (s.value.features.length) layers.push({ ...s.value, from: l.from });
    } else {
      failed.push({ kind: l.kind, title: l.title, source: l.source, url: l.url, reason: String(s.reason?.message || s.reason).slice(0, 160) });
    }
  });
  const order = Object.keys(KINDS);
  layers.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || String(a.title).localeCompare(String(b.title)));
  return {
    box,
    kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label])),
    asked: { national: NATIONAL.length, county: county.length },
    layers,
    failed,
  };
}

/* ---------------------------------------------------------------- route */

/** How long an answer is kept, in seconds: the networks change slowly. */
export const CACHE_SECONDS = 7 * 24 * 3600;

/**
 * GET /api/water/layers?lng=&lat=&m=  or  ?box=west,south,east,north
 * Public, like the shade map's lidar route: the box is all it is told.
 */
export async function handleWaterLayers(request, url, env, origin, ctx, json, { fetcher = fetch, cache = globalThis.caches?.default } = {}) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405, origin);
  const box = boxFrom(url.searchParams);
  if (typeof box === 'string') return json({ error: box }, 400, origin);
  const key = new Request(`https://water-layers.cache/v1?box=${box.join(',')}`);
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) {
      const body = await hit.json();
      return json({ ...body, cached: true }, 200, origin);
    }
  }
  const body = await waterLayersAt(env, box, { fetcher });
  /* Only a complete answer is kept: a layer that timed out is asked again next time. */
  if (cache && !body.failed.length) {
    const put = cache.put(key, new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    }));
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return json(body, 200, origin);
}
