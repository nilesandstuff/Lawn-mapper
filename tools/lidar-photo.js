/*
 * DOES THE LIDAR SIT ON THE PHOTO? (owner, 2026-10-19: "lidar has been at least somewhat misaligned
 * this whole time", and the perspective of each flight distorts flat ground, not just roofs: traces
 * "line up on one side of the property but they'd be off on the other side, or the whole property
 * would just be slightly larger/smaller".)
 *
 * The lidar's layers have always been laid on the frame's box as if the photo were exact. This
 * measures, lot by lot, how the photo's GROUND sits against the lidar's, with the shade map's own
 * matcher (public/shade/align.js alignToPhoto, the features session's): the lidar's ground-return
 * intensity, a true orthophoto with nothing leaning, against the photo's edges on open ground only
 * (roofs and crowns and a margin for their lean are masked out), as one shift for the frame and
 * then each quarter alone. The quarters are the owner's observation made into a number: if the
 * photo is only shifted they agree; if it is stretched or skewed they do not.
 *
 * Overture's buildings are in the same true coordinates as the lidar, so the same move puts their
 * footprints onto the photo's ground; the pictures show them as published and moved.
 *
 * Inputs: FRAMES (scale.json with boxes, <id>.png, <id>-labels.png), PLAN (lidar-plan.json from
 * tools/lidar-plan.js + lidar-newest.js; a lot without an entry asks the live site which clouds
 * cover it), OUT. Public EPT clouds only; a lot whose only flight is USGS's tiles is skipped.
 *
 *   FRAMES=frames PLAN=lidar-plan.json OUT=lidar-photo node tools/lidar-photo.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { alignToPhoto } from '../public/shade/align.js';
import { nad83Correction } from '../public/shade/datum.js';
import { gridOver, rasterise, fillGaps } from '../public/shade/grid.js';
import { pointsIn } from '../water/lib/ept.js';
import { nodeIo } from '../water/lib/node-io.js';
import { overtureFor } from '../public/lib/overture.js';

const R = 6378137;
const LOOKUP = process.env.LIDAR_LOOKUP || 'https://lawnmap.nilesandstuff.com/api/shade/lidar';
const DEFAULT_EPOCH = 2015.5; // as tools/lidar_sources.py
const TALL_M = 2;             // the lawn test: seen lawn standing under this much lidar

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '  -  ');
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const fromMerc = ([x, y]) => [(x / R) * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];

/** A frame ({lng, lat, zoom, size, height}) whose grid is exactly the 3857 box, at the photo's pixel count. */
export function frameOfBox(box, width, height) {
  const [w, s, e, n] = box;
  const [lng, lat] = fromMerc([(w + e) / 2, (s + n) / 2]);
  const perPx = (e - w) / width;
  const zoom = Math.log2((2 * Math.PI * R) / (512 * perPx));
  return { lng, lat, zoom, size: width, height };
}

/**
 * What the four quarters say together: the whole frame's shift, how far each quarter is from it,
 * and the stretch (how much the east half's shift differs from the west half's, per metre between
 * them, and the same north-south), in metres per metre. A scale of 1% reads 0.01.
 */
export function quarterPattern(fit, widthM, heightM) {
  const q = fit.quarters || [];
  const ok = (i) => q[i] && Number.isFinite(q[i].east) && q[i].score >= 0.12;
  const out = { quartersOk: [0, 1, 2, 3].filter(ok).length };
  // [NW, NE, SW, SE]
  const d = (i, j, k) => (ok(i) && ok(j) ? q[j][k] - q[i][k] : NaN);
  const ew = [d(0, 1, 'east'), d(2, 3, 'east')].filter(Number.isFinite), ns = [d(2, 0, 'north'), d(3, 1, 'north')].filter(Number.isFinite);
  out.stretchEW = ew.length ? (ew.reduce((a, v) => a + v, 0) / ew.length) / (widthM / 2) : NaN;   // east half moved further east than the west half: the photo's ground is wider
  out.stretchNS = ns.length ? (ns.reduce((a, v) => a + v, 0) / ns.length) / (heightM / 2) : NaN;
  const dist = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (ok(i) && ok(j)) dist.push(Math.hypot(q[i].east - q[j].east, q[i].north - q[j].north));
  out.quartersApartMaxM = dist.length ? Math.max(...dist) : NaN;
  out.quartersApartMedianM = median(dist);
  return out;
}

