/**
 * THE LIDAR'S ROOF EDGES SLID ONTO A PHOTO'S, copied from the core session's tools/lidar-roof-fit.js
 * (default branch at 0eaed6d, 2026-10-20) on its advice: heightSurface, dropPoints and fitRoof, with
 * the constants they read, unchanged. The tool's node-only parts (the corpus, the pictures) are left
 * out. It reads the shade map's grid (./shade/grid.js) and public/lib/photo-fit.js, copied unchanged
 * as ./lib/photo-fit.js. Do not edit here; take a newer copy instead.
 *
 * The edges are the lidar's HEIGHT SURFACE where it drops 2 m or more across a 3 x 3 window -- an eave,
 * the edge of a crown -- never a cell-by-cell roof mask (the core's first run matched that mask's own
 * holes). A roof in a photo leans by its height, so this measures where the ROOF is in the picture;
 * the ground matcher (./shade/align.js) is the better ground number where it commits.
 */
import { fillGaps } from './shade/grid.js';
import { gradients, edgeFit, PEAK_MIN } from './lib/photo-fit.js';

export { PEAK_MIN };

/* The height surface for the edges: 0.5 m cells; an edge is a drop of DROP_MIN_M or more across a 3 x 3 window. */
export const HEIGHT_CELL_M = 0.5, DROP_MIN_M = 2;
/* The photo's edges on a quarter-metre grid; the search reaches 4 m each way. */
export const FIT_CELL_M = 0.25, REACH_M = 4;
export const MIN_EDGE_CELLS = 24; // a garage-sized roof has 24 edge metres

/**
 * Height above ground, per cell of `g`, from a rasterised grid: the top filled and lightly smoothed
 * (3 x 3), the ground filled from far round (a roof's middle has none). NaN where nothing came back.
 * Pure.
 */
export function heightSurface(r, g) {
  const top = fillGaps(r.zTop, g.w, g.h, 2), ground = fillGaps(r.zGround, g.w, g.h, 40);
  const h = new Float32Array(g.w * g.h).fill(NaN);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    let t = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= g.h || xx >= g.w) continue;
      const v = top[yy * g.w + xx];
      if (!Number.isNaN(v)) { t += v; n++; }
    }
    const i = y * g.w + x;
    if (n && !Number.isNaN(ground[i])) h[i] = t / n - ground[i];
  }
  return h;
}

/**
 * The crisp drops of a height surface as fit-grid points with their direction. A step in the
 * smoothed surface spans the two cells either side of the real edge (a third and two thirds of the
 * step), so the points are the MID-SLOPE cells: those whose 3 x 3 window drops at least DROP_MIN_M
 * and whose own height lies in the middle half of that drop. Pairs either side of the edge, so the
 * fit is not biased out or in. The direction is the surface's gradient. `scale` is fit cells per
 * height cell. Pure.
 */
export function dropPoints(h, w, hgt, scale) {
  const pts = [];
  for (let y = 1; y < hgt - 1; y++) for (let x = 1; x < w - 1; x++) {
    const v = h[y * w + x];
    if (Number.isNaN(v)) continue;
    let lo = Infinity, hi = -Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const u = h[(y + dy) * w + x + dx]; if (!Number.isNaN(u)) { if (u < lo) lo = u; if (u > hi) hi = u; } }
    const range = hi - lo;
    if (!(range >= DROP_MIN_M) || v < lo + 0.25 * range || v > hi - 0.25 * range) continue;
    const gx = (h[y * w + x + 1] || 0) - (h[y * w + x - 1] || 0), gy = (h[(y + 1) * w + x] || 0) - (h[(y - 1) * w + x] || 0);
    const L = Math.hypot(gx, gy);
    if (!(L > 0.5)) continue;
    pts.push([(x + 0.5) * scale, (y + 0.5) * scale, gx / L, gy / L]);
  }
  return pts;
}

/**
 * The shift that puts the lidar's height drops (eaves, crown edges) on the photo's edges: { east,
 * north } in ground metres (the move to add to the lidar), with edgeFit's peak and the edge count.
 * Null with too few edges. `grey` is the photo on the fit grid (Wg x Hg), `h` the height surface on
 * g (with g.cellM, its cell in ground metres). Pure.
 */
export function fitRoof(h, g, grey, Wg, Hg, k) {
  const scale = g.cellM / FIT_CELL_M;
  const pts = dropPoints(h, g.w, g.h, scale);
  if (pts.length < MIN_EDGE_CELLS) return null;
  const { gx, gy } = gradients(grey, Wg, Hg);
  const f = edgeFit(pts, gx, gy, Wg, Hg, Math.round(REACH_M / FIT_CELL_M));
  if (!f) return null;
  return { east: f.dx * FIT_CELL_M, north: -f.dy * FIT_CELL_M, peak: f.peak, score: f.s, at0: f.at0, edges: pts.length, confident: f.peak >= PEAK_MIN, k };
}
