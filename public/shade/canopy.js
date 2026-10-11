/**
 * THE PROPERTY AS SOMETHING LIGHT CAN PASS THROUGH (shade map).
 *
 * The lidar becomes a stack of 1 m cubes over the ground. For each cube,
 * how strongly it stops light -- an extinction coefficient mu per metre --
 * measured from the laser itself:
 *
 *   a pulse that reaches a cube either returns from it or carries on; the
 *   share that returns is the cube's interception. Counting each return as
 *   1 / (number of returns of its pulse) of a pulse (a pulse split three ways
 *   left a third of itself at each), the pulses ENTERING a cube from above
 *   are everything that came back from it or below it, ground included.
 *
 *     gap  P  = 1 - (returned here) / (entered here)
 *     mu      = -ln P / dz                           (Beer-Lambert)
 *
 * This is the voxel gap-fraction method of the forestry lidar literature
 * (e.g. Hopkinson & Chasmer 2007; Durrieu et al. 2008). With leaves at
 * random angles ("spherical" leaf angles, G = 0.5) a leaf intercepts the
 * same share of a beam from any direction, so the mu measured by a near-
 * vertical laser serves a slanting sunbeam per metre of path too.
 *
 * A ROOF stops every pulse that reaches it, so its gap is ~0 and it comes
 * out opaque; and since nothing got under it, the walls below it are taken
 * as solid too (the laser cannot see them, and leaving them empty would let
 * a low sun shine through the house). A CROWN lets some through, in
 * proportion to what the laser saw, and the space under it is left open.
 *
 * WHAT THIS CANNOT KNOW, said where it is used:
 *   - A LEAF-OFF flight (the flight's season comes from WESM) sees bare
 *     branches: broadleaf crowns read far more see-through than in summer.
 *     `opaqueCanopy` treats every crown as solid instead, the other bound.
 *   - At 2-8 pulses a square metre a 1 m column holds only a few pulses, so
 *     a column with fewer than `minPulses` borrows the 3 x 3 around it.
 *   - The laser and the photo may be years apart: trees grow and are felled.
 */

import { cellOf } from './grid.js';

const NOISE = new Set([7, 18]);
export const GRASS_M = 0.5; // nothing below this over the ground stops light reaching the grass blades' tops
const P_MIN = 0.01; // a cube can stop at most 99% of light per metre; roofs are several cubes of it
const MAX_OVER_M = 80; // nothing on a residential lot stands taller
const SOLID_BELOW = 0.03; // under a layer that let through less than this share of pulses, nothing was seen

/**
 * Build the model over `grid` (grid.js, cells ~1 m) from columns `cols`
 * (las.js), with `shift` [dx, dy] in 3857 m applied to every point.
 *
 * Returns { grid, w, h, dz, z0, nz, ground (Float32 per column, absolute m),
 *           mu (Float32 w*h*nz, per metre), top (highest cube with mu > 0, m) }.
 */
