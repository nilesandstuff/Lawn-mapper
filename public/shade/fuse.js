/**
 * THE LIDAR REFINED BY A YARD WALK (owner, 2026-11-23): "I do actually want the AR to override/correct/refine the
 * lidar. The lidar is coarse, messes up the edges of canopy, and can even be off on position... AR, so far, hasn't
 * demonstrated being good at seeing high up from the ground, and AR won't be very good at conveying how much light
 * gets through a canopy in that same way that lidar brightness can. So my thought is that we use AR to improve the
 * existing lidar shapes (in position and dimensions), drawing over them... while maintaining the light that passes
 * through the canopies. Note: please make some use of the finer resolution of ar. And don't directly modify the
 * actual lidar files... This needs to be a separate file that fuses the rasterized lidar shapes AND the AR shapes."
 *
 * fuseModel(lidar, plants, origin) -> a NEW model file ({ meta, arrays }, lidar-model.js format) on a grid HALF a
 * metre square (FUSE_SUB = 2 per lidar metre), the lidar's own layers (z0, dz, nz). The lidar file is read, never
 * written. What each part is trusted for:
 *
 *   WHERE: the walk's plants (the scan tool's `plants`, docs/MAPS.md "scan": square-foot boxes from lo to hi
 *   decimetres over the ground, already fitted onto the lidar's frame by the walk's roof corners) say where the plant
 *   matter is, at a foot's grain, at every height the walk saw it (no cap: the owner, 2026-11-23, "I don't think we
 *   should be handicapping ourselves by arbitrarily ignoring distant points, unless you demonstrate that they're just
 *   plain wrong"; the core session's range study the same day found them coarser, not wrong).
 *
 *   HOW DENSE: the lidar says how much light a metre of canopy stops (canopy.js mu, from what the laser got through).
 *   Inside each lidar cube (1 m square, one layer) the walk only MOVES that density to where the plant is: each
 *   half-metre cell takes mu x (its share of the walk's plant) / (the cube's mean share), so the cube's mean
 *   extinction is the lidar's own. Concentrating it leaves gaps (more light through on average, as a real crown's
 *   gaps do), it does not invent shade.
 *
 *   NEW SHAPE: plant the walk saw where the lidar has nothing at that height (an edge the lidar's 1 m blocks missed,
 *   a hedge under its noise floor) takes the density of the lidar's own canopy nearest it at that height (within
 *   BORROW_M), else PLANT_MU (a dense shrub), scaled by how much of the cell the walk filled.
 *
 *   POSITION: a lidar tree (a clump of tree columns, 8-neighbour) that the walk saw well (CLUMP_MIN_CELLS half-metre
 *   cells of plant in the band both see, SHIFT_BAND_M) is moved, whole and at every height, to where its cubes best
 *   overlap the walk's plant in that band, by up to SHIFT_MAX_M in half-metre steps, when the best overlap beats
 *   the unmoved one by SHIFT_GAIN. A crown the lidar caught leaning or a season's growth away is put back over the
 *   trunk and branches the walk saw.
 *
 *   EDGES: where the walk saw OPEN AIR (plants.seen, the core session's, 2026-11-23: per 2 ft square, the
 *   decimetres seen open from the ground up, up to 8 ft; openFromSeen), a lidar cube's density leaves the part seen
 *   open for the rest of the cube (its mean kept); a cube seen open all through, with no plant seen in it, is
 *   emptied: the lidar's 1 m blocks (and the pooling of a sparse flight) spread a crown's skirt, a hedge's side or a
 *   low limb over air the phone looked through. Nothing is trimmed above what was seen open, or where the record
 *   says no claim (0) or not looked (255). ABOVE 8 FT (plants.seenHigh, a band of air seen open, openHighFromSeen)
 *   a cube is trimmed only after a walk in leaf, or where the lidar's cell is not a deciduous crown: in leaf-off
 *   months the phone sees straight through a bare crown, and that is not "no tree" (the owner, 2026-11-23).
 *
 *   THE LEAVES (owner, 2026-11-23: "seeing sky points through a tree canopy when the leaves are off should not be a
 *   signal that there's no tree there"): a walk made in leaf-off months (las.js leafOfMs: 1 November to 10 May) sees
 *   a deciduous crown's BRANCHES, not where its leaves will be, so inside a lidar cube of a deciduous crown (its summer
 *   copy muOn denser than mu) the density stays the lidar's, evenly, after such a walk; the walk may still move the
 *   tree and add plant the lidar did not have. A walk in leaf, or an evergreen, refines at every height.
 *
 * muOn (the summer copy) is fused the same way; plant added from the walk gets the same density in both.
 */
