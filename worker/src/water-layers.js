/**
 * WATER LAYERS FOR THE WATER MAP (owner, 2026-10-23: "look into adding new
 * layers that we collect from county gis servers, to make them available to
 * the water map: storm drains and any other water collection, water bodies,
 * anything else you think might be relevant").
 *
 * Two kinds of source, answered together by GET /api/water/layers:
 *
 *   NATIONAL -- free, keyless, everywhere in the US: the USGS National
 *   Hydrography Dataset (streams), the USFWS National Wetlands
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
const NEVER = /sanitary|\bsan\b|water ?main|hydrant|valve|meter|service ?line|potable|distribution|inspect|by year|complaint|work ?order|project|label|annotation|anno\b|grid|index|tile|footprint|outside of|draft|proposed|historic|\b(19|20)\d\d\b|abandon|retired|lined\b|lining|clean|televis|cctv|curb ?(box|stop)|service ?request|repair/i;

/* Name patterns, tried in order: the first that matches decides the kind. */
const RULES = [
  ['storm_inlet', /inlet|catch ?basin|drop ?structure|yard ?drain/i],
  ['storm_manhole', /(storm|drain).*man ?hole|man ?hole.*(storm|drain)|storm.*structure|^manholes?$/i],
  ['outfall', /outfall|out ?let|discharge ?point|headwall|end ?section/i],
  ['culvert', /culvert/i],
  ['detention_basin', /detention|retention|storm ?water ?(basin|pond)|bmp|bio ?retention|rain ?garden|infiltration/i],
  ['drain_district', /drain(age)? ?district|drainage ?(area|district)|drain ?assessment/i],
  ['drain_easement', /(drain|storm).*easement/i],
  ['storm_main', /storm.*(main|pipe|line|sewer|gravity|conduit|lateral)|storm ?sewer|storm ?drain|drain ?pipe/i],
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
  /* USGS's own server is slow over big shapes (23 s to over a minute in a
     test, 2026-10-23), and slower still with a record limit: it gets a longer
     wait and no limit. Its water bodies were dropped on 2026-10-24: they were
     in `failed` or `pending` on every box the water map asked, and the
     wetlands inventory below holds the same lakes and ponds and answers in a
     second. Its streams stay: nothing else draws a small stream nationally.
     Its high-resolution twin (NHDPlus_HR) timed out on all four boxes tried. */
  { kind: 'stream', source: 'USGS National Hydrography Dataset', title: 'Flowline - Large Scale', slow: true, paginate: false,
    url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6', fields: ['GNIS_NAME', 'FTYPE', 'FCODE', 'FLOWDIR'] },
  /* The inventory's open water (lakes, ponds, river channels) is a water
     body, not a wetland, so its answer is split by WETLAND_TYPE. */
  { kind: 'wetland', source: 'USFWS National Wetlands Inventory', title: 'Wetlands',
    url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0', fields: ['ATTRIBUTE', 'WETLAND_TYPE', 'ACRES'],
    split: (p) => (/lake|pond|riverine|deepwater/i.test(String(p.WETLAND_TYPE || '')) ? 'water_body' : 'wetland') },
  /* FEMA's own server refused the live Worker (HTTP 403, 2026-10-23) and its
     firewall then refused even a handful of test queries; Esri's public copy
     of the same zones (minus the unshaded X of minimal hazard) answers in
     under a second. FEMA's own is asked only when the copy fails. */
  { kind: 'flood_zone', source: 'FEMA National Flood Hazard Layer (Esri\'s public copy)', title: 'Flood Hazard Zones',
    url: 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer/0',
    fallback: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28',
    fields: ['FLD_ZONE', 'ZONE_SUBTY', 'SFHA_TF', 'STATIC_BFE'] },
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

/**
 * The query URL for one layer over one box. `paginate` false leaves out the
 * record limit, which some older servers refuse ("Pagination is not
 * supported") and USGS's answers slowly. Shapes are simplified to about half
 * a metre, which a lawn never notices and a county-wide flood zone needs.
 */
export function queryUrl(layerUrl, box, { fields = null, max = MAX_FEATURES, paginate = true, simplify = 0.000005 } = {}) {
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
    ...(simplify ? { maxAllowableOffset: String(simplify) } : {}),
    ...(paginate ? { resultRecordCount: String(max) } : {}),
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

/* ---------------------------------------------------------- coded values */

/*
 * NAMES FOR CODES (the water session's ask, 2026-10-24: Kent's SUBTYPE came
 * as bare numbers, "which mean nothing to a reader"). A layer says what its
 * codes mean in up to three places, tried in this order for each field:
 *   1. its subtypes (`types`, keyed by typeIdField), and each subtype's own
 *      coded-value domains;
 *   2. a field's coded-value domain (`fields[].domain.codedValues`);
 *   3. failing both, the labels its own map style gives the values of the
 *      field it is styled by (`drawingInfo.renderer`, unique values). Kent
 *      publishes no subtype names; its style names pipes "Culvert",
 *      "OpenChannel", "Underdrain" and inlets "Double Catch Basin", "Yard Drain".
 */
export function codebookOf(meta) {
  const book = {};
  const put = (field, code, name) => {
    if (!field || name === undefined || name === null || name === '') return;
    (book[field] = book[field] || {})[String(code)] = String(name);
  };
  const domainOf = (d) => (d && d.type === 'codedValue' && Array.isArray(d.codedValues) ? d.codedValues : null);
  for (const f of meta?.fields || []) {
    for (const cv of domainOf(f.domain) || []) put(f.name, cv.code, cv.name);
  }
  const typeField = meta?.typeIdField || meta?.subtypeField || null;
  const bySubtype = {};
  for (const t of meta?.types || []) {
    put(typeField, t.id, t.name);
    for (const [field, d] of Object.entries(t.domains || {})) {
      const values = domainOf(d);
      if (!values) continue;
      bySubtype[String(t.id)] = bySubtype[String(t.id)] || {};
      for (const cv of values) (bySubtype[String(t.id)][field] = bySubtype[String(t.id)][field] || {})[String(cv.code)] = String(cv.name);
    }
  }
  const r = meta?.drawingInfo?.renderer;
  if (r && r.type === 'uniqueValue' && r.field1 && !r.field2 && !book[r.field1]) {
    for (const u of r.uniqueValueInfos || []) put(r.field1, u.value, u.label);
  }
  return { book, typeField, bySubtype };
}

/** Attributes with each code replaced by its name, where the layer names it. */
export function decodeAttributes(attrs, codebook) {
  if (!codebook || !attrs) return attrs;
  const out = { ...attrs };
  const sub = codebook.typeField ? codebook.bySubtype[String(attrs[codebook.typeField])] : null;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    const name = (sub && sub[k] && sub[k][String(v)]) || (codebook.book[k] && codebook.book[k][String(v)]);
    if (name !== undefined) out[k] = name;
  }
  return out;
}

/* A layer's codebook, kept for the life of the Worker (a few kilobytes each). */
const CODEBOOKS = new Map();
export async function codebookFor(url, fetcher, timeoutMs) {
  if (CODEBOOKS.has(url)) return CODEBOOKS.get(url);
  let book = null;
  try {
    book = codebookOf(await fetchJson(`${url.replace(/\/+$/, '')}?f=json`, fetcher, Math.min(timeoutMs, 10000)));
  } catch {
    book = null; // codes stay codes; asked again on the next Worker
  }
  if (book) CODEBOOKS.set(url, book);
  return book;
}

/* ------------------------------------------------------------- clipping */

/*
 * CUT TO THE BOX. A service answers "every shape that touches the box" with
 * the whole shape: a flood zone running the length of a river came back as
 * 2.5 MB for two features. Everything is cut to the box (a margin of 2% so a
 * line along the edge stays whole) before it is sent.
 */
const inside = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** Sutherland-Hodgman against the box's four edges; a closed ring, or null. */
export function clipRing(ring, b) {
  let pts = ring.slice(0, ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? -1 : undefined);
  const edges = [
    (p) => p[0] >= b[0], (p) => p[0] <= b[2], (p) => p[1] >= b[1], (p) => p[1] <= b[3],
  ];
  const cross = [
    (a, c) => [b[0], a[1] + ((c[1] - a[1]) * (b[0] - a[0])) / (c[0] - a[0])],
    (a, c) => [b[2], a[1] + ((c[1] - a[1]) * (b[2] - a[0])) / (c[0] - a[0])],
    (a, c) => [a[0] + ((c[0] - a[0]) * (b[1] - a[1])) / (c[1] - a[1]), b[1]],
    (a, c) => [a[0] + ((c[0] - a[0]) * (b[3] - a[1])) / (c[1] - a[1]), b[3]],
  ];
  for (let k = 0; k < 4 && pts.length; k++) {
    const keep = edges[k];
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      if (keep(cur)) {
        if (!keep(prev)) out.push(cross[k](prev, cur));
        out.push(cur);
      } else if (keep(prev)) {
        out.push(cross[k](prev, cur));
      }
    }
    pts = out;
  }
  if (pts.length < 3) return null;
  const r = (p) => [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7];
  const closed = pts.map(r);
  closed.push(closed[0]);
  return closed;
}

/** Liang-Barsky on each segment; the line's pieces inside the box. */
export function clipLine(line, b) {
  const pieces = [];
  let cur = [];
  const flush = () => { if (cur.length >= 2) pieces.push(cur); cur = []; };
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x0 - b[0]], [dx, b[2] - x0], [-dy, y0 - b[1]], [dy, b[3] - y0]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; } else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { flush(); continue; }
    const a = [x0 + t0 * dx, y0 + t0 * dy];
    const c = [x0 + t1 * dx, y0 + t1 * dy];
    const last = cur.at(-1);
    if (!last || t0 > 0 || last[0] !== a[0] || last[1] !== a[1]) { flush(); cur.push(a); }
    cur.push(c);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