export function buildCanopy(cols, grid, { shift = null, dz = 1, opaqueCanopy = false, pool = 1, minPulses = 4 } = {}) {
  const { w, h } = grid;
  const N = w * h;

  /* Ground: the lowest ground return in each column, filled outward. */
  const ground = new Float32Array(N).fill(NaN);
  let zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const z = cols.z[i];
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    if (cols.cls[i] !== 2) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k >= 0 && !(ground[k] <= z)) ground[k] = z;
  }
  fillOut(ground, w, h);
  /* Columns with no ground anywhere near (a big roof) took their
     neighbours' ground from fillOut; if the whole grid had none, use the
     lowest return. */
  for (let k = 0; k < N; k++) if (Number.isNaN(ground[k])) ground[k] = zMin;

  /* Returns far above anything that grows (birds, haze, a stray echo) are
     dropped, or one of them would stretch the model hundreds of metres. */
  let zHigh = -Infinity;
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k >= 0 && cols.z[i] - ground[k] <= MAX_OVER_M && cols.z[i] > zHigh) zHigh = cols.z[i];
  }
  if (Number.isFinite(zHigh)) zMax = zHigh;
  const z0 = Math.floor(Math.min(...ground.filter(Number.isFinite)));
  const nz = Math.max(1, Math.ceil((zMax - z0) / dz) + 1);
  /* Pulse-weighted returns per cube; returns within GRASS_M of the ground
     reached the bottom and stop nothing: they go in `floor`, which counts
     only toward what ENTERED the cubes above. */
  const ret = new Float32Array(N * nz);
  const floor = new Float32Array(N);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    const z = cols.z[i];
    const wt = 1 / Math.max(1, cols.nret[i] || 1);
    if (z <= ground[k] + GRASS_M) { floor[k] += wt; continue; }
    if (z - ground[k] > MAX_OVER_M) continue;
    const layer = Math.min(nz - 1, Math.max(0, Math.floor((z - z0) / dz)));
    ret[k * nz + layer] += wt;
  }

  /* Pool over the columns around one only where it has too few pulses of
     its own: pooling everywhere would blur every roof edge by a metre and
     leak light under the eaves. */
  const pooled = pool > 0 ? boxSum(ret, w, h, nz, pool) : ret;
  const pooledFloor = pool > 0 ? boxSum(floor, w, h, 1, pool) : floor;
  const own = Float32Array.from(floor);
  for (let k = 0; k < N; k++) for (let l = 0; l < nz; l++) own[k] += ret[k * nz + l];

  const mu = new Float32Array(N * nz);
  let top = z0;
  for (let k = 0; k < N; k++) {
    /* From the bottom up: what entered a cube is what came back from it
       and from everything beneath it, the floor included. */
    const base = k * nz;
    const usePool = own[k] < minPulses;
    const src = usePool ? pooled : ret;
    let entered = usePool ? pooledFloor[k] : floor[k];
    for (let l = 0; l < nz; l++) {
      const here = src[base + l];
      entered += here;
      const zLow = z0 + l * dz;
      if (here <= 0 || entered <= 0) continue;
      const P = Math.max(P_MIN, 1 - here / entered);
      mu[base + l] = opaqueCanopy ? -Math.log(P_MIN) / dz : -Math.log(P) / dz;
      if (zLow + dz > top) top = zLow + dz;
    }
    /* UNDER WHAT NO PULSE GOT THROUGH, ASSUME SOLID. The laser sees a roof
       and nothing of the walls beneath it, so the space under a roof would
       otherwise be empty and a low sun would shine through the house. So
       from the highest layer under which fewer than SOLID_BELOW of the
       pulses got through, down to the grass, the column is opaque. A crown
       that lets light through is left as measured. */
    const total = entered;
    if (total >= minPulses * 0.5) {
      let below = total;
      for (let l = nz - 1; l >= 0; l--) {
        below -= src[base + l];
        if (src[base + l] > 0 && below / total < SOLID_BELOW) {
          for (let m = l; m >= 0; m--) {
            if (z0 + (m + 1) * dz <= ground[k] + GRASS_M) break;
            mu[base + m] = -Math.log(P_MIN) / dz;
          }
          break;
        }
      }
    }
  }
  return { grid, w, h, dz, z0, nz, ground, mu, top };
}

/** Fill NaN cells from their neighbours until none are left (or nothing changes). */
function fillOut(a, w, h) {
  for (let round = 0; round < 400; round++) {
    let left = 0;
    const src = Float32Array.from(a);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (!Number.isNaN(src[k])) continue;
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = src[yy * w + xx];
          if (!Number.isNaN(v)) { s += v; n++; }
        }
        if (n) a[k] = s / n; else left++;
      }
    }
    if (!left) return;
  }
}

/** Sum of each layer over the (2r+1)^2 columns around each column. */
function boxSum(a, w, h, nz, r) {
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * nz;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * nz;
          for (let l = 0; l < nz; l++) out[o + l] += a[i + l];
        }
      }
    }
  }
  return out;
}

/** Is the column solid just above the grass (inside a building, or under canopy nothing got through)? */
export function solidAtGrass(model, k) {
  const l = Math.floor((model.ground[k] + GRASS_M + 0.5 - model.z0) / model.dz);
  return l >= 0 && l < model.nz && model.mu[k * model.nz + l] >= SOLID_MU * 0.999;
}
const SOLID_MU = -Math.log(P_MIN);
