/*
 * DOES ONE PHOTO OF A LOT STRETCH OR SKEW AGAINST ANOTHER? (owner, 2026-10-19: lining his traces
 * up between Mapbox and county photos, "the lawn traces would line up on one side of the property
 * but they'd be off on the other side, or the whole property would just be slightly larger/smaller
 * between different photo sources, or both.")
 *
 * H63/H64 answered "a plain shift" with one number per lot. This keeps the FIELD: every patch's own
 * offset between the frame's photo and Mapbox's photo of the same box (public/lib/register.js, the
 * matcher the county photos are banked with), and reports how that offset changes across the lot:
 * the east third against the west third, the north against the south, and how many patches sit
 * more than 0.3 m from what one shift predicts.
 *
 * CONTROL AND TREATMENT. A lot traced on a county photo is the question. A lot traced on Mapbox is
 * the control: its frame IS a Mapbox photo, so the field should read zero everywhere; what it reads
 * instead is the method's own noise -- or Mapbox's imagery having changed under the trace since the
 * frame was saved, which this also detects.
 *
 *   FRAMES=frames OUT=photo-distortion node tools/photo-distortion.js
 *   (SITE=https://lawnmap.nilesandstuff.com, the Worker that serves /api/imagery)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { registerImages } from '../public/lib/register.js';
import { frameOfBox, cloudFor } from './lidar-photo.js';
import { gridOver, rasterise, fillGaps } from '../public/shade/grid.js';
import { dilate } from '../public/shade/align.js';
import { pointsIn } from '../water/lib/ept.js';
import { nodeIo } from '../water/lib/node-io.js';

const SITE = process.env.SITE || 'https://lawnmap.nilesandstuff.com';
const OFF_M = 0.3; // a patch further than this from one shift's prediction is "off"
/* register.js keeps as inliers only the patches within TOL_M of the fitted model, so a distortion
   bigger than that would be thrown out as outliers and never show in the field. 1 m (the first run
   used register.js's 0.3 m default and could not have seen more than that). */
const TOL_M = Number(process.env.TOL_M || 1.0);
/* GROUND AND ROOFS APART (2026-10-19, the first run's pictures): on a county leaf-off photo against
   leaf-on Mapbox, the patches that agree are mostly ROOFS, and a roof leans differently in each
   photo. Their offsets are lean, not ground. So each patch is sorted by the lidar: tall (1.5 m+
   above the ground, with a 3 m margin for the lean) or open ground, and the field is reported for
   each. The ground field is the owner's question; the tall field is how far the two photos' roofs
   and crowns sit apart. */
const TALL_M = 1.5, LEAN_M = 3;

const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '-');

/**
 * The field of a registration's agreeing patches: each one's offset less the median offset (one
 * shift), in metres, summarised by where the patch is. `vectors` are register.js's ({x, y, dx, dy,
 * inlier}) in grid cells of `cellM`; w, h the grid. Pure, tested.
 */
export function residualField(vectors, cellM, w, h) {
  const v = vectors.filter((p) => p.inlier);
  if (v.length < 4) return { patches: v.length };
  const mx = median(v.map((p) => p.dx)), my = median(v.map((p) => p.dy));
  const res = v.map((p) => ({ x: p.x / w, y: p.y / h, e: (p.dx - mx) * cellM, n: -(p.dy - my) * cellM }));
  const mean = (arr, k) => (arr.length ? arr.reduce((a, r) => a + r[k], 0) / arr.length : NaN);
  const third = (k, lo, hi) => res.filter((r) => r[k] >= lo && r[k] < hi);
  const west = third('x', 0, 1 / 3), east = third('x', 2 / 3, 1.01), north = third('y', 0, 1 / 3), south = third('y', 2 / 3, 1.01);
  const widthM = w * cellM, heightM = h * cellM;
  // the distance between the two thirds' own centres, so a linear stretch reads exactly
  const apartEW = (mean(east, 'x') - mean(west, 'x')) * widthM, apartNS = (mean(south, 'y') - mean(north, 'y')) * heightM;
  return {
    patches: v.length,
    shiftM: [mx * cellM, -my * cellM],
    // a positive stretch: the east third sits further east than the west third (the other photo is wider there)
    stretchEW: (mean(east, 'e') - mean(west, 'e')) / apartEW,
    stretchNS: (mean(north, 'n') - mean(south, 'n')) / apartNS,
    // a skew: the north third moved east against the south third, or the east third north against the west
    skewEN: (mean(north, 'e') - mean(south, 'e')) / apartNS,
    skewNE: (mean(east, 'n') - mean(west, 'n')) / apartEW,
    sideToSideM: Math.max(Math.hypot(mean(east, 'e') - mean(west, 'e'), mean(east, 'n') - mean(west, 'n')), Math.hypot(mean(north, 'e') - mean(south, 'e'), mean(north, 'n') - mean(south, 'n'))),
    offShare: res.filter((r) => Math.hypot(r.e, r.n) > OFF_M).length / res.length,
    maxM: Math.max(...res.map((r) => Math.hypot(r.e, r.n))),
    rmsM: Math.sqrt(res.reduce((a, r) => a + r.e * r.e + r.n * r.n, 0) / res.length),
    thirds: { west: [mean(west, 'e'), mean(west, 'n'), west.length], east: [mean(east, 'e'), mean(east, 'n'), east.length], north: [mean(north, 'e'), mean(north, 'n'), north.length], south: [mean(south, 'e'), mean(south, 'n'), south.length] },
  };
}

