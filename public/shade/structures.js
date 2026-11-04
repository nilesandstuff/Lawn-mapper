/**
 * WHAT STANDS ON A CELL: A BUILDING, A TREE, OR NOTHING (one home for the
 * rule; owner, 2026-11-03: "I want as much cohesiveness between the
 * different ways to read lidar as possible. The different maps only diverge
 * when they're doing something specific to that particular map").
 *
 * Pure: no drawing, no page. The shade map (seasonal.js), and by copy the
 * water map and the yard AR tool, read buildings from here; a fix to the
 * rule goes here and nowhere else (CLAUDE.md, "One way to read lidar").
 *
 * The rule, per 1 m column of the canopy model (canopy.js buildCanopy):
 *
 *  1. Columns with a return more than 2 m over the ground (CROWN_ABOVE_M)
 *     are something; the rest are nothing.
 *  2. BUILDING, first pass: the flat-roof rule (the core's H38: three
 *     returns or more over 2 m, all within 1.5 m of each other, and no last
 *     return reaching the ground), or a column NOTHING GOT THROUGH at the
 *     grass (canopy.js solidAtGrass: a pitched roof, which the flat rule
 *     misses -- or the densest evergreen).
 *  3. A SOLID TREE, taken back out of the buildings, patch by patch (4-way
 *     connected building columns): a tree when a quarter or more of its
 *     returns over 2 m came from pulses that split (needles and branches;
 *     almost never a roof), or the patch is under 4 m2 (a dense crown no
 *     pulse happened to get under), or it is under 60 m2 with a rough top
 *     (a roof is planes, so neighbouring columns' tops differ little: the
 *     median step 0.55 m or more is a tree). Set on the owner's lot
 *     (Kent 2016 cloud against the photo, 2026-10-11): houses 200-311 m2,
 *     2-3% split, steps 0.36-0.44 m; lawn spruces 6-42 m2, 0-38% split,
 *     0.55-1.5 m.
 *  4. EAVES: a pulse landing half on a roof's edge and half on the ground
 *     splits like a tree's, so a ring of "crown" hugs every roof. A crown
 *     column next to a building whose top is within 2 m of that building's
 *     is the building's edge.
 *  5. Everything else over 2 m is a tree (a crown the laser got through).
 *  6. A LOW STRUCTURE (owner, 2026-11-03: short structures -- sheds, stone
 *     bins, walls, trucks -- were drawn as trees). Below 2 m nothing above
 *     was looked at, and at 2 points a square meter a 2-5 m shed has too few
 *     returns per column for the roof rules, so it read as a crown. Hard
 *     surfaces send each pulse back once; a leaf-off crown splits them. A
 *     column is HARD when it stands 1-6 m (STRUCTURE_FLOOR_M,
 *     STRUCTURE_MAX_M), every return over 1 m came back as a single echo,
 *     none was fired in leaf (a crown in leaf can stop pulses whole), and
 *     it is not already a building. Hard columns join 8-way into patches;
 *     a patch of 4 or more is a low structure unless a tree more than 2 m
 *     taller than its top stands within 2 m of it (the solid-looking skirt
 *     of a spruce), or it is GREEN in the summer aerial photo (naip.js):
 *     its median vegetation index at or over the property's own line,
 *     halfway between its roofs' and its trees' in the same photo. At 2
 *     points a square meter a small evergreen or ornamental tree looks to
 *     the laser just like a shed; in the photo it is green and the shed is
 *     not. NO PHOTO, NO LOW STRUCTURES (owner, 2026-11-04: "I just don't
 *     want us to be seeing structures where there aren't any"); nor on a
 *     flight that kept almost no second returns (under 2% of those over
 *     2 m split), nor on points in leaf.
 *     A test that took a patch touching a tree as part of the tree
 *     (2026-11-03) was dropped the next day: on the owner's lot what it took
 *     was the edges of buildings, and the owner asked for no rules on
 *     assumptions. See shade findings 33.
 *
 * MEASURED (shade findings 24, by the water session, 2026-10-17): against
 * the Chesapeake 1 m land use's structures, 23 residential squares in VA,
 * MD and PA, 6 flights: 83% of structure cells found and 85% of the calls
 * right (91% and 94% within 1 m), IoU 0.72; the flat rule alone found 46%.
 * KNOWN WEAK: a house with trees against it can join a patch that reads as
 * a tree; sheds and porches of 4-60 m2 with rough tops read as trees; and
 * some structures come out as tall trees (owner, 2026-11-03).
 *
 * Leaf state does not enter: a building is a building on any flight.
 */

