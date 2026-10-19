/*
 * WHERE A KNOWN OUTLINE IS IN A PHOTO (owner, 2026-10-19: "compare the overture shapes with the
 * corresponding shapes that are visible in the imagery"). H102: our photos sit a median 1.6 m from
 * Overture's buildings and 1.2 m from the lidar, up to 6 m; one shift per lot takes out most of it.
 *
 * An outline is slid over the photo's brightness gradient and scored by how strongly the photo
 * changes ACROSS the outline, summed along it; the best shift is where that building's roof edge is
 * in the photo. A lot's shift is the median of its buildings'. Used by tools/overture-check.js
 * (measured on the locked lots) and by the editor (Overture drawn onto the photo on screen).
 * Pure: arrays in, numbers out.
 */

export const PEAK_MIN = 1.35; // best score over the search's median: a real edge fit, not noise

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/** Brightness on a Wg x Hg grid from a picture's RGBA (any size), area-averaged. */
export function greyGrid(data, pw, ph, Wg, Hg) {
  const g = new Float32Array(Wg * Hg);
  const sx = pw / Wg, sy = ph / Hg;
  for (let r = 0; r < Hg; r++) for (let c = 0; c < Wg; c++) {
    const x0 = Math.floor(c * sx), x1 = Math.max(x0 + 1, Math.floor((c + 1) * sx)), y0 = Math.floor(r * sy), y1 = Math.max(y0 + 1, Math.floor((r + 1) * sy));
    let t = 0, n = 0;
    for (let y = y0; y < Math.min(y1, ph); y++) for (let x = x0; x < Math.min(x1, pw); x++) { const o = (y * pw + x) * 4; t += 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]; n++; }
    g[r * Wg + c] = n ? t / n : 0;
  }
  return g;
}

/** A light blur, then the gradient, scaled so an edge as strong as the 95th percentile is 1. */
export function gradients(g, Wg, Hg) {
  const b = new Float32Array(Wg * Hg);
  for (let r = 0; r < Hg; r++) for (let c = 0; c < Wg; c++) {
    let t = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const rr = r + dy, cc = c + dx; if (rr >= 0 && cc >= 0 && rr < Hg && cc < Wg) { const w = (dx ? 1 : 2) * (dy ? 1 : 2); t += w * g[rr * Wg + cc]; n += w; } }
    b[r * Wg + c] = t / n;
  }
  const gx = new Float32Array(Wg * Hg), gy = new Float32Array(Wg * Hg), mag = [];
  for (let r = 1; r < Hg - 1; r++) for (let c = 1; c < Wg - 1; c++) {
    const i = r * Wg + c;
    gx[i] = (b[i + 1] - b[i - 1]) / 2; gy[i] = (b[i + Wg] - b[i - Wg]) / 2;
    if ((r * 7 + c) % 5 === 0) mag.push(Math.hypot(gx[i], gy[i]));
  }
  mag.sort((a, z) => a - z);
  const scale = mag[Math.floor(mag.length * 0.95)] || 1;
  for (let i = 0; i < gx.length; i++) { gx[i] /= scale; gy[i] /= scale; }
  return { gx, gy };
}

/** Points every cell along a ring (grid coordinates), each with the edge's normal. */
export function ringPoints(ring) {
  const pts = [];
  for (let i = 0; i + 1 < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[i + 1], L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const nx = -(by - ay) / L, ny = (bx - ax) / L;
    for (let t = 0.5; t < L; t += 1) pts.push([ax + ((bx - ax) * t) / L, ay + ((by - ay) * t) / L, nx, ny]);
  }
  return pts;
}

/** The best shift (cells) of points with normals over the gradient field, searched ±reach cells, coarse then fine. */
export function edgeFit(pts, gx, gy, Wg, Hg, reach) {
  const score = (dx, dy) => {
    let t = 0, n = 0;
    for (const [x, y, nx, ny] of pts) {
      const c = Math.round(x + dx), r = Math.round(y + dy);
      if (c < 1 || r < 1 || c >= Wg - 1 || r >= Hg - 1) continue;
      const i = r * Wg + c;
      t += Math.min(1, Math.abs(gx[i] * nx + gy[i] * ny)); n++;
    }
    return n >= pts.length * 0.8 ? t / n : NaN;
  };
  const all = [];
  let best = { s: -1, dx: 0, dy: 0 };
  for (let dy = -reach; dy <= reach; dy += 2) for (let dx = -reach; dx <= reach; dx += 2) {
    const v = score(dx, dy);
    if (!Number.isFinite(v)) continue;
    all.push(v);
    if (v > best.s) best = { s: v, dx, dy };
  }
  if (best.s < 0) return null;
  for (let dy = best.dy - 2; dy <= best.dy + 2; dy++) for (let dx = best.dx - 2; dx <= best.dx + 2; dx++) {
    const v = score(dx, dy);
    if (Number.isFinite(v) && v > best.s) best = { s: v, dx, dy };
  }
  return { ...best, peak: best.s / (median(all) || 1e-9), at0: score(0, 0) };
}

/**
 * Each outline (rings in grid cells) fitted to the photo, and the lot's shift: the median of the
 * buildings that fitted, in cells. Outlines touching the edge (margin cells) or under minCells
 * points are left out. null when nothing fitted.
 */
export function lotShift(rings, gx, gy, Wg, Hg, reach, { margin = 5, minPoints = 40 } = {}) {
  const fits = [];
  for (const ring of rings) {
    const xs = ring.map((q) => q[0]), ys = ring.map((q) => q[1]);
    if (Math.min(...xs) < margin || Math.min(...ys) < margin || Math.max(...xs) > Wg - margin || Math.max(...ys) > Hg - margin) continue;
    const pts = ringPoints(ring);
    if (pts.length < minPoints) continue;
    const f = edgeFit(pts, gx, gy, Wg, Hg, reach);
    if (f && f.peak >= PEAK_MIN) fits.push(f);
  }
  if (!fits.length) return null;
  return { dx: median(fits.map((f) => f.dx)), dy: median(fits.map((f) => f.dy)), n: fits.length, fits };
}

/** Robust (one round of trimming) least squares of shift = g + L * h, each axis apart. */
export function leanFit(rows) {
  const fit = (pts) => {
    const n = pts.length, mh = pts.reduce((a, p) => a + p.h, 0) / n;
    const vh = pts.reduce((a, p) => a + (p.h - mh) ** 2, 0);
    const axis = (k) => { const my = pts.reduce((a, p) => a + p.s[k], 0) / n; const L = vh > 1e-9 ? pts.reduce((a, p) => a + (p.h - mh) * (p.s[k] - my), 0) / vh : 0; return [my - L * mh, L]; };
    const [gx, Lx] = axis(0), [gy, Ly] = axis(1);
    return { g: [gx, gy], L: [Lx, Ly], res: pts.map((p) => Math.hypot(p.s[0] - gx - Lx * p.h, p.s[1] - gy - Ly * p.h)) };
  };
  let f = fit(rows);
  if (rows.length >= 5) {
    const cut = Math.max(0.6, 2.5 * median(f.res));
    const keep = rows.filter((_, i) => f.res[i] <= cut);
    if (keep.length >= 3) f = fit(keep);
  }
  return f;
}