import { toMerc, mercScale } from './ept.js';
import { leafOfMs, LEAF_ON } from './las.js';
import { SOLID_MU } from './canopy.js';

/** The fusing's own build, written into meta.fused.version: bump it whenever what fuseModel makes changes. */
export const FUSE_VERSION = 3; // 2: no height cap; a deciduous crown's density kept even after a leaf-off walk. 3: open air above 8 ft (seenHigh)
export const FUSE_SUB = 2;            // half-metre cells per lidar metre
export const PLANT_TRUST_M = Infinity; // no cap on the walk's heights (the owner, 2026-11-23)
export const PLANT_MU = 2.3;          // a cube of plant the lidar did not see: stops 90% of the light a metre
export const BORROW_M = 2;            // ...unless a lidar crown within this, at that height, says how dense it is
export const SHIFT_BAND_M = [1.5, Infinity]; // the heights both see, for moving a tree (from 5 ft up, every height)
export const SHIFT_MAX_M = 2;
export const SHIFT_GAIN = 1.3;        // the best overlap must beat the unmoved one by this much
export const CLUMP_MIN_CELLS = 12;    // half-metre cells of the walk's plant in the band, at the least, to move a tree
const R_EARTH = 6378137;              // scan/lib/frames.js: the walk's local frame is a sphere of this radius

/** A walk's local metres east/north of `origin` [lng, lat] -> [lng, lat] (scan/lib/frames.js fromLocal). */
export function fromLocal(origin, [e, n]) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return [origin[0] + (e / (R_EARTH * k)) * (180 / Math.PI), origin[1] + (n / R_EARTH) * (180 / Math.PI)];
}

/**
 * The walk's plants on the fused grid: per half-metre cell and lidar layer, the share of it (0..1) the walk saw
 * plant in (area x height). `grid` is the FINE grid (cell, cellY in 3857 units), `layers` the lidar's.
 */