/** A GeoJSON geometry cut to the box, or null when nothing of it is inside. */
export function clipGeometry(g, b) {
  if (!g) return null;
  switch (g.type) {
    case 'Point': return inside(g.coordinates, b) ? g : null;
    case 'MultiPoint': { const c = g.coordinates.filter((p) => inside(p, b)); return c.length ? { type: 'MultiPoint', coordinates: c } : null; }
    case 'LineString':
    case 'MultiLineString': {
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      const pieces = lines.flatMap((l) => clipLine(l, b));
      if (!pieces.length) return null;
      return pieces.length === 1 ? { type: 'LineString', coordinates: pieces[0] } : { type: 'MultiLineString', coordinates: pieces };
    }
    case 'Polygon':
    case 'MultiPolygon': {
      const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) => {
        const outer = clipRing(rings[0], b);
        if (!outer) return null;
        return [outer, ...rings.slice(1).map((h) => clipRing(h, b)).filter(Boolean)];
      }).filter(Boolean);
      if (!polys.length) return null;
      return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
    }
    default: return g;
  }
}

/** The box with a 2% margin each way. */
const margin = (b) => {
  const mx = (b[2] - b[0]) * 0.02, my = (b[3] - b[1]) * 0.02;
  return [b[0] - mx, b[1] - my, b[2] + mx, b[3] + my];
};

