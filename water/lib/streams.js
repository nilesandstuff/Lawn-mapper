/**
 * STREAMS AND THE FLOOD PLAIN BY THE LAWN (owner, 2026-10-31: "I do think we need more data about streams and flood
 * plains. It seems like there should be more data about elevation regarding ground water"; FINDINGS H63).
 *
 * Where groundwater meets the surface its elevation is known: a stream that flows all year runs at the water table,
 * and the water table under rising ground beside it stands at or above the stream's level. So the height of a lawn
 * above the nearest perennial stream's water is an upper bound on how deep the water table can be there (it is
 * usually shallower under a hillside, which the hillside reading speaks to). Three free national sources:
 *
 *   NHDPlus HR (USGS; hydro.nationalmap.gov, CORS *): the streams within a kilometre, each perennial, intermittent,
 *     a ditch or canal, with its name and the land it drains. Its water's elevation is read from the USGS 3DEP 10 m
 *     ground at the stream (hydro-flattened rivers carry their water surface; a small creek's channel is close).
 *   FEMA's National Flood Hazard Layer (hazards.fema.gov, open to browsers): the flood zones over the lawn, and on
 *     studied streams the 1%-chance (100-year) flood's water elevation (cross-sections and base flood elevation
 *     lines, NAVD88 like the lidar), interpolated between the two nearest to the lawn.
 *   The lot's own lidar ground (1 m) for the lawn's height against both.
 *
 * On the page only; not in the water balance (S19).
 */

const NHD = 'https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer/3/query';
const NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const FT = 0.3048;

/** NHD feature codes in words (fcode / 100 is the type; the rest its permanence). */
export function streamKind(fcode) {
  const f = Number(fcode);
  if (f === 46006) return 'perennial';
  if (f === 46003 || f === 46007) return 'intermittent';
  if (f === 46000) return 'stream';
  if (f === 55800) return 'river (through a lake or wide river)';
  if (Math.floor(f / 100) === 336) return 'ditch or canal';
  if (Math.floor(f / 100) === 428) return 'pipeline';
  if (Math.floor(f / 100) === 334) return 'connector';
  return 'stream';
}

