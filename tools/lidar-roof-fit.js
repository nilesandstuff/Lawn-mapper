/*
 * HOW FAR THE LIDAR'S ROOFS SIT FROM THE PHOTO'S, lot by lot (owner,
 * 2026-10-20: "I looked through the 104 corpus maps and some lidar roof
 * shapes are not centered on the foundation and overlap with actual lawn. So
 * yes, there's an alignment issue that needs to be addressed." C71 is his
 * example.)
 *
 * The lidar's roof is the one thing in it with a crisp edge that the photo
 * also shows crisply, so the measure is the roof: a roof mask from the point
 * cloud on 1 m cells (the rule lidar_frame.py trains with -- no ground return,
 * 2.5 m up, flat -- but at 1 m, not its 2 m), placed as the decoder reads it
 * today (the datum move), its edge cells with their directions slid over the
 * photo's edges (public/lib/photo-fit.js edgeFit, the matcher H102 used) for
 * the one shift of the frame that puts the lidar's roof edges on the photo's
 * roof edges, within 4 m. A roof in a photo leans away from its footprint by
 * its height, so what this finds is where the ROOF IS IN THE PICTURE, which is
 * what the trace was drawn against and what the roof veto and roof channel
 * should sit on; the ground under it is not moved by lean, and that is noted
 * where it matters.
 *
 * Per lot it also counts the owner's symptom: the share of the hand-traced
 * lawn under the lidar's roof mask, before the move and after. And it groups
 * the shifts by lidar project, because a datum or survey error is one shift
 * per flight, while photo lean and frame error are one per lot.
 *
 * THE FIRST RUN (39411799953) MATCHED THE WRONG EDGES: a roof mask built cell by
 * cell at 1 m is ragged (two or three points a cell; a cell with one stray
 * ground return is a hole), so most of its "edges" were holes inside the roof
 * and the fit slid 2-6 m onto whatever strong edge was near. This run takes
 * the edges from the lidar's HEIGHT SURFACE instead -- the top of what is
 * there, filled and smoothed on 0.5 m cells, less the ground -- where it drops
 * 2 m or more across a 3 x 3 window: the eave of a roof, the edge of a crown. The picture draws that surface's 2.5 m outline (solid), not the
 * ragged mask. And it counts the owner's symptom with the TRAINING's own roof
 * mask (lidar_frame.py's rule on 2 m cells) as well as at 1 m, because a 2 m
 * cell straddling an eave overlaps the lawn by up to 2 m by its size alone.
 *
 * Inputs: FRAMES (scale.json with boxes, tags, sources; <id>.png; <id>-labels.png),
 * PLAN (lidar-plan.json), OUT. Public EPT clouds only.
 *   FRAMES=frames PLAN=lidar-plan.json OUT=lidar-roof-fit node tools/lidar-roof-fit.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { frameOfBox, cloudFor } from './lidar-photo.js';
import { nad83Correction } from '../public/shade/datum.js';
import { gridOver, rasterise, fillGaps } from '../public/shade/grid.js';
import { dilate } from '../public/shade/align.js';
import { greyGrid, gradients, edgeFit, PEAK_MIN } from '../public/lib/photo-fit.js';
import { pointsIn } from '../water/lib/ept.js';
import { nodeIo } from '../water/lib/node-io.js';

/* The roof rule, as lidar_frame.py (ROOF_MIN_M, ROOF_SPREAD_M, ROOF_MIN_RETURNS): on 2 m cells it is
   the training's own mask; on 1 m cells the first run's ragged one (kept for the lawn count). */
export const ROOF_CELL_M = 1, TRAIN_CELL_M = 2, ROOF_MIN_M = 2.5, ROOF_SPREAD_M = 1.5, ROOF_MIN_RETURNS = 2;
/* The height surface for the edges: 0.5 m cells; an edge is a drop of DROP_MIN_M or more across a 3 x 3 window. */
export const HEIGHT_CELL_M = 0.5, DROP_MIN_M = 2;
/* The photo's edges on a quarter-metre grid; the search reaches 4 m each way. */
export const FIT_CELL_M = 0.25, REACH_M = 4;
/* The GROUND fit (owner, 2026-10-20: "above all else, lidar needs to line up with the ground"):
   the lidar's ground brightness (iLow, the returns within 0.3 m of each cell's lowest) where the
   surface is under GROUND_MAX_M and at least GROUND_MARGIN_M from anything taller, its strongest
   brightness edges (the top GROUND_EDGE_SHARE of ground cells by gradient: a drive's edge, a kerb,
   a path) slid onto the photo's edges within GROUND_REACH_M. Roofs and crowns lean; the ground
   does not. */
