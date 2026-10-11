/**
 * TREES THROUGH THE YEAR, FROM A LEAF-OFF FLIGHT (shade map, step 4).
 *
 * Most 3DEP lidar is flown with the leaves off (H72: the newest flight is
 * leaf-off in 50 of 106 counties; among our labelled crowns 201 of 271 were).
 * The laser then measures a deciduous crown's BRANCHES, not its summer
 * leaves: the step 2 model would let summer sun through a maple as if it
 * were March. So, following a literature check passed on by the owner
 * (2026-10-11; Parent & Volin 2014, Wasser et al. 2013: leaf-off lidar gives
 * height and footprint, not leaf-on density):
 *
 *  1. CROWNS. Columns with returns more than 2 m up that are not roofs,
 *     joined into clumps (8-neighbour). A ROOF column -- three returns or
 *     more, all within 1.5 m of each other, and no last return reaching the
 *     ground -- is a building and stays solid (canopy.js), as H38's roof
 *     rule has it.
 *
 *  2. EVERGREEN OR NOT, per column (a stand of trees is one clump and can be
 *     mixed), one of two ways, chosen on the page:
 *
 *     BY THE LASER: the share of LAST returns that reach the ground, pooled
 *     over the 5 x 5 m around it. MEASURED HERE, H73 (run
 *     37302462833, 290 labelled crowns): on leaf-off flights the median
 *     evergreen crown sends 64% of its last returns to the ground and the
 *     median broadleaf 94%; that feature alone tells them apart 75% of the
 *     time held out by map (read it as +-5). The cut is halfway, 0.79. Only
 *     for leaf-off or mixed flights; a leaf-on flight already saw summer.
 *     BUT THAT WAS MEASURED ON SINGLE TREES OVER LAWNS. On the owner's own
 *     wooded lot (Rockford MI, 2026-10-11) it called 72% of the tree cover
 *     evergreen where the leaf-off photo shows mostly bare brown woods with
 *     scattered conifers: stacked trunks and branches in a wood stop pulses
 *     too, and that flight ran into May.
 *
 *     BY THE PHOTO'S COLOUR, for a photo taken with the leaves off, where an
 *     evergreen is green and a bare crown brown or grey: excess green,
 *     (2G - R - B) / (R + G + B), pooled over the 3 x 3 m around the
 *     column, cut where the photo's own crowns split best into two groups
 *     (Otsu's method). H71 measured colour telling a bare crown from one in
 *     leaf 86-91% of the time. Whether a photo IS leaf-off is not
 *     detected -- raw greenness differs too much between photos -- so this
 *     is the person's choice, with the Trees view to check it against.
 *     Columns the photo does not cover fall back to the laser.
 *
 *  3. A DECIDUOUS CROWN IN LEAF stops light by Beer's law at a uniform
 *     density chosen so that sun straight down through the clump's crown
 *     depth keeps T_LEAF_ON: 6%. The depth is the clump's, from all its
 *     returns more than 2 m up (10th to 95th percentile of height over the
 *     ground): at 2-8 points a square metre one column holds too few. Each
 *     column's crown runs from the clump's crown base to its own top. Measured summer transmissivity under
 *     single urban broadleaves is about 5-15% of total sunlight (Larsson,
 *     SLU, reviewing earlier studies; horse chestnut 3%, Takacs et al. 2016),
 *     and photosynthetic light less than total, since leaves absorb it
 *     more. A low sun crosses more crown and keeps less -- the reason for
 *     Beer's law per cube rather than one number per tree. Where the leaf-off
 *     branches already stop more, they win.
 *
 *  4. BARE, it is what the laser measured. EVERGREENS are as measured all year.
 *
 *  5. IN BETWEEN, leaf-out and leaf-fall are ESTIMATED from the place's
 *     typical temperature (climate.js): leaves come out over three weeks from
 *     the day the typical mean first passes 10 C in spring, and fall over
 *     three weeks from the day it drops back below 10 C. An estimate, said so
 *     on the page; a phenology dataset could replace it.
 */

import { cellOf } from './grid.js';
import { GRASS_M, solidAtGrass } from './canopy.js';

const NOISE = new Set([7, 18]);
export const CROWN_ABOVE_M = 2;
export const EVERGREEN_BELOW = 0.79;
export const T_LEAF_ON = 0.06;
export const LEAF_T_C = 10;
export const LEAF_RAMP_DAYS = 21;

/**
 * Classify the model's columns and build its leaf-on state.
 *
 * Returns { kind (Uint8 per column: 0 open, 1 roof, 2 evergreen, 3 deciduous),
 *           clumps: [{ n, penetration, base, top, depth, evergreenShare }],
 *           clumpOf, muOn (per cube), muOff, counts (columns of each kind) }.
 */
