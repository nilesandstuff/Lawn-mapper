/*
 * DOES OVERTURE LINE UP WITH OUR LOTS? (owner, 2026-10-19: Overture's roofs, roads and sidewalks
 * "would be good info for every stage... the detector, the grass under canopy guesser, and manual
 * tracing", but "the 'if it lines up' statement is doing some heavy lifting".)
 *
 * Measured before anything is built on it. For each locked lot:
 *
 *   BUILDINGS against the lidar's roof mask. Lidar looks straight down at every point, so its
 *   roofs carry no perspective lean, and it already sits on our frames (H63/H64: the ground offset
 *   between a photo and the lidar is a plain shift of about half a metre). So the overlap of
 *   Overture's buildings with the lidar roofs, unshifted and at the best single shift, says how far
 *   off Overture is on that lot and whether one shift per lot fixes it. Each building is then
 *   given its own best shift too: if those scatter about the lot's shift, one shift cannot fix it.
 *
 *   THE TRACED LAWN against Overture. The traces were drawn on the photo, so this is the number a
 *   never-lawn rule or a veto would actually pay: how much of the lawn falls on an Overture
 *   building, road band or sidewalk band. The lidar's own roofs give the floor to compare with.
 *
 * Nothing changes on the site. Inputs are what workflow 36 already fetches:
 *   FRAMES   frames/ (scale.json with boxes, <id>.png, <id>-labels.png)
 *   LIDAR    lidar/  (<id>-roof.png, from lidar_frame.py)
 *   OUT      where the scores and the pictures go
 *
 *   FRAMES=frames LIDAR=lidar OUT=overture-out node tools/overture-check.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { overtureFor, overtureMasks } from '../public/lib/overture.js';

const CELL = 0.5;    // web-mercator metres a cell of the comparison grid
const SHIFT_M = 6;   // the search, in ground metres, each way
const BUILDING_PAD_M = 2;
const OWN_SHIFT_M = 3; // each building's own search, about the lot's shift

/* ------------------------------------------------------------ the arithmetic (tested) */

/**
 * The single shift (dx, dy cells; +dx east, +dy south) of a padded mask `big` (W+2P by H+2P) that
 * best overlaps `ref` (W by H), searching ±S cells. Returns IoU unshifted and at the best shift.
 */
export function bestShift(big, ref, W, H, P, S) {
  const BW = W + 2 * P;
  let refN = 0;
  for (let i = 0; i < W * H; i++) refN += ref[i] ? 1 : 0;
  const at = (dx, dy) => {
    let inter = 0, n = 0;
    for (let r = 0; r < H; r++) {
      const row = (r + P - dy) * BW + P - dx;
      for (let c = 0; c < W; c++) {
        if (big[row + c]) { n++; if (ref[r * W + c]) inter++; }
      }
    }
    const union = n + refN - inter;
    return { iou: union ? inter / union : 0, inter, n };
  };
  const zero = at(0, 0);
  let best = { dx: 0, dy: 0, ...zero };
  for (let dy = -S; dy <= S; dy++) for (let dx = -S; dx <= S; dx++) {
    const v = at(dx, dy);
    if (v.iou > best.iou + 1e-9 || (Math.abs(v.iou - best.iou) <= 1e-9 && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) best = { dx, dy, ...v };
  }
  return { zero, best, refN };
}

/** The value of padded `big` under frame cell i at shift (dx, dy). */
const under = (big, W, P, i, dx, dy) => big[(Math.floor(i / W) + P - dy) * (W + 2 * P) + (i % W) + P - dx];

export const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

/* ------------------------------------------------------------ pictures */

async function pngjs() { return (await import('pngjs')).PNG; }

function readMask(PNG, file, W, H, channel = 0) {
  const p = PNG.sync.read(readFileSync(file));
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const sr = Math.min(p.height - 1, Math.floor(((r + 0.5) * p.height) / H)), sc = Math.min(p.width - 1, Math.floor(((c + 0.5) * p.width) / W));
    out[r * W + c] = p.data[(sr * p.width + sc) * 4 + channel] >= 128 ? 1 : 0;
  }
  return out;
}

function edge(m, W, H, i) {
  if (!m(i)) return false;
  const r = Math.floor(i / W), c = i % W;
  return (c > 0 && !m(i - 1)) || (c < W - 1 && !m(i + 1)) || (r > 0 && !m(i - W)) || (r < H - 1 && !m(i + W));
}

