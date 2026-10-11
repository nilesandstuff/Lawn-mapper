/**
 * TREE CROWNS FROM THE TOP OF THE CANOPY, AND THEIR SHAPE (shade map).
 *
 * The owner's suggestion (2026-10-11): the first returns show a tree's
 * shape, and shape can rule an evergreen out. A spruce or fir is a cone: its
 * top falls away fast from the tip. An open-grown oak or maple is a dome: flat
 * across the top for metres. On a leaf-off flight a big oak can still be
 * holding its dead leaves (the Kent flight was 27 November) and stop the
 * laser like needles; its shape gives it away.
 *
 * Crowns: local maxima of a pit-free canopy height model (1 m, the tallest
 * return per column, max then mean over 3 x 3), with a search radius that
 * grows with height, flooded downhill to every column over 2 m. Shape: from
 * the RAW points (smoothing flattens a cone's tip), the drop from the
 * crown's highest return to the highest return 1.5-2 m out from it.
 *
 * Measured by eye on one street (Rockford MI, Kent 2016 cloud, against the
 * leaf-off and the August 2022 NAIP photos, 2026-10-11 -- STILL ONE STREET):
 * lawn spruces dropped 1.0-3.5 m (median 2.2), open-grown oaks and maples
 * 0.0-0.8 m. Broadleaf trees crowded in a wood are narrow and pointed too
 * (2.4-3.1 m), so a steep top cannot rule an evergreen IN; a flat one rules
 * it out.
 */

import { cellOf } from './grid.js';

const NOISE = new Set([7, 18]);

/**
 * crownsOf(cols, model, { shift, top }) -> { lab (Int32 per column, -1 none),
 * crowns: [{ apex, H, R (equivalent radius, m), n, drop (m, NaN if too few
 * points) }] }. `top` is each column's tallest return over its ground (NaN
 * where none), as seasonal.js keeps it.
 */
export function crownsOf(cols, model, { shift = null, top, minH = 4, dropAt = [1.5, 2] } = {}) {
  const { grid, w, h, ground } = model;
  const N = w * h;
  const chm = new Float32Array(N);
  for (let k = 0; k < N; k++) chm[k] = Number.isFinite(top[k]) ? Math.max(0, top[k]) : 0;
  const mx = new Float32Array(N), sm = new Float32Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && chm[yy * w + xx] > m) m = chm[yy * w + xx];
    }
    mx[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += mx[yy * w + xx]; n++; }
    }
    sm[y * w + x] = s / n;
  }
  /* Tops: the highest column within a radius that grows with height
     (2 m for a small tree, 5 m for a 30 m one). */
  const apexes = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x, v = sm[k];
    if (v < minH) continue;
    const r = Math.max(2, Math.min(5, Math.round(0.12 * v + 1)));
    let ok = true;
    for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx, u = sm[j];
      if (u > v || (u === v && j < k)) { ok = false; break; }
    }
    if (ok) apexes.push(k);
  }
  /* Downhill: each column, tallest first, joins the crown of a neighbour no
     lower than itself less half a metre. */
  const lab = new Int32Array(N).fill(-1);
  apexes.forEach((k, i) => { lab[k] = i; });
  const order = [];
  for (let k = 0; k < N; k++) if (sm[k] >= 2 && lab[k] < 0) order.push(k);
  order.sort((a, b) => sm[b] - sm[a]);
  for (let pass = 0; pass < 3; pass++) for (const k of order) {
    if (lab[k] >= 0) continue;
    const x = k % w, y = (k / w) | 0;
    let best = -1, bh = -1;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (lab[j] >= 0 && sm[j] >= sm[k] - 0.5 && sm[j] > bh) { bh = sm[j]; best = lab[j]; }
    }
    if (best >= 0) lab[k] = best;
  }
  const crowns = apexes.map((k) => ({ apex: k, H: sm[k], n: 0, R: 0, drop: NaN }));
  for (let k = 0; k < N; k++) if (lab[k] >= 0) crowns[lab[k]].n++;
  for (const c of crowns) c.R = Math.sqrt(c.n / Math.PI);
  /* Shape from the raw points: each crown's highest return, then the
     highest return between dropAt[0] and dropAt[1] metres out from it. */
  const hi = crowns.map(() => null);
  const gx = new Float32Array(cols.n), gy = new Float32Array(cols.n), cr = new Int32Array(cols.n).fill(-1), over = new Float32Array(cols.n);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0 || lab[k] < 0) continue;
    const o = cols.z[i] - ground[k];
    if (o < 2 || o > 80) continue;
    gx[i] = (cols.x[i] + (shift ? shift[0] : 0) - grid.x0) / grid.cell;
    gy[i] = (grid.y1 - cols.y[i] - (shift ? shift[1] : 0)) / grid.cell;
    cr[i] = lab[k]; over[i] = o;
    if (!hi[lab[k]] || o > over[hi[lab[k]]]) hi[lab[k]] = i;
  }
  const ring = crowns.map(() => -Infinity); // grid cells are 1 m, so r is in metres
  for (let i = 0; i < cols.n; i++) {
    const id = cr[i];
    if (id < 0) continue;
    const a = hi[id], r = Math.hypot(gx[i] - gx[a], gy[i] - gy[a]);
    if (r >= dropAt[0] && r <= dropAt[1] && over[i] > ring[id]) ring[id] = over[i];
  }
  crowns.forEach((c, id) => { if (hi[id] !== null && Number.isFinite(ring[id])) c.drop = over[hi[id]] - ring[id]; });
  return { lab, crowns };
}
