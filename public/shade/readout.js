/**
 * What the light map shows and what a pin or a box reads off it (shade map).
 *
 * The worker answers per sample point (every 0.5 m for a day, every 1 m for
 * the season). For the map those answers go into a raster at 0.5 m, are
 * smoothed over about a meter -- the lidar is 1 m, so finer detail is noise
 * -- and colored in at most seven bands with round edges. A pin and a box
 * read the same smoothed raster, so they report what the colors show.
 */

/* Sunlight is semantic heat: dark and cool in shade, bright and warm in sun.
   Matplotlib's inferno, which runs the full lightness range and stays in
   order for color-blind readers. */
export const HEAT = ['#000004', '#1f0c48', '#550f6d', '#88226a', '#ba3655', '#e35933', '#f98e09', '#f8c931', '#fcffa4']
  .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

export function heat(t) {
  const x = Math.min(1, Math.max(0, t)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x)), f = x - i;
  return HEAT[i].map((v, j) => Math.round(v + (HEAT[i + 1][j] - v) * f));
}

export const MAX_BANDS = 7;

/** The round step that cuts 0..top into at most `most` bands. */
export function niceStep(top, most = MAX_BANDS) {
  if (!(top > 0)) return 1;
  for (let p = Math.floor(Math.log10(top / most)) - 1; ; p++) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * 10 ** p;
      if (Math.ceil(top / step - 1e-9) <= most) return step;
    }
  }
}

/**
 * Bands from 0 to `top`: { step, n, edges (n + 1 of them), colors (one per
 * band, the ramp's ends included), of(value) -> band index }. `step` fixes
 * the step (hours of sun go by the hour: owner, 2026-10-11); otherwise the
 * round step that gives at most MAX_BANDS.
 */
export function bandsFor(top, { step: fixed } = {}) {
  const step = fixed > 0 ? fixed : niceStep(top);
  const n = Math.max(1, Math.ceil(top / step - 1e-9));
  const edges = Array.from({ length: n + 1 }, (_, i) => +(i * step).toFixed(6));
  const colors = Array.from({ length: n }, (_, i) => heat(n === 1 ? 1 : i / (n - 1)));
  const of = (v) => Math.min(n - 1, Math.max(0, Math.floor(v / step + 1e-9)));
  return { step, n, edges, colors, of };
}

/**
 * The sample answers as a raster W x H (cells of `per` raster pixels in the
 * model grid's cell units: xy * per), each value covering span x span
 * pixels; empty pixels NaN.
 */
export function rasterOf(values, xy, W, H, { per = 2, span = 1 } = {}) {
  const r = new Float32Array(W * H).fill(NaN);
  for (let p = 0; p < values.length; p++) {
    const x = Math.floor(xy[2 * p] * per), y = Math.floor(xy[2 * p + 1] * per);
    for (let j = 0; j < span; j++) for (let i = 0; i < span; i++) {
      const xx = x + i, yy = y + j;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) r[yy * W + xx] = values[p];
    }
  }
  return r;
}

/**
 * Smoothed: `passes` passes of a 3 x 3 mean over the pixels that have a
 * value. Empty pixels stay empty and lend nothing, so a house's edge does
 * not bleed into the lawn's numbers.
 */
export function smooth(r, W, H, passes = 2) {
  let a = r;
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(W * H).fill(NaN);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (Number.isNaN(a[y * W + x])) continue;
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const v = a[yy * W + xx];
        if (!Number.isNaN(v)) { s += v; n++; }
      }
      b[y * W + x] = s / n;
    }
    a = b;
  }
  return a;
}

/** The value at raster pixel (x, y), or the nearest within `reach` pixels; NaN if none. */
export function valueAt(r, W, H, x, y, reach = 1) {
  x = Math.floor(x); y = Math.floor(y);
  let best = NaN, bestD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
    const xx = x + dx, yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const v = r[yy * W + xx], d = dx * dx + dy * dy;
    if (!Number.isNaN(v) && d < bestD) { best = v; bestD = d; }
  }
  return best;
}

/**
 * Over the pixels of a box (raster pixel corners, any order) that hold a
 * value: { n, min, max, mean }, or n 0. `counts` (optional) also tallies
 * whole values, for the categorical "Trees" view.
 */
export function boxStats(r, W, H, [x0, y0, x1, y1], { counts = false } = {}) {
  const xa = Math.max(0, Math.floor(Math.min(x0, x1))), xb = Math.min(W - 1, Math.floor(Math.max(x0, x1)));
  const ya = Math.max(0, Math.floor(Math.min(y0, y1))), yb = Math.min(H - 1, Math.floor(Math.max(y0, y1)));
  let n = 0, s = 0, min = Infinity, max = -Infinity;
  const tally = counts ? {} : null;
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
    const v = r[y * W + x];
    if (Number.isNaN(v)) continue;
    n++; s += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (tally) tally[v] = (tally[v] || 0) + 1;
  }
  return n ? { n, min, max, mean: s / n, tally } : { n: 0, tally };
}
