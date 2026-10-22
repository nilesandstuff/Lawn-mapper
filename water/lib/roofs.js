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
  const evergreen = Uint8Array.from(full, (v) => (v === 2 ? 1 : 0));
  if (!parts) return { roof, evergreen, w: grid.w, h: grid.h };
  const noTreeTest = seasonalCanopy(cols, model, { classify: false }).kind;
  return {
    roof, evergreen, w: grid.w, h: grid.h,
    solid: Uint8Array.from(noTreeTest, (v) => (v === 1 ? 1 : 0)),
    flat: flatRule(cols, model),
  };
}

/*
 * ROOFS THE CORE SESSION'S WAY (owner, 2026-10-22: "We already have lidar in the water map, can't you use the
 * same setup as the core session for finding roofs? Yes I want to drop overture buildings").
 *
 * The rule the detector's training uses (tools/lidar_frame.py masks_from, thresholds fixed 2026-09-25), on its
 * own 2 m cells: no pulse reached the ground, three returns or more, the top 2.5 m or more over the ground,
 * every return within 1.5 m of the others. A crown lets pulses through and spreads its returns down through
 * the branches; a roof does neither. The core measured that this mask sits INSIDE the roof on every lot it
 * checked (DETECTOR-FINDINGS H111), so here the 2 m cells are then fitted to the water map's 1 m grid:
 *   trimmed   a 1 m cell of a roof cell whose own top is under 2 m over the ground and the ground was hit
 *   grown     a 1 m cell beside the roof the laser never got through, 2.5 m+ up, its returns within 1.5 m
 *             (two rounds: the eaves the 2 m cells cut off)
 *   filled    a 1 m cell nothing came back from, with roof on three sides or more
 * grid g: the water map's (lib/surface.js gridFor: W, H, toCell); cols: its points; zGround: its ground (filled).
 */
export const ROOF_MIN_M = 2.5, ROOF_SPREAD_M = 1.5, ROOF_MIN_RETURNS = 3, ROOF_TRIM_M = 2.0;
export function coreRoofs(g, cols, zGround, { grow = 2, strayGround = 0, growSpread = ROOF_SPREAD_M } = {}) {
  const W = g.W, H = g.H, N = W * H, W2 = Math.ceil(W / 2), H2 = Math.ceil(H / 2), N2 = W2 * H2;
  const n1 = new Uint16Array(N), ng1 = new Uint16Array(N), top1 = new Float32Array(N).fill(-Infinity), lo1 = new Float32Array(N).fill(Infinity);
  const n2 = new Uint16Array(N2), ng2 = new Uint16Array(N2), top2 = new Float32Array(N2).fill(-Infinity), lo2 = new Float32Array(N2).fill(Infinity);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const [fc, fr] = g.toCell(cols.x[i], cols.y[i]);
    const c = Math.floor(fc), r = Math.floor(fr);
    if (c < 0 || r < 0 || c >= W || r >= H) continue;
    const k = r * W + c, k2 = (r >> 1) * W2 + (c >> 1), z = cols.z[i], gr = cols.cls[i] === 2;
    n1[k]++; if (gr) ng1[k]++; if (z > top1[k]) top1[k] = z; if (z < lo1[k]) lo1[k] = z;
    n2[k2]++; if (gr) ng2[k2]++; if (z > top2[k2]) top2[k2] = z; if (z < lo2[k2]) lo2[k2] = z;
  }
  // each 2 m cell's ground: the mean of its 1 m cells' (filled) ground
  const g2 = new Float32Array(N2), gn = new Uint8Array(N2);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const v = zGround[r * W + c]; if (Number.isFinite(v)) { const k2 = (r >> 1) * W2 + (c >> 1); g2[k2] += v; gn[k2]++; } }
  const roof2 = new Uint8Array(N2);
  for (let k = 0; k < N2; k++) {
    if (!gn[k] || ng2[k] || n2[k] < ROOF_MIN_RETURNS) continue;
    if (top2[k] - g2[k] / gn[k] >= ROOF_MIN_M && top2[k] - lo2[k] <= ROOF_SPREAD_M) roof2[k] = 1;
  }
  const roof = new Uint8Array(N);
  const over = (k) => (n1[k] && Number.isFinite(zGround[k]) ? top1[k] - zGround[k] : NaN);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c;
    if (!roof2[(r >> 1) * W2 + (c >> 1)]) continue;
    const h = over(k);
    roof[k] = ng1[k] && Number.isFinite(h) && h < ROOF_TRIM_M ? 0 : 1;
  }
  const nb = (k) => { const c = k % W, r = (k - c) / W; return [c > 0 ? k - 1 : -1, c < W - 1 ? k + 1 : -1, r > 0 ? k - W : -1, r < H - 1 ? k + W : -1].filter((j) => j >= 0); };
  for (let round = 0; round < grow; round++) {
    const add = [];
    for (let k = 0; k < N; k++) {
      if (roof[k] || ng1[k] > strayGround || !n1[k]) continue;
      const h = over(k);
      if (!(h >= ROOF_MIN_M) || top1[k] - lo1[k] > growSpread) continue;
      if (nb(k).some((j) => roof[j])) add.push(k);
    }
    for (const k of add) roof[k] = 1;
  }
  for (let k = 0; k < N; k++) if (!roof[k] && !n1[k] && nb(k).filter((j) => roof[j]).length >= 3) roof[k] = 1;
  return roof;
}
