/**
 * EACH SOIL OF A MAP UNIT IN ITS OWN PLACE (owner, 2026-10-31: "if we're not reading the soil as granularly as
 * possible, we should"; FINDINGS H62).
 *
 * The soil survey maps units, not soils: "Spinks-Fern complex" is 50% Spinks (well drained), 25% Fern (somewhat
 * poorly drained, wet at 54 cm in spring), and minor soils, with no map of which is where inside the unit. Until
 * now the balance took the unit's main soil for all of it. The survey does say where its soils lie in words (Fern
 * in the lower, wetter positions; the drained soils on the rises), and the water collects by the lie of the land.
 * So each unit's soils are placed by the topographic wetness index, ln(a / tan b), of the USGS 3DEP 10 m ground
 * round the lot (lib/upslope.js, the hillside reading's own): within the unit's ground across that window, the
 * driest soil (by drainage class, then its water table) takes the driest share of the cells, the next the next,
 * each its percentage in the survey; a lawn cell then takes the soil of its own wetness. Each soil keeps its own
 * layers, intake, hydrologic group, drainage and month-by-month water table in the balance.
 *
 * Where the survey maps "Urban land" (no soil described), the nearest mapped unit in the window with soils lends
 * its soils, placed the same way. Without the 10 m ground or the window's soil map, the unit's main soil as before.
 *
 * Not checked against a soil pit on a lawn: SPECULATION (S18) until an auger says so.
 */
import { maskOf } from './geo.js';

export const DRAINAGE_ORDER = ['Excessively drained', 'Somewhat excessively drained', 'Well drained', 'Moderately well drained', 'Somewhat poorly drained', 'Poorly drained', 'Very poorly drained'];
const MIN_CELLS = 20; // fewer of a unit's cells in the window than this: the window's own spread of wetness is used

/** The shallowest water table a soil lists in any month, cm (Infinity with none). */
const wetTop = (c) => { const v = (c.wetByMonth || []).filter(Number.isFinite); return v.length ? Math.min(...v) : Infinity; };

/** A unit's soils that can be placed: described (layers with water), not urban land; driest first, shares summing to 1. */
export function placeable(unit) {
  const comps = (unit?.components || []).filter((c) => c.soil && c.pct > 0 && !/urban land/i.test(c.name || ''));
  if (!comps.length) return [];
  const rank = (c) => { const d = DRAINAGE_ORDER.indexOf(c.drainage); return d < 0 ? 2 : d; };
  comps.sort((a, b) => rank(a) - rank(b) || wetTop(b) - wetTop(a) || b.pct - a.pct);
  const total = comps.reduce((s, c) => s + c.pct, 0);
  return comps.map((c) => ({ ...c, share: c.pct / total }));
}

/** The wetness index on the 10 m ground (NaN where the ground is missing). */
export function twiOf(dem, t) {
  const out = new Float32Array(dem.W * dem.H);
  for (let i = 0; i < out.length; i++) out[i] = Number.isFinite(dem.z[i]) ? Math.log(t.area[i] / dem.cell / t.slope[i]) : NaN;
  return out;
}

const demGrid = (dem) => {
  const cs = (dem.bbox[2] - dem.bbox[0]) / dem.W;
  return { W: dem.W, H: dem.H, toCell: (x, y) => [(x - dem.bbox[0]) / cs, (dem.bbox[3] - y) / cs] };
};

