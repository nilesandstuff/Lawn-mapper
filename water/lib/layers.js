/**
 * DRAINS AND WATER FROM THE COUNTY'S AND THE NATION'S MAPS (owner, 2026-10-24: "build it", the layers the core
 * session gathers -- docs/WATER-LAYERS.md, GET /api/water/layers -- "you'll be attaching them to the unified saves
 * ... So you're responsible for ensuring alignment").
 *
 * ALIGNMENT, MEASURED (water/FINDINGS.md H37): Kent County's storm inlets, drawn as the service serves them, sit
 * on the grates the Mapbox photo shows (about 0.2 m) in every one of the 15 of 28 close-ups where a grate could be
 * seen; moved by the NAD83 correction the lidar needs (lib/datum.js), every one was over a metre off. So the layers
 * are drawn as served, on the photo's ground, like the traced lawn -- never moved by the lidar's shift. Other
 * counties' servers may differ; the national layers' own accuracy (NWI, FEMA: tens of feet) is far coarser.
 *
 * THE SAVED COPY: what the page shows is kept with the map, in the water tool's part of the unified save (at most
 * 64 KB with the sprinklers): cut to the map's box, each feature with only the fields the page reads, coordinates
 * to 6 decimals (about 0.1 m), and, past a size budget, the least useful kinds' farthest features dropped first.
 *
 * Pure.
 */

// 2: types sent as names (the core session, 2026-10-24); copies kept before are asked for again
export const SAVED_V = 2;
/** How old a saved copy may be before it is asked for again. */
export const FRESH_DAYS = 30;

/** Each kind: its words, how it is drawn, the fields the page keeps, and how much it matters when trimming. */
export const KINDS = {
  watershed: { label: 'watershed', draw: 'area', stroke: '#90a4ae', fill: null, dash: [6, 4], keep: ['NAME', 'CLASSIFICATION'], rank: 1 },
  drain_district: { label: 'county drain district', draw: 'area', stroke: '#ab47bc', fill: null, dash: [8, 4], keep: ['SUBTYPE', 'DRAIN_NAME', 'OWNER', 'NAME'], rank: 2 },
  drain_easement: { label: 'drain or storm easement', draw: 'area', stroke: '#8d6e63', fill: 'rgba(141,110,99,.22)', dash: [4, 3], keep: ['EASEMENT_NAME', 'GRANTEE', 'MAINT_RESP'], rank: 3 },
  wetland: { label: 'wetland', draw: 'area', stroke: '#2e7d32', fill: 'rgba(76,175,80,.28)', keep: ['WETLAND_TYPE', 'ATTRIBUTE', 'CLASS', 'NWI_CODE'], rank: 4 },
  flood_zone: { label: 'flood hazard zone', draw: 'area', stroke: '#ef6c00', fill: 'rgba(255,152,0,.22)', keep: ['FLD_ZONE', 'SFHA_TF', 'FLOOD_ZONE_TYPE', 'ZONE_SUBTY'], rank: 5 },
  water_body: { label: 'lake or pond', draw: 'area', stroke: '#1565c0', fill: 'rgba(30,136,229,.45)', keep: ['GNIS_NAME', 'NAME', 'DESC_', 'WETLAND_TYPE'], rank: 6 },
  detention_basin: { label: 'detention or retention basin', draw: 'area', stroke: '#00838f', fill: 'rgba(0,188,212,.35)', keep: ['NAME', 'TYPE', 'OWNER'], rank: 10 },
  stream: { label: 'stream or river', draw: 'line', stroke: '#1e88e5', width: 2.5, keep: ['GNIS_NAME', 'NAME', 'DESC_'], rank: 7 },
  open_drain: { label: 'open drain or ditch', draw: 'line', stroke: '#00acc1', width: 2.5, dash: [6, 3], keep: ['SUBTYPE', 'DRAIN_NAME', 'NAME', 'OWNER'], rank: 8 },
  storm_main: { label: 'storm sewer pipe', draw: 'line', stroke: '#5e35b1', width: 2, keep: ['SUBTYPE', 'DIAMETER', 'LATERAL_SIZE', 'MATERIAL', 'INFLW_INVRT_ELEV', 'OUTFLW_INVRT_ELEV', 'OWNER', 'YEAR_INSTALLED'], rank: 9 },
  culvert: { label: 'culvert', draw: 'line', stroke: '#455a64', width: 4, keep: ['SUBTYPE', 'DIAMETER', 'MATERIAL', 'OWNER'], rank: 9 },
  storm_manhole: { label: 'storm manhole', draw: 'point', shape: 'circle', stroke: '#311b92', fill: '#ffffff', keep: ['SUBTYPE', 'TOP_OF_CASTING', 'INVERT_IN', 'INVERT_OUT', 'DEPTH', 'OWNER'], rank: 11 },
  outfall: { label: 'outfall', draw: 'point', shape: 'triangle', stroke: '#004d40', fill: '#4db6ac', keep: ['OWNER', 'DIAMETER'], rank: 11 },
  storm_inlet: { label: 'storm inlet or catch basin', draw: 'point', shape: 'square', stroke: '#311b92', fill: '#ffeb3b', keep: ['SUBTYPE', 'TOP_OF_CASTING', 'SUMP_DEPTH', 'INVERT_ELEV', 'OWNER', 'YEAR_INSTALLED'], rank: 12 },
};
/** A field, in words (each service's own name otherwise, lower case). */
export const FIELD_WORDS = {
  TOP_OF_CASTING: 'top of the grate or lid (elevation)', SUMP_DEPTH: 'sump depth', INVERT_ELEV: 'pipe bottom (invert elevation)',
  INVERT_IN: 'pipe in, bottom (invert)', INVERT_OUT: 'pipe out, bottom (invert)', INFLW_INVRT_ELEV: 'upstream end, pipe bottom (invert)',
  OUTFLW_INVRT_ELEV: 'downstream end, pipe bottom (invert)', DIAMETER: 'diameter', LATERAL_SIZE: 'size', MATERIAL: 'material', OWNER: 'owner',
  YEAR_INSTALLED: 'installed', DEPTH: 'depth', DRAIN_NAME: 'county drain', EASEMENT_NAME: 'easement', GRANTEE: 'held by', MAINT_RESP: 'maintained by',
  FLD_ZONE: 'FEMA zone', SFHA_TF: 'in the special flood hazard area', FLOOD_ZONE_TYPE: 'flood zone', ZONE_SUBTY: 'zone detail',
  WETLAND_TYPE: 'wetland type', ATTRIBUTE: 'inventory code', CLASS: 'class', NWI_CODE: 'inventory code', GNIS_NAME: 'name', NAME: 'name',
  DESC_: 'description', CLASSIFICATION: 'classification', TYPE: 'type', SUBTYPE: 'type',
};