export function plantShare(plants, origin, grid, layers, groundAt) {
  const { w, h } = grid, { z0, dz, nz } = layers;
  const share = new Float32Array(w * h * nz);
  const cm = plants.cellM || 0.3048;
  const cy = grid.cellY || grid.cell;
  const cellArea = grid.cell * cy;
  for (const [i, j, lo, hi] of plants.boxes || []) {
    /* The box's corners in 3857, through degrees (never metres added onto toMerc: that stretches by 1/cos lat). */
    const [x0, y0] = toMerc(fromLocal(origin, [i * cm, j * cm]));
    const [x1, y1] = toMerc(fromLocal(origin, [(i + 1) * cm, (j + 1) * cm]));
    const c0 = Math.floor((x0 - grid.x0) / grid.cell), c1 = Math.floor((x1 - grid.x0) / grid.cell);
    const r0 = Math.floor((grid.y1 - y1) / cy), r1 = Math.floor((grid.y1 - y0) / cy);
    for (let r = Math.max(0, r0); r <= Math.min(h - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(w - 1, c1); c++) {
      const ox = Math.min(x1, grid.x0 + (c + 1) * grid.cell) - Math.max(x0, grid.x0 + c * grid.cell);
      const oy = Math.min(y1, grid.y1 - r * cy) - Math.max(y0, grid.y1 - (r + 1) * cy);
      if (!(ox > 0 && oy > 0)) continue;
      const a = (ox * oy) / cellArea, g = groundAt(c, r);
      const zLo = g + Math.min(lo, PLANT_TRUST_M * 10) / 10, zHi = g + Math.min(hi, PLANT_TRUST_M * 10) / 10;
      if (!(zHi > zLo)) continue;
      for (let l = Math.max(0, Math.floor((zLo - z0) / dz)); l < nz && z0 + l * dz < zHi; l++) {
        const f = (Math.min(zHi, z0 + (l + 1) * dz) - Math.max(zLo, z0 + l * dz)) / dz;
        if (f > 0) share[(r * w + c) * nz + l] = Math.min(1, share[(r * w + c) * nz + l] + a * f);
      }
    }
  }
  return share;
}

/**
 * Where the walk saw open air (plants.seen) on the fused grid: metres open from the ground per half-metre cell, NaN
 * where the record makes no claim (0) or the walk never looked (255). Async: the bytes are deflated (zlib).
 */
export async function openFromSeen(seen, origin, grid, { inflate = null } = {}) {
  const out = new Float32Array(grid.w * grid.h).fill(NaN);
  if (!seen?.clearTo || !(seen.w > 0) || !(seen.h > 0)) return out;
  const raw = Uint8Array.from(atob(seen.clearTo), (ch) => ch.charCodeAt(0));
  const bytes = inflate ? await inflate(raw) : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  if (bytes.length < seen.w * seen.h) return out;
  const cm = seen.cellM || 0.6096, cap = (seen.capDm ?? 24), notSeen = seen.notSeen ?? 255;
  const cy = grid.cellY || grid.cell;
  /* each fused cell reads the 2 ft square under its middle */
  const sw = toMerc(fromLocal(origin, [seen.i0 * cm, seen.j0 * cm]));
  const ne = toMerc(fromLocal(origin, [(seen.i0 + seen.w) * cm, (seen.j0 + seen.h) * cm]));
  for (let r = 0; r < grid.h; r++) for (let c = 0; c < grid.w; c++) {
    const x = grid.x0 + (c + 0.5) * grid.cell, y = grid.y1 - (r + 0.5) * cy;
    const sc = Math.floor(((x - sw[0]) / (ne[0] - sw[0])) * seen.w), sr = Math.floor(((y - sw[1]) / (ne[1] - sw[1])) * seen.h);
    if (sc < 0 || sr < 0 || sc >= seen.w || sr >= seen.h) continue;
    const b = bytes[sr * seen.w + sc];
    if (b === notSeen || b === 0) continue;
    out[r * grid.w + c] = Math.min(b, cap) / 10;
  }
  return out;
}

/**
 * Where the walk saw open air ABOVE 8 ft (plants.seenHigh, the core session's, 2026-11-23): per 2 ft square, the
 * biggest band of air seen open, lo..hi in units of unitDm (2 dm) over the ground. On the fused grid: { lo, hi },
 * metres over the ground per half-metre cell, NaN where the record makes no claim (0, 0) or the walk never looked
 * (255, 255). Async: the bytes are deflated (zlib).
 */
export async function openHighFromSeen(seenHigh, origin, grid, { inflate = null } = {}) {
  const lo = new Float32Array(grid.w * grid.h).fill(NaN), hi = new Float32Array(grid.w * grid.h).fill(NaN);
  const sh = seenHigh;
  if (!sh?.bands || !(sh.w > 0) || !(sh.h > 0)) return { lo, hi };
  const raw = Uint8Array.from(atob(sh.bands), (ch) => ch.charCodeAt(0));
  const bytes = inflate ? await inflate(raw) : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  if (bytes.length < 2 * sh.w * sh.h) return { lo, hi };
  const cm = sh.cellM || 0.6096, unit = (sh.unitDm ?? 2) / 10, notSeen = sh.notSeen ?? 255;
  const cy = grid.cellY || grid.cell;
  const sw = toMerc(fromLocal(origin, [sh.i0 * cm, sh.j0 * cm]));
  const ne = toMerc(fromLocal(origin, [(sh.i0 + sh.w) * cm, (sh.j0 + sh.h) * cm]));
  for (let r = 0; r < grid.h; r++) for (let c = 0; c < grid.w; c++) {
    const x = grid.x0 + (c + 0.5) * grid.cell, y = grid.y1 - (r + 0.5) * cy;
    const sc = Math.floor(((x - sw[0]) / (ne[0] - sw[0])) * sh.w), sr = Math.floor(((y - sw[1]) / (ne[1] - sw[1])) * sh.h);
    if (sc < 0 || sr < 0 || sc >= sh.w || sr >= sh.h) continue;
    const q = 2 * (sr * sh.w + sc), a = bytes[q], b = bytes[q + 1];
    if ((a === notSeen && b === notSeen) || !(b > a)) continue;
    lo[r * grid.w + c] = a * unit; hi[r * grid.w + c] = b * unit;
  }
  return { lo, hi };
}

/** The fused grid for a lidar file (the same corner, FUSE_SUB cells to the lidar's metre). */
export function fusedGrid(meta) {
  const G = meta.grid;
  return { w: G.w * FUSE_SUB, h: G.h * FUSE_SUB, x0: G.x0, y1: G.y1, cell: G.cell / FUSE_SUB, cellY: (G.cellY || G.cell) / FUSE_SUB, lat: G.lat };
}

/** The lidar's tree clumps (TREE 2 or SOLID_TREE 3 columns, 8-neighbour): an id per column, -1 elsewhere. */
function clumpsOf(kind, w, h) {
  const id = new Int32Array(w * h).fill(-1);
  let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (!(kind[s] === 2 || kind[s] === 3) || id[s] >= 0) continue;
    const q = [s]; id[s] = n;
    for (let i = 0; i < q.length; i++) {
      const k = q[i], x = k % w, y = (k / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if ((kind[j] === 2 || kind[j] === 3) && id[j] < 0) { id[j] = n; q.push(j); }
      }
    }
    n++;
  }
  return { id, n };
}

