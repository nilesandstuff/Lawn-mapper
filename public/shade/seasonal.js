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
 *     mixed), by the share of LAST returns that got through the crown,
 *     pooled over the 5 x 5 m around it and cut at 0.79. MEASURED HERE, H73
 *     (290 labelled single trees over lawns): on leaf-off flights the median
 *     evergreen crown sends 64% of its last returns to the ground, the
 *     median broadleaf 94%; 75% right held out by map (+-5). The cut sits
 *     between them.
 *     "Got through" means BELOW 4 m over the ground, not only to it (core
 *     session's findings S36, 2026-10-11, on the owner's lot -- one lot,
 *     STILL SPECULATION): in his woods 18% of last returns stop in the
 *     0.5-4 m layer -- honeysuckle that keeps its leaves into late November,
 *     vines -- and counting only ground returns called 76% of the woods
 *     evergreen; counting below 4 m, 21%, in a band along the west edge
 *     where the owner says the evergreens are. Colour was tried and dropped:
 *     leaf-off is a spectrum, not a switch (owner; H69, H73: colour 61%).
 *     Only for leaf-off or mixed flights; a leaf-on flight already saw summer.
 *
 *  3. A CROWN IN LEAF (calibrated 2026-10-11 from a literature review; the
 *     owner: summer, late summer above all, is when this must be right).
 *     Extinction per metre of crown, mu = G x LAD_eff (Beer's law):
 *       G = 0.5      leaves at random angles (spherical)
 *       LAD_eff = 1  m2 of leaf per m3 of crown, EFFECTIVE (clumping within
 *                    the crown folded in): Nowak 1996 (Forest Sci 42:504)
 *                    open-grown urban crowns work out at 0.6-1.5
 *     and a crown's effective leaf area index (LAD x its depth) capped at
 *     LAI_MAX = 5.5: solitary crowns measured by fisheye (effective plant
 *     area, Sjoman et al. 2021, AUF 47:252) averaged 4.6, maples 5.0-5.7,
 *     red oak 4.6, linden 7.1; Nowak's equations 4.1-5.5. (Breda 2003's
 *     within-crown clumping, 0.88-0.95, is already inside "effective".) So deeper crowns are
 *     darker up to that cap -- Canham et al. 1994 (CJFR 24:337) found species
 *     differ in shade more by crown DEPTH than by extinction per metre, and
 *     a sun lower in the sky crosses more crown, which is all that makes
 *     late summer darker: leaf area is flat from about mid-June to October
 *     (Harvard Forest, Lee et al. 2023; Hutchison & Matt 1977).
 *     A full crown passes exp(-0.5 x 5.5) = 6.4% of the sun straight down and
 *     about 2% at 45 degrees -- Konarska et al. 2014 measured 1.3-5.3% of the
 *     direct beam under single foliated urban trees in total sunlight, about
 *     0.7-3% in PAR (PAR is absorbed more: x0.55, Baldocchi et al. 1984).
 *     CHECKED (2026-10-11), the median of the day's PAR on the floor of
 *     continuous forest at Yankee Springs MI (Barry 2016 lidar, NASA's
 *     typical diffuse share): 3.6% mid-July, 3.1% late August (the lower
 *     sun), 3.6% in June. In the owner's wooded strip, lit from the lawn
 *     side: 4.8% July, 4.5% August. Closed New England stands measured 2.4-6.2% over
 *     the growing season (Canham 1994), scattered light included, which this
 *     model leaves out (worth 14-41% of understory PAR, Canham) -- so it
 *     errs slightly dark, the safe side for a lawn. Leaf-off lidar under-reads
 *     crown cover by 19-24% (Wasser et al. 2013), so in leaf the crowns'
 *     footprint is closed: gaps up to ~4 m inside filled, edges 1 m wider.
 *     IN SUMMER EVERY CROWN IS AT LEAST THIS DENSE, evergreen or not
 *     (hemlock and pine stands are as dark or darker: Canham 1994), so the
 *     evergreen call cannot brighten a summer day: it only decides which
 *     trees are bare in winter and spring.
 *
 *  4. BARE, a deciduous crown is what the laser measured (0.5-0.7 of the sun
 *     straight down on the owner's lot; Konarska et al. 2014 measured
 *     40-52% of the direct beam under leafless urban trees). EVERGREENS
 *     keep their in-leaf density all year.
 *
 *  5. IN BETWEEN, leaf-out and leaf-fall are ESTIMATED from the place's
 *     typical temperature (climate.js): leaves come out over five weeks from
 *     the day the typical mean first passes 10 C in spring, and fall over
 *     four weeks centred on the day it drops back below 10 C. At Rockford MI
 *     that puts half-leaf at May 17 and half-fall at Oct 19, against Harvard
 *     Forest's (42.5 N) May 18-24 and Oct 16-24 (Lee et al. 2023). An
 *     estimate, said so on the page; a phenology dataset could replace it.
 */