import { GRASS_M, solidAtGrass, buildCanopy } from './canopy.js';
import { cellOf } from './grid.js';
import { greenOver } from './naip.js';

export const NOISE = new Set([7, 18]); // LAS low and high noise
export const STRAY_ABOVE_M = 10; // a return this far above every other within STRAY_RADIUS_M is a stray the survey missed
export const STRAY_RADIUS_M = 3;
export const HIGH_NOISE = 18; // the LAS class a stray is given

/**
 * STRAYS THE SURVEY DID NOT FLAG (owner, 2026-11-04: a "column of tree
 * that's like 150 feet tall that doesn't relate to anything in real life":
 * one return 46.5 m up, class 1, nothing else within 40 m below it; a bird,
 * or a glitch). USGS's deliveries flag high noise as class 18, which every
 * reader here ignores (owner: "ignore 80m and noise"), but some slip
 * through. A return more than STRAY_ABOVE_M above every other return within
 * STRAY_RADIUS_M of it -- counting only returns that are themselves
 * anchored to something below, since one pulse off a bird leaves two or
 * three echoes that would vouch for each other -- is given class 18 here,
 * in place, before anything reads the columns. A tree's top has its own
 * crown under it within that radius; a wire has the next return along it
 * at its own height. Returns the count flagged.
 */
export function flagStrays(cols, grid, { shift = null, aboveM = STRAY_ABOVE_M, radiusM = STRAY_RADIUS_M, cellM = null } = {}) {
  if (!cols?.n) return 0;
  const { w, h } = grid;
  const N = w * h;
  const cm = cellM ?? grid.cell * Math.cos((grid.lat || 0) * Math.PI / 180);
  const r = Math.max(1, Math.round(radiusM / Math.max(cm, 1e-9)));
  /* ANCHORED, from the ground up: a return is anchored when, within the
     radius, an anchored return stands no more than aboveM below it; each
     cell's lowest return is anchored (the ground, or as near as the laser
     got). Taken in height order, so a stray cannot anchor another stray --
     one pulse off a bird leaves two or three echoes a few metres apart, and
     each would vouch for the other if judged alone. */
  const cell = new Int32Array(cols.n).fill(-1);
  const order = [];
  const low = new Float32Array(N).fill(Infinity);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    cell[i] = k;
    order.push(i);
    if (cols.z[i] < low[k]) low[k] = cols.z[i];
  }
  order.sort((p, q) => cols.z[p] - cols.z[q]);
  const anchoredTop = Float32Array.from(low); // the highest anchored return per cell so far (the lowest to start)
  let flagged = 0;
  for (const i of order) {
    const k = cell[i], z = cols.z[i];
    if (z === low[k]) continue; // the cell's lowest: anchored by definition
    const x = k % w, y = (k / w) | 0;
    let support = -Infinity;
    for (let dy = -r; dy <= r && support < z - aboveM; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const t = anchoredTop[yy * w + xx];
      if (t > support) support = t;
    }
    if (z - support <= aboveM) { if (z > anchoredTop[k]) anchoredTop[k] = z; } else { cols.cls[i] = HIGH_NOISE; flagged++; }
  }
  return flagged;
}
export const CROWN_ABOVE_M = 2;
export const MAX_OVER_M = 80;
export const FLAT_MIN_RETURNS = 3; // the flat-roof rule: this many returns over 2 m
export const FLAT_SPREAD_M = 1.5; // all within this of each other
export const SOLID_TREE_SPLIT = 0.25; // a solid patch this split is a tree, not a roof
export const SOLID_TREE_MAX_M2 = 60; // or one smaller than this
export const SOLID_SPECK_M2 = 4; // a solid patch smaller than this is always part of a tree
export const SOLID_TREE_ROUGH_M = 0.55; // whose neighboring tops differ by this much (median)
export const EAVE_M = 2; // a crown column beside a roof, its top within this of the roof's, is an eave
export const STRUCTURE_FLOOR_M = 1; // a low structure stands at least this tall
export const STRUCTURE_MAX_M = 6; // and no taller (taller is a building's rules, or a tree)
export const STRUCTURE_MIN_CELLS = 4; // a patch of at least this many hard columns
export const STRUCTURE_TREE_RISE_M = 2; // unless a tree this much taller than its top
export const STRUCTURE_TREE_RING = 2; // stands within this many columns of it
export const STRUCTURE_MIN_SPLIT = 0.02; // the flight must keep second returns: at least this share of those over 2 m split
export const WALL_INSET_M = 0.61; // walls stand 2 ft in from a roof's edge (owner, 2026-11-03: "the standard amount")