function picture(PNG, photoFile, W, H, layers) {
  const K = 3, out = new PNG({ width: W * K, height: H * K });
  const ph = existsSync(photoFile) ? PNG.sync.read(readFileSync(photoFile)) : null;
  for (let y = 0; y < H * K; y++) for (let x = 0; x < W * K; x++) {
    const o = (y * W * K + x) * 4;
    let rgb = [40, 40, 40];
    if (ph) {
      const sy = Math.min(ph.height - 1, Math.floor(((y + 0.5) * ph.height) / (H * K))), sx = Math.min(ph.width - 1, Math.floor(((x + 0.5) * ph.width) / (W * K)));
      const s = (sy * ph.width + sx) * 4;
      rgb = [ph.data[s], ph.data[s + 1], ph.data[s + 2]];
    }
    const i = Math.floor(y / K) * W + Math.floor(x / K);
    for (const L of layers) if (L.test(i)) { rgb = L.fill ? rgb.map((v, k) => Math.round(v * 0.55 + L.rgb[k] * 0.45)) : L.rgb; }
    out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; out.data[o + 3] = 255;
  }
  return PNG.sync.write(out);
}

/* ------------------------------------------------------------ the photo */
/*
 * WHERE EACH OVERTURE BUILDING IS IN THE PHOTO. Each outline is slid over the photo's edges (the
 * brightness gradient across the outline, summed along it) within PHOTO_REACH_M, and the shift
 * that puts it on the strongest edges is where that building's roof edge is in the photo. Then,
 * per lot, those shifts against each building's lidar height:
 *   shift = g + L * height
 * g is the photo's ground offset from Overture, L the lean (metres sideways per metre up). If one
 * shift fits every building, L is about nothing; if the tall ones move further, it is lean.
 * The same buildings' shifts onto the lidar roofs (lidarOwn) give the lidar's offset from the photo.
 */
const PHOTO_CELL_M = 0.2;     // ground metres a cell of the photo grid
const PHOTO_REACH_M = 6;
const PEAK_MIN = 1.35;        // best score over the median score of the search: a real edge fit, not noise

function photoGrid(PNG, file, Wg, Hg) {
  const p = PNG.sync.read(readFileSync(file));
  const g = new Float32Array(Wg * Hg);
  // area-average each grid cell from the photo's pixels (the photo is usually finer than 0.2 m)
  const sx = p.width / Wg, sy = p.height / Hg;
  for (let r = 0; r < Hg; r++) for (let c = 0; c < Wg; c++) {
    const x0 = Math.floor(c * sx), x1 = Math.max(x0 + 1, Math.floor((c + 1) * sx)), y0 = Math.floor(r * sy), y1 = Math.max(y0 + 1, Math.floor((r + 1) * sy));
    let t = 0, n = 0;
    for (let y = y0; y < Math.min(y1, p.height); y++) for (let x = x0; x < Math.min(x1, p.width); x++) { const o = (y * p.width + x) * 4; t += 0.299 * p.data[o] + 0.587 * p.data[o + 1] + 0.114 * p.data[o + 2]; n++; }
    g[r * Wg + c] = n ? t / n : 0;
  }
  // a light blur, then central differences
  const b = new Float32Array(Wg * Hg);
  for (let r = 0; r < Hg; r++) for (let c = 0; c < Wg; c++) {
    let t = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const rr = r + dy, cc = c + dx; if (rr >= 0 && cc >= 0 && rr < Hg && cc < Wg) { const w8 = (dx ? 1 : 2) * (dy ? 1 : 2); t += w8 * g[rr * Wg + cc]; n += w8; } }
    b[r * Wg + c] = t / n;
  }
  const gx = new Float32Array(Wg * Hg), gy = new Float32Array(Wg * Hg), mag = [];
  for (let r = 1; r < Hg - 1; r++) for (let c = 1; c < Wg - 1; c++) {
    const i = r * Wg + c;
    gx[i] = (b[i + 1] - b[i - 1]) / 2; gy[i] = (b[i + Wg] - b[i - Wg]) / 2;
    if ((r * 7 + c) % 5 === 0) mag.push(Math.hypot(gx[i], gy[i]));
  }
  mag.sort((a, z) => a - z);
  const scale = mag[Math.floor(mag.length * 0.95)] || 1; // an edge as strong as the photo's 95th percentile counts 1
  for (let i = 0; i < gx.length; i++) { gx[i] /= scale; gy[i] /= scale; }
  return { gx, gy };
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

