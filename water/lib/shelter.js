/**
 * EACH SPOT'S OWN WIND (owner, 2026-10-27: "looking into wind so that we get true localized effects rather than broad
 * area averages"; FINDINGS H50, research-wind-local.md).
 *
 * For every lawn cell and each of 16 directions the wind comes from (three rays 7.5 degrees apart), what stands
 * upwind of it, out to 150 m, and what it does to the wind at the grass:
 *   - a fence, hedge, row or crown: the USDA wind-erosion model's fitted barrier curve (WEPS, Agric. Handbook 727,
 *     2020, eqs. 56-66; from Hagen et al. 1981, Raine & Stevenson 1977, Heisler & DeWalle 1988 and others), by
 *     distance in its heights and its porosity; within 5 heights upwind of one, its upwind branch. A wind more than
 *     60 degrees off a fence's face does no sheltering past 6 heights (Pena et al. 2016's full-scale fence).
 *   - a single crown lifted off the ground: the wind runs under it, no shelter for 3 tree heights, then the barrier
 *     curve (Mayaud et al. 2016); a crown's narrow wake spreads, its deficit times W / (W + 2x tan 6 deg) (WAsP).
 *   - a building: the lee cavity and wake of the Rockle zones (QUIC-URB; Fackrell 1984: Lr/H = 1.8 (W/H) /
 *     ((L/H)^0.3 (1 + 0.24 W/H)); u = u0 (1 - (dN/x)^1.5) out to 3 Lr), at 2 m; in front of it, the upwind eddy
 *     (Hosker 1984: Lf/H = 2 (W/H) / (1 + 0.8 W/H), 0.6 H tall).
 * Several obstacles: the strongest shelter is taken (WEPS's rule). Leaves on and off apart (crowns pass 0.2 of the
 * wind in leaf, 0.5 bare; evergreens 0.2), blended by month with the shade map's own leaf calendar; directions
 * weighted by the month's daytime wind from the local station (wind.js). The yard's mean is then held to Heisler
 * 1990's measured yards (balance.js windShare) by one factor per month (calibrate), so nothing is counted twice.
 */
import { FENCE_STYLES } from './shade/fences.js';

export const SHELTER = { rangeM: 150, rays: [-7.5, 0, 7.5], leafOn: 0.2, leafOff: 0.5, evergreen: 0.2, liftedM: 2.5, z: 2, cavity: 0.1, eddy: 0.3 };
const RAD = Math.PI / 180;

/** WEPS: the share of the open wind at x barrier heights downwind (negative: upwind) of a barrier of porosity p. */
export function weps(x, p) {
  const P = Math.max(0, Math.min(0.8, p));
  const m = 0.008 - 0.17 * P + 0.17 * P ** 1.05, n = 1.35 * Math.exp(-0.5 * P ** 0.2), s = 10 * (1 - 0.5 * P), t = 3 - P;
  if (x < -5 || x > 35) return 1;
  return Math.max(0, Math.min(1, 1 - Math.exp(-m * x * x) + n * Math.exp(-0.003 * Math.max(0, x + s) ** t)));
}
/** WEPS's effective porosity of a barrier `xbr` of its heights deep. */
export const effPorosity = (p, xbr) => p + (1 - Math.exp(-0.5 * Math.max(0, xbr))) ** 0.3 * (1 - p);

/** A building H tall, W across the wind, L along it: the share of the wind at 2 m, x m downwind of its lee wall. */
export function buildingLee(x, H, W, L, z = SHELTER.z) {
  if (H <= z + 0.5) return weps(x / Math.max(1, H), 0);
  const w = W / H, Lr = (H * 1.8 * w) / ((Math.max(0.2, L / H)) ** 0.3 * (1 + 0.24 * w));
  const dN = Lr * Math.sqrt(1 - (z / H) ** 2);
  if (x < dN) return SHELTER.cavity;
  if (x < 3 * dN) return Math.max(SHELTER.cavity, 1 - (dN / x) ** 1.5);
  return 1;
}
/** In front of a building: inside its upwind eddy at 2 m (x m upwind of its face), or not. */
export function buildingFront(x, H, W, z = SHELTER.z) {
  const hE = 0.6 * H;
  if (z >= hE) return 1;
  const Lf = (H * 2 * (W / H)) / (1 + 0.8 * (W / H));
  return x < Lf * Math.sqrt(1 - (z / hE) ** 2) ? SHELTER.eddy : 1;
}