export const GROUND_MAX_M = 0.5, GROUND_MARGIN_M = 1.5, GROUND_EDGE_SHARE = 0.12, GROUND_REACH_M = 3, GROUND_MIN_OPEN = 0.2;
/* THE AGREE RULE (H111, adopted after the owner's by-eye check of 2026-10-22):
   a lot's lidar is moved only when the roof fit and the ground fit are both
   confident and agree within AGREE_M, by their mean. Two measurements of
   different things saying the same thing is a lot with no lean and a real
   offset (C71: 2 m). The ground fit alone was "confident" and 2 m wrong on
   C60; over the corpus it fixed as many lots as it broke. */
export const AGREE_M = 1;

/** The agree rule on one measured row: { east, north, peak } in ground metres, or null. Pure. */
export function agreeMove(r) {
  if (!r || !r.confident || !r.groundConfident) return null;
  if (!Number.isFinite(r.east) || !Number.isFinite(r.groundEast)) return null;
  if (Math.abs(r.east - r.groundEast) > AGREE_M || Math.abs(r.north - r.groundNorth) > AGREE_M) return null;
  if (Math.max(Math.abs(r.groundEast), Math.abs(r.groundNorth)) >= GROUND_REACH_M) return null;
  return { east: (r.east + r.groundEast) / 2, north: (r.north + r.groundNorth) / 2, peak: Math.min(r.peak, r.groundPeak), method: 'agree' };
}
export const MIN_EDGE_CELLS = 24; // a garage-sized roof has 24 edge metres

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '  -  ');

/** The roof mask (1 inside) from a rasterised grid `r` ({ n, nGround, zTop, zMin, zGround }) over `g`. Pure. */
export function roofMask(r, g) {
  /* The ground under a roof comes from round it: a wide fill (20 rounds, a 40 m roof) so the
     middle of a big roof still has a ground to be 2.5 m above. */
  const ground = fillGaps(r.zGround, g.w, g.h, 20);
  const m = new Uint8Array(g.w * g.h);
  for (let i = 0; i < m.length; i++) {
    if (r.nGround[i] || r.n[i] < ROOF_MIN_RETURNS || Number.isNaN(ground[i]) || Number.isNaN(r.zTop[i])) continue;
    if (r.zTop[i] - ground[i] >= ROOF_MIN_M && r.zTop[i] - r.zMin[i] <= ROOF_SPREAD_M) m[i] = 1;
  }
  /* One pass of open-then-close at 1 m: a lone cell is a tree top, a lone hole a chimney. */
  const nb = (a, i, w, h, want) => { const x = i % w, y = (i - x) / w; let c = 0; if (x > 0 && a[i - 1] === want) c++; if (x < w - 1 && a[i + 1] === want) c++; if (y > 0 && a[i - w] === want) c++; if (y < h - 1 && a[i + w] === want) c++; return c; };
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = m[i] ? (nb(m, i, g.w, g.h, 1) >= 2 ? 1 : 0) : (nb(m, i, g.w, g.h, 1) >= 3 ? 1 : 0);
  return out;
}

/**
 * The mask's edge cells as fit-grid points with the edge's direction: [x, y, nx, ny] in cells of
 * the fit grid (`scale` fit cells per mask cell). The sign of the normal does not matter to
 * edgeFit, which takes the gradient's absolute projection. Pure.
 */
export function edgePoints(mask, w, h, scale) {
  const pts = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!mask[i]) continue;
    const nx = mask[i + 1] - mask[i - 1], ny = mask[i + w] - mask[i - w];
    if (!nx && !ny) continue;
    const L = Math.hypot(nx, ny);
    pts.push([(x + 0.5) * scale, (y + 0.5) * scale, nx / L, ny / L]);
  }
  return pts;
}

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