import { cellOf } from './grid.js';
import { GRASS_M, solidAtGrass } from './canopy.js';

const NOISE = new Set([7, 18]);
export const CROWN_ABOVE_M = 2;
export const THROUGH_BELOW_M = 4; // a last return lower than this got through the crown (S36)
export const EVERGREEN_BELOW = 0.79;
export const G_OMEGA = 0.5; // G; within-crown clumping is inside the effective LAD and LAI
export const LAD = 1.0;
export const LAI_MAX = 5.5;
export const LEAF_T_C = 10;
export const LEAF_OUT_DAYS = 35;
export const LEAF_FALL_DAYS = 28;

/**
 * Classify the model's columns and build its leaf-on state.
 *
 * Returns { kind (Uint8 per column: 0 open, 1 roof, 2 evergreen, 3 deciduous),
 *           clumps: [{ n, penetration, base, top, depth, evergreenShare }],
 *           clumpOf, muOn (per cube), muOff, counts (columns of each kind) }.
 */
export function seasonalCanopy(cols, model, { shift = null, classify = true } = {}) {
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
      if (over < THROUGH_BELOW_M) lastGround[k]++;
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
  /* Eaves: a pulse that lands half on a roof edge and half on the ground
     splits like a tree's (the core's lidar-trees notes), so a ring of
     "crown" hugs every roof. A crown column next to a roof whose top is
     within 2 m of that roof's is the roof's edge. */
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (kind[k] !== 3) continue;
    for (let dy = -1; dy <= 1 && kind[k] === 3; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (kind[j] === 1 && Math.abs((zHi[j] - ground[j]) - (zHi[k] - ground[k])) <= 2) { kind[k] = 4; break; }
    }
  }
  for (let k = 0; k < N; k++) if (kind[k] === 4) kind[k] = 1;
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
  /* Evergreen per column, from its neighbourhood's share of last returns
     that got through. */
  let ever = 0;
  for (let k = 0; k < N; k++) {
    if (kind[k] !== 3 || !classify) continue;
    if (Number.isFinite(pen[k]) && pen[k] < EVERGREEN_BELOW) { kind[k] = 2; ever++; }
  }
  for (const c of clumps) c.evergreenShare = 0;
  for (let k = 0; k < N; k++) if (clumpOf[k] >= 0 && kind[k] === 2) clumps[clumpOf[k]].evergreenShare++;
  for (const c of clumps) c.evergreenShare /= c.n;

  /* The leaf-on state. Its footprint is the crown columns CLOSED: grown by
     2 m and shrunk back by 1, so gaps up to ~4 m inside the canopy fill and
     every edge reaches 1 m further. At 2-8 points a square metre many
     columns inside a leaf-off crown hold no return above 2 m, which would
     otherwise read as holes in the summer canopy (on the owner's lot the deep
     woods passed 10-12% of the day's light, against 2.4-6.2% measured under
     closed canopies); canopy-height-model closure is what Parent & Volin 2014
     found tracks leaf-on closure. Buildings stay buildings. A filled column
     takes the tallest crown neighbour's clump and height over its ground. */
  const isCrown = (j) => kind[j] === 2 || kind[j] === 3;
  const grown = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = 0;
    for (let dy = -2; dy <= 2 && !hit; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && isCrown(yy * w + xx)) { hit = 1; break; }
    }
    grown[y * w + x] = hit;
  }
  const footprint = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let all = 1;
    for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && !grown[yy * w + xx]) { all = 0; break; }
    }
    const k = y * w + x;
    footprint[k] = (all || isCrown(k)) && kind[k] !== 1 ? 1 : 0;
  }
  const muOn = Float32Array.from(mu);
  /* Crown top per column: the tallest crown return within 2 m (a pit-free
     canopy height model). One column at 2-8 points a square metre holds a
     return or two, mostly below its crown's real top, which would make the
     crown look shallow and hold too little leaf; leaf-off canopy height
     models read low anyway (Wasser et al. 2013). */
  const hOver = new Float32Array(N).fill(NaN);
  for (let k = 0; k < N; k++) if (isCrown(k)) hOver[k] = zHi[k] - ground[k];
  const crownOf = new Int32Array(N).fill(-1), topOf = new Float32Array(N).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (!isCrown(k)) continue;
    let tall = hOver[k];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (clumpOf[j] === clumpOf[k] && hOver[j] > tall) tall = hOver[j];
    }
    crownOf[k] = clumpOf[k];
    topOf[k] = ground[k] + tall;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (!footprint[k] || crownOf[k] >= 0) continue;
    let best = -1;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (isCrown(j) && (best < 0 || zHi[j] - ground[j] > zHi[best] - ground[best])) best = j;
    }
    if (best >= 0) { crownOf[k] = clumpOf[best]; topOf[k] = ground[k] + (topOf[best] - ground[best]); }
  }
  let leafy = 0;
  for (let k = 0; k < N; k++) {
    if (crownOf[k] < 0) continue;
    leafy++;
    const c = clumps[crownOf[k]];
    const lo = ground[k] + c.base, hi = Math.min(topOf[k], ground[k] + c.top);
    const depth = Math.max(dz, hi - lo);
    /* The cubes whose middles lie in [lo, hi] (at least the nearest one),
       sharing the column's leaf area exactly: tau straight down is
       G Omega x min(LAD x depth, LAI_MAX), however the cubes fall. */
    let l0 = Math.ceil((lo - z0) / dz - 0.5), l1 = Math.floor((hi - z0) / dz - 0.5);
    if (l1 < l0) l0 = l1 = Math.max(0, Math.min(nz - 1, Math.round((lo + hi) / 2 / dz - z0 / dz - 0.5)));
    l0 = Math.max(0, l0); l1 = Math.min(nz - 1, l1);
    const cubes = l1 - l0 + 1;
    if (cubes <= 0) continue;
    const muLeaf = (G_OMEGA * Math.min(LAD * depth, LAI_MAX)) / (cubes * dz);
    for (let l = l0; l <= l1; l++) {
      const i = k * nz + l;
      if (muLeaf > muOn[i]) muOn[i] = muLeaf;
    }
  }
  /* Evergreens are in leaf all year: their bare state is their leafy one. */
  const muOffSeason = Float32Array.from(mu);
  for (let k = 0; k < N; k++) {
    if (kind[k] !== 2) continue;
    for (let l = 0; l < nz; l++) muOffSeason[k * nz + l] = muOn[k * nz + l];
  }
  const counts = { roof: 0, evergreen: ever, deciduous: 0 };
  for (let k = 0; k < N; k++) { if (kind[k] === 1) counts.roof++; else if (kind[k] === 3) counts.deciduous++; }
  return { kind, clumps, clumpOf, muOn, muOff: muOffSeason, muMeasured: mu, counts, classified: classify, leafyColumns: leafy };
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
export function leafCalendar(tMean, { tC = LEAF_T_C, up = LEAF_OUT_DAYS, down = LEAF_FALL_DAYS } = {}) {
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
  const dropFrom = since(fall, out) - down / 2; // leaves start falling half the ramp before the crossing
  const share = (k) => {
    const a = since(k, out);
    if (a < up) return Math.min(1, a / up); // leafing out
    if (a < dropFrom) return 1; // summer
    return Math.max(0, 1 - (a - dropFrom) / down); // falling, then bare
  };
  return { out, fall, full: (out + up) % 365, bare: (out + Math.ceil(dropFrom + down)) % 365, halfOut: (out + Math.round(up / 2)) % 365, halfFall: fall, share };
}