/** The wetness index at a point in 3857, bilinear between the 10 m cells (the nearest finite one where some are missing). */
export function twiAtMerc(dem, twi, x, y) {
  const { W, H } = dem, cs = (dem.bbox[2] - dem.bbox[0]) / W;
  const fx = (x - dem.bbox[0]) / cs - 0.5, fy = (dem.bbox[3] - y) / cs - 0.5;
  const c0 = Math.max(0, Math.min(W - 1, Math.floor(fx))), r0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const c1 = Math.min(W - 1, c0 + 1), r1 = Math.min(H - 1, r0 + 1), tx = Math.max(0, Math.min(1, fx - c0)), ty = Math.max(0, Math.min(1, fy - r0));
  const v = [[r0, c0, (1 - tx) * (1 - ty)], [r0, c1, tx * (1 - ty)], [r1, c0, (1 - tx) * ty], [r1, c1, tx * ty]];
  let s = 0, w = 0, best = NaN, bw = -1;
  for (const [r, c, k] of v) { const z = twi[r * W + c]; if (Number.isFinite(z)) { s += z * k; w += k; if (k > bw) { bw = k; best = z; } } }
  return w > 0 ? s / w : best;
}

const quantile = (sorted, q) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * sorted.length)))];

/**
 * lotUnits: the survey's units on the lot (soil.js soilFor); winUnits: the same over the 10 m window (its polygons
 * reach the window's edges); dem, t: the 10 m ground and its terrain (upslope.js). -> Map mukey -> { comps (driest
 * first, with share), cuts (wetness-index bounds between them), borrowed: the lending unit's name or null }
 */
export function placeSoils(lotUnits, winUnits, dem, t) {
  const twi = twiOf(dem, t), G = demGrid(dem), N = dem.W * dem.H;
  const unitAt = new Int16Array(N).fill(-1);
  (winUnits || []).forEach((u, k) => {
    if (!u.polygons?.length) return;
    const m = maskOf(G, u.polygons.map((coordinates) => ({ type: 'Polygon', coordinates })));
    for (let i = 0; i < N; i++) if (m[i]) unitAt[i] = k;
  });
  const all = Array.from(twi).filter(Number.isFinite).sort((a, b) => a - b);
  const cellsOf = (k) => { const v = []; for (let i = 0; i < N; i++) if (unitAt[i] === k && Number.isFinite(twi[i])) v.push(twi[i]); return v.sort((a, b) => a - b); };
  // the nearest unit with soils to the window's middle (the lot), for urban land
  const mr = dem.H >> 1, mc = dem.W >> 1;
  const nearestWithSoils = () => {
    let best = -1, bd = Infinity;
    for (let i = 0; i < N; i++) {
      const k = unitAt[i];
      if (k < 0 || !placeable(winUnits[k]).length) continue;
      const d = (Math.floor(i / dem.W) - mr) ** 2 + ((i % dem.W) - mc) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  };
  const out = new Map();
  for (const u of lotUnits || []) {
    let comps = placeable(u), borrowed = null, k = (winUnits || []).findIndex((w) => w.mukey === u.mukey);
    if (!comps.length) {
      const b = nearestWithSoils();
      if (b < 0) continue;
      comps = placeable(winUnits[b]); borrowed = winUnits[b].name || 'the nearest mapped soil'; k = b;
    }
    if (comps.length === 1) { out.set(u.mukey, { comps, cuts: [], borrowed }); continue; }
    const own = k >= 0 ? cellsOf(k) : [];
    const sorted = own.length >= MIN_CELLS ? own : all;
    if (!sorted.length) continue;
    const cuts = [];
    let cum = 0;
    for (let j = 0; j < comps.length - 1; j++) { cum += comps[j].share; cuts.push(quantile(sorted, cum)); }
    out.set(u.mukey, { comps, cuts, borrowed, cells: own.length });
  }
  return { byUnit: out, twi };
}

/** Which of a placement's soils a wetness index falls to. */
export function soilIndex(place, v) {
  if (!Number.isFinite(v)) return 0;
  for (let j = 0; j < place.cuts.length; j++) if (v < place.cuts[j]) return j;
  return place.cuts.length;
}

/** The wetness index for every cell of the lot's grid g (its toMerc(col, row) in 3857). */
export function twiForGrid(dem, twi, g) {
  const out = new Float32Array(g.W * g.H);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    const [x, y] = g.toMerc(c + 0.5, r + 0.5);
    out[r * g.W + c] = twiAtMerc(dem, twi, x, y);
  }
  return out;
}