const arcgis = async (url, params, fetchFn) => {
  const q = new URLSearchParams({ f: 'json', ...params });
  const res = await fetchFn(`${url}?${q}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'error');
  return j.features || [];
};
const around = (lng, lat, m) => ({ geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', distance: String(m), units: 'esriSRUnit_Meter', outSR: '4326' });

/** The streams within `radiusM`: [{ name, kind, km2, line: [[lng, lat], ...] }]. */
export async function streamsNear(lng, lat, { radiusM = 1000, fetchFn = fetch, via = null } = {}) {
  // `via`: the water site's own cached route (src/streams.js); otherwise the service itself
  const fs = via
    ? await (async () => { const res = await fetchFn(`${via}?lng=${lng}&lat=${lat}&r=${radiusM}`, { signal: AbortSignal.timeout(90000) }); const j = await res.json(); if (!res.ok || j.error) throw new Error(j.error || `${res.status}`); return j.features || []; })()
    : await arcgis(NHD, { ...around(lng, lat, radiusM), outFields: 'gnis_name,fcode,totdasqkm', returnGeometry: 'true' }, fetchFn);
  return fs.map((f) => ({ name: f.attributes.gnis_name || null, kind: streamKind(f.attributes.fcode), km2: f.attributes.totdasqkm ?? null, line: (f.geometry?.paths || []).flat() })).filter((s) => s.line.length);
}

/** FEMA's flood zones over the box [w, s, e, n] and the 1% flood elevations within `radiusM` of the point. */
export async function floodNear(lng, lat, box, { radiusM = 1000, fetchFn = fetch } = {}) {
  const env = { geometry: box.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects' };
  const [zones, xs, bfe] = await Promise.all([
    arcgis(`${NFHL}/28/query`, { ...env, outFields: 'FLD_ZONE,ZONE_SUBTY,STATIC_BFE,DEPTH,LEN_UNIT,V_DATUM', returnGeometry: 'true' }, fetchFn),
    arcgis(`${NFHL}/14/query`, { ...around(lng, lat, radiusM), outFields: 'WSEL_REG,LEN_UNIT,V_DATUM', returnGeometry: 'true' }, fetchFn).catch(() => []),
    arcgis(`${NFHL}/16/query`, { ...around(lng, lat, radiusM), outFields: 'ELEV,LEN_UNIT,V_DATUM', returnGeometry: 'true' }, fetchFn).catch(() => []),
  ]);
  const toM = (v, unit) => (Number.isFinite(v) && v > -9000 ? (/feet/i.test(unit || 'Feet') ? v * FT : v) : null);
  return {
    zones: zones.map((f) => ({ zone: f.attributes.FLD_ZONE, subtype: f.attributes.ZONE_SUBTY || null, staticM: toM(f.attributes.STATIC_BFE, f.attributes.LEN_UNIT), rings: f.geometry?.rings || [] })),
    levels: [...xs.map((f) => ({ m: toM(f.attributes.WSEL_REG, f.attributes.LEN_UNIT), datum: f.attributes.V_DATUM, line: (f.geometry?.paths || []).flat(), from: 'cross-section' })),
      ...bfe.map((f) => ({ m: toM(f.attributes.ELEV, f.attributes.LEN_UNIT), datum: f.attributes.V_DATUM, line: (f.geometry?.paths || []).flat(), from: 'base flood elevation' }))].filter((l) => l.m !== null && l.line.length),
  };
}

// distances in metres on a local plane round a point
const plane = (lat) => { const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540; return (a, b) => Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky); };
function nearestOnLine(line, p, dist, lat) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  let best = Infinity, at = null;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1], [bx, by] = line[i];
    const dx = (bx - ax) * kx, dy = (by - ay) * ky, px = (p[0] - ax) * kx, py = (p[1] - ay) * ky;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
    const q = [ax + (bx - ax) * t, ay + (by - ay) * t], d = dist(q, p);
    if (d < best) { best = d; at = q; }
  }
  if (line.length === 1) { best = dist(line[0], p); at = line[0]; }
  return { d: best, at };
}
const inRing = (ring, x, y) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
// an Esri polygon's rings: outer rings clockwise, holes anticlockwise; a point is inside when the count of rings round it is odd
const inZone = (rings, p) => rings.reduce((n, r) => n + (inRing(r, p[0], p[1]) ? 1 : 0), 0) % 2 === 1;

/**
 * What the streams and the flood map say about the lawn. lawn: [{ p: [lng, lat], z: lidar ground m }] (its cells);
 * waterAt([lng, lat]) -> the 10 m ground's lowest within 15 m (m), the stream's water. ->
 * { perennial: { name, kind, distM, waterM, aboveM } | null, nearest: (any stream) | null,
 *   zones: [{ zone, subtype, share }], flood: { m, from, n, depthShare, maxDepthM, lowestAboveM } | null }
 */
export function streamReading({ streams = [], flood = null, lawn, waterAt }) {
  if (!lawn?.length) return null;
  const lat = lawn[0].p[1], dist = plane(lat);
  const mid = [lawn.reduce((s, c) => s + c.p[0], 0) / lawn.length, lawn.reduce((s, c) => s + c.p[1], 0) / lawn.length];
  const zs = lawn.map((c) => c.z).filter(Number.isFinite).sort((a, b) => a - b);
  const median = zs[zs.length >> 1], lowest = zs[0];
  const describe = (s) => {
    if (!s) return null;
    const { d, at } = nearestOnLine(s.line, mid, dist, lat);
    const waterM = waterAt ? waterAt(at) : null;
    return { name: s.name, kind: s.kind, km2: s.km2, distM: Math.round(d), waterM: Number.isFinite(waterM) ? waterM : null, aboveM: Number.isFinite(waterM) && Number.isFinite(median) ? median - waterM : null };
  };
  const byDist = streams.map((s) => ({ s, d: nearestOnLine(s.line, mid, dist, lat).d })).sort((a, b) => a.d - b.d);
  const perennial = byDist.find((x) => x.s.kind === 'perennial' || /^river/.test(x.s.kind));
  const out = { perennial: describe(perennial?.s), nearest: describe(byDist[0]?.s), zones: [], flood: null, lawnM: median };
  if (flood) {
    const tally = new Map();
    for (const c of lawn) {
      const z = flood.zones.find((f) => inZone(f.rings, c.p));
      const key = z ? `${z.zone}|${z.subtype || ''}` : 'none|';
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    out.zones = [...tally].map(([k, n]) => { const [zone, subtype] = k.split('|'); return { zone: zone === 'none' ? null : zone, subtype: subtype || null, share: n / lawn.length }; }).sort((a, b) => b.share - a.share);
    // the 1% flood's water at the lawn: between the two nearest levels, by distance (a static elevation if the zone has one)
    const lv = flood.levels.map((l) => ({ ...l, d: nearestOnLine(l.line, mid, dist, lat).d })).sort((a, b) => a.d - b.d);
    let m = null, from = null;
    // the nearest level, and the next nearest on the same reach (within 2 m of it: two streams' sections can both be near)
    const b2 = lv.length >= 2 ? lv.slice(1).find((l) => Math.abs(l.m - lv[0].m) <= 2) : null;
    if (b2) { const a = lv[0], b = b2; m = (a.m * b.d + b.m * a.d) / (a.d + b.d || 1); from = `${a.from === b.from ? `${a.from}s` : `${a.from} and ${b.from}`} ${Math.round(a.d)} and ${Math.round(b.d)} m away`; }
    else if (lv.length >= 1) { m = lv[0].m; from = `a ${lv[0].from} ${Math.round(lv[0].d)} m away`; }
    else { const st = flood.zones.find((f) => Number.isFinite(f.staticM)); if (st) { m = st.staticM; from = 'the zone\'s own flood elevation'; } }
    if (Number.isFinite(m)) {
      const under = zs.filter((z) => z < m);
      out.flood = { m, from, depthShare: under.length / zs.length, maxDepthM: under.length ? m - lowest : 0, lowestAboveM: lowest - m, datum: lv[0]?.datum || null };
    }
  }
  return out;
}