async function cloudFor(id, box, plan) {
  const p = plan[id];
  if (p) {
    const tiles = typeof p.url === 'string' && p.url.startsWith('tiles://');
    const url = tiles ? p.octreeUrl : p.url;
    if (url) return { url, epoch: (tiles ? p.octreeEpoch : p.epoch) || (p.year ? p.year + 0.5 : null) || DEFAULT_EPOCH, name: tiles ? p.octreeName : p.name, fellBack: tiles };
  }
  const [lng, lat] = fromMerc([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
  const r = await fetch(`${LOOKUP}?lng=${lng}&lat=${lat}`);
  if (!r.ok) return null;
  const j = await r.json();
  const c = j?.clouds?.[0];
  return c?.url ? { url: c.url, epoch: c.epoch || DEFAULT_EPOCH, name: c.name, lookedUp: true } : null;
}

function readPhoto(PNG, file) {
  const p = PNG.sync.read(readFileSync(file));
  return { data: p.data, width: p.width, height: p.height };
}

/** Seen lawn (labels R) standing under TALL_M+ of lidar, with the lidar moved by `shift` (3857 m). */
function lawnUnderTall(cols, box, lat, labels, shift) {
  const g = gridOver(box, 0.5, lat);
  const r = rasterise(cols, g, { shift });
  const top = fillGaps(r.zTop, g.w, g.h, 1), ground = fillGaps(r.zGround, g.w, g.h, 3);
  let n = 0, tall = 0;
  for (let row = 0; row < g.h; row++) for (let col = 0; col < g.w; col++) {
    const lr = Math.min(labels.height - 1, Math.floor(((row + 0.5) * labels.height) / g.h)), lc = Math.min(labels.width - 1, Math.floor(((col + 0.5) * labels.width) / g.w));
    if (labels.data[(lr * labels.width + lc) * 4] < 128) continue;
    const i = row * g.w + col;
    if (Number.isNaN(top[i]) || Number.isNaN(ground[i])) continue;
    n++; if (top[i] - ground[i] >= TALL_M) tall++;
  }
  return n >= 200 ? tall / n : NaN;
}

function picture(PNG, photo, box, lat, cols, shift, ovShift, ov, file, fit) {
  const K = 2, W = photo.width, H = photo.height; // drawn at the photo's own pixels, halved
  const w = Math.round(W / K), h = Math.round(H / K);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (Math.min(H - 1, y * K) * W + Math.min(W - 1, x * K)) * 4, o = (y * w + x) * 4;
    out.data[o] = photo.data[s]; out.data[o + 1] = photo.data[s + 1]; out.data[o + 2] = photo.data[s + 2]; out.data[o + 3] = 255;
  }
  const [bw, bs, be, bn] = box;
  const px = (X, Y) => [((X - bw) / (be - bw)) * w, ((bn - Y) / (bn - bs)) * h];
  const dot = (x, y, rgb) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 4; out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; } };
  const line = (a, b, rgb) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let t = 0; t <= L; t += 0.5) dot(a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L, rgb); };
  // the lidar's tall things (TALL_M+), moved by the shift, as a red outline on a 0.5 m grid
  if (cols) {
    const g = gridOver(box, 0.5, lat);
    const r = rasterise(cols, g, { shift });
    const top = fillGaps(r.zTop, g.w, g.h, 1), ground = fillGaps(r.zGround, g.w, g.h, 3);
    const tall = new Uint8Array(g.w * g.h);
    for (let i = 0; i < tall.length; i++) tall[i] = !Number.isNaN(top[i]) && !Number.isNaN(ground[i]) && top[i] - ground[i] >= 2.5 ? 1 : 0;
    for (let row = 0; row < g.h; row++) for (let col = 0; col < g.w; col++) {
      const i = row * g.w + col;
      if (!tall[i]) continue;
      const edge = (col > 0 && !tall[i - 1]) || (col < g.w - 1 && !tall[i + 1]) || (row > 0 && !tall[i - g.w]) || (row < g.h - 1 && !tall[i + g.w]);
      if (!edge) continue;
      const X = g.x0 + (col + 0.5) * g.cell, Y = g.y1 - (row + 0.5) * g.cell;
      dot(...px(X, Y), [255, 40, 40]);
    }
  }
  /* Overture is already in true (WGS84) coordinates, so it moves by the photo match alone -- not
     by the datum move, which is the lidar's own NAD83 correction. */
  for (const poly of ov?.buildings || []) {
    const ring = poly[0].map(toMerc);
    for (let i = 0; i + 1 < ring.length; i++) {
      line(px(...ring[i]), px(...ring[i + 1]), [255, 230, 0]);
      if (ovShift) line(px(ring[i][0] + ovShift[0], ring[i][1] + ovShift[1]), px(ring[i + 1][0] + ovShift[0], ring[i + 1][1] + ovShift[1]), [0, 230, 230]);
    }
  }
  // the quarters: a cross at each quarter's centre, moved by that quarter's own answer x5 (so a 0.2 m disagreement shows)
  (fit?.quarters || []).forEach((q, i) => {
    if (!q || !Number.isFinite(q.east)) return;
    const cx = (i % 2 ? 0.75 : 0.25) * w, cy = (i >= 2 ? 0.75 : 0.25) * h;
    const k = Math.cos((lat * Math.PI) / 180), sx = (q.east * 5 / k) / (be - bw) * w, sy = -(q.north * 5 / k) / (bn - bs) * h;
    line([cx - 6, cy], [cx + 6, cy], [255, 255, 255]); line([cx, cy - 6], [cx, cy + 6], [255, 255, 255]);
    line([cx, cy], [cx + sx, cy + sy], [255, 120, 0]);
  });
  writeFileSync(file, PNG.sync.write(out));
}