/** A 1 m grid over the box: 1 where the lidar is tall (or unknown under a roof), grown by LEAN_M. null without lidar. */
async function tallMask(id, box, io, plan) {
  const cloud = await cloudFor(id, box, plan).catch((e) => { console.log(`      (no cloud for the tall mask: ${String(e?.message || e).slice(0, 80)})`); return null; });
  if (!cloud) return null;
  const { cols } = await pointsIn(cloud.url, box, io);
  if (!cols || cols.n < 500) return null;
  const lat = frameOfBox(box, 1, 1).lat;
  const g = gridOver(box, 1, lat);
  const r = rasterise(cols, g);
  const ground = fillGaps(r.zGround, g.w, g.h, 3), top = fillGaps(r.zTop, g.w, g.h, 2);
  const tall = new Uint8Array(g.w * g.h);
  for (let i = 0; i < tall.length; i++) if (Number.isNaN(ground[i]) || top[i] - ground[i] >= TALL_M) tall[i] = 1;
  return { mask: dilate(tall, g.w, g.h, LEAN_M), w: g.w, h: g.h, cloud: cloud.name };
}

function rgba(PNG, buf) { const p = PNG.sync.read(buf); return { data: p.data, width: p.width, height: p.height }; }

/**
 * Mapbox's photo of exactly this box. The Worker clamps zoom to 20 and the logical size to 1280,
 * so the request is sized to put the box at zoom 20 where it fits (a 60 m box is 800 logical px)
 * and at 1280 px wide otherwise; Mapbox answers at @2x. Asking at the frame's own @2x pixel
 * width was the first run's mistake: zoom 21, clamped to 20, a picture of different ground.
 */
async function mapboxOf(box, jpeg) {
  const perPx20 = (2 * Math.PI * 6378137) / (512 * 2 ** 20); // 3857 metres a logical pixel at zoom 20
  const wPx = (box[2] - box[0]) / perPx20, hPx = (box[3] - box[1]) / perPx20;
  const fit = Math.min(1, 1280 / Math.max(wPx, hPx));
  const size = Math.max(256, Math.round(wPx * fit)), hgt = Math.max(256, Math.round(hPx * fit));
  const f = frameOfBox(box, size, hgt);
  /* With a Mapbox token of its own (CI has MAPBOX_SERVER_TOKEN) the picture is asked of Mapbox
     directly, by the Worker's own URL builder, so nothing between the runner and the Worker can
     refuse it; otherwise through the site. */
  const token = process.env.MAPBOX_SERVER_TOKEN || process.env.MAPBOX_TOKEN;
  let url = `${SITE}/api/imagery?${new URLSearchParams({ lng: f.lng, lat: f.lat, zoom: f.zoom.toFixed(4), size, height: hgt, provider: 'mapbox' })}`;
  if (token) {
    try {
      const { imageryUrl } = await import('../worker/src/imagery.js');
      url = imageryUrl('mapbox', { lng: f.lng, lat: f.lat, zoom: Math.min(20, f.zoom), size, height: hgt }, token, {}) || url;
    } catch { /* the Worker's route, then */ }
  }
  let last = '';
  for (let t = 0; t < 3; t++) {
    const r = await fetch(url, { headers: { 'User-Agent': 'lawn-mapper photo-distortion (GitHub Actions)', Accept: 'image/*' } });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      const j = jpeg.decode(buf, { useTArray: true });
      return { data: j.data, width: j.width, height: j.height };
    }
    last = `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 120).replace(/\s+/g, ' ')}`;
    await new Promise((ok) => setTimeout(ok, 3000 * (t + 1)));
  }
  throw new Error(`Mapbox would not answer: ${last}`);
}