/** The kinds, per column. */
export const NOTHING = 0, BUILDING = 1, TREE = 2, SOLID_TREE = 3, STRUCTURE = 4, UNKNOWN = 5;
/** Why, per column (the rule's step that decided it). */
export const WHY = Object.freeze({
  0: 'nothing over 2 m',
  1: 'building: a flat roof (returns within 1.5 m, none reached the ground)',
  2: 'building: nothing got through at the grass',
  3: 'building: an eave beside a roof',
  4: 'tree: the laser got through',
  5: 'solid tree: a quarter or more of its pulses split',
  6: 'solid tree: a patch under 4 m2',
  7: 'solid tree: a small patch with a rough top',
  8: 'low structure: every pulse came back once, as off a hard surface',
  9: 'unknown: the laser hit something here that no rule named; it stops light as the laser measured it',
});

/**
 * Per-column counts from the points: returns over 2 m (`above`), those of
 * split pulses (`multiAbove`), last returns at the grass (`lastGround`),
 * the lowest and highest return over 2 m (`zLo`, `zHi`, absolute m), the
 * highest return over the ground (`top`, m over it), and returns 1 m or
 * more up (`firm`), of them single echoes (`firmSingle`) and those fired in
 * leaf (`firmLeafOn`, las.js leaf 2).
 */
export function columnStats(cols, model, { shift = null } = {}) {
  const { grid, w, h, ground } = model;
  const N = w * h;
  const above = new Uint16Array(N), multiAbove = new Uint16Array(N), lastGround = new Uint16Array(N);
  const zLo = new Float32Array(N).fill(Infinity), zHi = new Float32Array(N).fill(-Infinity);
  const top = new Float32Array(N).fill(-Infinity), firm = new Uint16Array(N), firmSingle = new Uint16Array(N), firmLeafOn = new Uint16Array(N);
  const firmBright = new Float32Array(N); // mean intensity of the single echoes over 1 m (summed here, divided below)
  const groundI = [];
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    const over = cols.z[i] - ground[k];
    if ((cols.ret[i] || 1) >= (cols.nret[i] || 1) && over < GRASS_M) lastGround[k]++; // a pulse that reached the ground
    if (over < MAX_OVER_M && over > top[k]) top[k] = over;
    if (over >= STRUCTURE_FLOOR_M && over < MAX_OVER_M) {
      firm[k]++;
      if ((cols.nret[i] || 1) === 1) firmSingle[k]++;
      if (cols.leaf?.[i] === 2) firmLeafOn[k]++;
      if ((cols.nret[i] || 1) === 1) firmBright[k] += cols.intensity?.[i] || 0;
    }
    if (over > CROWN_ABOVE_M && over < MAX_OVER_M) {
      above[k]++;
      if ((cols.nret[i] || 1) > 1) multiAbove[k]++;
      if (cols.z[i] < zLo[k]) zLo[k] = cols.z[i];
      if (cols.z[i] > zHi[k]) zHi[k] = cols.z[i];
    }
  }
  for (let k = 0; k < N; k++) if (firmSingle[k]) firmBright[k] /= firmSingle[k];
  /* The flight's own ground, for brightness relative to it: intensity is
     not comparable between flights (sensor, gain, altitude), so every use
     of it is per property, against this. */
  for (let i = 0; i < cols.n; i += 7) if (cols.cls[i] === 2 && cols.intensity?.[i]) groundI.push(cols.intensity[i]);
  groundI.sort((a, b) => a - b);
  const groundBright = groundI.length ? groundI[groundI.length >> 1] : 0;
  return { above, multiAbove, lastGround, zLo, zHi, top, firm, firmSingle, firmLeafOn, firmBright, groundBright };
}

