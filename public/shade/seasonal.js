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
 *     joined into clumps (8-neighbor). A ROOF column -- three returns or
 *     more, all within 1.5 m of each other, and no last return reaching the
 *     ground -- is a building and stays solid (canopy.js), as H38's roof
 *     rule has it.
 *
 * 1b. A TREE NOTHING GOT THROUGH (a dense spruce) is as solid as a roof and
 *     stays solid in the light, but is labelled an evergreen, not a
 *     building, when a quarter or more of its returns came from pulses that
 *     split (on needles, almost never on a roof), or when it is under 60 m2
 *     with a rough top (a roof is planes), or a speck under 4 m2 (a column
 *     of a dense crown no pulse happened to get under); 2 then decides its tree as a
 *     whole. The light hardly moves (the mean summer beam reaching the ground
 *     changed by 0.002 or less on three lots); the labels do: at 7300
 *     Brooks Ln the lawn spruces had all been "buildings".
 *
 *  2. EVERGREEN OR NOT, PER TREE, BY HOW DENSE IT WAS IN WINTER (owner,
 *     2026-10-12: if little of the laser got through a crown with the leaves
 *     off, it needs no summer leaves). Crowns are segmented from the canopy
 *     top (crowns.js); a crown is evergreen when the median of its columns'
 *     overhead transmittance on the leaf-off flight is under 0.2, and it is
 *     not a dome (2c). Everything else is deciduous and takes leaves.
 *     MEASURED on H73's hand-labelled crowns on leaf-off flights (data/
 *     labelled-crowns.csv; 34 evergreen, 143 broadleaf): evergreens passed
 *     a median 17% of the overhead sun in winter, 8% with leaves added;
 *     broadleaf 54% bare, 6% in leaf. So the two errors are not alike: an
 *     evergreen given leaves goes about twice too dark, a broadleaf left
 *     bare about nine times too bright. Scored by how far each crown's
 *     summer light lands from the truth, this rule is off by 0.023 on
 *     average, as good as giving every crown leaves (0.023) or the earlier
 *     rule (0.020), and it keeps 17 of the 34 evergreens as measured
 *     against 9, leaving 3 of 143 broadleaf bare. H73's own classifier
 *     (pulses reaching the ground, cut 0.79) is the better CLASSIFIER, 29 of
 *     34 and 99 of 143 here, but the worse light (0.078): its 44 broadleaf
 *     called evergreen are each nine times too bright. Replaced (2026-10-12):
 *     that classifier with a "below 4 m counts as through" line (from the
 *     owner's honeysuckle woods; it cost lawn trees, 15 of 34), a density
 *     check against the flight's bare crowns, and a rim grown out from solid
 *     trees. Color was tried and dropped long ago: leaf-off is a spectrum,
 *     not a switch (owner; H69, H73: color 61%). Only for leaf-off or mixed
 *     flights; a leaf-on flight already saw summer.
 *
 * 2c. NOT A DOME (owner's suggestion, 2026-10-11): a crown at least 4 m in
 *     radius whose top falls less than 0.7 m from its highest return to the
 *     highest return 2.5-3.5 m out is an open-grown broadleaf, however dense
 *     it was in winter -- a big oak can still hold its dead leaves on a late-November
 *     flight and stop the laser like needles; the owner caught two such
 *     domes called evergreen on Brooks Ln. MEASURED on H73's hand-labelled
 *     crowns (data/labelled-crowns.csv, 234 found in the lidar on 60 maps:
 *     41 evergreen, 193 broadleaf; noisy labels, evergreens under-
 *     represented): the drop ranks an evergreen above a broadleaf 70% of the
 *     time; medians 1.23 m against about 0.5. This cut rules out 59% of the
 *     broadleaf crowns and wrongly 22% of the evergreens (9 of 41, the same
 *     9 as at 0.4 m; at 1.1 m, the first street's cut, it was 32% for 73%).
 *     An evergreen ruled out only gets summer leaves (a little too dark); a
 *     broadleaf left evergreen gets none (much too bright). A steep top does
 *     NOT rule one in: broadleaf trees crowded in a wood are pointed too.
 *
 *  3. A CROWN IN LEAF (calibrated 2026-10-11 from a literature review; the
 *     owner: summer, late summer above all, is when this must be right).
 *     Extinction per meter of crown, mu = G x LAD_eff (Beer's law):
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
 *     differ in shade more by crown DEPTH than by extinction per meter, and
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
 *     typical temperature (climate.js), in LIGHT -- what the map draws:
 *       spring: the canopy greens the day the typical mean passes 14.5 C (or
 *         7.5 C under the summer's warmest, where summers are cool), and the
 *         shade follows 12 days later, half the leaves' shade on that day,
 *         over five weeks;
 *       fall: half the shade gone two weeks before the day the typical mean
 *         drops back below 10 C, over four weeks.
 *     MEASURED (2026-10-13; tools/shade-check-neon.js, PhenoCam):
 *       - the spring rule's shape was fitted on PhenoCam's cameras over 119
 *         deciduous sites across the US (green-up predicted for each site
 *         from the others: off by 7.2 days, against 10.7 for the old rule,
 *         10 C plus 17 days); the 12 days from green to shade on NEON's
 *         ground light sensors under eleven deciduous forests. Each NEON
 *         year predicted with the other year's lag: off by 9-10 days,
 *         against 15-17 for the old rule, which put the shade 2-6 weeks
 *         early in the South and on time in the North.
 *       - fall: the old date (10 C) was 13-16 days late at NEON in both
 *         2022 and 2023, and PhenoCam's green fades three weeks before it;
 *         the light comes back as the leaves turn, before they drop. Two
 *         weeks earlier: off by 11-13 days, no lean. A fitted fall shape did
 *         no better at NEON, so the simple shift stands.
 *     KNOWN WEAK: the Pacific Northwest (one PhenoCam site there): Portland's
 *     leaves come out in early June here, April in life. The old rule had it
 *     mid-May, also late.
 */

import { cellOf } from './grid.js';
import { GRASS_M, solidAtGrass } from './canopy.js';
import { crownsOf } from './crowns.js';

const NOISE = new Set([7, 18]);
export const CROWN_ABOVE_M = 2;
export const SOLID_TREE_SPLIT = 0.25; // a solid patch this split is a tree, not a roof (1b)
export const SOLID_TREE_MAX_M2 = 60; // or one smaller than this
export const SOLID_SPECK_M2 = 4; // a solid patch smaller than this is always part of a tree
export const SOLID_TREE_ROUGH_M = 0.55; // whose neighboring tops differ by this much (median)
export const WINTER_DENSE_T = 0.2; // a crown passing less of the overhead sun than this in winter is evergreen (2)
export const DOME_RING_M = [2.5, 3.5]; // how far out from a crown's highest return its top is read (2c)
export const DOME_DROP_M = 0.7; // a crown whose top falls less than this there is a dome (H73's crowns)
export const DOME_MIN_R_M = 4; // and only a crown this wide (equivalent radius) is judged
export const G_OMEGA = 0.5; // G; within-crown clumping is inside the effective LAD and LAI
export const LAD = 1.0;
export const LAI_MAX = 5.5;
export const LEAF_T_C = 10; // fall: half the shade gone LEAF_FALL_LEAD_DAYS before the typical mean drops below this (5)
export const LEAF_FALL_LEAD_DAYS = 14;
export const GREEN_T_C = 14.5; // spring: the canopy greens when the typical mean passes this (PhenoCam, 5)
export const GREEN_CAP_C = 7.5; // or this far under the summer's warmest, if lower
export const SHADE_LAG_DAYS = 12; // and its shade is half there this many days later (NEON, 5)
export const LEAF_OUT_DAYS = 35;
export const LEAF_FALL_DAYS = 28;

/**
 * Classify the model's columns and build its leaf-on state.
 *
 * Returns { kind (Uint8 per column: 0 open, 1 roof, 2 evergreen, 3 deciduous),
 *           clumps: [{ n, base, top, depth, evergreenShare }],
 *           clumpOf, muOn (per cube), muOff, counts (columns of each kind) }.
 */
export function seasonalCanopy(cols, model, { shift = null, classify = true, fill = {} } = {}) {
  /* How the summer leaves are filled in (tools/shade-check-leafon.js scores
     the choices against NEON's leaf-on lidar). Defaults: as shipped. */
  const { closeR = 2, taperM = 0, spread = 'even', topR = 2, ladScale = 1, baseFrom = 'clump', laiMax = LAI_MAX, edgeTopM = 0, lawnClumpM2 = 0 } = fill;
  const { grid, w, h, nz, dz, z0, ground, mu } = model;
  const N = w * h;
  const above = new Uint16Array(N), multiAbove = new Uint16Array(N), lastGround = new Uint16Array(N);
  const heights = []; // [column, height over ground] of every crown return, for clump depths
  const zLo = new Float32Array(N).fill(Infinity), zHi = new Float32Array(N).fill(-Infinity);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    const over = cols.z[i] - ground[k];
    if ((cols.ret[i] || 1) >= (cols.nret[i] || 1) && over < GRASS_M) lastGround[k]++; // a pulse that reached the ground
    if (over > CROWN_ABOVE_M && over < 80) {
      above[k]++;
      if ((cols.nret[i] || 1) > 1) multiAbove[k]++;
      heights.push(k, over);
      if (cols.z[i] < zLo[k]) zLo[k] = cols.z[i];
      if (cols.z[i] > zHi[k]) zHi[k] = cols.z[i];
    }
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
     planes, so neighboring columns' tops differ little. Since it was that
     dense with the leaves off, it is an evergreen. (Kent 2016 cloud, 7300
     Brooks Ln, checked against the photo, 2026-10-11: houses 200-311 m2,
     2-3% split, tops differing a median 0.36-0.44 m between neighbors;
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
    /* And a speck under 4 m2 is no building: a column or two of a dense crown
       where, by chance, no pulse reached the ground. */
    const tree = (a > 0 && m / a >= SOLID_TREE_SPLIT) || patch.length < SOLID_SPECK_M2 || (patch.length < SOLID_TREE_MAX_M2 && rough >= SOLID_TREE_ROUGH_M);
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
  for (let k = 0; k < N; k++) if (kind[k] === 5) kind[k] = 2;
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
    clumps.push({ n: members.length, hs: [] });
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
  /* 2. Evergreen or not, per tree: dense in winter and not a dome (2c). The
     tree decides for all its columns, a solid core (1b) included. */
  let ever = 0, domed = 0;
  if (classify) {
    const top = new Float32Array(N).fill(NaN);
    for (let k = 0; k < N; k++) if (above[k] && kind[k] !== 1) top[k] = zHi[k] - ground[k];
    const { lab, crowns } = crownsOf(cols, model, { shift, top, dropAt: DOME_RING_M });
    const ts = crowns.map(() => []);
    for (let k = 0; k < N; k++) {
      if (lab[k] < 0 || (kind[k] !== 2 && kind[k] !== 3)) continue;
      let tau = 0;
      const g = ground[k] + 0.1;
      for (let l = 0; l < nz; l++) if (z0 + (l + 0.5) * dz > g) tau += mu[k * nz + l] * dz;
      ts[lab[k]].push(Math.exp(-tau));
    }
    const call = crowns.map((c, id) => {
      const t = ts[id].sort((a, b) => a - b);
      if (!t.length || !(t[t.length >> 1] < WINTER_DENSE_T)) return 3;
      if (c.R >= DOME_MIN_R_M && c.drop < DOME_DROP_M) { domed += t.length; return 3; }
      return 2;
    });
    for (let k = 0; k < N; k++) if ((kind[k] === 2 || kind[k] === 3) && lab[k] >= 0) kind[k] = call[lab[k]];
  }
  for (let k = 0; k < N; k++) if (kind[k] === 2) ever++;
  for (const c of clumps) c.evergreenShare = 0;
  for (let k = 0; k < N; k++) if (clumpOf[k] >= 0 && kind[k] === 2) clumps[clumpOf[k]].evergreenShare++;
  for (const c of clumps) c.evergreenShare /= c.n;

  /* The leaf-on state. Its footprint is the crown columns CLOSED: grown by
     2 m and shrunk back by 2, so gaps up to ~4 m inside the canopy fill and
     the edges stay where the laser found them. At 2-8 points a square meter many
     columns inside a leaf-off crown hold no return above 2 m, which would
     otherwise read as holes in the summer canopy (on the owner's lot the deep
     woods passed 10-12% of the day's light, against 2.4-6.2% measured under
     closed canopies); canopy-height-model closure is what Parent & Volin 2014
     found tracks leaf-on closure. The edges were grown 1 m as well until
     2026-10-11, for Wasser et al.'s under-read cover; held against the
     shadows in the August 2022 NAIP photo of the owner's lot that put 37%
     of the grass in shade where the photo has 32%, and on the owner's
     neighbor's lawn it laid summer leaves over open grass the owner can see
     from above. Edges where the laser saw them: 29% against 32%; the deep
     woods 4.8% (owner's) and 4.4% (Yankee Springs), still within Canham's
     2.4-6.2%. Buildings stay buildings. A filled column
     takes the tallest crown neighbor's clump and height over its ground. */
  /* Only deciduous crowns take leaves (see 3), so only they are grown,
     filled and given leaf; evergreens and buildings stay as measured. */
  const isCrown = (j) => kind[j] === 3;
  const grown = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = 0;
    for (let dy = -closeR; dy <= closeR && !hit; dy++) for (let dx = -closeR; dx <= closeR; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && isCrown(yy * w + xx)) { hit = 1; break; }
    }
    grown[y * w + x] = hit;
  }
  const footprint = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let all = 1;
    for (let dy = -closeR; dy <= closeR && all; dy++) for (let dx = -closeR; dx <= closeR; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && !grown[yy * w + xx]) { all = 0; break; }
    }
    const k = y * w + x;
    footprint[k] = (all || isCrown(k)) && kind[k] !== 1 && kind[k] !== 2 ? 1 : 0;
  }
  const muOn = Float32Array.from(mu);
  /* Crown top per column: the tallest crown return within 2 m (a pit-free
     canopy height model). One column at 2-8 points a square meter holds a
     return or two, mostly below its crown's real top, which would make the
     crown look shallow and hold too little leaf; leaf-off canopy height
     models read low anyway (Wasser et al. 2013). */
  const hOver = new Float32Array(N).fill(NaN);
  for (let k = 0; k < N; k++) if (isCrown(k)) hOver[k] = zHi[k] - ground[k];
  const crownOf = new Int32Array(N).fill(-1), topOf = new Float32Array(N).fill(NaN);
  /* edgeTopM: within this many meters of the footprint's edge a column keeps
     its own top (a crown's shoulder is lower than its middle); inside, the
     tallest within topR. */
  let shoulder = null;
  if (edgeTopM > 0) {
    shoulder = new Float32Array(N).fill(99);
    const q = [];
    for (let k = 0; k < N; k++) if (!footprint[k] && !isCrown(k)) { shoulder[k] = 0; q.push(k); }
    for (let i = 0; i < q.length; i++) {
      const k = q[i], x = k % w, y = (k / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy, j = yy * w + xx;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && shoulder[j] > shoulder[k] + 1) { shoulder[j] = shoulder[k] + 1; q.push(j); }
      }
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (!isCrown(k)) continue;
    let tall = hOver[k];
    /* LAWN TREES (owner, 2026-10-14: "forest canopies behave differently
       from lawn canopies ... we care much more about lawn trees"): a crown
       in a clump smaller than lawnClumpM2 keeps its own top and is not
       widened by the closing; the closing and the tallest-neighbour top are
       for closed canopy, where NEON's ground sensors need them. */
    const lawnLike = lawnClumpM2 > 0 && clumpOf[k] >= 0 && clumps[clumpOf[k]].n < lawnClumpM2;
    const r = lawnLike || (shoulder && shoulder[k] <= edgeTopM) ? 0 : topR;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
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
    if (best >= 0 && lawnClumpM2 > 0 && clumpOf[best] >= 0 && clumps[clumpOf[best]].n < lawnClumpM2) continue; // a lawn tree is not widened
    if (best >= 0) { crownOf[k] = clumpOf[best]; topOf[k] = ground[k] + (topOf[best] - ground[best]); }
  }
  /* Distance (m) to the footprint's edge, for a crown thinning toward it. */
  let edgeD = null;
  if (taperM > 0) {
    edgeD = new Float32Array(N).fill(99);
    const q = [];
    for (let k = 0; k < N; k++) if (crownOf[k] < 0) { edgeD[k] = 0; q.push(k); }
    for (let i = 0; i < q.length; i++) {
      const k = q[i], x = k % w, y = (k / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy, j = yy * w + xx;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && edgeD[j] > edgeD[k] + 1) { edgeD[j] = edgeD[k] + 1; q.push(j); }
      }
    }
  }
  /* Leaf-off crown returns per cube, for leaves where the branches are, and
     each column's lowest one (both over the 5 x 5 around it). */
  let branch = null, lowBranch = null;
  if (spread === 'branches' || baseFrom === 'column') {
    const own = new Float32Array(N * nz), low = new Float32Array(N).fill(Infinity);
    for (let i = 0; i < cols.n; i++) {
      if (NOISE.has(cols.cls[i])) continue;
      const k = cellOf(grid, cols.x[i], cols.y[i], shift);
      if (k < 0) continue;
      const over = cols.z[i] - ground[k];
      if (over <= CROWN_ABOVE_M || over >= 80) continue;
      own[k * nz + Math.min(nz - 1, Math.max(0, Math.floor((cols.z[i] - z0) / dz)))]++;
      if (over < low[k]) low[k] = over;
    }
    branch = own; lowBranch = low;
  }
  const near = (k, f) => {
    const x = k % w, y = (k / w) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) f(yy * w + xx);
    }
  };
  let leafy = 0;
  for (let k = 0; k < N; k++) {
    if (crownOf[k] < 0) continue;
    leafy++;
    const c = clumps[crownOf[k]];
    let baseH = c.base;
    if (baseFrom === 'column') {
      let m = Infinity;
      near(k, (j) => { if (lowBranch[j] < m) m = lowBranch[j]; });
      if (Number.isFinite(m)) baseH = Math.max(CROWN_ABOVE_M, m);
    }
    const lo = ground[k] + baseH, hi = Math.min(topOf[k], ground[k] + c.top);
    const depth = Math.max(dz, hi - lo);
    /* The cubes whose middles lie in [lo, hi] (at least the nearest one),
       sharing the column's leaf area exactly: tau straight down is
       G Omega x min(LAD x depth, LAI_MAX), however the cubes fall. */
    let l0 = Math.ceil((lo - z0) / dz - 0.5), l1 = Math.floor((hi - z0) / dz - 0.5);
    if (l1 < l0) l0 = l1 = Math.max(0, Math.min(nz - 1, Math.round((lo + hi) / 2 / dz - z0 / dz - 0.5)));
    l0 = Math.max(0, l0); l1 = Math.min(nz - 1, l1);
    const cubes = l1 - l0 + 1;
    if (cubes <= 0) continue;
    const taper = edgeD ? Math.min(1, (edgeD[k] - 0.5) / taperM) : 1;
    const tau = G_OMEGA * Math.min(LAD * ladScale * depth, laiMax) * Math.max(0, taper);
    let wts = null;
    if (spread === 'branches') {
      wts = new Float32Array(cubes);
      let sum = 0;
      near(k, (j) => { for (let l = l0; l <= l1; l++) { wts[l - l0] += branch[j * nz + l]; } });
      for (let q = 0; q < cubes; q++) { wts[q] += 0.25; sum += wts[q]; } // a little everywhere in the crown
      for (let q = 0; q < cubes; q++) wts[q] /= sum;
    }
    for (let l = l0; l <= l1; l++) {
      const i = k * nz + l;
      const muLeaf = wts ? (tau * wts[l - l0]) / dz : tau / (cubes * dz);
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
 * values), in light (5): { out: the day the shade starts, halfOut, full,
 * fall (= halfFall: half the shade gone), bare, share(k): 0..1 of the
 * leaves' shade on day k }. Where it never gets cold enough for the trees
 * to drop their leaves (or never warm enough), share is 1 (or 0).
 */
export function leafCalendar(tMean, {
  tC = LEAF_T_C, lead = LEAF_FALL_LEAD_DAYS, green = GREEN_T_C, cap = GREEN_CAP_C, lag = SHADE_LAG_DAYS,
  up = LEAF_OUT_DAYS, down = LEAF_FALL_DAYS,
} = {}) {
  const warm = tMean.map((t) => t >= tC);
  if (warm.every(Boolean)) return { out: null, fall: null, share: () => 1, always: true };
  if (!warm.some(Boolean)) return { out: null, fall: null, share: () => 0, never: true };
  const since = (k, d) => (k - d + 365) % 365;
  /* Spring: the first day after the coldest that passes the green-up
     temperature; autumn: the first day after the warmest below tC. */
  let coldest = 0, warmest = 0;
  for (let k = 1; k < 365; k++) { if (tMean[k] < tMean[coldest]) coldest = k; if (tMean[k] > tMean[warmest]) warmest = k; }
  const tGreen = Math.min(green, tMean[warmest] - cap);
  let greenUp = coldest;
  while (tMean[greenUp % 365] < tGreen) greenUp++;
  let cold = warmest;
  while (tMean[cold % 365] >= tC) cold++;
  let halfOut = (greenUp + lag) % 365;
  let fall = (cold - lead + 365) % 365;
  /* A short season keeps its leafing-out and a week of full leaf. */
  const room = since(fall, halfOut) - up / 2 - down / 2 - 7;
  if (room < 0) { halfOut = (halfOut + Math.floor(room / 2) + 365) % 365; fall = (fall - Math.ceil(room / 2)) % 365; }
  const out = (halfOut - Math.round(up / 2) + 365) % 365;
  const dropFrom = since(fall, out) - down / 2; // leaves start falling half the ramp before the half-way day
  const share = (k) => {
    const a = since(k, out);
    if (a < up) return Math.min(1, a / up); // leafing out
    if (a < dropFrom) return 1; // summer
    return Math.max(0, 1 - (a - dropFrom) / down); // falling, then bare
  };
  return { out, fall, full: (out + up) % 365, bare: (out + Math.ceil(dropFrom + down)) % 365, halfOut, halfFall: fall, share };
}