/** The share of traced lawn (labels R >= 128) under the roof mask. NaN with too little lawn. Pure. */
export function lawnUnderRoof(mask, g, labels) {
  let n = 0, under = 0;
  for (let row = 0; row < g.h; row++) for (let col = 0; col < g.w; col++) {
    const lr = Math.min(labels.height - 1, Math.floor(((row + 0.5) * labels.height) / g.h)), lc = Math.min(labels.width - 1, Math.floor(((col + 0.5) * labels.width) / g.w));
    if (labels.data[(lr * labels.width + lc) * 4] < 128) continue;
    n++; if (mask[row * g.w + col]) under++;
  }
  return n >= 100 ? under / n : NaN;
}

/**
 * The lidar's ground brightness per cell of `g`, filled and lightly smoothed (3 x 3), NaN where no
 * low return came back within reach; and the ground mask: cells under GROUND_MAX_M of height and
 * at least `marginCells` from any cell GROUND_MAX_M or taller. Pure.
 */
export function groundSurface(r, h, g, marginCells) {
  const raw = fillGaps(r.iLow, g.w, g.h, 2);
  const b = new Float32Array(g.w * g.h).fill(NaN);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    let t = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= g.h || xx >= g.w) continue;
      const v = raw[yy * g.w + xx];
      if (!Number.isNaN(v)) { t += v; n++; }
    }
    if (n) b[y * g.w + x] = t / n;
  }
  const tall = new Uint8Array(g.w * g.h);
  for (let i = 0; i < tall.length; i++) tall[i] = h[i] >= GROUND_MAX_M ? 1 : 0;
  const near = dilate(tall, g.w, g.h, marginCells);
  const ground = new Uint8Array(g.w * g.h);
  for (let i = 0; i < ground.length; i++) ground[i] = !near[i] && !Number.isNaN(h[i]) && !Number.isNaN(b[i]) ? 1 : 0;
  return { bright: b, ground };
}

/**
 * The ground's brightness edges as fit-grid points with their direction: the ground cells whose
 * brightness gradient is in the top `share` of all ground cells. Pure.
 */
export function groundPoints(bright, ground, w, hgt, scale, share = GROUND_EDGE_SHARE) {
  const cand = [];
  for (let y = 1; y < hgt - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!ground[i] || !ground[i - 1] || !ground[i + 1] || !ground[i - w] || !ground[i + w]) continue;
    const gx = bright[i + 1] - bright[i - 1], gy = bright[i + w] - bright[i - w];
    const L = Math.hypot(gx, gy);
    if (!(L > 0)) continue;
    cand.push([L, (x + 0.5) * scale, (y + 0.5) * scale, gx / L, gy / L]);
  }
  if (!cand.length) return [];
  cand.sort((a, b) => b[0] - a[0]);
  return cand.slice(0, Math.max(1, Math.round(cand.length * share))).map(([, x, y, nx, ny]) => [x, y, nx, ny]);
}

/**
 * The shift that puts the lidar's GROUND edges on the photo's: { east, north } in ground metres,
 * edgeFit's peak, the point count, and `confident`. Null with too few ground edges. Pure.
 */