/**
 * Building, tree or nothing for every column of `model` (canopy.js
 * buildCanopy over the same `cols` and grid; its `ground` and `mu` are
 * read). `cols` are the readers' point columns (las.js: x, y in EPSG:3857,
 * z, cls, ret, nret); `shift` the same [dx, dy] the model was built with.
 *
 * Returns { kind (Uint8 per column: NOTHING, BUILDING, TREE, SOLID_TREE, STRUCTURE,
 *                 UNKNOWN: something over the grass no rule named, light as measured),
 *           why (Uint8 per column, a key of WHY), stats (columnStats),
 *           counts: { building, tree, solidTree, structure, unknown } }.
 */
export function structuresOf(cols, model, { shift = null, stats = null, low = {} } = {}) {
  const { w, h, ground } = model;
  const N = w * h;
  const st = stats || columnStats(cols, model, { shift });
  const { above, multiAbove, lastGround, zLo, zHi } = st;
  const kind = new Uint8Array(N), why = new Uint8Array(N);
  /* 1-2. Something over 2 m; a building by the flat rule or nothing through. */
  for (let k = 0; k < N; k++) {
    if (!above[k]) continue;
    const flat = above[k] >= FLAT_MIN_RETURNS && zHi[k] - zLo[k] < FLAT_SPREAD_M && lastGround[k] === 0;
    if (flat) { kind[k] = BUILDING; why[k] = 1; } else if (solidAtGrass(model, k)) { kind[k] = BUILDING; why[k] = 2; } else { kind[k] = TREE; why[k] = 4; }
  }
  /* 3. Solid trees, patch by patch. */
  const seen = new Uint8Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (kind[s0] !== BUILDING || seen[s0]) continue;
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
        if (kind[j] !== BUILDING) continue;
        if (dx + dy > 0 && above[k] && above[j]) steps.push(Math.abs(zHi[k] - zHi[j]));
        if (!seen[j]) { seen[j] = 1; patch.push(j); }
      }
    }
    steps.sort((p1, p2) => p1 - p2);
    const rough = steps.length ? steps[steps.length >> 1] : 0;
    const reason = a > 0 && m / a >= SOLID_TREE_SPLIT ? 5 : patch.length < SOLID_SPECK_M2 ? 6 : patch.length < SOLID_TREE_MAX_M2 && rough >= SOLID_TREE_ROUGH_M ? 7 : 0;
    if (reason) for (const k of patch) { kind[k] = SOLID_TREE; why[k] = reason; }
  }
  /* 4. Eaves (decided against the buildings as they stand after 3, then set). */
  const eave = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x;
    if (kind[k] !== TREE) continue;
    for (let dy = -1; dy <= 1 && !eave[k]; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (kind[j] === BUILDING && Math.abs((zHi[j] - ground[j]) - (zHi[k] - ground[k])) <= EAVE_M) { eave[k] = 1; break; }
    }
  }
  for (let k = 0; k < N; k++) if (eave[k]) { kind[k] = BUILDING; why[k] = 3; }
  const lowInfo = lowStructures(kind, why, st, w, h, low);
  /* 7. NOTHING THE LASER HIT IS LEFT OUT (owner, 2026-11-04: "every thing
     that the lidar hits should be recognized"), and what no rule can name
     is UNKNOWN, not a tree (owner, later the same day: "we can go back to
     marking it brown and then calling it unknown, then just judge how much
     light is passing through based on laser passing through"). A column
     with a return over the grass (GRASS_M) that no step above claimed keeps
     exactly the light the laser measured: no leaves added, no trunk space
     emptied, no solid fill forced. That is the lidar's own strength -- the
     laser passes through what light passes through -- and it is the most
     faithful answer when the shape alone cannot say what stands there. */
  for (let k = 0; k < N; k++) if (kind[k] === NOTHING && st.top[k] > GRASS_M) { kind[k] = UNKNOWN; why[k] = 9; }
  const counts = { building: 0, tree: 0, solidTree: 0, structure: 0, unknown: 0 };
  for (let k = 0; k < N; k++) {
    if (kind[k] === BUILDING) counts.building++;
    else if (kind[k] === TREE) counts.tree++;
    else if (kind[k] === SOLID_TREE) counts.solidTree++;
    else if (kind[k] === STRUCTURE) counts.structure++;
    else if (kind[k] === UNKNOWN) counts.unknown++;
  }
  return { kind, why, stats: st, counts, green: lowInfo };
}

