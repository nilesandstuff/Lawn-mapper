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
    iou0: fit.zero.iou, iouBest: fit.best.iou,
    shiftEast: m(fit.best.dx), shiftNorth: -m(fit.best.dy), shiftM: m(Math.hypot(fit.best.dx, fit.best.dy)),
  };

  // Each building its own shift, about the lot's: does one shift fix the lot?
  const residuals = [];
  const BW = W + 2 * P;
  for (const poly of ov.buildings) {
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
    residuals.push({ m: m(Math.hypot(best.dx - fit.best.dx, best.dy - fit.best.dy)), iou: best.iou, areaM2: area * CELL * CELL * k * k });
  }
  row.ownShifts = residuals.length;
  row.residualMedianM = median(residuals.map((r) => r.m));
  row.residualOver15 = residuals.length ? residuals.filter((r) => r.m > 1.5).length / residuals.length : NaN;

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
  const pictures = Number(process.env.PICTURES || 24);
  const rows = [], skipped = {};
  let shown = 0;
  for (const id of ids) {
    if (!existsSync(join(dirs.frames, `${id}-labels.png`))) { skipped[id] = 'no labels'; continue; }
    if (!existsSync(join(dirs.lidar, `${id}-roof.png`))) { skipped[id] = 'no lidar'; continue; }
    let row = null;
    for (let tries = 0; tries < 3 && !row; tries++) {
      try { row = await checkLot(PNG, id, boxes[id], dirs, shown < pictures); } catch (err) { if (tries === 2) skipped[id] = `overture: ${String(err.message || err).slice(0, 80)}`; }
    }
    if (!row) continue;
    if (shown < pictures) shown++;
    rows.push(row);
    console.log(`  ${String(rows.length).padStart(3)} ${id.slice(0, 26).padEnd(26)} IoU ${pct(row.iou0)} -> ${pct(row.iouBest)} at ${row.shiftM.toFixed(1)} m (E ${row.shiftEast.toFixed(1)}, N ${row.shiftNorth.toFixed(1)}); own-shift spread ${num(row.residualMedianM)} m over ${row.ownShifts}; lawn on bldg ${pct(row.lawnOnBuilding0)}, road ${pct(row.lawnOnRoad0)}, walk ${pct(row.lawnOnWalk0)}, lidar roof ${pct(row.lawnOnLidarRoof)}`);
  }
  writeFileSync(join(dirs.out, 'overture-check.json'), JSON.stringify({ cell: CELL, shiftM: SHIFT_M, rows, skipped }, null, 1));

  const col = (k) => rows.map((r) => r[k]);
  const pooled = (a, b) => { let x = 0, y = 0; for (const r of rows) { if (Number.isFinite(r[a])) { x += r[a] * r.lawnCells; y += r.lawnCells; } } return y ? x / y : NaN; };
  console.log(`\n${rows.length} lots checked; ${Object.keys(skipped).length} skipped (${summariseSkips(skipped)}).`);
  console.log('\nOVERTURE BUILDINGS AGAINST THE LIDAR ROOFS (lidar has no perspective lean):');
  console.log(`  overlap (IoU), median: as published ${pct(median(col('iou0')))}, at each lot's best shift ${pct(median(col('iouBest')))}`);
  console.log(`  best shift, median ${num(median(col('shiftM')))} m; lots needing more than 1 m: ${rows.filter((r) => r.shiftM > 1).length}, more than 2 m: ${rows.filter((r) => r.shiftM > 2).length}`);
  console.log(`  each building its own shift, about the lot's: median ${num(median(col('residualMedianM')))} m; share of buildings off by more than 1.5 m, median ${pct(median(col('residualOver15')))}`);
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
