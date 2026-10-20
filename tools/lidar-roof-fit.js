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
 * Inputs: FRAMES (scale.json with boxes, tags, sources; <id>.png; <id>-labels.png),
 * PLAN (lidar-plan.json), OUT. Public EPT clouds only.
 *   FRAMES=frames PLAN=lidar-plan.json OUT=lidar-roof-fit node tools/lidar-roof-fit.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { frameOfBox, cloudFor } from './lidar-photo.js';
import { nad83Correction } from '../public/shade/datum.js';
import { gridOver, rasterise, fillGaps } from '../public/shade/grid.js';
import { greyGrid, gradients, edgeFit, PEAK_MIN } from '../public/lib/photo-fit.js';
import { pointsIn } from '../water/lib/ept.js';
import { nodeIo } from '../water/lib/node-io.js';

/* The roof rule, as lidar_frame.py (ROOF_MIN_M, ROOF_SPREAD_M, ROOF_MIN_RETURNS) but on 1 m cells. */
export const ROOF_CELL_M = 1, ROOF_MIN_M = 2.5, ROOF_SPREAD_M = 1.5, ROOF_MIN_RETURNS = 2;
/* The photo's edges on a quarter-metre grid; the search reaches 4 m each way. */
export const FIT_CELL_M = 0.25, REACH_M = 4;
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
 * The shift that puts the lidar's roof edges on the photo's: { east, north } in ground metres
 * (the move to add to the lidar), with edgeFit's peak and the edge count. Null with too few edges.
 * `grey` is the photo on the fit grid (Wg x Hg), `mask` the roof on g (ROOF_CELL_M). Pure.
 */
export function fitRoof(mask, g, grey, Wg, Hg, k) {
  const scale = ROOF_CELL_M / FIT_CELL_M;
  const pts = edgePoints(mask, g.w, g.h, scale);
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
      const g = gridOver(box, ROOF_CELL_M, frame.lat);
      const today = roofMask(rasterise(cols, g, { shift: pre }), g);
      let roofCells = 0; for (let i = 0; i < today.length; i++) roofCells += today[i];
      const fg = gridOver(box, FIT_CELL_M, frame.lat);
      const grey = greyGrid(photo.data, photo.width, photo.height, fg.w, fg.h);
      const fit = fitRoof(today, g, grey, fg.w, fg.h, k);
      const moved = fit ? roofMask(rasterise(cols, g, { shift: [pre[0] + fit.east / k, pre[1] + fit.north / k] }), g) : null;
      const row = {
        id, tag, source: sources[id] || null, cloud: cloud.name, epoch: cloud.epoch, points: cols.n,
        datumEast: datum.east, datumNorth: datum.north, roofCells,
        east: fit?.east ?? NaN, north: fit?.north ?? NaN, shiftM: fit ? Math.hypot(fit.east, fit.north) : NaN,
        peak: fit?.peak ?? NaN, score: fit?.score ?? NaN, at0: fit?.at0 ?? NaN, edges: fit?.edges ?? 0, confident: !!fit?.confident,
        lawnUnderRoofToday: labels ? lawnUnderRoof(today, g, labels) : NaN,
        lawnUnderRoofMoved: labels && moved ? lawnUnderRoof(moved, g, labels) : NaN,
        seconds: (Date.now() - t0) / 1000,
      };
      rows.push(row);
      if (rows.length <= pictures) {
        const safe = `${tag}-${id.slice(0, 18)}`.replace(/[^\w.-]+/g, '_');
        picture(PNG, photo, box, labels, [{ mask: today, g, rgb: [255, 230, 0] }, ...(moved ? [{ mask: moved, g, rgb: [0, 230, 230] }] : [])], join(dirs.out, 'pictures', `${safe}.png`));
      }
      console.log(`  ${String(rows.length).padStart(3)} ${tag.padEnd(6)} ${(sources[id] || '?').padEnd(7)} roof ${String(roofCells).padStart(4)} m²  ${fit ? `moved ${num(row.shiftM)} m (E ${num(fit.east)}, N ${num(fit.north)}) peak ${num(fit.peak)} ${fit.confident ? 'MEASURED' : 'unsure  '}` : 'no roof edge to fit        '}  lawn under roof: today ${pct(row.lawnUnderRoofToday)} moved ${pct(row.lawnUnderRoofMoved)}  ${row.seconds.toFixed(0)}s  ${cloud.name || ''}`);
    } catch (err) {
      skipped[id] = String(err?.message || err).slice(0, 100);
      console.log(`  --- ${tag.padEnd(6)} failed: ${skipped[id]}`);
    }
  }
  writeFileSync(join(dirs.out, 'lidar-roof-fit.json'), JSON.stringify({ roofCellM: ROOF_CELL_M, fitCellM: FIT_CELL_M, reachM: REACH_M, rows, skipped }, null, 1));

  const sure = rows.filter((r) => r.confident);
  const sh = sure.map((r) => r.shiftM);
  console.log(`\n${rows.length} lots read, ${Object.keys(skipped).length} skipped; a roof fit on ${rows.filter((r) => Number.isFinite(r.shiftM)).length}, MEASURED (peak ${PEAK_MIN}+) on ${sure.length}.`);
  if (sure.length) {
    console.log(`THE LIDAR'S ROOFS AGAINST THE PHOTO'S, the measured lots: median ${num(median(sh))} m off (E ${num(median(sure.map((r) => r.east)))}, N ${num(median(sure.map((r) => r.north)))}); over 0.5 m on ${sh.filter((v) => v > 0.5).length}, over 1 m on ${sh.filter((v) => v > 1).length}, over 2 m on ${sh.filter((v) => v > 2).length} of ${sure.length}.`);
    const pooled = (key) => { const xs = sure.map((r) => r[key]).filter(Number.isFinite); return median(xs); };
    console.log(`Traced lawn under the lidar's roof, median over the measured lots: today ${pct(pooled('lawnUnderRoofToday'))}, moved ${pct(pooled('lawnUnderRoofMoved'))}.`);
    const better = sure.filter((r) => Number.isFinite(r.lawnUnderRoofToday) && r.lawnUnderRoofMoved < r.lawnUnderRoofToday - 1e-9).length, worse = sure.filter((r) => Number.isFinite(r.lawnUnderRoofToday) && r.lawnUnderRoofMoved > r.lawnUnderRoofToday + 1e-9).length;
    console.log(`  less lawn under the roof after the move on ${better} lots, more on ${worse}.`);
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
    for (const r of worst) console.log(`    ${r.tag.padEnd(6)} ${num(r.shiftM)} m (E ${num(r.east)}, N ${num(r.north)}) peak ${num(r.peak)}  lawn under roof ${pct(r.lawnUnderRoofToday)} -> ${pct(r.lawnUnderRoofMoved)}  ${r.cloud || ''}`);
  }
  const unsure = rows.filter((r) => !r.confident);
  if (unsure.length) console.log(`\n  UNSURE (${unsure.length}): ${unsure.map((r) => `${r.tag} (peak ${num(r.peak)}, ${r.edges} edges)`).join(', ')}`);
  console.log('\nPictures: yellow = the lidar roof as the decoder reads it today, cyan = moved onto the photo\'s roof edges, green = the traced lawn.');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); process.exit(1); });