function photoFit(PNG, id, box, k, ov, lidarOwn, dirs, wantPicture = false) {
  const photo = join(dirs.frames, `${id}.png`), hfile = join(dirs.lidar, `${id}-height.png`);
  if (!existsSync(photo)) return { photo: false };
  const [w, s, e, n] = box;
  const across = (e - w) * k, down = (n - s) * k;
  const Wg = Math.round(across / PHOTO_CELL_M), Hg = Math.round(down / PHOTO_CELL_M);
  const { gx, gy } = photoGrid(PNG, photo, Wg, Hg);
  let hp = null;
  if (existsSync(hfile)) hp = PNG.sync.read(readFileSync(hfile));
  const heightAt = (c, r) => { if (!hp) return NaN; const x = Math.min(hp.width - 1, Math.max(0, Math.floor((c / Wg) * hp.width))), y = Math.min(hp.height - 1, Math.max(0, Math.floor((r / Hg) * hp.height))); return hp.data[(y * hp.width + x) * 4] / 10; };
  const R = 6378137;
  const toG = ([lng, la]) => { const x = (lng * Math.PI / 180) * R, y = Math.log(Math.tan(Math.PI / 4 + (la * Math.PI / 180) / 2)) * R; return [((x - w) / (e - w)) * Wg, ((n - y) / (n - s)) * Hg]; };
  const reach = Math.round(PHOTO_REACH_M / PHOTO_CELL_M);
  const fits = [];
  for (const [bi, poly] of ov.buildings.entries()) {
    const ring = poly[0].map(toG);
    const xs = ring.map((q) => q[0]), ys = ring.map((q) => q[1]);
    const margin = 1 / PHOTO_CELL_M;
    if (Math.min(...xs) < margin || Math.min(...ys) < margin || Math.max(...xs) > Wg - margin || Math.max(...ys) > Hg - margin) continue;
    // area (ground m²) and orientation, then points every cell along each edge with outward-agnostic normals
    let a2 = 0; for (let i = 0; i + 1 < ring.length; i++) a2 += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    const areaM2 = Math.abs(a2 / 2) * PHOTO_CELL_M ** 2;
    if (areaM2 < 30) continue;
    const pts = [];
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-6) continue;
      const nx = -(by - ay) / L, ny = (bx - ax) / L;
      for (let t = 0.5; t < L; t += 1) pts.push([ax + ((bx - ax) * t) / L, ay + ((by - ay) * t) / L, nx, ny]);
    }
    if (pts.length < 40) continue;
    const f = edgeFit(pts, gx, gy, Wg, Hg, reach);
    if (!f) continue;
    // its height: the 30th percentile of the lidar inside it, about the eaves rather than the ridge
    const hs = [];
    const [c0, c1, r0, r1] = [Math.floor(Math.min(...xs)), Math.ceil(Math.max(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...ys))];
    for (let r = r0; r <= r1; r += 2) for (let c = c0; c <= c1; c += 2) if (inside(ring, c + 0.5, r + 0.5)) { const h = heightAt(c, r); if (Number.isFinite(h)) hs.push(h); }
    hs.sort((a, z) => a - z);
    const h = hs.length >= 5 ? hs[Math.floor(hs.length * 0.3)] : NaN;
    fits.push({ bi, areaM2, peak: f.peak, s: [f.dx * PHOTO_CELL_M, -f.dy * PHOTO_CELL_M], h, lidar: lidarOwn.get(bi) || null, ring, dx: f.dx, dy: f.dy });
  }
  if (wantPicture) photoPicture(PNG, photo, Wg, Hg, fits, join(dirs.out, 'pictures', `${id.replace(/[^\w.-]+/g, '_')}-photo.png`));
  const good = fits.filter((f) => f.peak >= PEAK_MIN);
  const out = { photo: true, photoBuildings: fits.length, photoFitted: good.length };
  if (!good.length) return out;
  const mags = good.map((f) => Math.hypot(...f.s));
  out.photoShiftMedianM = median(mags);
  out.photoShiftMaxM = Math.max(...mags);
  out.photoShiftOver1 = good.filter((f, i) => mags[i] > 1).length;
  out.photoShiftOver2 = good.filter((f, i) => mags[i] > 2).length;
  // one shift for the lot: the spread of the buildings about their own median shift
  const med = [median(good.map((f) => f.s[0])), median(good.map((f) => f.s[1]))];
  out.photoLotShift = med;
  out.photoSpreadM = median(good.map((f) => Math.hypot(f.s[0] - med[0], f.s[1] - med[1])));
  // lean: shift against height, where the lot has buildings of different heights
  const withH = good.filter((f) => Number.isFinite(f.h) && f.h >= 1.5);
  out.photoWithHeight = withH.length;
  if (withH.length >= 3) {
    const hsd = Math.sqrt(withH.reduce((a, f) => a + (f.h - withH.reduce((b, z) => b + z.h, 0) / withH.length) ** 2, 0) / withH.length);
    out.heightSpreadM = hsd;
    if (hsd >= 1) {
      const lf = leanFit(withH);
      out.leanG = lf.g; out.leanL = lf.L; out.leanPerM = Math.hypot(...lf.L);
      out.leanResM = median(lf.res);
      out.constResM = median(withH.map((f) => Math.hypot(f.s[0] - med[0], f.s[1] - med[1])));
    }
  }
  // the lidar onto the photo, building by building: (Overture -> photo) less (Overture -> lidar)
  const both = good.filter((f) => f.lidar);
  if (both.length) {
    const lp = both.map((f) => [f.s[0] - f.lidar[0], f.s[1] - f.lidar[1]]);
    out.lidarToPhotoMedianM = median(lp.map((v) => Math.hypot(...v)));
    out.lidarToPhoto = [median(lp.map((v) => v[0])), median(lp.map((v) => v[1]))];
    out.lidarToPhotoN = both.length;
    out.lidarToPhotoHeights = both.map((f) => f.h);
    out.lidarToPhotoVecs = lp;
  }
  out.photoFits = good.map((f) => ({ s: f.s.map((v) => +v.toFixed(2)), h: Number.isFinite(f.h) ? +f.h.toFixed(1) : null, peak: +f.peak.toFixed(2), areaM2: Math.round(f.areaM2), lidar: f.lidar && f.lidar.map((v) => +v.toFixed(2)) }));
  return out;
}

