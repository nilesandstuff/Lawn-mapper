/**
 * THE GROUND, ONE PIECE OF CODE FOR THE SHADE MAP AND THE WATER MAP (owner,
 * 2026-10-17: "copy the shade map's way of building the ground on a 3d
 * plane. Make sure your system is the exact same as the shade map").
 *
 * The water session measured the two maps' grounds on six 160 m squares
 * (water/FINDINGS.md): the shade map's, the LOWEST class-2 return in each
 * 1 m column, sits 1-3 cm low and is 1.5-2.6 cm rough cell to cell (the
 * lowest of a few noisy returns is biased low); the water map's, a
 * Gaussian-weighted MEAN of the class-2 returns within 2 m of the cell's
 * centre (sigma 0.8 m), is 0.4-0.9 cm rough with an error bar per cell.
 * The water map needs the smooth one (its job is telling 3-5 cm dips from
 * noise); to the light 2 cm is nothing. So this is the water map's ground,
 * copied from water/lib/surface.js (groundSurface, inpaint) onto the shade
 * map's grid (grid.js gridOver: cells one real metre on a side, row 0
 * north) with the shade map's shift applied at the input, as cellOf does.
 * The water map copies this file back unchanged.
 *
 *   groundSurface(cols, grid, { shift })
 *     -> { z (Float32 per cell, NaN where no ground point lies within
 *          `radius`), se (the standard error of z: the points' local
 *          scatter over the square root of their effective count), sd, n }
 *   inpaint(grid, z) -> z with every NaN filled from its neighbours, outward
 *
 * Cells are one real metre, so a distance in cells is a distance in metres.
 * Noise classes (7, 18) are never ground; only class 2 is.
 */

export const KERNEL_SIGMA = 0.8;
export const KERNEL_RADIUS = 2.0;

/** The point's position in cells (x east, y south from the grid's north-west corner), shift applied. */
function cellXY(grid, x, y, shift) {
  const cellY = grid.cellY || grid.cell;
  return [((x + (shift ? shift[0] : 0)) - grid.x0) / grid.cell, (grid.y1 - (y + (shift ? shift[1] : 0))) / cellY];
}

/** Indices of the class-2 points in each cell (a bucket per cell, as a CSR list), with their positions in cells. */
function buckets(grid, cols, shift) {
  const W = grid.w, H = grid.h, N = W * H;
  const count = new Uint32Array(N + 1);
  const cellOf = new Int32Array(cols.n).fill(-1);
  const px = new Float32Array(cols.n), py = new Float32Array(cols.n);
  for (let i = 0; i < cols.n; i++) {
    if (cols.cls[i] !== 2) continue;
    const [fc, fr] = cellXY(grid, cols.x[i], cols.y[i], shift);
    px[i] = fc; py[i] = fr;
    const c = Math.floor(fc), r = Math.floor(fr);
    if (c < 0 || r < 0 || c >= W || r >= H) continue;
    cellOf[i] = r * W + c;
    count[cellOf[i] + 1]++;
  }
  for (let j = 0; j < N; j++) count[j + 1] += count[j];
  const fill = count.slice(0, N);
  const idx = new Uint32Array(count[N]);
  for (let i = 0; i < cols.n; i++) if (cellOf[i] >= 0) idx[fill[cellOf[i]]++] = i;
  return { start: count, idx, px, py };
}

/**
 * The ground surface over `grid` from the columns `cols` (las.js), `shift`
 * [dx, dy] in 3857 units added to every point. `scatterFloor` keeps a cell
 * built from two points that happen to agree from claiming millimetres.
 */
export function groundSurface(cols, grid, { shift = null, sigma = KERNEL_SIGMA, radius = KERNEL_RADIUS, scatterFloor = 0.012 } = {}) {
  const W = grid.w, H = grid.h, N = W * H;
  const { start, idx, px, py } = buckets(grid, cols, shift);
  const z = new Float32Array(N).fill(NaN), se = new Float32Array(N).fill(NaN), sd = new Float32Array(N).fill(NaN), n = new Uint16Array(N);
  const reach = Math.ceil(radius), r2 = radius * radius, inv2s2 = 1 / (2 * sigma * sigma);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const cx = c + 0.5, cy = r + 0.5;
      let sw = 0, sw2 = 0, swz = 0, swzz = 0, m = 0;
      for (let rr = Math.max(0, r - reach); rr <= Math.min(H - 1, r + reach); rr++) {
        for (let cc = Math.max(0, c - reach); cc <= Math.min(W - 1, c + reach); cc++) {
          const j = rr * W + cc;
          for (let p = start[j]; p < start[j + 1]; p++) {
            const i = idx[p];
            const d2 = (px[i] - cx) * (px[i] - cx) + (py[i] - cy) * (py[i] - cy);
            if (d2 > r2) continue;
            const w = Math.exp(-d2 * inv2s2);
            sw += w; sw2 += w * w; swz += w * cols.z[i]; swzz += w * cols.z[i] * cols.z[i]; m++;
          }
        }
      }
      const at = r * W + c;
      n[at] = Math.min(m, 65535);
      if (sw < 1e-3) continue;
      const mean = swz / sw, neff = (sw * sw) / sw2;
      const scatter = Math.sqrt(Math.max(0, swzz / sw - mean * mean));
      z[at] = mean; sd[at] = scatter;
      se[at] = Math.max(scatter, scatterFloor) / Math.sqrt(Math.max(1, neff));
    }
  }
  return { z, se, sd, n, sigma };
}

/** Fill NaN cells from their neighbours, outward, so every cell has a height (under a roof, the ground around it). */
export function inpaint(grid, z) {
  const W = grid.w, H = grid.h;
  const out = Float32Array.from(z);
  let todo = [];
  for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) todo.push(i);
  for (let pass = 0; todo.length && pass < 500; pass++) {
    const next = [], set = [];
    for (const i of todo) {
      const r = Math.floor(i / W), c = i % W;
      let s = 0, k = 0;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const v = out[rr * W + cc];
        if (!Number.isNaN(v)) { s += v; k++; }
      }
      if (k) set.push([i, s / k]); else next.push(i);
    }
    for (const [i, v] of set) out[i] = v;
    todo = next;
  }
  return out;
}

/** The ground every cell: the smooth surface, filled; the lowest return of all where no ground point exists at all. */
export function groundOf(cols, grid, { shift = null } = {}) {
  const g = groundSurface(cols, grid, { shift });
  const z = inpaint(grid, g.z);
  let zMin = Infinity;
  for (let i = 0; i < cols.n; i++) if (cols.cls[i] !== 7 && cols.cls[i] !== 18 && cols.z[i] < zMin) zMin = cols.z[i];
  for (let k = 0; k < z.length; k++) if (Number.isNaN(z[k])) z[k] = Number.isFinite(zMin) ? zMin : 0;
  return { z, raw: g.z, se: g.se, sd: g.sd, n: g.n };
}