/**
 * One layer over one box, as labelled FeatureCollections: one, or one per
 * kind when the layer is split (the wetlands inventory's open water).
 */
export async function queryLayer(layer, box, { fetcher = fetch, timeoutMs = 12000 } = {}) {
  const ask = (url, paginate) => fetchJson(queryUrl(url, box, { fields: layer.fields, paginate }), fetcher, timeoutMs);
  const from = async (url) => {
    try {
      return await ask(url, layer.paginate !== false);
    } catch (e) {
      if (layer.paginate === false || !/pagination/i.test(String(e?.message || e))) throw e;
      return ask(url, false);
    }
  };
  /* The layer's names for its codes: from the catalogue (water_layers.codebook)
     when it has them. Asking the county's server for them on the spot doubled
     the requests a press made of it, and Kent's then missed the 15 s answer
     (2026-10-24), so a layer the catalogue has not described is sent as served
     unless it asks (`decodeLive`). */
  const book = layer.codebook !== undefined ? Promise.resolve(layer.codebook)
    : layer.decodeLive ? codebookFor(layer.url, fetcher, timeoutMs) : Promise.resolve(null);
  let data;
  let usedFallback = false;
  try {
    data = await from(layer.url);
  } catch (e) {
    if (!layer.fallback) throw e;
    data = await from(layer.fallback);
    usedFallback = true;
  }
  const codebook = usedFallback ? null : await book;
  const cut = margin(box);
  const byKind = new Map();
  for (const f of data.features || []) {
    const geometry = clipGeometry(esriToGeoJSON(f.geometry), cut);
    if (!geometry) continue;
    const properties = tidyAttributes(decodeAttributes(f.attributes, codebook), layer.fields || null);
    const kind = layer.split ? layer.split(properties) : layer.kind;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push({ type: 'Feature', geometry, properties });
  }
  const truncated = Boolean(data.exceededTransferLimit) || (data.features || []).length >= MAX_FEATURES;
  return [...byKind].map(([kind, features]) => ({
    kind,
    label: KINDS[kind]?.label || kind,
    source: layer.source,
    title: layer.title,
    url: layer.url,
    truncated,
    type: 'FeatureCollection',
    features,
  }));
}