function picture(PNG, frame, r, file) {
  // the agreeing patches' offsets, less one shift, as lines x20 on the frame (red = off by more than OFF_M)
  const K = 2, w = Math.round(frame.width / K), h = Math.round(frame.height / K), out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (Math.min(frame.height - 1, y * K) * frame.width + Math.min(frame.width - 1, x * K)) * 4, o = (y * w + x) * 4; out.data[o] = frame.data[s]; out.data[o + 1] = frame.data[s + 1]; out.data[o + 2] = frame.data[s + 2]; out.data[o + 3] = 255; }
  const v = r.vectors.filter((p) => p.inlier);
  if (!v.length) { writeFileSync(file, PNG.sync.write(out)); return; }
  const gw0 = r.gridW, gh0 = r.gridH;
  const dot0 = (x, y, rgb) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 4; out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; } };
  // the outliers first, grey: matched to something, but not within TOL_M of the model
  for (const p of r.vectors) if (!p.inlier) { const cx = (p.x / gw0) * w, cy = (p.y / gh0) * h; for (let d = -2; d <= 2; d++) { dot0(cx + d, cy + d, [160, 160, 160]); dot0(cx + d, cy - d, [160, 160, 160]); } }
  const mx = median(v.map((p) => p.dx)), my = median(v.map((p) => p.dy));
  const gw = r.gridW, gh = r.gridH;
  const dot = (x, y, rgb) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 4; out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; } };
  for (const p of v) {
    const cx = (p.x / gw) * w, cy = (p.y / gh) * h, ex = (p.dx - mx) * 20 * (w / gw), ey = (p.dy - my) * 20 * (h / gh);
    const off = Math.hypot((p.dx - mx) * r.cellM, (p.dy - my) * r.cellM) > OFF_M;
    for (let t = 0; t <= 1; t += 0.02) dot(cx + ex * t, cy + ey * t, p.tall ? (off ? [255, 60, 255] : [120, 200, 255]) : (off ? [255, 50, 50] : [255, 255, 60]));
    for (let d = -3; d <= 3; d++) { dot(cx + d, cy, [255, 255, 255]); dot(cx, cy + d, [255, 255, 255]); }
  }
  writeFileSync(file, PNG.sync.write(out));
}

