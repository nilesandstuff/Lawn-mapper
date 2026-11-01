/**
 * THE WATER TABLE UNDER A LAWN, MONTH BY MONTH (owner, 2026-11-01: "Yes build all 3. We're really trying to make this
 * as true to life as possible" -- the height above the nearest water, water rising from a shallow water table into the
 * roots, and seeps; a customer's lawn wet weeks after rain in a dry month, H69; FINDINGS H70).
 *
 * HAND, the height above the nearest drainage (Renno et al. 2008; Nobre et al. 2011): follow the ground downhill (D8 on
 * the USGS 3DEP 10 m ground, lib/upslope.js terrain) to the first water, and take the height difference. Water here
 * is what holds a water table up, from the free national maps:
 *   permanent  NHD perennial streams and rivers, NHD lakes and ponds, NWI lakes, rivers, open-water ponds (UB, AB)
 *              and wetlands flooded most of the year (water regimes F, G, H, K);
 *   seasonal   NHD intermittent streams, ditches and canals (county drains can run dry in late summer), swamps, NWI wetlands saturated or flooded in the wet season (A, B, C, E),
 *              and the ground's own channels (CHANNEL_HA or more draining through a cell): water there in the wet half.
 * Each water cell's level is the 10 m ground there (3DEP's ground is hydro-flattened: a lake's cells carry its surface).
 */
import { toMerc, fromMerc } from './ept.js';
import { CHANNEL_HA } from './upslope.js';

/** An NWI code ('PEM1C', 'PUBHx', 'L1UBH', 'PFO1/EM1A') -> { system, cls, regime } (regime: the water regime letter). */
export function nwiCode(code) {
  const m = /^([LPRME])(\d)?([A-Z]{2})(\d*)(?:\/([A-Z]{2})(\d*))?([A-Z])?/.exec(String(code || ''));
  if (!m) return null;
  return { system: m[1], cls: m[3], regime: m[7] || null };
}

/** How an NWI polygon holds the water table: 'permanent', 'seasonal' or null (left out). */
export function nwiKind(code) {
  const c = nwiCode(code);
  if (!c) return null;
  if (c.system === 'L' || c.system === 'R') return 'permanent';
  if (c.system !== 'P') return null;
  if (c.cls === 'UB' || c.cls === 'AB') return 'permanent';
  if (c.regime && 'FGHKV'.includes(c.regime)) return 'permanent';
  if (c.regime && 'ABCEJ'.includes(c.regime)) return 'seasonal';
  return null;
}

/** An NHD stream (lib/streams.js streamKind words) -> 'permanent' | 'seasonal'. */
export const streamHold = (kind) => (kind === 'perennial' || /^river/.test(kind || '') ? 'permanent' : kind === 'intermittent' || kind === 'stream' || /ditch|canal/.test(kind || '') ? 'seasonal' : null);
/** An NHD waterbody fcode -> 'permanent' | 'seasonal' | null. 390 lake/pond, 436 reservoir, 466 swamp/marsh, 493 estuary. */
export const bodyHold = (fcode) => { const f = Math.floor(Number(fcode) / 100); return f === 390 || f === 436 || f === 493 ? 'permanent' : f === 466 ? 'seasonal' : null; };

/**
 * The water on the 10 m ground. dem: lib/upslope.js demAround; t: terrain(dem).
 * streams: [{ kind, line: [[lng, lat]] }]; bodies: [{ fcode, rings: [[[lng, lat]]] }]; wetlands: [{ code, rings }].
 * -> hold: Uint8Array per cell (0 none, 1 permanent, 2 seasonal, 3 the ground's own channel: seasonal, no mapped level).
 */
