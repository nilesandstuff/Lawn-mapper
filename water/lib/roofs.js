/**
 * ROOFS, THE SHADE MAP'S WAY (water session, 2026-10-17). The features
 * session's building classifier, run on the water map's own grid, from its
 * modules copied unchanged into lib/shade/ (see its README), as it advised:
 *
 *   grid  = gridOver(box, 1, lat)        the water map's grid exactly (1 m, row 0 north)
 *   model = buildCanopy(cols, grid)      ground = lowest class-2 return per column, filled
 *   kind  = seasonalCanopy(cols, model, { classify: true }).kind     1 = ROOF
 *
 * No datum shift is passed: the water map works in the cloud's own frame.
 *
 * What decides a roof (the features session's summary): (a) H38's flat-roof
 * rule per column (3+ returns 2 m up, spanning under 1.5 m, no last return
 * near the ground), or (b) a column nothing gets through at the grass (a
 * pitched roof); then per patch, a TREE instead when a quarter of its
 * returns split, or it is under 4 m2, or under 60 m2 with a rough top; then
 * an eaves ring that widens a roof by up to 1 m.
 *
 * `parts` returns each stage separately, for scoring them one by one
 * (water/tools/impervious.mjs, FINDINGS H13).
 */

import { gridOver } from './shade/grid.js';
import { buildCanopy } from './shade/canopy.js';
import { seasonalCanopy } from './shade/seasonal.js';

const NOISE = new Set([7, 18]);

/** H38's flat-roof rule alone, per column, on the model's ground. */
function flatRule(cols, model) {
  const { grid, w, h, ground } = model, N = w * h;
  const n = new Uint16Array(N), last = new Uint16Array(N);
  const lo = new Float32Array(N).fill(Infinity), hi = new Float32Array(N).fill(-Infinity);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const c = Math.floor((cols.x[i] - grid.x0) / grid.cell), r = Math.floor((grid.y1 - cols.y[i]) / grid.cell);
    if (c < 0 || r < 0 || c >= w || r >= h) continue;
    const k = r * w + c, over = cols.z[i] - ground[k];
    if ((cols.ret[i] || 1) >= (cols.nret[i] || 1) && over < 0.5) last[k]++;
    if (over > 2 && over < 80) { n[k]++; lo[k] = Math.min(lo[k], cols.z[i]); hi[k] = Math.max(hi[k], cols.z[i]); }
  }
  const out = new Uint8Array(N);
  for (let k = 0; k < N; k++) out[k] = n[k] >= 3 && hi[k] - lo[k] < 1.5 && last[k] === 0 ? 1 : 0;
  return out;
}

/**
 * Roof masks on the grid of `bbox` (EPSG:3857) at `lat`: { roof } -- the
 * shade map's full classifier -- and with `parts`, also { flat, solid } (the
 * flat rule alone; flat or solid at the grass, before the tree test).
 */
export function shadeRoofs(cols, bbox, lat, { parts = false } = {}) {
  const grid = gridOver(bbox, 1, lat);
  const model = buildCanopy(cols, grid);
  const full = seasonalCanopy(cols, model, { classify: true }).kind;
  const roof = Uint8Array.from(full, (v) => (v === 1 ? 1 : 0));
  if (!parts) return { roof, w: grid.w, h: grid.h };
  const noTreeTest = seasonalCanopy(cols, model, { classify: false }).kind;
  return {
    roof, w: grid.w, h: grid.h,
    solid: Uint8Array.from(noTreeTest, (v) => (v === 1 ? 1 : 0)),
    flat: flatRule(cols, model),
  };
}