/**
 * The obstacles on one grid: { W, H, kind (0 open, 1 building, 2 evergreen, 3 deciduous), height (m), base (m, a
 * crown's underside) }, cells 1 m; fences: the shade map's lengths on this grid (fences.js fencesOnGrid: ax, ay, bx,
 * by, h, style, nE, nN). cells: indices of the cells to work out, with (ox, oy) their offset into this grid.
 * -> { on: Float32Array(cells x 16), off: Float32Array(cells x 16) } -- the share of the open wind from each direction
 *    (0 = from the north, clockwise), leaves on and off.
 */
export function shelterByDirection(grid, cells, gridW, ox, oy, fences = [], opts = SHELTER) {
  const { W, H, kind, height, base } = grid;
  const n = cells.length, on = new Float32Array(n * 16), off = new Float32Array(n * 16);
  const at = (x, y) => { const c = Math.floor(x), r = Math.floor(y); return c < 0 || r < 0 || c >= W || r >= H ? -1 : r * W + c; };
  // how far across an obstacle runs at (x, y), perpendicular to the ray (px, py), in metres (both ways, up to 40 m)
  const across = (x, y, px, py, isB) => {
    let w = 1;
    for (const sgn of [1, -1]) for (let s = 1; s <= 20; s++) { const j = at(x + sgn * px * s, y + sgn * py * s); if (j < 0 || !(isB ? kind[j] === 1 : kind[j] >= 2)) break; w++; }
    return w;
  };
  const fz = fences.map((f) => ({ ...f, p: FENCE_STYLES[f.style]?.wind ?? 0 }));
  for (let q = 0; q < n; q++) {
    const i = cells[q], cx = (i % gridW) + ox + 0.5, cy = Math.floor(i / gridW) + oy + 0.5;
    for (let d = 0; d < 16; d++) {
      let sOn = 0, sOff = 0;
      for (const dr of opts.rays) {
        const th = (d * 22.5 + dr) * RAD;
        const ux = Math.sin(th), uy = -Math.cos(th); // toward where the wind comes from (grid y runs south)
        let bestOn = 1, bestOff = 1;
        const take = (vOn, vOff) => { if (vOn < bestOn) bestOn = vOn; if (vOff < bestOff) bestOff = vOff; };
        // upwind: march out, one object at a time
        let t = 1;
        while (t <= opts.rangeM) {
          const j = at(cx + ux * t, cy + uy * t);
          if (j < 0) break;
          const k = kind[j];
          if (!k || height[j] < 1.5) { t++; continue; }
          const isB = k === 1, x = t;
          let Hm = height[j], depth = 0, lowest = base[j], ever = k === 2;
          while (t <= opts.rangeM) { const jj = at(cx + ux * t, cy + uy * t); if (jj < 0 || !(isB ? kind[jj] === 1 : kind[jj] >= 2)) break; Hm = Math.max(Hm, height[jj]); lowest = Math.min(lowest, base[jj]); ever ||= kind[jj] === 2; depth++; t++; }
          const Wd = across(cx + ux * x, cy + uy * x, -uy, ux, isB);
          if (isB) { const v = buildingLee(x - 0.5, Hm, Wd, depth); take(v, v); }
          else {
            const g = Wd / (Wd + 2 * x * Math.tan(6 * RAD));
            const lifted = lowest >= opts.liftedM && depth <= 2 * Hm;
            const val = (p) => {
              const xs = lifted ? (x - 3 * Hm) / Hm : x / Hm;
              if (lifted && xs < 0) return 1;
              const s = weps(xs, effPorosity(p, depth / Hm));
              return 1 - (1 - s) * g;
            };
            take(val(ever ? opts.evergreen : opts.leafOn), val(ever ? opts.evergreen : opts.leafOff));
          }
          if (bestOn < 0.05 && bestOff < 0.05) break;
        }
        // downwind, near: in front of a building's face, or within 5 heights upwind of a crown
        for (let s = 1; s <= 40; s++) {
          const j = at(cx - ux * s, cy - uy * s);
          if (j < 0) break;
          const k = kind[j];
          if (!k || height[j] < 1.5) continue;
          if (k === 1) { const v = buildingFront(s - 0.5, height[j], across(cx - ux * s, cy - uy * s, -uy, ux, true)); take(v, v); }
          else { const pOn = k === 2 ? opts.evergreen : opts.leafOn, pOff = k === 2 ? opts.evergreen : opts.leafOff; take(weps(-s / height[j], pOn), weps(-s / height[j], pOff)); }
          break;
        }
        // fences, as drawn (lengths on this grid)
        for (const f of fz) {
          const dx = f.bx - f.ax, dy = f.by - f.ay;
          for (const dir of [1, -1]) { // 1: the fence upwind of the cell (its lee); -1: downwind (its upwind side)
            const hx = ux * dir, hy = uy * dir, den = hx * dy - hy * dx;
            if (Math.abs(den) < 1e-9) continue;
            const qx = f.ax - cx, qy = f.ay - cy;
            const tt = (qx * dy - qy * dx) / den, v = (qx * hy - qy * hx) / den;
            if (tt <= 0 || v < 0 || v > 1) continue;
            const xh = tt / f.h;
            if (dir === 1) {
              const cosPhi = Math.abs(ux * f.nE + -uy * f.nN); // the wind against the fence's normal
              if (cosPhi < 0.5 && xh > 6) continue;
              const s2 = weps(xh, f.p); take(s2, s2);
            } else if (xh <= 5) { const s2 = weps(-xh, f.p); take(s2, s2); }
          }
        }
        sOn += bestOn; sOff += bestOff;
      }
      on[q * 16 + d] = sOn / opts.rays.length; off[q * 16 + d] = sOff / opts.rays.length;
    }
  }
  return { on, off };
}