/*
 * THE CHECK A PERSON CAN MAKE: the lidar's ground picture (alignToPhoto's `picture`, intensity on
 * open and covered ground alike) laid over the photo, in two panels. Left: as the decoder reads it
 * today (the datum move only). Right: moved by the photo match. The lidar is drawn in red, the photo
 * in green and blue, so a driveway edge that sits in both reads white and one that is off reads as a
 * red edge beside a cyan one.
 */
function groundPicture(PNG, photo, fit, file) {
  const pic = fit.picture, { w, h, cellM } = fit.grid;
  if (!pic || !w) return;
  const out = new PNG({ width: 2 * w + 4, height: h });
  const grey = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(photo.width - 1, Math.floor(((x + 0.5) * photo.width) / w)), sy = Math.min(photo.height - 1, Math.floor(((y + 0.5) * photo.height) / h));
    const s = (sy * photo.width + sx) * 4;
    grey[y * w + x] = 0.299 * photo.data[s] + 0.587 * photo.data[s + 1] + 0.114 * photo.data[s + 2];
  }
  const panels = [[0, 0, 0], Number.isFinite(fit.east) ? [fit.east / cellM, -fit.north / cellM, w + 4] : null];
  for (const pnl of panels) {
    if (!pnl) continue;
    const [mx, my, ox] = pnl;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * (2 * w + 4) + x + ox) * 4;
      const g = grey[y * w + x];
      // the lidar cell that lands here once moved by (mx, my)
      const lx = Math.round(x - mx), ly = Math.round(y - my);
      let l = NaN;
      if (lx >= 0 && ly >= 0 && lx < w && ly < h) { const li = (ly * w + lx) * 4; if (pic.data[li + 3]) l = pic.data[li]; }
      out.data[o] = Number.isNaN(l) ? Math.round(g * 0.5) : l; out.data[o + 1] = Math.round(g); out.data[o + 2] = Math.round(g); out.data[o + 3] = 255;
    }
  }
  for (let y = 0; y < h; y++) for (let x = w; x < w + 4; x++) { const o = (y * (2 * w + 4) + x) * 4; out.data[o] = 255; out.data[o + 1] = 255; out.data[o + 2] = 255; out.data[o + 3] = 255; }
  writeFileSync(file, PNG.sync.write(out));
}