/* The photo at the 0.2 m grid: Overture's outline as published in yellow, moved onto the photo's
   edges in cyan (red where the fit was too weak to count). */
function photoPicture(PNG, photo, Wg, Hg, fits, file) {
  const p = PNG.sync.read(readFileSync(photo));
  const K = 2, out = new PNG({ width: Wg * K, height: Hg * K });
  for (let y = 0; y < Hg * K; y++) for (let x = 0; x < Wg * K; x++) {
    const sx = Math.min(p.width - 1, Math.floor(((x + 0.5) * p.width) / (Wg * K))), sy = Math.min(p.height - 1, Math.floor(((y + 0.5) * p.height) / (Hg * K)));
    const s = (sy * p.width + sx) * 4, o = (y * Wg * K + x) * 4;
    out.data[o] = p.data[s]; out.data[o + 1] = p.data[s + 1]; out.data[o + 2] = p.data[s + 2]; out.data[o + 3] = 255;
  }
  const line = (ring, dx, dy, rgb) => {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[i + 1], L = Math.hypot(bx - ax, by - ay) * K;
      for (let t = 0; t <= L; t += 0.5) {
        const x = Math.round((ax + dx + ((bx - ax) * t) / L) * K), y = Math.round((ay + dy + ((by - ay) * t) / L) * K);
        if (x < 0 || y < 0 || x >= Wg * K || y >= Hg * K) continue;
        const o = (y * Wg * K + x) * 4; out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2];
      }
    }
  };
  for (const f of fits) {
    line(f.ring, 0, 0, [255, 230, 0]);
    line(f.ring, f.dx, f.dy, f.peak >= PEAK_MIN ? [0, 230, 230] : [255, 40, 40]);
  }
  writeFileSync(file, PNG.sync.write(out));
}

function inside(ring, x, y) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

/* ------------------------------------------------------------ one lot */