/** 6. Low structures (see the head of this file), set in place on `kind` and `why`. */
function lowStructures(kind, why, st, w, h, { green = null, touchTree = false } = {}) {
  const { top, firm, firmSingle, firmLeafOn, above, multiAbove, firmBright, groundBright } = st;
  const N = w * h;
  /* A flight that kept only one return a pulse (some did: a North Carolina
     2016 flight has none split) cannot tell a hard surface from a crown. */
  let a = 0, m = 0;
  for (let k = 0; k < N; k++) { a += above[k]; m += multiAbove[k]; }
  if (!a || m / a < STRUCTURE_MIN_SPLIT) return null;
  /* NO PHOTO, NO LOW STRUCTURES (owner, 2026-11-04: "I just don't want us
     to be seeing structures where there aren't any"). At 2 points a square
     meter a small evergreen and a shed look alike to the laser; the summer
     photo's green tells them apart (shade findings 33). */
  if (!green || green.length !== N) return null;
  const cut = greenCut(kind, green, N);
  if (cut === null) return null;
  const hard = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    hard[k] = kind[k] !== BUILDING && top[k] >= STRUCTURE_FLOOR_M && top[k] <= STRUCTURE_MAX_M
      && firm[k] > 0 && firmSingle[k] === firm[k] && firmLeafOn[k] === 0 ? 1 : 0;
  }
  const lab = new Int32Array(N).fill(-1);
  const R = STRUCTURE_TREE_RING;
  for (let s0 = 0; s0 < N; s0++) {
    if (!hard[s0] || lab[s0] >= 0) continue;
    const patch = [s0];
    lab[s0] = s0;
    let pTop = 0;
    for (let q = 0; q < patch.length; q++) {
      const k = patch[q], x = k % w, y = (k / w) | 0;
      if (top[k] > pTop) pTop = top[k];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (hard[j] && lab[j] < 0) { lab[j] = s0; patch.push(j); }
      }
    }
    if (patch.length < STRUCTURE_MIN_CELLS) continue;
    let skirt = false;
    for (let q = 0; q < patch.length && !skirt; q++) {
      const k = patch[q], x = k % w, y = (k / w) | 0;
      for (let dy = -R; dy <= R && !skirt; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (lab[j] === s0 || (kind[j] !== TREE && kind[j] !== SOLID_TREE)) continue;
        /* Touching a tree, or a tree well over it near by: part of the tree. */
        if ((touchTree && Math.abs(dx) <= 1 && Math.abs(dy) <= 1) || top[j] > pTop + STRUCTURE_TREE_RISE_M) { skirt = true; break; }
      }
    }
    if (skirt) continue;
    /* Green in the summer photo: a plant, not a structure. */
    const gv = patch.map((k) => green[k]).filter(Number.isFinite).sort((p1, p2) => p1 - p2);
    if (!gv.length || gv[gv.length >> 1] >= cut) continue;
    for (const k of patch) { kind[k] = STRUCTURE; why[k] = 8; }
  }
  return { cut };
}

/**
 * The property's own line between green and not (owner, 2026-11-04:
 * calibrated per property): halfway between the median vegetation index of
 * its buildings' roofs and of its trees, in the same photo. Null when the
 * photo shows fewer than 20 tree columns (no trees to calibrate on) -- then
 * no low structures are called. With no roofs, 0 stands in for them.
 */