const R = 6378137;
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const roundCoords = (c) => (typeof c[0] === 'number' ? [round6(c[0]), round6(c[1])] : c.map(roundCoords));
const firstPoint = (g) => { let c = g.coordinates; while (Array.isArray(c[0])) c = c[0]; return c; };
/** Metres east and north of `ref`, near enough over a lot. */
export const enuOf = (ref, p) => [((p[0] - ref[0]) * Math.PI / 180) * R * Math.cos((ref[1] * Math.PI) / 180), ((p[1] - ref[1]) * Math.PI / 180) * R];

/** The box to ask for: the map's own, at most `maxM` across, about its middle. box [w, s, e, n] degrees. */
export function askBox(box, maxM = 1100) {
  const mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const [we] = enuOf(mid, [box[2], mid[1]]), [, sn] = enuOf(mid, [mid[0], box[3]]);
  const hx = Math.min(we, maxM / 2), hy = Math.min(sn, maxM / 2);
  const dLng = (hx / (R * Math.cos((mid[1] * Math.PI) / 180))) * 180 / Math.PI, dLat = (hy / R) * 180 / Math.PI;
  return [mid[0] - dLng, mid[1] - dLat, mid[0] + dLng, mid[1] + dLat].map((v) => +v.toFixed(6));
}

/**
 * The answer, as kept with the map. answer: GET /api/water/layers's; centre [lng, lat] (the lawn's middle);
 * budget: the most bytes the copy may take. -> { v, at, box, complete, failed: [titles], sources: [names],
 * trimmed, layers: [{ kind, title, source, from, features: [{ g: geometry, p: { kept fields } }] }] }
 */