async function checkLot(PNG, id, box, dirs, wantPicture) {
  const [w, s, e, n] = box;
  const lat = (2 * Math.atan(Math.exp(((s + n) / 2) / 6378137)) - Math.PI / 2);
  const k = Math.cos(lat); // ground metres per mercator metre
  const W = Math.max(8, Math.round((e - w) / CELL)), H = Math.max(8, Math.round((n - s) / CELL));
  const P = Math.ceil(SHIFT_M / k / CELL) + 2, S = P - 2;
  const pad = P * CELL;
  const all = await overtureFor([w - pad, s - pad, e + pad, n + pad]);
  // Overture answers whole tiles, a mile or more across: keep what touches this frame.
  const R = 6378137, merc = ([lng, la]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (la * Math.PI / 180) / 2)) * R];
  const near = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of pts) { const [x, y] = merc(q); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return x1 >= w - pad - 20 && x0 <= e + pad + 20 && y1 >= s - pad - 20 && y0 <= n + pad + 20; };
  const ov = { roads: all.roads.filter((r) => r.lines.some(near)), buildings: all.buildings.filter((b) => b[0] && near(b[0])) };
  const g = { W: W + 2 * P, H: H + 2 * P, cell: CELL, toCell: (x, y) => [(x - (w - pad)) / CELL, ((n + pad) - y) / CELL] };
  const { paved, building } = overtureMasks(g, ov);
  const road = paved.map((v) => (v === 1 ? 1 : 0)), walk = paved.map((v) => (v === 2 ? 1 : 0));

  const roof = readMask(PNG, join(dirs.lidar, `${id}-roof.png`), W, H);
  const lab = PNG.sync.read(readFileSync(join(dirs.frames, `${id}-labels.png`)));
  const lawn = new Uint8Array(W * H), within = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const sr = Math.min(lab.height - 1, Math.floor(((r + 0.5) * lab.height) / H)), sc = Math.min(lab.width - 1, Math.floor(((c + 0.5) * lab.width) / W));
    const o = (sr * lab.width + sc) * 4;
    lawn[r * W + c] = lab.data[o] >= 128 || lab.data[o + 2] >= 128 ? 1 : 0;
    within[r * W + c] = lab.data[o + 1] >= 128 ? 1 : 0;
  }

  const fit = bestShift(building, roof, W, H, P, S);
  const m = (cells) => cells * CELL * k; // a shift in cells, in ground metres
  const row = {
    id, buildings: ov.buildings.length, roads: ov.roads.filter((r) => !r.walk).length, walks: ov.roads.filter((r) => r.walk).length,
    roofCells: fit.refN,
    roofM2: fit.refN * CELL * CELL * k * k,
    overtureM2: (() => { let x = 0; for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) x += building[(r + P) * (W + 2 * P) + c + P] ? 1 : 0; return x * CELL * CELL * k * k; })(),
    iou0: fit.zero.iou, iouBest: fit.best.iou,
    shiftEast: m(fit.best.dx), shiftNorth: -m(fit.best.dy), shiftM: m(Math.hypot(fit.best.dx, fit.best.dy)),
  };

  // Each building its own shift, about the lot's: does one shift fix the lot?
  const residuals = [];
  const lidarOwn = new Map(); // polygon index -> its own shift onto the lidar roofs, ground metres [east, north]
  const BW = W + 2 * P;
  for (const [bi, poly] of ov.buildings.entries()) {
    const one = overtureMasks(g, { roads: [], buildings: [poly] }).building;
    let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1, area = 0;
    for (let i = 0; i < one.length; i++) if (one[i]) { const r = Math.floor(i / BW), c = i % BW; r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); area++; }
    if (area * CELL * CELL * k * k < 30) continue; // sheds and slivers
    const bp = Math.ceil(BUILDING_PAD_M / k / CELL), S2 = Math.ceil(OWN_SHIFT_M / k / CELL);
    if (r0 - P < 0 || c0 - P < 0 || r1 - P >= H || c1 - P >= W) continue; // wholly inside the frame
    let best = { iou: -1, dx: 0, dy: 0 };
    for (let dy = fit.best.dy - S2; dy <= fit.best.dy + S2; dy++) for (let dx = fit.best.dx - S2; dx <= fit.best.dx + S2; dx++) {
      let inter = 0, roofN = 0;
      for (let r = r0 - bp; r <= r1 + bp; r++) for (let c = c0 - bp; c <= c1 + bp; c++) {
        const fr = r - P + dy, fc = c - P + dx; // the frame cell under this padded cell once shifted
        if (fr < 0 || fc < 0 || fr >= H || fc >= W || !roof[fr * W + fc]) continue;
        roofN++;
        if (one[r * BW + c]) inter++;
      }
      const iou = inter / (area + roofN - inter || 1);
      if (iou > best.iou + 1e-9 || (Math.abs(iou - best.iou) <= 1e-9 && Math.hypot(dx - fit.best.dx, dy - fit.best.dy) < Math.hypot(best.dx - fit.best.dx, best.dy - fit.best.dy))) best = { iou, dx, dy };
    }
    if (best.iou < 0.3) continue; // the lidar does not see it as a roof (under trees, or gone)
    lidarOwn.set(bi, [m(best.dx), -m(best.dy)]);
    residuals.push({ m: m(Math.hypot(best.dx - fit.best.dx, best.dy - fit.best.dy)), iou: best.iou, areaM2: area * CELL * CELL * k * k });
  }
  row.ownShifts = residuals.length;
  row.residualMedianM = median(residuals.map((r) => r.m));
  row.residualOver15 = residuals.length ? residuals.filter((r) => r.m > 1.5).length / residuals.length : NaN;

  // THE PHOTO (owner, 2026-10-19: "the imagery is not consistently lining up with the overture shapes").
  Object.assign(row, photoFit(PNG, id, box, k, ov, lidarOwn, dirs, wantPicture));

  // The traced lawn, unshifted and at the lot's best shift.
  const lawnN = lawn.reduce((a, v) => a + v, 0);
  const share = (big, dx, dy) => { let x = 0; for (let i = 0; i < W * H; i++) if (lawn[i] && under(big, W, P, i, dx, dy)) x++; return lawnN ? x / lawnN : NaN; };
  const bandOnLawn = (big, dx, dy) => { let b = 0, x = 0; for (let i = 0; i < W * H; i++) if (within[i] && under(big, W, P, i, dx, dy)) { b++; if (lawn[i]) x++; } return b ? x / b : NaN; };
  let lawnOnRoof = 0; for (let i = 0; i < W * H; i++) if (lawn[i] && roof[i]) lawnOnRoof++;
  const { dx, dy } = fit.best;
  Object.assign(row, {
    lawnCells: lawnN,
    lawnOnLidarRoof: lawnN ? lawnOnRoof / lawnN : NaN,
    lawnOnBuilding0: share(building, 0, 0), lawnOnBuildingBest: share(building, dx, dy),
    lawnOnRoad0: share(road, 0, 0), lawnOnRoadBest: share(road, dx, dy),
    lawnOnWalk0: share(walk, 0, 0), lawnOnWalkBest: share(walk, dx, dy),
    roadBandOnLawn0: bandOnLawn(road, 0, 0), walkBandOnLawn0: bandOnLawn(walk, 0, 0),
  });

  if (wantPicture) {
    const at = (big, ddx, ddy) => (i) => under(big, W, P, i, ddx, ddy);
    const layers = [
      { test: (i) => roof[i], rgb: [255, 60, 60], fill: true },                       // lidar roof, red wash
      { test: (i) => edge((j) => lawn[j], W, H, i), rgb: [60, 255, 60] },                // traced lawn, green line
      { test: (i) => edge(at(road, 0, 0), W, H, i), rgb: [60, 120, 255] },               // road band, blue
      { test: (i) => edge(at(walk, 0, 0), W, H, i), rgb: [255, 60, 255] },               // walk band, magenta
      { test: (i) => edge(at(building, 0, 0), W, H, i), rgb: [255, 230, 0] },            // Overture building as published, yellow
      { test: (i) => (dx || dy) && edge(at(building, dx, dy), W, H, i), rgb: [0, 230, 230] }, // at the lot's best shift, cyan
    ];
    writeFileSync(join(dirs.out, 'pictures', `${id.replace(/[^\w.-]+/g, '_')}.png`), picture(PNG, join(dirs.frames, `${id}.png`), W, H, layers));
  }
  return row;
}