export function waterOnGround(dem, t, { streams = [], bodies = [], wetlands = [] } = {}) {
  const { W, H } = dem, hold = new Uint8Array(W * H);
  const cellOf = ([lng, lat]) => {
    const [x, y] = toMerc([lng, lat]);
    const c = Math.floor(((x - dem.bbox[0]) / (dem.bbox[2] - dem.bbox[0])) * W), r = Math.floor(((dem.bbox[3] - y) / (dem.bbox[3] - dem.bbox[1])) * H);
    return c < 0 || r < 0 || c >= W || r >= H ? -1 : r * W + c;
  };
  const mark = (i, v) => { if (i >= 0 && (hold[i] === 0 || v < hold[i])) hold[i] = v; };
  // lines: every half cell along each segment
  for (const s of streams) {
    const v = streamHold(s.kind) === 'permanent' ? 1 : streamHold(s.kind) === 'seasonal' ? 2 : 0;
    if (!v || !s.line?.length) continue;
    const m = s.line.map(toMerc), step = ((dem.bbox[2] - dem.bbox[0]) / W) / 2;
    for (let k = 1; k < m.length; k++) {
      const [x0, y0] = m[k - 1], [x1, y1] = m[k], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
      for (let q = 0; q <= n; q++) mark(cellOf(fromMerc([x0 + ((x1 - x0) * q) / n, y0 + ((y1 - y0) * q) / n])), v);
    }
    if (m.length === 1) mark(cellOf(s.line[0]), v);
  }
  // polygons: cell centres inside (and the cell of each vertex, for a pond smaller than a cell)
  const polys = [
    ...bodies.map((b) => ({ v: bodyHold(b.fcode) === 'permanent' ? 1 : bodyHold(b.fcode) === 'seasonal' ? 2 : 0, rings: b.rings })),
    ...wetlands.map((w) => ({ v: nwiKind(w.code) === 'permanent' ? 1 : nwiKind(w.code) === 'seasonal' ? 2 : 0, rings: w.rings })),
  ];
  for (const p of polys) {
    if (!p.v || !p.rings?.length) continue;
    const mr = p.rings.map((r) => r.map(toMerc));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of mr) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const cw = (dem.bbox[2] - dem.bbox[0]) / W, ch = (dem.bbox[3] - dem.bbox[1]) / H;
    const r0 = Math.max(0, Math.floor((dem.bbox[3] - y1) / ch)), r1 = Math.min(H - 1, Math.floor((dem.bbox[3] - y0) / ch));
    // row by row: where the rings' edges cross the row's middle, filled between pairs (even-odd, holes and all)
    for (let r = r0; r <= r1; r++) {
      const y = dem.bbox[3] - (r + 0.5) * ch, xs = [];
      for (const ring of mr) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a2, b2) => a2 - b2);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const ca = Math.max(0, Math.ceil((xs[k] - dem.bbox[0]) / cw - 0.5)), cb = Math.min(W - 1, Math.floor((xs[k + 1] - dem.bbox[0]) / cw - 0.5));
        for (let c = ca; c <= cb; c++) mark(r * W + c, p.v);
      }
    }
    for (const r of p.rings) for (const pt of r) mark(cellOf(pt), p.v);
  }
  // the ground's own channels (3: seasonal for the flow, not a mapped water level)
  if (t) for (let i = 0; i < W * H; i++) if (!hold[i] && t.area[i] >= CHANNEL_HA * 1e4) hold[i] = 3;
  return hold;
}

/**
 * Height above the nearest water, down the flow path, for every 10 m cell: { perm, wet } -- to permanent water only
 * (the dry half of the year), and to permanent or seasonal water (the wet half) -- each { h (m; NaN where the path
 * leaves the window first), level (the water's height), dist (m along the path) }.
 */
export function handGrid(dem, t, hold) {
  const { W, cell } = dem, N = dem.W * dem.H;
  const run = (isWater) => {
    const tgt = new Int32Array(N).fill(-2), dist = new Float32Array(N);
    for (let i0 = 0; i0 < N; i0++) {
      if (tgt[i0] !== -2) continue;
      const path = [];
      let j = i0, found = -1;
      while (j >= 0 && tgt[j] === -2) {
        if (isWater(j)) { found = j; tgt[j] = j; dist[j] = 0; break; }
        path.push(j);
        if (path.length > N) break;
        j = t.down[j];
      }
      if (found < 0 && j >= 0 && tgt[j] !== -2) found = tgt[j];
      // back along the path: each cell's water, and how far along the path it is
      let d = found >= 0 && j >= 0 ? dist[j] : 0;
      for (let k = path.length - 1; k >= 0; k--) {
        const a = path[k], b = k + 1 < path.length ? path[k + 1] : j;
        if (b >= 0) d += cell * (Math.abs(b - a) === 1 || Math.abs(b - a) === W ? 1 : Math.SQRT2);
        tgt[a] = found; dist[a] = found >= 0 ? d : NaN;
      }
    }
    const h = new Float32Array(N), level = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const w = tgt[i];
      if (w >= 0 && Number.isFinite(dem.z[w])) { level[i] = dem.z[w]; h[i] = dem.z[i] - dem.z[w]; } else { level[i] = NaN; h[i] = NaN; }
    }
    return { h, level, dist, tgt };
  };
  return { perm: run((i) => hold[i] === 1), wet: run((i) => hold[i] >= 1) };
}

