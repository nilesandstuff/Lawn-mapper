/*
 * OVERTURE OVER EACH FRAME, FOR THE DECODER (owner, 2026-10-19/20: Overture's buildings, roads and
 * sidewalks "would be good info for every stage... the detector, the grass under canopy guesser,
 * and manual tracing"; and for the detector, "there's a curb or sidewalk edge that runs parallel to
 * this at an unknown distance").
 *
 * Writes <OUT>/<id>-overture.png beside each frame, three channels on a 0.5 m grid over the
 * frame's box (rows north to south, like the photo):
 *   R  building footprint (255 inside Overture's building polygons)
 *   G  nearness to a sidewalk, footway, crosswalk or path LINE: 255 on the line, 0 at WALK_REACH_M
 *      and beyond -- the "edge parallel to this at an unknown distance" as a number the decoder
 *      can learn the distance from
 *   B  nearness to a road CENTRELINE the same way, to ROAD_REACH_M
 * tools/fuse_layers.py reads them as three more numbers a patch (and a flag).
 *
 * Overture is true-coordinate data (H101: within about a metre of the lidar; H103/H104: the photo
 * within about half a metre of that where it can be measured), drawn as published -- no shift.
 * A frame Overture does not answer for (after three tries) gets no file, which the decoder reads
 * as "no Overture here", the same as modality dropout shows it.
 *
 *   FRAMES=frames OUT=overture node tools/overture-frames.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { overtureFor, overtureMasks } from '../public/lib/overture.js';
import { fitToRoof, shiftRaster, ALIGN_MIN_IOU, ALIGN_MIN_GAIN, ALIGN_REACH_M } from '../public/lib/overture-fit.js';

const CELL_M = 0.5;
export const WALK_REACH_M = 10, ROAD_REACH_M = 15;
const R = 6378137;
const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];

/**
 * Nearness to the closest of `lines` (each an array of [x, y] grid cells), per cell of a W x H grid:
 * 1 on a line, falling to 0 at `reachCells` away. Pure, tested.
 */
export function nearness(lines, W, H, reachCells) {
  const dist = new Float32Array(W * H).fill(Infinity);
  const r = Math.ceil(reachCells) + 1;
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      const [ax, ay] = line[k - 1], [bx, by] = line[k];
      const c0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), c1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r));
      const r0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), r1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r));
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
        const px = col + 0.5, py = row + 0.5;
        const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        const i = row * W + col;
        if (d < dist[i]) dist[i] = d;
      }
    }
  }
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= reachCells ? 1 - dist[i] / reachCells : 0;
  return out;
}

/*
 * OVERTURE'S BUILDINGS ONTO THE LIDAR'S ROOFS (owner, 2026-10-20: the outlines "are not lining up
 * with the building footprints... may just legitimately be an issue with the placements according to
 * overture"; H101: a median 0.87 m from the lidar's roofs, over 1 m on 47 of 101 lots, every
 * building on a lot off by the same amount). The fit lives in public/lib/overture-fit.js since the
 * predictions page draws the same move in the browser; re-exported here for the tests and the log.
 */
export { fitToRoof, shiftRaster, ALIGN_MIN_IOU, ALIGN_MIN_GAIN, ALIGN_REACH_M } from '../public/lib/overture-fit.js';

/** The three channels for one box ([w, s, e, n] in EPSG:3857 metres) from Overture's answer. Pure. */
export function rasterise(box, ov) {
  const [w, s, e, n] = box;
  const lat = (2 * Math.atan(Math.exp(((s + n) / 2) / R)) - Math.PI / 2) * 180 / Math.PI;
  const k = Math.cos((lat * Math.PI) / 180);
  const cell = CELL_M / k; // a ground half-metre, in mercator metres
  const W = Math.max(4, Math.round((e - w) / cell)), H = Math.max(4, Math.round((n - s) / cell));
  const g = { W, H, cell, toCell: (x, y) => [(x - w) / cell, (n - y) / cell] };
  const { building } = overtureMasks(g, { roads: [], buildings: ov.buildings });
  const toGrid = (line) => line.map((p) => { const [x, y] = toMerc(p); return g.toCell(x, y); });
  const walks = [], roads = [];
  for (const r of ov.roads) for (const line of r.lines) (r.walk ? walks : roads).push(toGrid(line));
  return {
    W, H, building,
    walk: nearness(walks, W, H, WALK_REACH_M / CELL_M),
    road: nearness(roads, W, H, ROAD_REACH_M / CELL_M),
    counts: { buildings: ov.buildings.length, walks: walks.length, roads: roads.length },
  };
}