/* ------------------------------------------------------------ the run */

async function main() {
  const dirs = { frames: process.env.FRAMES || 'frames', lidar: process.env.LIDAR || 'lidar', out: process.env.OUT || 'overture-out' };
  mkdirSync(join(dirs.out, 'pictures'), { recursive: true });
  const PNG = await pngjs();
  const scale = JSON.parse(readFileSync(join(dirs.frames, 'scale.json'), 'utf8'));
  const boxes = scale.boxes || {};
  const ids = Object.keys(boxes).filter((id) => !id.includes(':example:')).sort();
  const pictures = Number(process.env.PICTURES || 40);
  const rows = [], skipped = {};
  let shown = 0;
  for (const id of ids) {
    if (!existsSync(join(dirs.frames, `${id}-labels.png`))) { skipped[id] = 'no labels'; continue; }
    if (!existsSync(join(dirs.lidar, `${id}-roof.png`))) { skipped[id] = 'no lidar'; continue; }
    let row = null;
    for (let tries = 0; tries < 4 && !row; tries++) {
      try { row = await checkLot(PNG, id, boxes[id], dirs, shown < pictures); } catch (err) {
        const why = String(err?.cause?.message || err?.message || err).slice(0, 120);
        if (tries === 3) skipped[id] = `overture: ${why}`;
        else await new Promise((ok) => setTimeout(ok, [5, 30, 90][tries] * 1000)); // a throttled host, not a broken lot
      }
    }
    if (!row) { console.log(`  --- ${id.slice(0, 26).padEnd(26)} skipped: ${skipped[id]}`); continue; }
    if (shown < pictures) shown++;
    rows.push(row);
    console.log(`  ${String(rows.length).padStart(3)} ${id.slice(0, 26).padEnd(26)} roof ${row.roofM2.toFixed(0).padStart(4)} m² lidar / ${row.overtureM2.toFixed(0).padStart(4)} m² Overture; IoU ${pct(row.iou0)} -> ${pct(row.iouBest)} at ${row.shiftM.toFixed(1)} m (E ${row.shiftEast.toFixed(1)}, N ${row.shiftNorth.toFixed(1)}); own-shift spread ${num(row.residualMedianM)} m over ${row.ownShifts}; PHOTO ${row.photoFitted ?? 0}/${row.photoBuildings ?? 0} bldgs fit, shift ${num(row.photoShiftMedianM)} m (max ${num(row.photoShiftMaxM)}), spread ${num(row.photoSpreadM)} m${Number.isFinite(row.leanPerM) ? `, lean ${num(row.leanPerM)} m/m (res ${num(row.leanResM)} vs ${num(row.constResM)} one shift)` : ''}${Number.isFinite(row.lidarToPhotoMedianM) ? `, lidar->photo ${num(row.lidarToPhotoMedianM)} m over ${row.lidarToPhotoN}` : ''}; lawn on bldg ${pct(row.lawnOnBuilding0)}, road ${pct(row.lawnOnRoad0)}, walk ${pct(row.lawnOnWalk0)}, lidar roof ${pct(row.lawnOnLidarRoof)}`);
  }
  writeFileSync(join(dirs.out, 'overture-check.json'), JSON.stringify({ cell: CELL, shiftM: SHIFT_M, rows, skipped }, null, 1));

  const col = (k) => rows.map((r) => r[k]);
  const pooled = (a, b) => { let x = 0, y = 0; for (const r of rows) { if (Number.isFinite(r[a])) { x += r[a] * r.lawnCells; y += r.lawnCells; } } return y ? x / y : NaN; };
  console.log(`\n${rows.length} lots checked; ${Object.keys(skipped).length} skipped (${summariseSkips(skipped)}).`);
  console.log('\nOVERTURE BUILDINGS AGAINST THE LIDAR ROOFS (lidar has no perspective lean):');
  console.log(`  overlap (IoU), median: as published ${pct(median(col('iou0')))}, at each lot's best shift ${pct(median(col('iouBest')))}`);
  const both = rows.filter((r) => r.roofM2 >= 50 && r.overtureM2 >= 50);
  console.log(`  lots where both see at least 50 m² of roof: ${both.length}; their IoU median ${pct(median(both.map((r) => r.iou0)))} as published, ${pct(median(both.map((r) => r.iouBest)))} shifted`);
  console.log(`  lots where the lidar sees a roof and Overture has none: ${rows.filter((r) => r.roofM2 >= 50 && r.overtureM2 < 10).length}; Overture a building the lidar does not: ${rows.filter((r) => r.overtureM2 >= 50 && r.roofM2 < 10).length}`);
  console.log(`  best shift, median ${num(median(col('shiftM')))} m; lots needing more than 1 m: ${rows.filter((r) => r.shiftM > 1).length}, more than 2 m: ${rows.filter((r) => r.shiftM > 2).length}`);
  console.log(`  each building its own shift, about the lot's: median ${num(median(col('residualMedianM')))} m; share of buildings off by more than 1.5 m, median ${pct(median(col('residualOver15')))}`);
  const ph = rows.filter((r) => r.photoFitted > 0);
  const fitsAll = ph.flatMap((r) => r.photoFits.map((f) => ({ ...f, lot: r.id })));
  const magsAll = fitsAll.map((f) => Math.hypot(...f.s));
  console.log('\nOVERTURE BUILDINGS ON THE PHOTO (each outline slid onto the photo\'s edges; the shift is where its roof edge is in the photo):');
  console.log(`  lots with a fitted building: ${ph.length} of ${rows.length}; buildings fitted ${fitsAll.length} of ${rows.reduce((a, r) => a + (r.photoBuildings || 0), 0)}`);
  console.log(`  shift per building: median ${num(median(magsAll))} m; over 1 m ${pct(magsAll.filter((x) => x > 1).length / (magsAll.length || 1))}, over 2 m ${pct(magsAll.filter((x) => x > 2).length / (magsAll.length || 1))}, over 3 m ${pct(magsAll.filter((x) => x > 3).length / (magsAll.length || 1))}`);
  console.log(`  per lot, median shift ${num(median(ph.map((r) => r.photoShiftMedianM)))} m; lots whose median building is off by more than 1 m: ${ph.filter((r) => r.photoShiftMedianM > 1).length}, more than 2 m: ${ph.filter((r) => r.photoShiftMedianM > 2).length}`);
  const multi = ph.filter((r) => r.photoFitted >= 2);
  console.log(`  ONE SHIFT PER LOT? on the ${multi.length} lots with 2+ fitted buildings, the buildings scatter about the lot's shift by a median ${num(median(multi.map((r) => r.photoSpreadM)))} m`);
  const leaned = rows.filter((r) => Number.isFinite(r.leanPerM));
  console.log(`  LEAN (shift = ground offset + lean x height), on the ${leaned.length} lots with 3+ fitted buildings of different heights:`);
  if (leaned.length) {
    console.log(`    lean, median ${num(median(leaned.map((r) => r.leanPerM)))} m sideways per metre up (a 6 m eave: ${num(6 * median(leaned.map((r) => r.leanPerM)))} m)`);
    console.log(`    ground offset g, median ${num(median(leaned.map((r) => Math.hypot(...r.leanG))))} m`);
    console.log(`    left over: ${num(median(leaned.map((r) => r.leanResM)))} m with lean, ${num(median(leaned.map((r) => r.constResM)))} m with one shift`);
  }
  // pooled: does the shift grow with height? Each building's shift against its lot's median, by height band
  const bands = [[0, 3], [3, 5], [5, 7], [7, 10], [10, 99]];
  console.log('    pooled, each building\'s distance from its lot\'s lowest fitted building, by its height above that one:');
  for (const [a, b] of bands) {
    const d = [];
    for (const r of ph) {
      const fs = r.photoFits.filter((f) => f.h != null);
      if (fs.length < 2) continue;
      const lo = fs.reduce((m0, f) => (f.h < m0.h ? f : m0), fs[0]);
      for (const f of fs) if (f !== lo && f.h - lo.h >= a && f.h - lo.h < b) d.push(Math.hypot(f.s[0] - lo.s[0], f.s[1] - lo.s[1]));
    }
    console.log(`      ${a}-${b === 99 ? '' : b} m higher: ${d.length} buildings, median ${num(median(d))} m apart`);
  }
  const lp = rows.filter((r) => Number.isFinite(r.lidarToPhotoMedianM));
  console.log('\nTHE LIDAR ON THE PHOTO (per building: where the photo has its roof edge, less where the lidar has the roof):');
  console.log(`  ${lp.length} lots, ${lp.reduce((a, r) => a + r.lidarToPhotoN, 0)} buildings; per building median ${num(median(lp.flatMap((r) => r.lidarToPhotoVecs.map((v) => Math.hypot(...v)))))} m; per lot median ${num(median(lp.map((r) => Math.hypot(...r.lidarToPhoto))))} m; lots over 1 m ${lp.filter((r) => Math.hypot(...r.lidarToPhoto) > 1).length}, over 2 m ${lp.filter((r) => Math.hypot(...r.lidarToPhoto) > 2).length}`);

  console.log('\nTHE TRACED LAWN ON OVERTURE (pooled over all lawn cells; what a never-lawn rule would cost):');
  console.log(`  on an Overture building  ${pct(pooled('lawnOnBuilding0'))} as published, ${pct(pooled('lawnOnBuildingBest'))} at the lot's shift   (on the lidar's own roofs: ${pct(pooled('lawnOnLidarRoof'))})`);
  console.log(`  on a road band           ${pct(pooled('lawnOnRoad0'))} as published, ${pct(pooled('lawnOnRoadBest'))} at the lot's shift`);
  console.log(`  on a sidewalk band       ${pct(pooled('lawnOnWalk0'))} as published, ${pct(pooled('lawnOnWalkBest'))} at the lot's shift`);
  console.log(`  worst lots, lawn on a building: ${worst(rows, 'lawnOnBuilding0')}`);
  console.log(`  worst lots, lawn on a road or walk band: ${worst(rows, (r) => r.lawnOnRoad0 + r.lawnOnWalk0)}`);
  console.log(`\n  inside the property line, share of each band that is traced lawn, median: road ${pct(median(col('roadBandOnLawn0')))}, walk ${pct(median(col('walkBandOnLawn0')))}`);
  console.log('\nPictures (first lots): red wash = lidar roof, green = traced lawn, yellow = Overture building as published,');
  console.log('cyan = the same at the lot\'s best shift, blue = road band, magenta = sidewalk band.');
}

const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '  -  ');
const num = (x) => (Number.isFinite(x) ? x.toFixed(2) : '-');
const summariseSkips = (sk) => { const c = {}; for (const v of Object.values(sk)) { const k = v.split(':')[0]; c[k] = (c[k] || 0) + 1; } return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'; };
function worst(rows, key) {
  const f = typeof key === 'function' ? key : (r) => r[key];
  return rows.filter((r) => Number.isFinite(f(r))).sort((a, b) => f(b) - f(a)).slice(0, 5).map((r) => `${pct(f(r))}`).join(', ');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); process.exit(1); });