/**
 * The flow over the ground with the mapped water burned in (Hellweger 1997's "AGREE", simply): the national lines sit
 * 10-30 m off the 10 m ground's own groove, so a path down a valley can run beside a creek to the window's edge without
 * touching it (the wet lawn of H69: 174 cells past Buck Creek). Water cells are lowered `depthM` for the routing only;
 * heights above the water are read from the true ground. -> terrain(dem) of the burned ground.
 */
export function burnedTerrain(dem, hold, terrainFn, depthM = 5) {
  const z = Float32Array.from(dem.z);
  for (let i = 0; i < z.length; i++) if (hold[i] && Number.isFinite(z[i])) z[i] -= depthM;
  return terrainFn({ ...dem, z });
}

/** The 10 m cell of a point in 3857 (-1 off the window). */
export function demCell(dem, x, y) {
  const c = Math.floor(((x - dem.bbox[0]) / (dem.bbox[2] - dem.bbox[0])) * dem.W), r = Math.floor(((dem.bbox[3] - y) / (dem.bbox[3] - dem.bbox[1])) * dem.H);
  return c < 0 || r < 0 || c >= dem.W || r >= dem.H ? -1 : r * dem.W + c;
}

/* ------------------------------------------------ the water table's depth (H70) */

/** The share of the ground's height above the nearby water levels that the water table keeps: measured on 227-241
 * shallow wells in Kent and Ottawa (Wellogic static levels against 3DEP and the water maps): 0.48-0.52 per metre. The
 * wells' own depths read about 2.4 m deeper than this throughout (a well screened 10-18 m down reads the head there,
 * deeper than the water table in a recharge area), so the rate is taken, not the depth. */
export const RISE_SHARE = 0.5;
/** How much deeper the water table goes from spring to autumn, where nothing holds it: shallow unconfined wells swing
 * 0.3-1.2 m month to month (H61, research-groundwater.md); the middle. */
export const SWING_M = 0.75;
const IDW_M = 1000, IDW_MIN_M = 20;

/**
 * The water level round a point: the levels of the mapped water within IDW_M, inverse-distance weighted (the water
 * table meets the ground there). cells: indices of 10 m cells -> Map cell -> { any (permanent and seasonal water),
 * perm (permanent only) }, metres; NaN with none in reach.
 */
export function waterLevels(dem, hold, cells) {
  const { W, cell } = dem;
  const water = [];
  for (let i = 0; i < hold.length; i++) if ((hold[i] === 1 || hold[i] === 2) && Number.isFinite(dem.z[i])) water.push([(i % W) * cell, Math.floor(i / W) * cell, dem.z[i], hold[i] === 1]);
  const out = new Map();
  for (const i of cells) {
    if (out.has(i)) continue;
    const x = (i % W) * cell, y = Math.floor(i / W) * cell;
    let sa = 0, za = 0, sp = 0, zp = 0;
    for (const [wx, wy, wz, perm] of water) {
      const d = Math.hypot(wx - x, wy - y); if (d > IDW_M) continue;
      const w = 1 / Math.max(IDW_MIN_M, d) ** 2;
      sa += w; za += w * wz; if (perm) { sp += w; zp += w * wz; }
    }
    out.set(i, { any: sa ? za / sa : NaN, perm: sp ? zp / sp : NaN });
  }
  return out;
}

/** 0 in mid-April (the water table at its highest) to 1 in mid-October (its lowest). month 0-11. */
export const seasonShape = (month) => (1 - Math.cos((2 * Math.PI * (month + 0.5 - 3.5)) / 12)) / 2;

