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
 * 1b. A TREE NOTHING GOT THROUGH (a dense spruce) is as solid as a roof and
 *     stays solid in the light, but is labelled an evergreen, not a
 *     building, when a quarter or more of its returns came from pulses that
 *     split (on needles, almost never on a roof), or when it is under 60 m2
 *     with a rough top (a roof is planes). The crown around it, out to 3 m
 *     while its top keeps falling away and as dense as an evergreen must
 *     measure (2b), is the same tree, so it gets no summer leaves either.
 *     The light hardly moves (the mean summer beam reaching the ground
 *     changed by 0.002 or less on three lots); the labels do: at 7300
 *     Brooks Ln the lawn spruces had all been "buildings".
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

 2b. AND DENSE. A leaf-off flight caught an evergreen WITH its needles, so
     it must have stopped far more of the laser than a bare deciduous crown
     -- conifer foliage holds several times the area of a leafless crown's
     wood (Breda 2003, J Exp Bot 54:2403: conifer LAI 3-8 or more; bare
     broadleaf woody area 0.5-1.5). A column the penetration rule calls
     evergreen stays one only if its crown's optical depth above 4 m (5 x 5
     m pooled) is at least twice the median of the crowns that rule calls
     bare on the same flight -- relative, so point density and the flight's
     settings cancel. On the owner's lot (2026-10-11) the penetration rule
     alone called 18% of crown columns evergreen, scattered through his
     deciduous woods and fringing other crowns; those calls passed 42% of
     the overhead sun as measured (median), against 52% for the bare
     crowns -- leafless by the laser's own reading. With the density check,
     4-5%: compact round crowns, the shape of yard spruces. Over 300 m of
     his woods that moved the July median on the forest floor from 5.8% to
     4.8% of the day's light (p90 14% to 12%); Yankee Springs, 4.1%. The two errors
     are not equal, which is why the check leans one way: a deciduous crown
     called evergreen gets no summer leaves and passes ~45% of the summer
     sun overhead instead of ~6%; an evergreen called deciduous gets leaves
     over its needles and goes from dark to a bit darker. Under 100 bare
     columns on the flight there is no reference and the check is skipped.
 *
 * 2c. NOT A DOME (owner's suggestion, 2026-10-11): a crown at least 4 m in
 *     radius whose top falls less than 1.1 m from its highest return to the
 *     highest return 2.5-3.5 m out is an open-grown broadleaf, whatever 2
 *     said -- a big oak can still hold its dead leaves on a late-November
 *     flight and stop the laser like needles. On one street (Kent 2016 cloud,
 *     labelled by eye on the leaf-off and August 2022 NAIP photos): six lawn
 *     spruces fell 1.4-3.9 m, seven oaks and maples 0.1-0.8 m; two of those
 *     big domes had been called evergreen, which the owner caught. A steep
 *     top does NOT rule one in: broadleaf trees crowded in a wood are pointed
 *     too. STILL ONE STREET (crowns.js).
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
 *     footprint is closed: gaps up to ~4 m inside filled. Its edges stay
 *     where the laser saw them: grown 1 m, the August 2022 NAIP photo's
 *     shadows on the owner's lawn were 32% against the model's 37% (29%
 *     without), and leaves lay over open lawn (2026-10-11).
 *     ONLY DECIDUOUS CROWNS GET LEAVES (owner, 2026-10-11): the leaf-off
 *     flight already measured every crown as it stands in the leaf-off
 *     months, evergreens included, and an evergreen in summer is what the
 *     flight saw. So the evergreen call matters from leaf-out to leaf-fall
 *     and nowhere else: a deciduous crown wrongly called evergreen stays as
 *     bare as the winter laser saw it all summer (too bright), and an
 *     evergreen wrongly called deciduous gets leaves on top of its needles
 *     (a little too dark).
 *
 *  4. IN THE LEAF-OFF MONTHS EVERY CROWN IS WHAT THE LASER MEASURED: a bare
 *     deciduous crown passed 0.5-0.7 of the sun straight down on the owner's
 *     lot (Konarska et al. 2014 measured 40-52% of the direct beam under
 *     leafless urban trees), and an evergreen is as dense as the laser found
 *     it, in every season.
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
import { crownsOf } from './crowns.js';

const NOISE = new Set([7, 18]);
export const CROWN_ABOVE_M = 2;
export const THROUGH_BELOW_M = 4; // a last return lower than this got through the crown (S36)
export const EVERGREEN_BELOW = 0.79;
export const EVERGREEN_DENSER = 2; // and at least this many times as dense as the bare crowns (2b)
export const SOLID_TREE_SPLIT = 0.25; // a solid patch this split is a tree, not a roof (1b)
export const SOLID_TREE_MAX_M2 = 60; // or one smaller than this
export const SOLID_TREE_ROUGH_M = 0.55; // whose neighbouring tops differ by this much (median)
export const SOLID_TREE_RIM_M = 3; // its crown reaches this far past the part nothing got through
export const DOME_RING_M = [2.5, 3.5]; // how far out from a crown's highest return its top is read (2c)
export const DOME_DROP_M = 1.1; // a crown whose top falls less than this there is a dome
export const DOME_MIN_R_M = 4; // and only a crown this wide (equivalent radius) is judged
export const BARE_MIN = 100; // bare crown columns needed to say what bare is here
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
  const above = new Uint16Array(N), multiAbove = new Uint16Array(N), lastAll = new Float32Array(N), lastGround = new Float32Array(N);
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
      if ((cols.nret[i] || 1) > 1) multiAbove[k]++;
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
  /* A tree nothing got through (a dense spruce) is solid like a roof, and
     stays so in the light, but it is not a building. Per patch of solid
     columns it is a tree when a quarter or more of the returns above 2 m
     came from pulses that split (on needles and branches; almost never on
     a roof), or when the patch is small and its top is rough -- a roof is
     planes, so neighbouring columns' tops differ little. Since it was that
     dense with the leaves off, it is an evergreen. (Kent 2016 cloud, 7300
     Brooks Ln, checked against the photo, 2026-10-11: houses 200-311 m2,
     2-3% split, tops differing a median 0.36-0.44 m between neighbours;
     the lawn spruces 6-42 m2, 0-38% split, 0.55-1.5 m.) */
  const seen = new Uint8Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (kind[s0] !== 1 || seen[s0]) continue;
    const patch = [s0];
    seen[s0] = 1;
    let a = 0, m = 0;
    const steps = [];
    for (let q = 0; q < patch.length; q++) {
      const k = patch[q], x = k % w, y = (k / w) | 0;
      a += above[k]; m += multiAbove[k];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (kind[j] !== 1) continue;
        if (dx + dy > 0 && above[k] && above[j]) steps.push(Math.abs(zHi[k] - zHi[j]));
        if (!seen[j]) { seen[j] = 1; patch.push(j); }
      }
    }
    steps.sort((p1, p2) => p1 - p2);
    const rough = steps.length ? steps[steps.length >> 1] : 0;
    const tree = (a > 0 && m / a >= SOLID_TREE_SPLIT) || (patch.length < SOLID_TREE_MAX_M2 && rough >= SOLID_TREE_ROUGH_M);
    if (classify && tree) for (const k of patch) kind[k] = 5;
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
  const solidTree = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (kind[k] === 5) { kind[k] = 2; solidTree[k] = 1; }
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
     that got through -- and, since it decides the summer (see 2), only
     where the crown also measured DENSE: its optical depth above 4 m,
     pooled over the 5 x 5 m of crown around it, at least EVERGREEN_DENSER
     times the median of the crowns penetration calls bare on this flight. */
  let ever = 0, domed = 0;
  for (let k = 0; k < N; k++) if (kind[k] === 2) ever++;
  if (classify) {
    const od = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      if (kind[k] !== 3) continue;
      for (let l = 0; l < nz; l++) if (z0 + (l + 0.5) * dz > ground[k] + THROUGH_BELOW_M) od[k] += mu[k * nz + l] * dz;
    }
    /* The reference leaves out what lies around a solid tree (1b): a
       spruce's skirt reads "through" by the 4 m line, and a lawn of spruces
       would otherwise raise the bar their own rims are measured against. */
    const nearSolid = new Uint8Array(N), R = SOLID_TREE_RIM_M;
    for (let k = 0; k < N; k++) {
      if (!solidTree[k]) continue;
      const x = k % w, y = (k / w) | 0;
      for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) nearSolid[yy * w + xx] = 1;
    }
    const bare = [], dense = new Float32Array(N).fill(NaN);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (kind[k] !== 3) continue;
      let a = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || kind[yy * w + xx] !== 3) continue;
        a += od[yy * w + xx]; n++;
      }
      dense[k] = a / n;
      if (!(pen[k] < EVERGREEN_BELOW) && !nearSolid[k]) bare.push(dense[k]);
    }
    bare.sort((a, b) => a - b);
    const ref = bare.length >= BARE_MIN ? bare[bare.length >> 1] : 0;
    for (let k = 0; k < N; k++) {
      if (kind[k] !== 3 || !(pen[k] < EVERGREEN_BELOW)) continue;
      if (dense[k] >= EVERGREEN_DENSER * ref) { kind[k] = 2; ever++; }
    }
    /* The rest of a solid tree's crown (1b): only its densest middle stopped
       everything, and a spruce's skirt reaches the ground, where the 4 m
       line would count a return as through. So the crown columns around a
       solid tree, out to SOLID_TREE_RIM_M, belong to it while their tops
       keep falling away from it (a cone; a neighbouring crown rises again)
       AND they measured as dense as an evergreen must (above) -- without
       that, every vine tangle in a deciduous wood grew a bare rim. */
    const rimFrom = [], rimDist = new Uint8Array(N), rimSeen = Uint8Array.from(solidTree);
    for (let k = 0; k < N; k++) if (solidTree[k]) rimFrom.push(k);
    for (let q = 0; q < rimFrom.length; q++) {
      const k = rimFrom[q], x = k % w, y = (k / w) | 0;
      if (rimDist[k] >= SOLID_TREE_RIM_M) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (rimSeen[j] || zHi[j] - ground[j] > zHi[k] - ground[k] + 1) continue;
        if (kind[j] === 3 && dense[j] >= EVERGREEN_DENSER * ref) { kind[j] = 2; ever++; } else if (kind[j] !== 2) continue;
        rimSeen[j] = 1; rimDist[j] = rimDist[k] + 1; rimFrom.push(j);
      }
    }
    /* 2c. NOT A DOME. Whatever called it evergreen, a broad crown whose top
       stays flat for metres is an open-grown broadleaf (crowns.js). */
    const top = new Float32Array(N).fill(NaN);
    for (let k = 0; k < N; k++) if (above[k]) top[k] = zHi[k] - ground[k];
    const { lab, crowns } = crownsOf(cols, model, { shift, top, dropAt: DOME_RING_M });
    const dome = crowns.map((c) => c.R >= DOME_MIN_R_M && c.drop < DOME_DROP_M);
    for (let k = 0; k < N; k++) if (kind[k] === 2 && lab[k] >= 0 && dome[lab[k]]) { kind[k] = 3; ever--; domed++; }
  }
  for (const c of clumps) c.evergreenShare = 0;
  for (let k = 0; k < N; k++) if (clumpOf[k] >= 0 && kind[k] === 2) clumps[clumpOf[k]].evergreenShare++;
  for (const c of clumps) c.evergreenShare /= c.n;

  /* The leaf-on state. Its footprint is the crown columns CLOSED: grown by
     2 m and shrunk back by 2, so gaps up to ~4 m inside the canopy fill and
     the edges stay where the laser found them. At 2-8 points a square metre many
     columns inside a leaf-off crown hold no return above 2 m, which would
     otherwise read as holes in the summer canopy (on the owner's lot the deep
     woods passed 10-12% of the day's light, against 2.4-6.2% measured under
     closed canopies); canopy-height-model closure is what Parent & Volin 2014
     found tracks leaf-on closure. The edges were grown 1 m as well until
     2026-10-11, for Wasser et al.'s under-read cover; held against the
     shadows in the August 2022 NAIP photo of the owner's lot that put 37%
     of the grass in shade where the photo has 32%, and on the owner's
     neighbour's lawn it laid summer leaves over open grass the owner can see
     from above. Edges where the laser saw them: 29% against 32%; the deep
     woods 4.8% (owner's) and 4.4% (Yankee Springs), still within Canham's
     2.4-6.2%. Buildings stay buildings. A filled column
     takes the tallest crown neighbour's clump and height over its ground. */
  /* Only deciduous crowns take leaves (see 3), so only they are grown,
     filled and given leaf; evergreens and buildings stay as measured. */
  const isCrown = (j) => kind[j] === 3;
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
    for (let dy = -2; dy <= 2 && all; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && !grown[yy * w + xx]) { all = 0; break; }
    }
    const k = y * w + x;
    footprint[k] = (all || isCrown(k)) && kind[k] !== 1 && kind[k] !== 2 ? 1 : 0;
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
  const counts = { roof: 0, evergreen: ever, deciduous: 0, domed };
  for (let k = 0; k < N; k++) { if (kind[k] === 1) counts.roof++; else if (kind[k] === 3) counts.deciduous++; }
  return { kind, clumps, clumpOf, muOn, muOff: mu, counts, classified: classify, leafyColumns: leafy };
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