export function fitGround(bright, ground, g, grey, Wg, Hg) {
  const scale = g.cellM / FIT_CELL_M;
  const pts = groundPoints(bright, ground, g.w, g.h, scale);
  if (pts.length < MIN_EDGE_CELLS * 2) return null;
  const { gx, gy } = gradients(grey, Wg, Hg);
  const f = edgeFit(pts, gx, gy, Wg, Hg, Math.round(GROUND_REACH_M / FIT_CELL_M));
  if (!f) return null;
  return { east: f.dx * FIT_CELL_M, north: -f.dy * FIT_CELL_M, peak: f.peak, score: f.s, at0: f.at0, edges: pts.length, confident: f.peak >= PEAK_MIN };
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

function readPhoto(PNG, file) {
  const p = PNG.sync.read(readFileSync(file));
  return { data: p.data, width: p.width, height: p.height };
}

/** The photo (halved) with the roof mask's outline as read today (yellow) and moved (cyan), the traced lawn's edge in green. */
function picture(PNG, photo, box, labels, masks, file) {
  const K = 2, W = photo.width, H = photo.height;
  const w = Math.round(W / K), h = Math.round(H / K);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (Math.min(H - 1, y * K) * W + Math.min(W - 1, x * K)) * 4, o = (y * w + x) * 4;
    out.data[o] = photo.data[s]; out.data[o + 1] = photo.data[s + 1]; out.data[o + 2] = photo.data[s + 2]; out.data[o + 3] = 255;
  }
  const dot = (x, y, rgb) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 4; out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; } };
  const outline = (mask, mw, mh, rgb, thick = 1) => {
    for (let row = 0; row < mh; row++) for (let col = 0; col < mw; col++) {
      const i = row * mw + col;
      if (!mask[i]) continue;
      const edge = (col > 0 && !mask[i - 1]) || (col < mw - 1 && !mask[i + 1]) || (row > 0 && !mask[i - mw]) || (row < mh - 1 && !mask[i + mw]);
      if (!edge) continue;
      const cx = ((col + 0.5) / mw) * w, cy = ((row + 0.5) / mh) * h, r = (w / mw) / 2;
      for (let t = -r; t <= r; t += 0.5) for (let u = -thick; u <= thick; u++) { dot(cx + t, cy + u, rgb); dot(cx + u, cy + t, rgb); }
    }
  };
  if (labels) {
    const lm = new Uint8Array(labels.width * labels.height);
    for (let i = 0; i < lm.length; i++) lm[i] = labels.data[i * 4] >= 128 ? 1 : 0;
    outline(lm, labels.width, labels.height, [60, 230, 60], 0);
  }
  for (const { mask, g, rgb } of masks) outline(mask, g.w, g.h, rgb);
  writeFileSync(file, PNG.sync.write(out));
}