export function seasonalCanopy(cols, model, { shift = null, classify = true, greenness = null } = {}) {
  const { grid, w, h, nz, dz, z0, ground, mu } = model;
  const N = w * h;
  const above = new Uint16Array(N), lastAll = new Float32Array(N), lastGround = new Float32Array(N);
  const heights = []; // [column, height over ground] of every crown return, for clump depths
  const zLo = new Float32Array(N).fill(Infinity), zHi = new Float32Array(N).fill(-Infinity);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    const over = cols.z[i] - ground[k];
    if ((cols.ret[i] || 1) >= (cols.nret[i] || 1)) {
      lastAll[k]++;
      if (over <= GRASS_M) lastGround[k]++;
    }
    if (over > CROWN_ABOVE_M && over < 80) {
      above[k]++;
      heights.push(k, over);
      if (cols.z[i] < zLo[k]) zLo[k] = cols.z[i];
      if (cols.z[i] > zHi[k]) zHi[k] = cols.z[i];
    }
  }
  /* Penetration pooled over the 5 x 5 columns, as H73 averaged over a crown's cells. */
  const pen = new Float32Array(N).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, g = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      a += lastAll[yy * w + xx]; g += lastGround[yy * w + xx];
    }
    if (a > 0) pen[y * w + x] = g / a;
  }
  const kind = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (!above[k]) continue;
    /* A building: H38's flat-roof rule, or a column nothing got through (a
       pitched roof, which the flat rule misses, or the densest evergreen). */
    const roof = (above[k] >= 3 && zHi[k] - zLo[k] < 1.5 && lastGround[k] === 0) || solidAtGrass(model, k);
    kind[k] = roof ? 1 : 3;
  }
  /* Clumps of crown columns. */
  const clumpOf = new Int32Array(N).fill(-1);
  const clumps = [];
  for (let s = 0; s < N; s++) {
    if (kind[s] !== 3 || clumpOf[s] >= 0) continue;
    const id = clumps.length, members = [s];
    clumpOf[s] = id;
    for (let q = 0; q < members.length; q++) {
      const k = members[q], x = k % w, y = (k / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (kind[j] === 3 && clumpOf[j] < 0) { clumpOf[j] = id; members.push(j); }
      }
    }
    let ps = 0, pn = 0;
    for (const k of members) if (Number.isFinite(pen[k])) { ps += pen[k]; pn++; }
    clumps.push({ n: members.length, penetration: pn ? ps / pn : 1, hs: [] });
  }
  for (let i = 0; i < heights.length; i += 2) {
    const id = clumpOf[heights[i]];
    if (id >= 0) clumps[id].hs.push(heights[i + 1]);
  }
  for (const c of clumps) {
    c.hs.sort((a, b) => a - b);
    const q = (f) => c.hs[Math.min(c.hs.length - 1, Math.floor(f * c.hs.length))];
    c.base = c.hs.length ? Math.max(CROWN_ABOVE_M, q(0.1)) : CROWN_ABOVE_M;
    c.top = c.hs.length ? q(0.95) : CROWN_ABOVE_M + dz;
    c.depth = Math.max(dz, c.top - c.base);
    delete c.hs;
  }
  /* Evergreen per column: by the photo's colour where asked and covered,
     else by the laser. */
  const green = greenness ? pooledGreen(greenness, w, h, kind) : null;
  const cut = green ? otsu(Array.from(green).filter((v, k) => kind[k] === 3 && Number.isFinite(v))) : null;
  let ever = 0, byColour = 0;
  for (let k = 0; k < N; k++) {
    if (kind[k] !== 3 || !classify) continue;
    let evergreen;
    if (green && cut !== null && Number.isFinite(green[k])) { evergreen = green[k] >= cut; byColour++; } else evergreen = Number.isFinite(pen[k]) && pen[k] < EVERGREEN_BELOW;
    if (evergreen) { kind[k] = 2; ever++; }
  }
  for (const c of clumps) c.evergreenShare = 0;
  for (let k = 0; k < N; k++) if (clumpOf[k] >= 0 && kind[k] === 2) clumps[clumpOf[k]].evergreenShare++;
  for (const c of clumps) c.evergreenShare /= c.n;

  /* The leaf-on state: deciduous crown cubes at the in-leaf density. */
  const muOn = Float32Array.from(mu);
  for (let k = 0; k < N; k++) {
    if (kind[k] !== 3) continue;
    const c = clumps[clumpOf[k]];
    const muLeaf = -Math.log(T_LEAF_ON) / c.depth;
    /* The cubes whose middles lie in this column's crown: from the clump's
       crown base to this column's own top, but no higher than the clump's
       crown top, so straight down crosses at most the depth muLeaf was set for. */
    const lo = ground[k] + c.base, hi = Math.min(zHi[k], ground[k] + c.top);
    for (let l = Math.max(0, Math.floor((lo - z0) / dz)); l < nz; l++) {
      const mid = z0 + (l + 0.5) * dz;
      if (mid > hi) break;
      if (mid < lo) continue;
      const i = k * nz + l;
      if (muLeaf > muOn[i]) muOn[i] = muLeaf;
    }
  }
  const counts = { roof: 0, evergreen: ever, deciduous: 0 };
  for (let k = 0; k < N; k++) { if (kind[k] === 1) counts.roof++; else if (kind[k] === 3) counts.deciduous++; }
  return { kind, clumps, clumpOf, muOn, muOff: mu, counts, classified: classify, byColour, greenCut: cut };
}

