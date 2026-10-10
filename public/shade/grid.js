/**
 * THE POINT CLOUD ON A GRID (shade map, features session).
 *
 * A grid here is a rectangle in EPSG:3857 cut into square cells:
 *
 *   { x0, y1, cell, w, h, lat }    x0 = west edge, y1 = NORTH edge, rows run
 *                                  north to south like a photo's; cell is in
 *                                  web-mercator metres (see ept.js on metres)
 *
 * Rasterised per cell, from the points and nothing inferred:
 *
 *   n         every return
 *   nGround   returns classed ground (class 2)
 *   iGround   mean intensity of the ground returns -- a true top-down picture
 *             of the ground with nothing leaning, which is what is lined up
 *             with the photo (align.js)
 *   zGround   lowest ground return (the terrain)
 *   zTop      highest return of any kind (roofs, crowns: the surface)
 *   iLow      mean intensity of every return within `lowM` of the cell's
 *             lowest -- the ground PLUS the grass, which most 3DEP
 *             deliveries leave unclassified (class 1) rather than ground:
 *             about twice the ground returns, which is what a sparse
 *             cloud's picture of the ground needs. Two passes.
 *   nFirstOfMany  first returns of a pulse that went on to return again --
 *             it hit something it did not stop at: a crown's leaves or
 *             branches, a wire, a roof's edge. Kept now because canopy
 *             thickness is what the shade model will be built on.
 *
 * Class 7 and 18 (noise) are left out of everything.
 */

import { toMerc, mercScale } from './ept.js';

const NOISE = new Set([7, 18]);

/** A grid over a 3857 box, cells `cellM` REAL metres on a side at latitude `lat`. */
export function gridOver(bbox, cellM, lat) {
  const cell = cellM / mercScale(lat);
  const w = Math.max(1, Math.round((bbox[2] - bbox[0]) / cell));
  const h = Math.max(1, Math.round((bbox[3] - bbox[1]) / cell));
  return { x0: bbox[0], y1: bbox[3], cell, w, h, lat };
}

/**
 * The grid exactly covering a site imagery frame ({lng, lat, zoom, size,
 * height}, as /api/imagery takes it), `cols` x `rows` cells. Web-mercator
 * pixels are linear in 3857 metres, so the corners say it all.
 */
export function gridForFrame(frame, cols, rows) {
  const R = 6378137;
  const worldM = 2 * Math.PI * R;
  const perPx = worldM / (512 * 2 ** frame.zoom); // 3857 metres per logical px
  const [cx, cy] = toMerc([frame.lng, frame.lat]);
  const W = frame.size * perPx, H = (frame.height || frame.size) * perPx;
  return { x0: cx - W / 2, y1: cy + H / 2, cell: W / cols, cellY: H / rows, w: cols, h: rows, lat: frame.lat };
}

/** The 3857 box of a grid. */
export const gridBox = (g) => [g.x0, g.y1 - g.h * (g.cellY || g.cell), g.x0 + g.w * g.cell, g.y1];

/** Column and row of a 3857 point, or -1 outside. Optional shift [dx, dy] in 3857 m. */
export function cellOf(g, x, y, shift = null) {
  const sx = shift ? x + shift[0] : x, sy = shift ? y + shift[1] : y;
  const c = Math.floor((sx - g.x0) / g.cell);
  const r = Math.floor((g.y1 - sy) / (g.cellY || g.cell));
  return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
}

/** Rasterise columns (las.js) onto a grid; see the header for the layers. */
export function rasterise(cols, g, { shift = null, lowM = 0.3 } = {}) {
  const N = g.w * g.h;
  const out = {
    n: new Uint16Array(N), nGround: new Uint16Array(N), nFirstOfMany: new Uint16Array(N),
    iGround: new Float32Array(N).fill(NaN), zGround: new Float32Array(N).fill(NaN),
    zTop: new Float32Array(N).fill(NaN), zMin: new Float32Array(N).fill(NaN),
    iLow: new Float32Array(N).fill(NaN),
  };
  const iSum = new Float64Array(N);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(g, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    const z = cols.z[i];
    out.n[k]++;
    if (!(out.zTop[k] >= z)) out.zTop[k] = z;
    if (!(out.zMin[k] <= z)) out.zMin[k] = z;
    if (cols.ret[i] === 1 && cols.nret[i] > 1) out.nFirstOfMany[k]++;
    if (cols.cls[i] === 2) {
      out.nGround[k]++;
      iSum[k] += cols.intensity[i];
      if (!(out.zGround[k] <= z)) out.zGround[k] = z;
    }
  }
  for (let k = 0; k < N; k++) if (out.nGround[k]) out.iGround[k] = iSum[k] / out.nGround[k];
  const lSum = new Float64Array(N), lN = new Uint16Array(N);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(g, cols.x[i], cols.y[i], shift);
    if (k < 0 || !(cols.z[i] <= out.zMin[k] + lowM)) continue;
    lSum[k] += cols.intensity[i]; lN[k]++;
  }
  for (let k = 0; k < N; k++) if (lN[k]) out.iLow[k] = lSum[k] / lN[k];
  return out;
}