export function greenCut(kind, green, N = kind.length) {
  const roofs = [], trees = [];
  for (let k = 0; k < N; k++) {
    if (!Number.isFinite(green[k])) continue;
    if (kind[k] === BUILDING) roofs.push(green[k]);
    else if (kind[k] === TREE || kind[k] === SOLID_TREE) trees.push(green[k]);
  }
  if (trees.length < 20) return null;
  const med = (v) => v.sort((p1, p2) => p1 - p2)[v.length >> 1];
  const t = med(trees), r = roofs.length >= 20 ? med(roofs) : 0;
  return t > r + 0.05 ? (t + r) / 2 : null;
}

/**
 * WALLS UNDER THE EAVES (owner, 2026-11-03: "Let's assume that walls are
 * offset by the standard amount, 2 feet probably"). The laser sees a roof,
 * not the walls under it; a roof overhangs its walls by about 2 ft, so the
 * walls stand that far in from the roof's edge. From a per-column mask
 * (`mask`, w x h columns of `cellM` meters; e.g. kind === BUILDING) at a
 * finer step `fineM`: { w, h, cellM: fineM, walls (Uint8: inside the
 * walls), eaves (Uint8: under the roof but outside the walls), inset }.
 * The roof edge is where the mask ends, so the outline is as blocky as the
 * columns; the inset is measured straight-line from it.
 */
export function wallsOf(mask, w, h, { cellM = 1, fineM = 0.25, insetM = WALL_INSET_M } = {}) {
  const f = Math.max(1, Math.round(cellM / fineM));
  const fw = w * f, fh = h * f, step = cellM / f;
  const roof = new Uint8Array(fw * fh);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) roof[y * fw + x] = mask[((y / f) | 0) * w + ((x / f) | 0)] ? 1 : 0;
  /* A fine cell is inside the walls when no cell off the roof lies within the inset of it (centre to centre). */
  const r = Math.ceil(insetM / step), r2 = (insetM / step) ** 2;
  const walls = new Uint8Array(fw * fh), eaves = new Uint8Array(fw * fh);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const k = y * fw + x;
    if (!roof[k]) continue;
    let near = false;
    for (let dy = -r; dy <= r && !near; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= fw || yy >= fh || !roof[yy * fw + xx]) { near = true; break; }
    }
    if (near) eaves[k] = 1; else walls[k] = 1;
  }
  return { w: fw, h: fh, cellM: step, walls, eaves, inset: insetM };
}

/**
 * The same from the points alone, for a tool with no canopy model of its
 * own: builds one over `grid` (grid.js gridOver, ~1 m cells) as the shade
 * map does, and returns structuresOf's answer plus that model's `ground`.
 * `green`: naip.js greenOver(grid), the summer photo's vegetation index per
 * column; without it no low structures are called.
 */
/**
 * THE ONE CALL FOR EVERY TOOL (owner, 2026-11-04: "set it up to where the
 * shade map handles the photo comparison and makes the judgements here, so
 * we don't need to duplicate any changes elsewhere"): reads the summer photo
 * for `grid` itself (naip.js, one request per lot per page) and returns
 * structuresFrom's answer with it, plus `photo` (whether it answered). A
 * tool that calls this gets every later change to the rule and the photo
 * check with no change of its own. `flownMs`: the lidar flight's date, so
 * the photo read is the one nearest it (naip.js).
 */
export async function structuresFor(cols, grid, { shift = null, flownMs = null, fetchFn, decodePng } = {}) {
  flagStrays(cols, grid, { shift });
  const green = await greenOver(grid, { flownMs, ...(fetchFn ? { fetchFn } : {}), ...(decodePng ? { decodePng } : {}) });
  return { ...structuresFrom(cols, grid, { shift, green }), photo: !!green };
}

export function structuresFrom(cols, grid, { shift = null, green = null } = {}) {
  const model = buildCanopy(cols, grid, { shift });
  return { ...structuresOf(cols, model, { shift, low: { green } }), ground: model.ground, model };
}