/* ------------------------------------------------------------- catalogue */

/** The most county and state layers one answer asks (each is a request to their server). */
export const MAX_COUNTY_LAYERS = 30;

/** The catalogued county layers whose box meets this one (D1 water_layers). */
export async function countyLayersOver(env, box) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      /* AT MOST MAX_COUNTY_LAYERS, the drainage network first and then the
         most local (2026-10-24): a statewide server can cover a box with sixty
         layers of its own -- Massachusetts' alone has 62 -- and every layer is
         a request to its server on every press. Ranked so a city's inlets beat
         a state's lakes, and a county's lakes beat the state's. */
      `SELECT url, kind, title, source, county_key, codebook FROM water_layers
        WHERE ok = 1 AND west <= ?3 AND east >= ?1 AND south <= ?4 AND north >= ?2
        ORDER BY CASE WHEN kind IN ('storm_inlet','storm_manhole','storm_main','culvert','outfall','open_drain',
                                    'drain_district','drain_easement','detention_basin') THEN 0 ELSE 1 END,
                 (east - west) * (north - south), kind, title
        LIMIT ${MAX_COUNTY_LAYERS}`,
    ).bind(box[0], box[1], box[2], box[3]).all();
    const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
    return (results || []).filter((r) => KINDS[r.kind]).map((r) => ({
      kind: r.kind, url: r.url, title: r.title, source: r.source || r.county_key || 'county GIS', fields: null,
      codebook: parse(r.codebook),
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
export async function waterLayersAt(env, box, { fetcher = fetch, timeoutMs = 25000, deadlineMs = 0 } = {}) {
  const county = await countyLayersOver(env, box);
  const all = [...NATIONAL.map((l) => ({ ...l, from: 'national' })), ...county.map((l) => ({ ...l, from: 'county' }))];
  const asks = all.map((l) => queryLayer(l, box, { fetcher, timeoutMs: l.slow ? SLOW_MS : timeoutMs })
    .then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })));
  const assemble = (settled) => {
    const layers = [];
    const failed = [];
    const pending = [];
    settled.forEach((s, i) => {
      const l = all[i];
      const name = { kind: l.kind, title: l.title, source: l.source, url: l.url };
      if (!s) pending.push(name);
      else if (s.status === 'fulfilled') {
        for (const one of s.value) if (one.features.length) layers.push({ ...one, from: l.from });
      } else failed.push({ ...name, reason: String(s.reason?.message || s.reason).slice(0, 160) });
    });
    const order = Object.keys(KINDS);
    layers.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || String(a.title).localeCompare(String(b.title)));
    return {
      box,
      kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.label])),
      asked: { national: NATIONAL.length, county: county.length },
      layers,
      failed,
      ...(pending.length ? { pending } : {}),
    };
  };
  /* Everything, however long the slowest source takes. */
  const whole = Promise.all(asks).then(assemble);
  if (!deadlineMs) return { body: await whole, later: null };
  /* What has answered by the deadline; the rest is `pending`, and `later`
     resolves to the whole answer for the caller to keep. */
  const got = new Array(asks.length).fill(null);
  asks.forEach((a, i) => a.then((s) => { got[i] = s; }));
  const done = await Promise.race([whole.then(() => true), new Promise((r) => setTimeout(() => r(false), deadlineMs))]);
  if (done) return { body: await whole, later: null };
  return { body: assemble(got.slice()), later: whole };
}