async function main() {
  const frames = process.env.FRAMES || 'frames', out = process.env.OUT || 'overture';
  /* LIDAR=dir of lidar_frame.py's <id>-roof.png and OVERTURE_ALIGN=1: each lot's buildings moved
     onto the lidar's roofs (fitToRoof) before the channels are written. */
  const lidar = process.env.LIDAR || '', align = process.env.OVERTURE_ALIGN === '1' && !!lidar;
  mkdirSync(out, { recursive: true });
  const { PNG } = await import('pngjs');
  const scale = JSON.parse(readFileSync(join(frames, 'scale.json'), 'utf8'));
  const boxes = scale.boxes || {};
  const ids = Object.keys(boxes).filter((id) => existsSync(join(frames, `${id}.png`))).sort();
  const summary = { cell: CELL_M, walkReachM: WALK_REACH_M, roadReachM: ROAD_REACH_M, aligned: align, frames: {}, skipped: {} };
  let withBuilding = 0, withWalk = 0, withRoad = 0, fitted = 0, applied = 0;
  const shifts = [];
  console.log(`${ids.length} frames; Overture's footprints, sidewalk lines and road centrelines over each${align ? ", the buildings moved onto the lidar's roofs" : ' (as published)'}\n`);
  for (const id of ids) {
    const box = boxes[id];
    const pad = ROAD_REACH_M * 2; // mercator metres past the box, so a line just outside still counts
    let ov = null;
    for (let t = 0; t < 3 && !ov; t++) {
      try { ov = await overtureFor([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad]); } catch (err) { if (t === 2) summary.skipped[id] = String(err?.message || err).slice(0, 100); else await new Promise((ok) => setTimeout(ok, 5000 * (t + 1))); }
    }
    if (!ov) { console.log(`  --- ${id.slice(0, 30).padEnd(30)} ${summary.skipped[id]}`); continue; }
    // Overture answers whole tiles: keep what comes near this box. By the line's own box, not its
    // vertices: a straight street's two vertices can both lie far outside a frame it runs through.
    const near = (pts) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { const [x, y] = toMerc(p); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      return x1 >= box[0] - pad && x0 <= box[2] + pad && y1 >= box[1] - pad && y0 <= box[3] + pad;
    };
    ov = { roads: ov.roads.filter((r) => r.lines.some(near)), buildings: ov.buildings.filter((b) => b[0] && near(b[0])) };
    const r = rasterise(box, ov);
    let fit = null, moved = '';
    const roofFile = join(lidar, `${id}-roof.png`);
    if (align && existsSync(roofFile) && r.counts.buildings) {
      const rp = PNG.sync.read(readFileSync(roofFile));
      const roof = { data: new Uint8Array(rp.width * rp.height), w: rp.width, h: rp.height };
      for (let i = 0; i < roof.data.length; i++) roof.data[i] = rp.data[i * 4] >= 128 ? 1 : 0;
      fit = fitToRoof(r.building, r.W, r.H, roof, Math.round(ALIGN_REACH_M / CELL_M));
      if (fit) {
        fitted++;
        fit.shiftM = Math.hypot(fit.dx, fit.dy) * CELL_M;
        fit.applied = fit.iou >= ALIGN_MIN_IOU && fit.iou - fit.iou0 >= ALIGN_MIN_GAIN;
        if (fit.applied) { r.building = shiftRaster(r.building, r.W, r.H, fit.dx, fit.dy); applied++; shifts.push(fit.shiftM); }
        moved = fit.applied ? `; buildings moved ${fit.shiftM.toFixed(1)} m onto the lidar's roofs (overlap ${(100 * fit.iou0).toFixed(0)}% -> ${(100 * fit.iou).toFixed(0)}%)`
          : `; left as published (overlap ${(100 * fit.iou0).toFixed(0)}% -> ${(100 * fit.iou).toFixed(0)}% at ${fit.shiftM.toFixed(1)} m: not a fit)`;
      } else moved = '; no lidar roof to fit to';
    }
    const png = new PNG({ width: r.W, height: r.H });
    for (let i = 0; i < r.W * r.H; i++) {
      png.data[i * 4] = r.building[i] ? 255 : 0;
      png.data[i * 4 + 1] = Math.round(255 * r.walk[i]);
      png.data[i * 4 + 2] = Math.round(255 * r.road[i]);
      png.data[i * 4 + 3] = 255;
    }
    writeFileSync(join(out, `${id}-overture.png`), PNG.sync.write(png));
    const share = (a, test) => { let x = 0; for (let i = 0; i < a.length; i++) if (test(a[i])) x++; return x / a.length; };
    const rec = { ...r.counts, building: share(r.building, (v) => v > 0), nearWalk: share(r.walk, (v) => v > 0), nearRoad: share(r.road, (v) => v > 0), fit };
    summary.frames[id] = rec;
    if (rec.buildings) withBuilding++; if (rec.walks) withWalk++; if (rec.roads) withRoad++;
    console.log(`  ${id.slice(0, 30).padEnd(30)} ${String(rec.buildings).padStart(3)} buildings (${(100 * rec.building).toFixed(0)}% of the frame), ${String(rec.walks).padStart(3)} walk lines (${(100 * rec.nearWalk).toFixed(0)}% within ${WALK_REACH_M} m), ${String(rec.roads).padStart(3)} roads (${(100 * rec.nearRoad).toFixed(0)}% within ${ROAD_REACH_M} m)${moved}`);
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  const n = Object.keys(summary.frames).length;
  console.log(`\n${n} frames written, ${Object.keys(summary.skipped).length} skipped; a building on ${withBuilding}, a sidewalk or path line on ${withWalk}, a road on ${withRoad}.`);
  if (align) {
    const s = shifts.sort((a, b) => a - b), med = s.length ? s[s.length >> 1] : NaN;
    console.log(`Buildings fitted to the lidar's roofs on ${fitted} frames, moved on ${applied} (median ${Number.isFinite(med) ? med.toFixed(2) : '-'} m; over 1 m on ${s.filter((v) => v > 1).length}, over 2 m on ${s.filter((v) => v > 2).length}); as published where the fit was no better.`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); process.exit(1); });