async function main() {
  const dirs = { frames: process.env.FRAMES || 'frames', out: process.env.OUT || 'lidar-photo' };
  const planFile = process.env.PLAN || 'lidar-plan.json';
  mkdirSync(join(dirs.out, 'pictures'), { recursive: true });
  const { PNG } = await import('pngjs');
  const scale = JSON.parse(readFileSync(join(dirs.frames, 'scale.json'), 'utf8'));
  const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
  const boxes = scale.boxes || {};
  const ids = Object.keys(boxes).filter((id) => !id.includes(':example:') && existsSync(join(dirs.frames, `${id}.png`))).sort();
  const pictures = Number(process.env.PICTURES || 48);
  const io = nodeIo();
  const rows = [], skipped = {};
  console.log(`${ids.length} lots; the lidar's ground matched to each frame's photo (public/shade/align.js)\n`);
  for (const id of ids) {
    const box = boxes[id];
    const t0 = Date.now();
    try {
      const cloud = await cloudFor(id, box, plan);
      if (!cloud) { skipped[id] = 'no public cloud'; console.log(`  --- ${id.slice(0, 26).padEnd(26)} no public point cloud`); continue; }
      const photo = readPhoto(PNG, join(dirs.frames, `${id}.png`));
      const labels = existsSync(join(dirs.frames, `${id}-labels.png`)) ? readPhoto(PNG, join(dirs.frames, `${id}-labels.png`)) : null;
      const frame = frameOfBox(box, photo.width, photo.height);
      const k = Math.cos((frame.lat * Math.PI) / 180);
      const widthM = (box[2] - box[0]) * k, heightM = (box[3] - box[1]) * k;
      const { cols } = await pointsIn(cloud.url, box, io);
      if (!cols || cols.n < 500) { skipped[id] = `only ${cols?.n || 0} points`; console.log(`  --- ${id.slice(0, 26).padEnd(26)} only ${cols?.n || 0} points in the frame`); continue; }
      const datum = nad83Correction(frame.lat, frame.lng, cloud.epoch);
      const pre = [datum.east / k, datum.north / k];
      const fit = alignToPhoto(cols, frame, photo, { pre });
      const pattern = quarterPattern(fit, widthM, heightM);
      const shiftM = Number.isFinite(fit.east) ? Math.hypot(fit.east, fit.north) : NaN;
      // the move to apply to the lidar: the datum, plus what the photo match found (3857 m)
      const full = Number.isFinite(fit.east) ? [pre[0] + fit.east / k, pre[1] + fit.north / k] : null;
      const row = {
        id, cloud: cloud.name, epoch: cloud.epoch, points: cols.n, pointsPerM2: cols.n / (widthM * heightM),
        datumEast: datum.east, datumNorth: datum.north, datumM: Math.hypot(datum.east, datum.north),
        east: fit.east, north: fit.north, shiftM, confident: !!fit.confident, why: fit.why,
        score: fit.score, second: fit.second, openShare: fit.openShare, spreadM: fit.spreadM, errorM: fit.errorM,
        quarters: fit.quarters, ...pattern, widthM, heightM,
        seconds: (Date.now() - t0) / 1000,
      };
      if (labels) {
        row.tallDatum = lawnUnderTall(cols, box, frame.lat, labels, pre);        // the lidar as the decoder reads it today (datum only)
        row.tallNone = lawnUnderTall(cols, box, frame.lat, labels, null);        // no correction at all
        if (full) row.tallFit = lawnUnderTall(cols, box, frame.lat, labels, full); // moved onto the photo's ground
      }
      rows.push(row);
      if (rows.length <= pictures) {
        let ov = null;
        try { ov = await overtureFor(box); } catch { /* the picture does without */ }
        const safe = id.replace(/[^\w.-]+/g, '_');
        picture(PNG, photo, box, frame.lat, cols, full || pre, Number.isFinite(fit.east) ? [fit.east / k, fit.north / k] : null, ov, join(dirs.out, 'pictures', `${safe}.png`), fit);
        groundPicture(PNG, photo, fit, join(dirs.out, 'pictures', `${safe}-ground.png`));
      }
      console.log(`  ${String(rows.length).padStart(3)} ${id.slice(0, 26).padEnd(26)} ${row.pointsPerM2.toFixed(1).padStart(5)} pts/m²  datum ${num(row.datumM)} m (E ${num(datum.east)}, N ${num(datum.north)})  photo: ${Number.isFinite(fit.east) ? `${num(shiftM)} m (E ${num(fit.east)}, N ${num(fit.north)})` : '  -  '} ${fit.confident ? 'MEASURED' : 'unsure  '} q-scores ${(fit.quarters || []).map((q) => (q ? q.score.toFixed(2) : '-')).join('/')} apart ${num(pattern.quartersApartMaxM)} m, stretch EW ${num(100 * pattern.stretchEW, 1)}% NS ${num(100 * pattern.stretchNS, 1)}%; open ${pct(fit.openShare)}; lawn under tall: none ${pct(row.tallNone)} datum ${pct(row.tallDatum)} fit ${pct(row.tallFit)}; ${row.seconds.toFixed(0)}s  (${fit.why})`);
    } catch (err) {
      skipped[id] = String(err?.message || err).slice(0, 100);
      console.log(`  --- ${id.slice(0, 26).padEnd(26)} failed: ${skipped[id]}`);
    }
  }
  writeFileSync(join(dirs.out, 'lidar-photo.json'), JSON.stringify({ rows, skipped }, null, 1));

  const sure = rows.filter((r) => r.confident), any = rows.filter((r) => Number.isFinite(r.east));
  console.log(`\n${rows.length} lots matched; ${Object.keys(skipped).length} skipped.`);
  console.log('\nTHE DATUM MOVE ALREADY APPLIED (NAD83 -> WGS84, S35/H98):');
  console.log(`  median ${num(median(rows.map((r) => r.datumM)))} m`);
  console.log('\nWHAT IS LEFT BETWEEN THE LIDAR\'S GROUND AND THE PHOTO\'S, after the datum move:');
  console.log(`  measured with confidence on ${sure.length} of ${rows.length} lots (quarters agree to under 20 cm); an answer of some kind on ${any.length}`);
  for (const [name, set] of [['measured lots', sure], ['every lot with an answer', any]]) {
    if (!set.length) continue;
    const m = set.map((r) => r.shiftM);
    console.log(`  ${name}: shift median ${num(median(m))} m; over 0.5 m ${set.filter((r) => r.shiftM > 0.5).length}, over 1 m ${set.filter((r) => r.shiftM > 1).length}, over 2 m ${set.filter((r) => r.shiftM > 2).length}, over 3 m ${set.filter((r) => r.shiftM > 3).length}`);
    console.log(`    east median ${num(median(set.map((r) => r.east)))} m, north median ${num(median(set.map((r) => r.north)))} m (a common direction would be a datum or a Mapbox bias, not perspective)`);
  }
  console.log('\nSHIFT OR DISTORTION? the four quarters matched alone (the owner: "line up on one side ... off on the other"):');
  const q4 = rows.filter((r) => r.quartersOk >= 3);
  console.log(`  ${q4.length} lots with 3+ quarters matched; quarters apart (max pair) median ${num(median(q4.map((r) => r.quartersApartMaxM)))} m; over 0.5 m on ${q4.filter((r) => r.quartersApartMaxM > 0.5).length}, over 1 m on ${q4.filter((r) => r.quartersApartMaxM > 1).length}`);
  const st = q4.filter((r) => Number.isFinite(r.stretchEW) && Number.isFinite(r.stretchNS));
  console.log(`  stretch (east half vs west half, per metre apart): median |EW| ${num(100 * median(st.map((r) => Math.abs(r.stretchEW))), 2)}%, |NS| ${num(100 * median(st.map((r) => Math.abs(r.stretchNS))), 2)}%; lots over 1% either way: ${st.filter((r) => Math.abs(r.stretchEW) > 0.01 || Math.abs(r.stretchNS) > 0.01).length} (1% over a 40 m lot is 0.4 m side to side)`);
  console.log(`  sign: EW stretch positive (photo wider than the lidar) on ${st.filter((r) => r.stretchEW > 0.003).length}, negative on ${st.filter((r) => r.stretchEW < -0.003).length}; NS positive on ${st.filter((r) => r.stretchNS > 0.003).length}, negative on ${st.filter((r) => r.stretchNS < -0.003).length}`);
  console.log('\nTHE LAWN TEST (seen lawn standing under 2 m+ of lidar; the lidar in the right place puts little of it there):');
  for (const [name, set] of [['measured lots', sure.filter((r) => Number.isFinite(r.tallFit))], ['every lot with an answer', any.filter((r) => Number.isFinite(r.tallFit))]]) {
    if (!set.length) continue;
    const mean = (k) => set.reduce((a, r) => a + r[k], 0) / set.length;
    console.log(`  ${name} (${set.length}): no correction ${pct(mean('tallNone'))} -> datum only (today) ${pct(mean('tallDatum'))} -> moved onto the photo ${pct(mean('tallFit'))} (means); medians ${pct(median(set.map((r) => r.tallNone)))} -> ${pct(median(set.map((r) => r.tallDatum)))} -> ${pct(median(set.map((r) => r.tallFit)))}; better than today on ${set.filter((r) => r.tallFit < r.tallDatum - 0.002).length}, worse on ${set.filter((r) => r.tallFit > r.tallDatum + 0.002).length}`);
  }
  console.log('\nWhy the unsure ones were unsure:');
  const whys = {};
  for (const r of rows) if (!r.confident) { const kcat = r.why.replace(/[\d.]+ ?(m|cm)/g, 'N$1').slice(0, 70); whys[kcat] = (whys[kcat] || 0) + 1; }
  for (const [kcat, n] of Object.entries(whys).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${kcat}`);
  console.log('\nPictures: yellow = Overture as published, cyan = Overture moved onto the photo\'s ground by the lidar match,');
  console.log('red = the lidar\'s 2.5 m+ things (roofs with their porches and decks, crowns) moved the same way,');
  console.log('white crosses = the four quarters, each with an orange tick showing its OWN answer (5x), so a stretch reads as ticks pointing apart.');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); process.exit(1); });