export function compact(answer, { centre, budget = 30000, now = Date.now() } = {}) {
  const layers = [];
  for (const l of answer?.layers || []) {
    if (!KINDS[l.kind] || !Array.isArray(l.features)) continue;
    // each feature under its own kind: a storm "pipe" its county types as a culvert or an open channel is one
    const byKind = new Map();
    for (const f of l.features) {
      if (!f?.geometry?.coordinates) continue;
      const kind = kindOf(l.kind, f.properties?.SUBTYPE), k = KINDS[kind];
      const p = {};
      for (const key of k.keep) {
        const v = f.properties?.[key];
        if (v === null || v === undefined || v === '' || v === ' ') continue;
        if (key === 'SUBTYPE' && typeof v === 'number') continue; // a code no layer names means nothing to a reader
        p[key] = typeof v === 'number' ? +v.toFixed(2) : String(v).slice(0, 60);
      }
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push({ g: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) }, p });
    }
    for (const [kind, features] of byKind) layers.push({ kind, title: String(l.title || '').slice(0, 60), source: String(l.source || '').slice(0, 60), from: l.from === 'national' ? 'national' : 'county', features });
  }
  const out = {
    v: SAVED_V, at: new Date(now).toISOString(), box: answer?.box || null,
    complete: !(answer?.pending?.length) && !(answer?.failed?.length),
    failed: [...(answer?.failed || []), ...(answer?.pending || [])].map((f) => String(f.title || f.kind || '').slice(0, 60)),
    sources: [...new Set(layers.map((l) => l.source).filter(Boolean))],
    trimmed: 0, layers,
  };
  // past the budget: the least useful kind's farthest feature goes first, until it fits
  const size = () => JSON.stringify(out).length;
  if (size() > budget && centre) {
    const dist = (f) => { const [e, n] = enuOf(centre, firstPoint(f.g)); return Math.hypot(e, n); };
    for (const l of layers) l.features.sort((a, b) => dist(a) - dist(b));
    let guard = 0;
    while (size() > budget && guard++ < 20000) {
      const l = layers.filter((x) => x.features.length).sort((a, b) => (KINDS[a.kind].rank - KINDS[b.kind].rank))[0];
      if (!l) break;
      // drop a tenth of that kind at a time (at least one), from the far end
      const n = Math.max(1, Math.floor(l.features.length / 10));
      l.features.splice(l.features.length - n, n);
      out.trimmed += n;
    }
    out.layers = layers.filter((l) => l.features.length);
  }
  return out;
}

/** A storm main's own type, where its county names one (Kent's style: "Culvert", "OpenChannel", "FloodRoute"). */
export function kindOf(kind, subtype) {
  if (kind !== 'storm_main' || typeof subtype !== 'string') return kind;
  if (/culvert/i.test(subtype)) return 'culvert';
  if (/open ?channel|flood ?route|ditch|swale/i.test(subtype)) return 'open_drain';
  return kind;
}

/** A type as words: "StormMain" -> "Storm main", "SUB_DRN_DISTRICT" -> "Sub drn district". */
export const typeWords = (v) => String(v).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase().replace(/^./, (c) => c.toUpperCase());

/** Is a saved copy still good to use? */
export const freshEnough = (saved, now = Date.now()) => !!saved && saved.v === SAVED_V && saved.complete && Date.parse(saved.at) > now - FRESH_DAYS * 86400000;

/* ------------------------------------------------------------------ geometry */

const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const inRing = (p, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
const linesOf = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []);
const pointsOf = (g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : []);

/** Metres from a point to a feature (0 inside an area). */
export function distanceM(at, g) {
  const loc = (q) => enuOf(at, q);
  const P = [0, 0];
  let best = Infinity;
  for (const q of pointsOf(g)) best = Math.min(best, Math.hypot(...loc(q)));
  for (const line of linesOf(g)) for (let i = 1; i < line.length; i++) best = Math.min(best, segDist(P, loc(line[i - 1]), loc(line[i])));
  for (const poly of polysOf(g)) {
    const rings = poly.map((r) => r.map(loc));
    if (inRing(P, rings[0]) && !rings.slice(1).some((h) => inRing(P, h))) return 0;
    for (const r of rings) for (let i = 1; i < r.length; i++) best = Math.min(best, segDist(P, r[i - 1], r[i]));
  }
  return best;
}

/** The structures that take water in (an inlet, manhole, outfall or basin) within `m` metres of a point. */
export function intakesNear(saved, at, m) {
  const out = [];
  for (const l of saved?.layers || []) {
    if (!['storm_inlet', 'storm_manhole', 'outfall', 'detention_basin', 'culvert', 'open_drain'].includes(l.kind)) continue;
    for (const f of l.features) { const d = distanceM(at, f.g); if (d <= m) out.push({ kind: l.kind, d, source: l.source }); }
  }
  return out.sort((a, b) => a.d - b.d);
}

/**
 * What to say under the map: the storm network near the lawn, flood zones and wetlands on the lot, the drain
 * districts. lawn: rings of [lng, lat] (the traced lawn) or null; mid: [lng, lat]. -> { lines: [html-free strings] }
 */