async function main() {
  const dirs = { frames: process.env.FRAMES || 'frames', out: process.env.OUT || 'lidar-roof-fit' };
  const planFile = process.env.PLAN || 'lidar-plan.json';
  mkdirSync(join(dirs.out, 'pictures'), { recursive: true });
  const { PNG } = await import('pngjs');
  const scale = JSON.parse(readFileSync(join(dirs.frames, 'scale.json'), 'utf8'));
  const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
  const boxes = scale.boxes || {}, tags = scale.tags || {}, sources = scale.sources || {};
  const ids = Object.keys(boxes).filter((id) => !id.includes(':example:') && existsSync(join(dirs.frames, `${id}.png`))).sort();
  const pictures = Number(process.env.PICTURES || 200);
  const io = nodeIo();
  const rows = [], skipped = {};
  console.log(`${ids.length} lots; the lidar's roof edges slid onto each photo's edges (photo-fit.js edgeFit), ${ROOF_CELL_M} m roof cells, ${FIT_CELL_M} m photo cells, ${REACH_M} m reach\n`);
  for (const id of ids) {
    const box = boxes[id], tag = tags[id] || id.slice(0, 22);
    const t0 = Date.now();
    try {
      const cloud = await cloudFor(id, box, plan);
      if (!cloud) { skipped[id] = 'no public cloud'; console.log(`  --- ${tag.padEnd(6)} no public point cloud`); continue; }
      const photo = readPhoto(PNG, join(dirs.frames, `${id}.png`));
      const labels = existsSync(join(dirs.frames, `${id}-labels.png`)) ? readPhoto(PNG, join(dirs.frames, `${id}-labels.png`)) : null;
      const frame = frameOfBox(box, photo.width, photo.height);
      const k = Math.cos((frame.lat * Math.PI) / 180);
      const { cols } = await pointsIn(cloud.url, box, io);
      if (!cols || cols.n < 500) { skipped[id] = `only ${cols?.n || 0} points`; console.log(`  --- ${tag.padEnd(6)} only ${cols?.n || 0} points in the frame`); continue; }
      const datum = nad83Correction(frame.lat, frame.lng, cloud.epoch);
      const pre = [datum.east / k, datum.north / k]; // the lidar as the decoder reads it today (3857 m)
      /* The height surface as the decoder reads the lidar today (the datum move), and its edges
         against the photo; the same with no datum move at all, to see which the photo prefers. */
      const hg = { ...gridOver(box, HEIGHT_CELL_M, frame.lat), cellM: HEIGHT_CELL_M };
      const hToday = heightSurface(rasterise(cols, hg, { shift: pre }), hg);
      const fg = gridOver(box, FIT_CELL_M, frame.lat);
      const grey = greyGrid(photo.data, photo.width, photo.height, fg.w, fg.h);
      const fit = fitRoof(hToday, hg, grey, fg.w, fg.h, k);
      const fitRaw = fitRoof(heightSurface(rasterise(cols, hg), hg), hg, grey, fg.w, fg.h, k);
      /* THE GROUND (owner, 2026-10-20): the lidar's ground brightness edges against the photo's,
         roofs and crowns and a margin for their lean kept out. This is the number that moves the
         lidar; the roof fit less it is the roof's lean in the picture. */
      const rToday = rasterise(cols, hg, { shift: pre });
      const gs = groundSurface(rToday, hToday, hg, Math.round(GROUND_MARGIN_M / HEIGHT_CELL_M));
      const gfit = fitGround(gs.bright, gs.ground, hg, grey, fg.w, fg.h);
      let groundCells = 0; for (let i = 0; i < gs.ground.length; i++) groundCells += gs.ground[i];
      const lean = fit?.confident && gfit?.confident ? { east: fit.east - gfit.east, north: fit.north - gfit.north } : null;
      const tallOf = (h) => { const m = new Uint8Array(h.length); for (let i = 0; i < m.length; i++) m[i] = h[i] >= ROOF_MIN_M ? 1 : 0; return m; };
      const tallToday = tallOf(hToday);
      const hMoved = fit ? heightSurface(rasterise(cols, hg, { shift: [pre[0] + fit.east / k, pre[1] + fit.north / k] }), hg) : null;
      /* The owner's symptom, three ways: the training's own roof mask (2 m cells), the same rule at
         1 m, and the height surface's 2.5 m+ (roofs and crowns), each over the traced lawn. */
      const g2 = gridOver(box, TRAIN_CELL_M, frame.lat), g1 = gridOver(box, ROOF_CELL_M, frame.lat);
      const roof2 = roofMask(rasterise(cols, g2, { shift: pre }), g2), roof1 = roofMask(rasterise(cols, g1, { shift: pre }), g1);
      let roofCells = 0; for (let i = 0; i < roof2.length; i++) roofCells += roof2[i] * TRAIN_CELL_M * TRAIN_CELL_M;
      const row = {
        id, tag, source: sources[id] || null, cloud: cloud.name, epoch: cloud.epoch, points: cols.n,
        datumEast: datum.east, datumNorth: datum.north, roofCells,
        east: fit?.east ?? NaN, north: fit?.north ?? NaN, shiftM: fit ? Math.hypot(fit.east, fit.north) : NaN,
        peak: fit?.peak ?? NaN, score: fit?.score ?? NaN, at0: fit?.at0 ?? NaN, edges: fit?.edges ?? 0, confident: !!fit?.confident,
        rawEast: fitRaw?.east ?? NaN, rawNorth: fitRaw?.north ?? NaN, rawScore: fitRaw?.score ?? NaN, rawAt0: fitRaw?.at0 ?? NaN,
        groundEast: gfit?.east ?? NaN, groundNorth: gfit?.north ?? NaN, groundM: gfit ? Math.hypot(gfit.east, gfit.north) : NaN,
        groundPeak: gfit?.peak ?? NaN, groundScore: gfit?.score ?? NaN, groundAt0: gfit?.at0 ?? NaN, groundEdges: gfit?.edges ?? 0, groundConfident: !!gfit?.confident,
        groundShareOfFrame: groundCells / gs.ground.length,
        leanEast: lean?.east ?? NaN, leanNorth: lean?.north ?? NaN, leanM: lean ? Math.hypot(lean.east, lean.north) : NaN,
        lawnUnderRoof2m: labels ? lawnUnderRoof(roof2, g2, labels) : NaN,
        lawnUnderRoof1m: labels ? lawnUnderRoof(roof1, g1, labels) : NaN,
        lawnUnderTallToday: labels ? lawnUnderRoof(tallToday, hg, labels) : NaN,
        lawnUnderTallMoved: labels && hMoved ? lawnUnderRoof(tallOf(hMoved), hg, labels) : NaN,
        seconds: (Date.now() - t0) / 1000,
      };
      rows.push(row);
      if (rows.length <= pictures) {
        const safe = `${tag}-${id.slice(0, 18)}`.replace(/[^\w.-]+/g, '_');
        picture(PNG, photo, box, labels, [{ mask: roof2, g: g2, rgb: [255, 120, 0] }, { mask: tallToday, g: hg, rgb: [255, 230, 0] }, ...(hMoved ? [{ mask: tallOf(hMoved), g: hg, rgb: [0, 230, 230] }] : [])], join(dirs.out, 'pictures', `${safe}.png`));
      }
      console.log(`  ${String(rows.length).padStart(3)} ${tag.padEnd(6)} ${(sources[id] || '?').padEnd(7)} GROUND ${gfit ? `${num(row.groundM)} m (E ${num(gfit.east)}, N ${num(gfit.north)}) peak ${num(gfit.peak)} ${gfit.confident ? 'MEASURED' : 'unsure  '}` : 'no ground edge to fit             '} (${pct(row.groundShareOfFrame)} of the frame open)  roof ${fit ? `${num(row.shiftM)} m (E ${num(fit.east)}, N ${num(fit.north)}) peak ${num(fit.peak)} ${fit.confident ? 'MEASURED' : 'unsure  '}` : 'no edge to fit                  '}  lean ${lean ? `${num(row.leanM)} m (E ${num(lean.east)}, N ${num(lean.north)})` : '  -  '}  lawn under roof 2 m ${pct(row.lawnUnderRoof2m)}  ${row.seconds.toFixed(0)}s  ${cloud.name || ''}`);
    } catch (err) {
      skipped[id] = String(err?.message || err).slice(0, 100);
      console.log(`  --- ${tag.padEnd(6)} failed: ${skipped[id]}`);
    }
  }
  writeFileSync(join(dirs.out, 'lidar-roof-fit.json'), JSON.stringify({ roofCellM: ROOF_CELL_M, fitCellM: FIT_CELL_M, reachM: REACH_M, groundReachM: GROUND_REACH_M, rows, skipped }, null, 1));
  /* THE GROUND SHIFTS, for the training (lidar_frame.py adds them to the datum move): the move
     for the lidar in ground metres, only where the ground fit is clear. */
  /* Kept out of the file: a fit that ran to the edge of its search (nothing to say it would not
     have gone further), and a frame with little open ground to match on (under GROUND_MIN_OPEN of
     its cells): run 3 put C88 at 4.6 m on 11% open ground, which is a fit to the wrong edges. */
  const shifts = {};
  for (const r of rows) { const m = agreeMove(r); if (m) shifts[r.id] = { ...m, tag: r.tag }; }
  const groundOnly = rows.filter((r) => r.groundConfident && Math.abs(r.groundEast) < GROUND_REACH_M && Math.abs(r.groundNorth) < GROUND_REACH_M && r.groundShareOfFrame >= GROUND_MIN_OPEN).length;
  console.log(`\nlidar-shifts.json: ${Object.keys(shifts).length} lots moved by THE AGREE RULE (roof fit and ground fit both confident and within ${AGREE_M} m of each other; the ground-only rule would have moved ${groundOnly}, and H111 found it breaks as many lots as it fixes).`);
  for (const [id, m] of Object.entries(shifts)) if (Math.hypot(m.east, m.north) >= 1) console.log(`  ${m.tag || id.slice(0, 24)}  E ${m.east.toFixed(2)}  N ${m.north.toFixed(2)} m`);
  writeFileSync(join(dirs.out, 'lidar-shifts.json'), JSON.stringify({ unit: 'ground metres, the move to give the lidar after the datum move', rule: `roof fit and ground fit both confident and agreeing within ${AGREE_M} m; the move is their mean (H111)`, shifts }, null, 1));

  const gsure = rows.filter((r) => r.groundConfident);
  console.log(`\n${rows.length} lots read, ${Object.keys(skipped).length} skipped.`);
  console.log(`THE LIDAR'S GROUND AGAINST THE PHOTO'S (the number that matters): a ground fit on ${rows.filter((r) => Number.isFinite(r.groundM)).length}, MEASURED (peak ${PEAK_MIN}+) on ${gsure.length}.`);
  if (gsure.length) {
    const gm = gsure.map((r) => r.groundM);
    console.log(`  measured lots: median ${num(median(gm))} m off after the datum move (E ${num(median(gsure.map((r) => r.groundEast)))}, N ${num(median(gsure.map((r) => r.groundNorth)))}); within 0.5 m on ${gm.filter((v) => v <= 0.5).length}, over 1 m on ${gm.filter((v) => v > 1).length}, over 2 m on ${gm.filter((v) => v > 2).length} of ${gsure.length}.`);
    for (const src of ['mapbox', 'county']) {
      const s2 = gsure.filter((r) => (r.source || '').toLowerCase().includes(src));
      if (s2.length) console.log(`  ${src.padEnd(7)} photos: ${s2.length} measured, median ${num(median(s2.map((r) => r.groundM)))} m (E ${num(median(s2.map((r) => r.groundEast)))}, N ${num(median(s2.map((r) => r.groundNorth)))})`);
    }
    const far = gsure.filter((r) => r.groundM > 0.75).sort((a, b) => b.groundM - a.groundM);
    if (far.length) console.log(`  ground over 0.75 m: ${far.map((r) => `${r.tag} ${num(r.groundM)} m (E ${num(r.groundEast)}, N ${num(r.groundNorth)}, peak ${num(r.groundPeak)})`).join('; ')}`);
    const leans = rows.filter((r) => Number.isFinite(r.leanM));
    if (leans.length) {
      console.log(`  LEAN (roof fit less ground fit, both measured, ${leans.length} lots): median ${num(median(leans.map((r) => r.leanM)))} m; over 1 m on ${leans.filter((r) => r.leanM > 1).length}, over 2 m on ${leans.filter((r) => r.leanM > 2).length}.`);
      const byCloudL = new Map();
      for (const r of leans) { const c = r.cloud || '?'; if (!byCloudL.has(c)) byCloudL.set(c, []); byCloudL.get(c).push(r); }
      for (const [c, rs] of [...byCloudL.entries()].sort((a, b) => b[1].length - a[1].length)) if (rs.length >= 2) console.log(`    ${c.slice(0, 40).padEnd(40)} ${rs.length} lots: lean E ${num(median(rs.map((r) => r.leanEast)))} N ${num(median(rs.map((r) => r.leanNorth)))}, ground E ${num(median(rs.map((r) => r.groundEast)))} N ${num(median(rs.map((r) => r.groundNorth)))}`);
    }
  }
  const gunsure = rows.filter((r) => !r.groundConfident);
  if (gunsure.length) console.log(`  ground unsure (${gunsure.length}): ${gunsure.map((r) => `${r.tag} (peak ${num(r.groundPeak)}, ${r.groundEdges} edges, ${pct(r.groundShareOfFrame)} open)`).join(', ')}`);
  const sure = rows.filter((r) => r.confident);
  const sh = sure.map((r) => r.shiftM);
  console.log(`\nTHE ROOFS: a roof fit on ${rows.filter((r) => Number.isFinite(r.shiftM)).length}, MEASURED (peak ${PEAK_MIN}+) on ${sure.length}. These are where the roof is IN THE PICTURE (lean included), not a ground number.`);
  if (sure.length) {
    console.log(`THE LIDAR'S ROOFS AGAINST THE PHOTO'S, the measured lots: median ${num(median(sh))} m off (E ${num(median(sure.map((r) => r.east)))}, N ${num(median(sure.map((r) => r.north)))}); over 0.5 m on ${sh.filter((v) => v > 0.5).length}, over 1 m on ${sh.filter((v) => v > 1).length}, over 2 m on ${sh.filter((v) => v > 2).length} of ${sure.length}.`);
    const pooled = (key, set = sure) => { const xs = set.map((r) => r[key]).filter(Number.isFinite); return xs.length ? { med: median(xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length } : { med: NaN, mean: NaN, n: 0 }; };
    const say = (label, key, set) => { const p = pooled(key, set); return `${label} median ${pct(p.med)}, mean ${pct(p.mean)} (${p.n} lots)`; };
    console.log(`TRACED LAWN UNDER THE LIDAR'S ROOF, every lot read: ${say("the training's 2 m roof mask", 'lawnUnderRoof2m', rows)}; ${say('the same rule at 1 m', 'lawnUnderRoof1m', rows)}; ${say('anything 2.5 m+ (0.5 m)', 'lawnUnderTallToday', rows)}.`);
    console.log(`  After the move (measured lots): ${say('2.5 m+', 'lawnUnderTallMoved')} against ${say('today', 'lawnUnderTallToday')}.`);
    const better = sure.filter((r) => Number.isFinite(r.lawnUnderTallToday) && r.lawnUnderTallMoved < r.lawnUnderTallToday - 1e-9).length, worse = sure.filter((r) => Number.isFinite(r.lawnUnderTallToday) && r.lawnUnderTallMoved > r.lawnUnderTallToday + 1e-9).length;
    console.log(`  less lawn under 2.5 m+ after the move on ${better} lots, more on ${worse}.`);
    const prefRaw = sure.filter((r) => Number.isFinite(r.rawScore) && r.rawScore > r.score + 1e-9).length;
    console.log(`  The datum move: the photo's edges score higher WITHOUT it on ${prefRaw} of ${sure.length} measured lots (at the datum position vs none: median ${num(median(sure.map((r) => r.at0)))} vs ${num(median(sure.map((r) => r.rawAt0)))}).`);
    for (const src of ['mapbox', 'county']) {
      const s = sure.filter((r) => (r.source || '').toLowerCase().includes(src));
      if (s.length) console.log(`  ${src.padEnd(7)} photos: ${s.length} measured, median ${num(median(s.map((r) => r.shiftM)))} m (E ${num(median(s.map((r) => r.east)))}, N ${num(median(s.map((r) => r.north)))})`);
    }
    /* ONE SHIFT PER FLIGHT, OR ONE PER LOT? Lots grouped by lidar project: a datum or survey
       error gives every lot of a project the same vector; lean and frame error scatter them. */
    const byCloud = new Map();
    for (const r of sure) { const c = r.cloud || '?'; if (!byCloud.has(c)) byCloud.set(c, []); byCloud.get(c).push(r); }
    console.log('\n  BY LIDAR PROJECT (measured lots): the median shift, and how far the lots scatter about it');
    console.log(`  ${'project'.padEnd(44)} lots   E      N     |med|  scatter`);
    for (const [c, rs] of [...byCloud.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const e = median(rs.map((r) => r.east)), n = median(rs.map((r) => r.north));
      const scatter = median(rs.map((r) => Math.hypot(r.east - e, r.north - n)));
      console.log(`  ${c.slice(0, 44).padEnd(44)} ${String(rs.length).padStart(3)}  ${num(e).padStart(5)}  ${num(n).padStart(5)}  ${num(Math.hypot(e, n)).padStart(5)}  ${num(scatter).padStart(5)}${rs.length >= 3 ? '' : '   (too few to say)'}`);
    }
    const worst = sure.slice().sort((a, b) => b.shiftM - a.shiftM).slice(0, 10);
    console.log('\n  FURTHEST OFF (measured):');
    for (const r of worst) console.log(`    ${r.tag.padEnd(6)} ${num(r.shiftM)} m (E ${num(r.east)}, N ${num(r.north)}) peak ${num(r.peak)}  lawn under 2.5 m+ ${pct(r.lawnUnderTallToday)} -> ${pct(r.lawnUnderTallMoved)}  ${r.cloud || ''}`);
  }
  const unsure = rows.filter((r) => !r.confident);
  if (unsure.length) console.log(`\n  UNSURE (${unsure.length}): ${unsure.map((r) => `${r.tag} (peak ${num(r.peak)}, ${r.edges} edges)`).join(', ')}`);
  console.log('\nPictures: orange = the training\'s 2 m roof mask as the decoder reads it today, yellow = the lidar\'s 2.5 m+ surface (roofs and crowns) today, cyan = the same moved onto the photo\'s edges, green = the traced lawn.');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); process.exit(1); });