/** Each month's share of the open wind per cell: the directions weighted by the month's daytime wind (rose: 16 shares,
    or even without one), leaves on by the month's share (leaf[m], 0-1). -> [12 Float32Array(n)] */
export function monthlyShelter({ on, off }, n, roses, leaf) {
  return Array.from({ length: 12 }, (_, m) => {
    const w = roses?.[m]?.length === 16 && roses[m].some((v) => v > 0) ? roses[m] : new Array(16).fill(1 / 16);
    const tot = w.reduce((a, b) => a + b, 0) || 1, L = Math.max(0, Math.min(1, leaf?.[m] ?? 1));
    const out = new Float32Array(n);
    for (let q = 0; q < n; q++) { let s = 0; for (let d = 0; d < 16; d++) s += w[d] * (L * on[q * 16 + d] + (1 - L) * off[q * 16 + d]); out[q] = s / tot; }
    return out;
  });
}

/** Held to Heisler's measured yards: each month's factors scaled so the lawn's mean is his figure for the cover round
    it (yard, 0-1), the scale kept between that figure and 1 (shelter never undone, never doubled). */
export function calibrate(months, yard) {
  return months.map((F) => {
    let s = 0; for (const v of F) s += v;
    const mean = F.length ? s / F.length : 1;
    const B = Math.max(yard, Math.min(1, mean > 0 ? yard / mean : 1));
    return { B, F: Float32Array.from(F, (v) => Math.max(0.05, v * B)) };
  });
}