/**
 * Fill NaN cells from their neighbours, `rounds` cells deep at most, so a
 * sparse cloud reads as a picture rather than a sieve. Cells further than
 * that from any data stay NaN (under a roof, the ground stays unknown).
 */
export function fillGaps(a, w, h, rounds = 2) {
  let cur = Float32Array.from(a);
  for (let r = 0; r < rounds; r++) {
    const next = Float32Array.from(cur);
    let changed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = y * w + x;
        if (!Number.isNaN(cur[k])) continue;
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = cur[yy * w + xx];
          if (!Number.isNaN(v)) { s += v; n++; }
        }
        if (n >= 2) { next[k] = s / n; changed++; }
      }
    }
    cur = next;
    if (!changed) break;
  }
  return cur;
}

/** The value at quantile q (0..1) of the finite entries. */
export function quantile(a, q) {
  const v = Array.from(a).filter(Number.isFinite).sort((x, y) => x - y);
  return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))] : NaN;
}

/**
 * A layer as an RGBA picture ({ data, width, height }, ImageData's shape),
 * grey from the 2nd to the 98th percentile; NaN is transparent, which
 * register.js reads as "no data" rather than as black.
 */
export function greyPicture(a, w, h, { lo = 0.02, hi = 0.98 } = {}) {
  const a0 = quantile(a, lo), a1 = quantile(a, hi);
  const span = a1 - a0 || 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    const v = a[k];
    if (!Number.isFinite(v)) continue;
    const g = Math.round(255 * Math.min(1, Math.max(0, (v - a0) / span)));
    data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = g;
    data[k * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

/**
 * Separable Gaussian blur that ignores NaN (no data) rather than spreading
 * it, and leaves NaN cells NaN.
 */
export function blurNaN(a, w, h, sigma) {
  if (!(sigma > 0)) return Float32Array.from(a);
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const pass = (src, horiz) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const at = y * w + x;
        if (Number.isNaN(src[at])) { out[at] = NaN; continue; }
        let s = 0, n = 0;
        for (let i = -r; i <= r; i++) {
          const xx = horiz ? x + i : x, yy = horiz ? y : y + i;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = src[yy * w + xx];
          if (Number.isNaN(v)) continue;
          s += v * k[i + r]; n += k[i + r];
        }
        out[at] = n ? s / n : NaN;
      }
    }
    return out;
  };
  return pass(pass(a, true), false);
}

/**
 * Bilinear resample of a w x h layer to W x H over the same ground. A cell
 * with any NaN corner is NaN. Nearest-neighbour would draw every coarse
 * cell's square outline into the picture, and those false horizontal and
 * vertical edges are exactly what an edge-orientation registration matches.
 */
export function resample(a, w, h, W, H) {
  const out = new Float32Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const fy = Math.min(h - 1, Math.max(0, ((Y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let X = 0; X < W; X++) {
      const fx = Math.min(w - 1, Math.max(0, ((X + 0.5) * w) / W - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a00 = a[y0 * w + x0], a10 = a[y0 * w + x1], a01 = a[y1 * w + x0], a11 = a[y1 * w + x1];
      out[Y * W + X] = (a00 * (1 - tx) + a10 * tx) * (1 - ty) + (a01 * (1 - tx) + a11 * tx) * ty;
    }
  }
  return out;
}

/**
 * RGBA (any size) -> luminance on a w x h grid over the same ground, each
 * cell the mean of the pixels whose CENTRES fall inside it.
 *
 * register.js's greyOn bins by floor(), which averages a cell's pixels from
 * half a source pixel up and to the left of the cell's centre. Comparing
 * two pictures of different pixel sizes that way leaves a bias of half the
 * difference: 5-6 cm between a Mapbox photo and a lidar grid, measured on a
 * synthetic scene with no offset at all (2026-10-10). Centred here.
 */
export function greyCentred(rgba, W, H, w, h) {
  const out = new Float32Array(w * h);
  const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, Math.ceil(y * sy - 0.5)), yb = Math.min(H, Math.max(ya + 1, Math.ceil((y + 1) * sy - 0.5)));
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, Math.ceil(x * sx - 0.5)), xb = Math.min(W, Math.max(xa + 1, Math.ceil((x + 1) * sx - 0.5)));
      let s = 0, n = 0;
      for (let yy = ya; yy < yb; yy++) {
        for (let xx = xa; xx < xb; xx++) {
          const i = (yy * W + xx) * 4;
          if (rgba[i + 3] === 0) continue;
          s += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; n++;
        }
      }
      out[y * w + x] = n ? s / n : NaN;
    }
  }
  return out;
}