/**
 * The water table's depth under one spot, month by month, cm (NaN: deeper than 4 m or unknown).
 * z: the spot's ground (lidar, m); any/perm: the water levels round it (waterLevels); survey: the soil survey's wet
 * layer by month (cm | null x 12, the spot's own soil).
 *   high (April):  RISE_SHARE of the height above the water round it (any), or the survey's, the shallower;
 *   each month:    the high plus SWING_M x seasonShape, but no deeper than RISE_SHARE of the height above the
 *                  PERMANENT water round it (a pond or a creek holds the water table up all year) -- or the survey's
 *                  listed depth that month, the shallower.
 */
export function tableDepths(z, levels, survey = null) {
  const out = new Float32Array(12).fill(NaN);
  if (!Number.isFinite(z)) return out;
  const listed = (survey || []).filter(Number.isFinite);
  const surveyHigh = listed.length ? Math.min(...listed) / 100 : Infinity;
  const fromAny = Number.isFinite(levels?.any) ? Math.max(0, RISE_SHARE * (z - levels.any)) : Infinity;
  const high = Math.min(fromAny, surveyHigh);
  const held = Number.isFinite(levels?.perm) ? Math.max(0, RISE_SHARE * (z - levels.perm)) : Infinity;
  for (let m = 0; m < 12; m++) {
    let d = Number.isFinite(high) ? Math.max(high, Math.min(high + SWING_M * seasonShape(m), held)) : held;
    const s = survey?.[m];
    if (Number.isFinite(s)) d = Math.min(d, s / 100);
    out[m] = Number.isFinite(d) && d <= 4 ? d * 100 : NaN;
  }
  return out;
}

/* ---------------------------------------- water rising from it into the roots (H70) */

/** AquaCrop's soil classes for capillary rise (Raes et al., FAO AquaCrop reference manual ch. 3, Eq. 3.7j-l;
 * research-caprise.md): I sandy, II loamy, III sandy clayey, IV silty clayey; Ksat ranges mm/day. */
export const CR_CLASS = {
  sand: 1, 'loamy sand': 1, 'sandy loam': 1, loam: 2, 'silt loam': 2, silt: 2,
  'sandy clay loam': 3, 'sandy clay': 3, 'clay loam': 3, 'silty clay loam': 4, 'silty clay': 4, clay: 4,
};
const CR_PARAMS = {
  1: { k: [200, 2000], a: (K) => -0.3112 - 1e-5 * K, b: (K) => -1.4936 + 0.2416 * Math.log(K) },
  2: { k: [100, 750], a: (K) => -0.4986 + 9e-5 * K, b: (K) => -2.1320 + 0.4778 * Math.log(K) },
  3: { k: [5, 150], a: (K) => -0.5677 - 4e-5 * K, b: (K) => -3.7189 + 0.5922 * Math.log(K) },
  // class IV's Ksat held to 35 mm/day at most (AquaCrop's own clay default; above it the curve runs away: research-caprise.md)
  4: { k: [1, 35], a: (K) => -0.6366 + 8e-4 * K, b: (K) => -1.9165 + 0.7063 * Math.log(K) },
};

/** The most water a water table zM below the roots can lift into them, mm/day: CR = exp((ln z - b) / a). */
export function capRise(cls, ksatMmDay, zM) {
  const p = CR_PARAMS[cls] || CR_PARAMS[2];
  if (!(zM > 0) || zM >= 4) return 0;
  const K = Math.max(p.k[0], Math.min(p.k[1], Number.isFinite(ksatMmDay) ? ksatMmDay : p.k[0]));
  return Math.min(99, Math.exp((Math.log(zM) - p.b(K)) / p.a(K)));
}

/** The soil between the roots and the water table: the slowest layer from fromCm to toCm -> { cls, ksatMmDay, texture }. */
export function subsoilOf(profile, fromCm, toCm, textureClass) {
  let best = null;
  for (const h of profile?.horizons || []) {
    if (h.topCm === null || h.bottomCm === null || h.bottomCm <= fromCm || h.topCm >= toCm || !Number.isFinite(h.ksatUmS)) continue;
    if (!best || h.ksatUmS < best.ksatUmS) best = h;
  }
  const texture = best ? textureClass(best.sand ?? 40, best.clay ?? 20) || 'loam' : 'loam';
  return { cls: CR_CLASS[texture] || 2, ksatMmDay: best ? best.ksatUmS * 86.4 : 100, texture };
}