/* ---------------------------------------------------------------- route */

/** How long an answer is kept, in seconds: the networks change slowly. */
export const CACHE_SECONDS = 7 * 24 * 3600;
/* An answer missing a source that timed out is kept a day, not a week: long
   enough that one slow server does not make every visit wait for it, short
   enough that it is asked again soon. */
export const PARTIAL_CACHE_SECONDS = 24 * 3600;
/*
 * How long a slow national source is waited for, from the start. Cloudflare
 * lets work handed to waitUntil run about 30 s past the answer, so this is
 * kept inside DEADLINE_MS + 30 s, or the whole answer is never kept (it was
 * not, at 45 s, 2026-10-23).
 */
export const SLOW_MS = 38000;
/** How long an answer with sources still pending is kept: long enough for a quick second ask. */
export const PENDING_CACHE_SECONDS = 120;
/*
 * HOW LONG A VISITOR WAITS. USGS's hydrography server answered the same small
 * box in 0.7 s and in 61 s within one minute (2026-10-23). So the answer goes
 * out at the deadline with whatever has come back, the slow layers named under
 * `pending`; the asking carries on in the background and the whole answer is
 * kept, so asking again a minute later returns everything.
 */
export const DEADLINE_MS = 15000;

/**
 * GET /api/water/layers?lng=&lat=&m=  or  ?box=west,south,east,north
 * Public, like the shade map's lidar route: the box is all it is told.
 */
export async function handleWaterLayers(request, url, env, origin, ctx, json, { fetcher = fetch, cache = globalThis.caches?.default } = {}) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405, origin);
  const box = boxFrom(url.searchParams);
  if (typeof box === 'string') return json({ error: box }, 400, origin);
  const key = new Request(`https://water-layers.cache/v3?box=${box.join(',')}`);
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) {
      const body = await hit.json();
      return json({ ...body, cached: true }, 200, origin);
    }
  }
  const { body, later } = await waterLayersAt(env, box, { fetcher, deadlineMs: ctx?.waitUntil ? DEADLINE_MS : 0 });
  const keep = (b) => {
    if (!cache) return Promise.resolve();
    const age = b.pending ? PENDING_CACHE_SECONDS : b.failed.length ? PARTIAL_CACHE_SECONDS : CACHE_SECONDS;
    return cache.put(key, new Response(JSON.stringify(b), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${age}` },
    })).catch(() => {});
  };
  /* The answer as it stands is kept at once, for a couple of minutes; the
     whole one replaces it when the slow sources are in. */
  if (later) ctx.waitUntil(keep(body).then(() => later).then(keep));
  else if (ctx?.waitUntil) ctx.waitUntil(keep(body));
  else await keep(body);
  return json(body, 200, origin);
}