export function summary(saved, { lawn = [], mid }) {
  const lines = [];
  if (!saved?.layers) return lines;
  const lawnPts = lawn.flat();
  const near = (g) => {
    // to the lawn: the least distance from its outline's points, or the middle when there is no lawn
    if (!lawnPts.length) return distanceM(mid, g);
    if (pointsOf(g).length) return Math.min(...pointsOf(g).map((q) => { const P = enuOf(mid, q); const rings = lawn.map((r) => r.map((x) => enuOf(mid, x))); if (rings.some((r) => inRing(P, r))) return 0; let b = Infinity; for (const r of rings) for (let i = 1; i < r.length; i++) b = Math.min(b, segDist(P, r[i - 1], r[i])); return b; }));
    // an area overlapping the lawn either way is on it: a lawn corner inside it, or a corner of it inside the lawn
    const rings = lawn.map((r) => r.map((x) => enuOf(mid, x)));
    for (const poly of polysOf(g)) for (const q of poly[0]) if (rings.some((r) => inRing(enuOf(mid, q), r))) return 0;
    return Math.min(...lawnPts.map((q) => distanceM(q, g)));
  };
  const of = (kind) => saved.layers.filter((l) => l.kind === kind).flatMap((l) => l.features.map((f) => ({ ...f, source: l.source })));
  const ft = (m) => Math.round(m * 3.28084);
  const inlets = of('storm_inlet'), holes = of('storm_manhole'), pipes = of('storm_main');
  if (inlets.length || pipes.length) {
    const nearest = inlets.map((f) => near(f.g)).sort((a, b) => a - b)[0];
    lines.push(`Storm sewer on the map: ${[inlets.length && `${inlets.length} inlet${inlets.length > 1 ? 's' : ''}`, holes.length && `${holes.length} manhole${holes.length > 1 ? 's' : ''}`, pipes.length && `${pipes.length} pipe run${pipes.length > 1 ? 's' : ''}`].filter(Boolean).join(', ')}${Number.isFinite(nearest) ? `; the nearest inlet is ${nearest < 1 ? 'on' : `about ${ft(nearest)} ft from`} your lawn` : ''} (${[...new Set([...inlets, ...pipes].map((f) => f.source))].join(', ')}).`);
  } else lines.push('No storm sewer is mapped here (it may be a city\'s or a township\'s, and not public).');
  const zones = of('flood_zone').filter((f) => !/^X$|minimal|0\.2/i.test(String(f.p.FLD_ZONE || f.p.FLOOD_ZONE_TYPE || '')) || f.p.SFHA_TF === 'T');
  const wet = zones.filter((f) => near(f.g) < 1);
  if (wet.length) lines.push(`Part of your lawn lies in a flood hazard zone (${[...new Set(wet.map((f) => f.p.FLD_ZONE || f.p.FLOOD_ZONE_TYPE).filter(Boolean))].join(', ') || 'mapped'}): ground FEMA expects a flood to reach in about a 1-in-100 year.`);
  else if (zones.length) lines.push(`A flood hazard zone is on the map, about ${ft(Math.min(...zones.map((f) => near(f.g))))} ft from your lawn.`);
  const wl = of('wetland'), wlNear = wl.map((f) => near(f.g)).sort((a, b) => a - b)[0];
  if (Number.isFinite(wlNear) && wlNear < 60) lines.push(wlNear < 1 ? 'A mapped wetland reaches your lawn: the ground there is likely wet for part of the year.' : `A mapped wetland lies about ${ft(wlNear)} ft from your lawn.`);
  const dd = of('drain_district').filter((f) => near(f.g) < 1).map((f) => f.p.DRAIN_NAME || f.p.NAME).filter(Boolean);
  if (dd.length) lines.push(`Your lawn is in the ${[...new Set(dd)].join(' and ')} drain district${new Set(dd).size > 1 ? 's' : ''}: the county drain that carries its storm water away.`);
  const ez = of('drain_easement').filter((f) => near(f.g) < 1);
  if (ez.length) lines.push('A drain or storm easement crosses your lawn: the drain owner may dig or work there.');
  return lines;
}

/** The feature nearest a point within `m` metres, for a tap. -> { kind, title, source, p, d } | null */
export function pick(saved, at, m) {
  let best = null;
  for (const l of saved?.layers || []) {
    const k = KINDS[l.kind];
    for (const f of l.features) {
      const d = distanceM(at, f.g);
      if (d > m) continue;
      // under the finger a point wins over a line, a line over an area it lies in
      const score = d + (k.draw === 'line' ? m * 0.4 : k.draw === 'area' ? m * 0.9 : 0);
      if (!best || score < best.score) best = { kind: l.kind, title: l.title, source: l.source, p: f.p, d, score };
    }
  }
  return best;
}