/** The extinction coefficients with a share `f` (0 bare .. 1 in full leaf) of deciduous leaves out. */
export function muWithLeaves(season, f) {
  if (f <= 0) return season.muOff;
  if (f >= 1) return season.muOn;
  const out = new Float32Array(season.muOff.length);
  for (let i = 0; i < out.length; i++) out[i] = season.muOff[i] + f * (season.muOn[i] - season.muOff[i]);
  return out;
}

/**
 * Leaf-out and leaf-fall from the typical year's mean temperature (365
 * values): { out: day the leaves start, fall: day they start dropping,
 * share(k): 0..1 leaves on day k }. Where it never gets cold enough for
 * the trees to drop their leaves (or never warm enough), share is 1 (or 0).
 */
export function leafCalendar(tMean, { tC = LEAF_T_C, ramp = LEAF_RAMP_DAYS } = {}) {
  const warm = tMean.map((t) => t >= tC);
  if (warm.every(Boolean)) return { out: null, fall: null, share: () => 1, always: true };
  if (!warm.some(Boolean)) return { out: null, fall: null, share: () => 0, never: true };
  /* Spring: the first warm day after the coldest day; autumn: the first cold day after that. */
  let coldest = 0;
  for (let k = 1; k < 365; k++) if (tMean[k] < tMean[coldest]) coldest = k;
  let out = coldest;
  while (!warm[out % 365]) out++;
  let fall = out;
  while (warm[fall % 365]) fall++;
  out %= 365; fall %= 365;
  const since = (k, d) => (k - d + 365) % 365;
  const season = since(fall, out);
  const share = (k) => {
    const a = since(k, out);
    if (a > season + ramp) return 0; // winter
    if (a < ramp) return a / ramp; // leafing out
    if (a < season) return 1; // summer
    return Math.max(0, 1 - (a - season) / ramp); // dropping
  };
  return { out, fall, share };
}

/** Excess green pooled over the 3 x 3 columns, over crown columns only (kind 3); NaN where the photo has none. */
function pooledGreen(g, w, h, kind) {
  const out = new Float32Array(w * h).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (kind[k] !== 3) continue;
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const v = g[yy * w + xx];
      if (Number.isFinite(v)) { s += v; n++; }
    }
    if (n) out[k] = s / n;
  }
  return out;
}

/** The cut that best splits values into two groups (Otsu's method); null with too few. */
export function otsu(values, steps = 200) {
  if (values.length < 20) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) return null;
  let best = null, bestScore = -1;
  for (let i = 1; i < steps; i++) {
    const t = lo + ((hi - lo) * i) / steps;
    let na = 0, sa = 0, nb = 0, sb = 0;
    for (const v of values) { if (v < t) { na++; sa += v; } else { nb++; sb += v; } }
    if (!na || !nb) continue;
    const score = na * nb * (sa / na - sb / nb) ** 2;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/**
 * Excess green of a photo, per column of `grid`: the photo ({ data, width,
 * height } RGBA) covers the EPSG:3857 box `photoBox` [x0, y0, x1, y1].
 * NaN where the photo does not reach.
 */
export function greennessOn(grid, photo, photoBox) {
  const { w, h } = grid;
  const out = new Float32Array(w * h).fill(NaN);
  const W = photo.width, H = photo.height;
  const sx = W / (photoBox[2] - photoBox[0]), sy = H / (photoBox[3] - photoBox[1]);
  const r = Math.max(0.5, (grid.cell * sx) / 2);
  for (let y = 0; y < h; y++) {
    const Y = grid.y1 - (y + 0.5) * grid.cell;
    const py = (photoBox[3] - Y) * sy;
    for (let x = 0; x < w; x++) {
      const X = grid.x0 + (x + 0.5) * grid.cell;
      const px = (X - photoBox[0]) * sx;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      let sr = 0, sg = 0, sb = 0;
      for (let yy = Math.max(0, Math.floor(py - r)); yy < Math.min(H, Math.ceil(py + r)); yy++) {
        for (let xx = Math.max(0, Math.floor(px - r)); xx < Math.min(W, Math.ceil(px + r)); xx++) {
          const i = (yy * W + xx) * 4;
          sr += photo.data[i]; sg += photo.data[i + 1]; sb += photo.data[i + 2];
        }
      }
      const t = sr + sg + sb;
      if (t > 0) out[y * w + x] = (2 * sg - sr - sb) / t;
    }
  }
  return out;
}