/**
 * The fused model: { meta, arrays } (lidar-model.js), the lidar file untouched. `lidar` is the shade map's file as
 * read ({ meta, arrays }, joined with any overflow), `plants` the scan tool's record, `origin` the map's [lng, lat]
 * (the point the walk's metres are measured from).
 */
export function fuseModel(lidar, plants, origin, { now = new Date(), open = null, openHigh = null } = {}) {
  const { meta, arrays } = lidar;
  const G = meta.grid, { z0, dz, nz } = meta.layers;
  const W = G.w, H = G.h, S = FUSE_SUB, w = W * S, h = H * S;
  const grid = { w, h, x0: G.x0, y1: G.y1, cell: G.cell / S, cellY: (G.cellY || G.cell) / S, lat: G.lat };
  const parent = (c, r) => ((r / S) | 0) * W + ((c / S) | 0);
  const ground = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) ground[r * w + c] = arrays.ground[parent(c, r)];
  const share = plantShare(plants, origin, grid, { z0, dz, nz }, (c, r) => ground[r * w + c]);
  const layerOf = (m) => Math.floor((m - z0) / dz);
  const kind = arrays.kind || new Uint8Array(W * H);

  /* 1. POSITION: each lidar tree the walk saw well, moved (whole) to best overlap the walk's plant in the band both see. */
  const { id: clump, n: nClumps } = clumpsOf(kind, W, H);
  const moveOf = new Array(nClumps).fill(null).map(() => [0, 0]);
  const steps = Math.round(SHIFT_MAX_M / (G.cell * mercScale(G.lat) / S));
  const band = (k, l) => { const zm = z0 + (l + 0.5) * dz - arrays.ground[k]; return zm >= SHIFT_BAND_M[0] && zm <= SHIFT_BAND_M[1]; };
  const moved = [];
  for (let id = 0; id < nClumps; id++) {
    /* the clump's cubes in the band, on the fine grid */
    const cells = [];
    for (let k = 0; k < W * H; k++) {
      if (clump[k] !== id) continue;
      const X = k % W, Y = (k / W) | 0;
      for (let l = 0; l < nz; l++) if (arrays.mu[k * nz + l] > 0 && band(k, l)) for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) cells.push((Y * S + sy) * w + X * S + sx, l);
    }
    if (cells.length < 2 * CLUMP_MIN_CELLS) continue;
    const overlap = (dx, dy) => {
      let s = 0, seen = 0;
      for (let q = 0; q < cells.length; q += 2) {
        const f = cells[q], l = cells[q + 1], c = (f % w) + dx, r = ((f / w) | 0) + dy;
        if (c < 0 || r < 0 || c >= w || r >= h) continue;
        const v = share[(r * w + c) * nz + l];
        if (v > 0) { s += v; seen++; }
      }
      return { s, seen };
    };
    const at0 = overlap(0, 0);
    let best = { ...at0, dx: 0, dy: 0 };
    let near = 0;
    for (let dy = -steps; dy <= steps; dy++) for (let dx = -steps; dx <= steps; dx++) {
      const o = overlap(dx, dy);
      /* the most of the walk's plant inside the tree; on a tie, the smaller move */
      if (o.s > best.s + 1e-6 || (Math.abs(o.s - best.s) <= 1e-6 && dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy)) best = { ...o, dx, dy };
      if (o.seen >= CLUMP_MIN_CELLS) near = Math.max(near, o.seen);
    }
    if (near < CLUMP_MIN_CELLS || (best.dx === 0 && best.dy === 0)) continue;
    if (!(best.s >= SHIFT_GAIN * at0.s && best.s > 0)) continue;
    moveOf[id] = [best.dx, best.dy];
    moved.push({ clump: id, east: best.dx * G.cell * mercScale(G.lat) / S, north: -best.dy * G.cell * mercScale(G.lat) / S });
  }

  /* 2. The lidar on the fine grid, each tree where step 1 put it (a moved tree leaves its old place empty). */
  const fuseOne = (src) => {
    if (!src) return null;
    const out = new Float32Array(w * h * nz);
    for (let k = 0; k < W * H; k++) {
      const X = k % W, Y = (k / W) | 0;
      const [mx, my] = clump[k] >= 0 ? moveOf[clump[k]] : [0, 0];
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const c = X * S + sx + mx, r = Y * S + sy + my;
        if (c < 0 || r < 0 || c >= w || r >= h) continue;
        const f = r * w + c;
        for (let l = 0; l < nz; l++) { const v = src[k * nz + l]; if (v > out[f * nz + l]) out[f * nz + l] = v; }
      }
    }
    return out;
  };
  const muL = fuseOne(arrays.mu), muOnL = fuseOne(arrays.muOn);
  /* The lidar's kinds as placed: roofs and low structures are the lidar's alone (a walk's plant is never folded
     into a roof, and a roof's density is never moved). */
  const placed = new Uint8Array(w * h);
  for (let k = 0; k < W * H; k++) {
    if (!kind[k]) continue;
    const X = k % W, Y = (k / W) | 0, [mx, my] = clump[k] >= 0 ? moveOf[clump[k]] : [0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const c = X * S + sx + mx, r = Y * S + sy + my;
      if (c >= 0 && r >= 0 && c < w && r < h) placed[r * w + c] = kind[k];
    }
  }
  const hard = (f) => placed[f] === 1 || placed[f] === 4;
  /* A deciduous crown's cell (its summer copy denser somewhere in the column) and whether the walk saw leaves. */
  const walkInLeaf = leafOfMs(Number(plants.walk)) === LEAF_ON;
  const decid = new Uint8Array(w * h);
  if (muOnL && !walkInLeaf) for (let f = 0; f < w * h; f++) for (let l = 0; l < nz; l++) if (muOnL[f * nz + l] > muL[f * nz + l] + 1e-6) { decid[f] = 1; break; }

  /* 3. Within each lidar cube's footprint (S x S half-metre cells, one layer, as placed), the density moved to where
     the walk saw plant, its mean kept; 4. plant the lidar did not have, at a borrowed or a shrub's density. */
  const borrowR = Math.max(1, Math.round(BORROW_M / (G.cell * mercScale(G.lat) / S)));
  const borrow = (mu, c, r, l) => {
    let best = 0, bd = Infinity;
    for (let dy = -borrowR; dy <= borrowR; dy++) for (let dx = -borrowR; dx <= borrowR; dx++) {
      const cc = c + dx, rr = r + dy;
      if (cc < 0 || rr < 0 || cc >= w || rr >= h) continue;
      const v = mu[(rr * w + cc) * nz + l], d = dx * dx + dy * dy;
      if (v > 0 && v < SOLID_MU * 0.999 && d < bd) { bd = d; best = v; }
    }
    return best || PLANT_MU;
  };
  let added = 0, refined = 0, trimmed = 0;
  /* The share of layer l of fine cell f the walk saw open (0..1), from `open` (metres open from the ground, NaN: no claim). */
  const openShare = (f, l) => {
    const zl = z0 + l * dz;
    let sh = 0;
    const o = open ? open[f] : NaN;
    if (o > 0) sh += Math.max(0, Math.min(1, (ground[f] + o - zl) / dz));
    /* above 8 ft: only after a walk in leaf, or where the lidar's cell is not a deciduous crown (THE LEAVES) */
    if (openHigh && !decid[f]) {
      const a = openHigh.lo[f], b = openHigh.hi[f];
      if (b > a) sh += Math.max(0, Math.min(zl + dz, ground[f] + b) - Math.max(zl, ground[f] + a)) / dz;
    }
    return Math.min(1, sh);
  };
  const refine = (mu) => {
    if (!mu) return null;
    const out = Float32Array.from(mu);
    const sh = new Float32Array(S * S), av = new Float32Array(S * S);
    for (let R = 0; R < H; R++) for (let C = 0; C < W; C++) for (let l = 0; l < nz; l++) {
      let sumShare = 0, sumMu = 0, sumOpen = 0, isHard = false, isDecid = false;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const q = sy * S + sx, f = (R * S + sy) * w + C * S + sx;
        sh[q] = share[f * nz + l]; av[q] = 1 - openShare(f, l);
        sumShare += sh[q]; sumMu += mu[f * nz + l]; sumOpen += 1 - av[q]; if (hard(f)) isHard = true; if (decid[f]) isDecid = true;
      }
      if (isHard || !(sumShare > 0 || (sumOpen > 0 && sumMu > 0))) continue; // a roof, or nothing the walk can say: the lidar as it is
      if (isDecid && sumMu > 0 && sumShare > 0) continue; // a deciduous crown seen leaf-off: its branches, not its leaves (THE LEAVES)
      const meanMu = sumMu / (S * S);
      /* where the density goes: where the walk saw plant, else where it did not see open air */
      const wts = sumShare > 0 ? sh : av;
      let sumW = 0; for (let q = 0; q < S * S; q++) sumW += wts[q];
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const q = sy * S + sx, c = C * S + sx, r = R * S + sy, i = (r * w + c) * nz + l;
        if (meanMu > 0) {
          out[i] = sumW > 0 ? Math.min(SOLID_MU, meanMu * wts[q] * (S * S) / sumW) : 0;
          if (mu === muL) { if (sumShare > 0) refined++; else if (out[i] === 0) trimmed++; }
        } else if (sh[q] > 0) { out[i] = Math.min(SOLID_MU, sh[q] * borrow(mu, c, r, l)); if (mu === muL) added++; }
      }
    }
    return out;
  };
  const mu = refine(muL), muOn = refine(muOnL);

  /* The fine grid's kinds and tops, from the lidar's (as placed) and the walk's plant. */
  const kindF = Uint8Array.from(placed), top = new Float32Array(w * h).fill(NaN);
  for (let f = 0; f < w * h; f++) {
    let hi = -1;
    for (let l = nz - 1; l >= 0; l--) if (mu[f * nz + l] > 0) { hi = l; break; }
    if (hi >= 0) { top[f] = z0 + (hi + 1) * dz - ground[f]; if (!kindF[f]) kindF[f] = 2; }
    else if (kindF[f] === 2 || kindF[f] === 3) kindF[f] = 0;
  }
  /* Per half-metre cell, what the walk did there: 1 it saw plant, 2 it saw open air and the lidar was trimmed. */
  const walk = new Uint8Array(w * h);
  for (let f = 0; f < w * h; f++) for (let l = 0; l < nz; l++) if (share[f * nz + l] > 0) { walk[f] = 1; break; }
  if (open) for (let f = 0; f < w * h; f++) if (!walk[f] && open[f] > 0 && muL) { for (let l = 0; l < nz; l++) if (muL[f * nz + l] > 0 && mu[f * nz + l] === 0) { walk[f] = 2; break; } }
  const out = {
    meta: {
      v: meta.v, tool: 'shade', build: meta.build, at: now.toISOString(), basedOn: meta.basedOn || null,
      fused: { version: FUSE_VERSION, from: 'the shade map\'s lidar model and one yard walk\'s plants (fuse.js)', lidarAt: meta.at, walk: plants.walk ?? null, walkAt: plants.at ?? null, walkFit: plants.fit || null, sub: S, walkInLeaf, refined, added, trimmed, seenOpen: !!open, seenOpenHigh: !!openHigh, moved },
      fences: meta.fences || [], grid, layers: { z0, dz, nz }, lidar: meta.lidar || null, photo: meta.photo || null, rule: meta.rule, leaves: meta.leaves,
    },
    arrays: { ground, kind: kindF, top, mu, walk },
  };
  if (muOn) out.arrays.muOn = muOn;
  return out;
}
