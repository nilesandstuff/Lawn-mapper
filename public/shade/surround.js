/**
 * THE BLOCK AROUND THE LOT, COARSELY (core session, 2026-11-06, for the AR:
 * "14-29% of the pictures' skyline rays leave [the model's grid] within
 * 100 m. If the model could carry the surrounding block's `ground` and `top`
 * ... the skyline would stop guessing at the edge").
 *
 * The lot's own model stays as it is. This reads the same cloud, with the
 * same shift, over a box AROUND_M wider each way, thinned to about one point
 * a square meter (ept.js pointsIn spacingM: only the octree's coarse levels,
 * so a phone downloads a fraction of the full density), flags its strays
 * (structures.js flagStrays, so a bird does not make a tower), and grids it
 * at CELL_M:
 *   ground  Float32  the mean height of the cell's ground returns (class 2),
 *                    absolute m; where a cell has none (under a roof, a
 *                    crown), filled from its neighbours (ground.js inpaint)
 *   top     Float32  the highest non-noise return over that ground, m; 0
 *                    where nothing stands
 * The page reads it once the lot's model is built and writes it into the
 * model file (model-out.js `surround`) with a second save; a failure costs
 * nothing but the arrays.
 */

import { gridOver, cellOf } from './grid.js';
import { mercScale } from './ept.js';
import { NOISE, flagStrays } from './structures.js';
import { inpaint } from './ground.js';

export const AROUND_M = 100;
export const CELL_M = 2;
export const SPACING_M = 1;

/** The lot's box (EPSG:3857) widened by `aroundM` real meters each way. */
export function surroundBox(box, lat, aroundM = AROUND_M) {
  const d = aroundM / mercScale(lat);
  return [box[0] - d, box[1] - d, box[2] + d, box[3] + d];
}

/** { grid, ground, top } at `cellM` over `box` from `cols` (flags their strays in place). */
export function surroundGrids(cols, box, lat, { shift = null, cellM = CELL_M } = {}) {
  const grid = gridOver(box, cellM, lat);
  const N = grid.w * grid.h;
  flagStrays(cols, grid, { shift, cellM });
  const gs = new Float64Array(N), gn = new Uint32Array(N), hi = new Float32Array(N).fill(-Infinity), lo = new Float32Array(N).fill(Infinity);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    const z = cols.z[i];
    if (cols.cls[i] === 2) { gs[k] += z; gn[k]++; }
    if (z > hi[k]) hi[k] = z;
    if (z < lo[k]) lo[k] = z;
  }
  const g0 = new Float32Array(N);
  let any = false;
  for (let k = 0; k < N; k++) { g0[k] = gn[k] ? gs[k] / gn[k] : NaN; if (gn[k]) any = true; }
  /* no ground class anywhere (an unclassified cloud): the lowest return per cell stands in */
  if (!any) for (let k = 0; k < N; k++) g0[k] = Number.isFinite(lo[k]) ? lo[k] : NaN;
  const ground = inpaint(grid, g0);
  const top = new Float32Array(N);
  for (let k = 0; k < N; k++) top[k] = Number.isFinite(hi[k]) && Number.isFinite(ground[k]) ? Math.max(0, hi[k] - ground[k]) : 0;
  return { grid, ground, top, cellM, aroundM: null };
}

/**
 * Read and grid the surround: `url` the cloud the lot was built from, `box`
 * the lot model's box, `shift` its line-up, `io` the page's readers,
 * `pointsIn` ept.js's. Resolves to surroundGrids' answer, or null.
 */
export async function readSurround({ url, box, lat, shift, io, pointsIn, aroundM = AROUND_M, spacingM = SPACING_M, cellM = CELL_M }) {
  const wide = surroundBox(box, lat, aroundM);
  const got = await pointsIn(url, wide, io, { spacingM, lat });
  if (!got?.cols?.n) return null;
  const s = surroundGrids(got.cols, wide, lat, { shift, cellM });
  s.aroundM = aroundM;
  s.points = got.cols.n;
  return s;
}