async function main() {
  const dirs = { frames: process.env.FRAMES || 'frames', out: process.env.OUT || 'photo-distortion' };
  mkdirSync(join(dirs.out, 'pictures'), { recursive: true });
  const { PNG } = await import('pngjs');
  const jpeg = (await import('jpeg-js')).default;
  const scale = JSON.parse(readFileSync(join(dirs.frames, 'scale.json'), 'utf8'));
  const boxes = scale.boxes || {}, sources = scale.sources || {};
  const planFile = process.env.PLAN || 'lidar-plan.json';
  const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : {};
  const ids = Object.keys(boxes).filter((id) => !id.includes(':example:') && existsSync(join(dirs.frames, `${id}.png`))).sort();
  const pictures = Number(process.env.PICTURES || 40);
  const rows = [], skipped = {};
  const io = nodeIo();
  console.log(`${ids.length} lots; each frame's photo registered to Mapbox's photo of the same box (public/lib/register.js), patch by patch; the lidar sorts each patch into open ground or tall\n`);
  for (const id of ids) {
    const box = boxes[id];
    try {
      const frame = rgba(PNG, readFileSync(join(dirs.frames, `${id}.png`)));
      const mb = await mapboxOf(box, jpeg);
      if (Math.abs(mb.width / mb.height - frame.width / frame.height) > 0.02) { skipped[id] = 'Mapbox answered a different shape'; continue; }
      const k = Math.cos((frameOfBox(box, 1, 1).lat * Math.PI) / 180);
      const widthM = (box[2] - box[0]) * k;
      const r = registerImages(mb, frame, widthM, { cellM: 0.2, reachM: 6, tolM: TOL_M });
      // the working grid, for the field: register.js caps it at 700 cells across
      let cell = 0.2, gw = Math.round(widthM / cell); if (gw > 700) { cell = widthM / 700; gw = 700; }
      const gh = Math.max(16, Math.round((gw * mb.height) / mb.width));
      r.gridW = gw; r.gridH = gh;
      const field = residualField(r.vectors, r.cellM, gw, gh);
      // ground and tall apart, by the lidar
      const tm = await tallMask(id, box, io, plan).catch((e) => { console.log(`      (no tall mask: ${String(e?.message || e).slice(0, 80)})`); return null; });
      let groundField = null, tallField = null, nGround = NaN, nTall = NaN;
      if (tm) {
        const isTall = (p) => { const c = Math.min(tm.w - 1, Math.floor((p.x / gw) * tm.w)), rr = Math.min(tm.h - 1, Math.floor((p.y / gh) * tm.h)); return tm.mask[rr * tm.w + c] === 1; };
        for (const p of r.vectors) p.tall = isTall(p);
        const gv = r.vectors.filter((p) => !p.tall), tv = r.vectors.filter((p) => p.tall);
        nGround = gv.filter((p) => p.inlier).length; nTall = tv.filter((p) => p.inlier).length;
        groundField = residualField(gv, r.cellM, gw, gh);
        tallField = residualField(tv, r.cellM, gw, gh);
      }
      // A maps ref pixels to mov pixels; on the ground, identity is mov.width / ref.width, so the scale is read against that
      const A = r.A, scaleOf = A ? Math.sqrt(Math.abs(A[0] * A[4] - A[1] * A[3])) * (mb.width / frame.width) : NaN, rot = A ? (Math.atan2(A[3], A[0]) * 180) / Math.PI : NaN;
      const row = {
        id, source: sources[id] || 'unknown', widthM, model: r.model, confident: r.confident, why: r.why, inliers: r.inliers, patches: r.patches,
        offsetM: r.offsetM, rmsM: r.rmsM, scale: scaleOf, rotationDeg: rot, models: r.models, ...field,
        // patches that matched something but sit more than TOL_M from the model: vegetation that differs, or distortion beyond the tolerance
        outlierShare: r.patches ? (r.patches - r.inliers) / r.patches : NaN,
        lidar: !!tm, nGround, nTall, ground: groundField, tall: tallField,
        // the two photos' roofs and crowns apart: the tall patches' median offset less the ground patches'
        tallVsGroundM: groundField?.shiftM && tallField?.shiftM ? Math.hypot(tallField.shiftM[0] - groundField.shiftM[0], tallField.shiftM[1] - groundField.shiftM[1]) : NaN,
      };
      rows.push(row);
      if (rows.length <= pictures) picture(PNG, frame, r, join(dirs.out, 'pictures', `${id.replace(/[^\w.-]+/g, '_')}.png`));
      console.log(`  ${String(rows.length).padStart(3)} ${id.slice(0, 26).padEnd(26)} ${(row.source || '?').padEnd(7)} ${String(r.inliers).padStart(3)}/${String(r.patches).padEnd(3)} patches  ${(r.model || '-').padEnd(11)} shift ${num(r.offsetM?.east)} E ${num(r.offsetM?.north)} N  scale ${num(100 * (scaleOf - 1), 1)}% rot ${num(rot, 2)}°  all: side-to-side ${num(field.sideToSideM)} m, off ${pct(field.offShare)}; GROUND ${Number.isFinite(nGround) ? `${nGround} patches: stretch EW ${num(100 * (groundField?.stretchEW ?? NaN), 2)}% NS ${num(100 * (groundField?.stretchNS ?? NaN), 2)}%, side-to-side ${num(groundField?.sideToSideM)} m, off ${pct(groundField?.offShare)}` : 'no lidar'}; TALL ${Number.isFinite(nTall) ? `${nTall} patches, ${num(row.tallVsGroundM)} m from the ground's shift` : '-'}  ${r.confident ? '' : `(${r.why})`}`);
    } catch (err) {
      skipped[id] = String(err?.message || err).slice(0, 100);
      console.log(`  --- ${id.slice(0, 26).padEnd(26)} failed: ${skipped[id]}`);
    }
  }
  writeFileSync(join(dirs.out, 'photo-distortion.json'), JSON.stringify({ rows, skipped }, null, 1));

  console.log(`\n${rows.length} lots; ${Object.keys(skipped).length} skipped.`);
  for (const [name, set] of [['CONTROL: frames that are Mapbox photos (should read zero; what it reads is the method\'s noise, or Mapbox changed)', rows.filter((r) => r.source === 'mapbox')], ['COUNTY PHOTOS against Mapbox', rows.filter((r) => r.source === 'county')], ['other sources', rows.filter((r) => r.source !== 'mapbox' && r.source !== 'county')]]) {
    if (!set.length) continue;
    const ok = set.filter((r) => r.patches >= 4 && Number.isFinite(r.sideToSideM));
    console.log(`\n${name}: ${set.length} lots, ${ok.length} with a field`);
    if (!ok.length) continue;
    console.log(`  one shift: median ${num(median(ok.map((r) => Math.hypot(r.offsetM?.east || 0, r.offsetM?.north || 0))))} m; model picked: ${['shift', 'shift+scale', 'affine'].map((m) => `${m} ${ok.filter((r) => r.model === m).length}`).join(', ')}`);
    console.log(`  scale where a scale was picked: ${ok.filter((r) => r.model !== 'shift').map((r) => `${num(100 * (r.scale - 1), 1)}%`).join(', ') || 'none'}`);
    console.log(`  the field, beyond one shift: side-to-side median ${num(median(ok.map((r) => r.sideToSideM)))} m; over 0.3 m on ${ok.filter((r) => r.sideToSideM > 0.3).length}, over 0.5 m on ${ok.filter((r) => r.sideToSideM > 0.5).length}, over 1 m on ${ok.filter((r) => r.sideToSideM > 1).length}`);
    console.log(`  stretch: median |EW| ${num(100 * median(ok.map((r) => Math.abs(r.stretchEW))), 2)}%, |NS| ${num(100 * median(ok.map((r) => Math.abs(r.stretchNS))), 2)}%; lots over 0.5% either way ${ok.filter((r) => Math.abs(r.stretchEW) > 0.005 || Math.abs(r.stretchNS) > 0.005).length} (0.5% over 40 m is 0.2 m)`);
    console.log(`  patches off by more than ${OFF_M} m from one shift: median share ${pct(median(ok.map((r) => r.offShare)))}; rms about one shift median ${num(median(ok.map((r) => r.rmsM)))} m`);
    console.log(`  matched patches thrown out (over ${TOL_M} m from the model): median share ${pct(median(set.map((r) => r.outlierShare)))}; lots with over half thrown out ${set.filter((r) => r.outlierShare > 0.5).length}`);
    const gk = set.filter((r) => r.ground && r.ground.patches >= 4 && Number.isFinite(r.ground.sideToSideM));
    console.log(`  OPEN GROUND ONLY (${gk.length} lots with 4+ agreeing ground patches): side-to-side median ${num(median(gk.map((r) => r.ground.sideToSideM)))} m; over 0.3 m on ${gk.filter((r) => r.ground.sideToSideM > 0.3).length}, over 0.5 m on ${gk.filter((r) => r.ground.sideToSideM > 0.5).length}; stretch median |EW| ${num(100 * median(gk.map((r) => Math.abs(r.ground.stretchEW))), 2)}% |NS| ${num(100 * median(gk.map((r) => Math.abs(r.ground.stretchNS))), 2)}%; patches off by more than ${OFF_M} m median ${pct(median(gk.map((r) => r.ground.offShare)))}`);
    const tk = set.filter((r) => Number.isFinite(r.tallVsGroundM));
    console.log(`  ROOFS AND CROWNS against the ground (${tk.length} lots): the tall patches sit a median ${num(median(tk.map((r) => r.tallVsGroundM)))} m from where the ground says (lean differing between the two photos); over 0.5 m on ${tk.filter((r) => r.tallVsGroundM > 0.5).length}, over 1 m on ${tk.filter((r) => r.tallVsGroundM > 1).length}`);
  }
  console.log(`\nPictures: each agreeing patch's offset less the lot's one shift, drawn 20x (ground yellow, red when over ${OFF_M} m; tall blue, magenta when over); grey crosses = matched patches more than ${TOL_M} m from the model, left out.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); process.exit(1); });
