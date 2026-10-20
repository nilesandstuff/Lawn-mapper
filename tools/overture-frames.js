/*
 * THE PAVED CENTRELINES OVER EACH FRAME, FOR THE DECODER (owner, 2026-10-20).
 *
 * What is left of Overture for the lawn map after H105 and the owner's own
 * look at the shapes on the predictions page: "the overture building outlines
 * are bad. Some shapes are just plain wrong... Let's completely scrap the
 * overture shapes for the lawn map." The roads and sidewalks: "the lines
 * aren't always perfectly centered on roads/sidewalks, so the full width of
 * the lines sometimes overlaps with lawn... If we used only the center lines
 * of the road/sidewalk shapes, that might be useful. Because the center lines
 * of the shapes do seem to always fall on actual roads/sidewalks, just not
 * always on the center. So if it could be at all useful to tell the detector
 * 'this center line falls somewhere on a road, sidewalk, or sometimes a
 * driveway' then yes let's give it to the detector."
 *
 * So: ONE channel, the line itself and nothing about its width. Writes
 * <OUT>/<id>-overture.png beside each frame, grey, on a 0.5 m grid over the
 * frame's box (rows north to south, like the photo): 255 on any OpenStreetMap
 * road, sidewalk, footway, crosswalk or path centreline, falling to 0 at
 * LINE_REACH_M -- a line one cell wide would vanish into the decoder's
 * metre-and-a-half patches, so it is given a short skirt, still far inside any
 * road's half-width. No building, no band, no typical width (H105: the 10 and
 * 15 m nearness channels and the footprint made THE PLAN worse). Roads and
 * sidewalks are one channel on purpose: the owner's meaning for both is the
 * same, "paved somewhere here". tools/fuse_layers.py reads it as two more
 * numbers a patch (the line and a flag).
 *
 * Overture is true-coordinate data, drawn as published. A frame Overture does
 * not answer for (after three tries) gets no file, which the decoder reads as
 * "no lines here", the same as modality dropout shows it.
 *
 *   FRAMES=frames OUT=overture node tools/overture-frames.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { overtureFor } from '../public/lib/overture.js';

const CELL_M = 0.5;
export const LINE_REACH_M = 2;
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

/** The one channel for one box ([w, s, e, n] in EPSG:3857 metres) from Overture's answer. Pure. */
export function rasterise(box, ov) {
  const [w, s, e, n] = box;
  const lat = (2 * Math.atan(Math.exp(((s + n) / 2) / R)) - Math.PI / 2) * 180 / Math.PI;
  const k = Math.cos((lat * Math.PI) / 180);
  const cell = CELL_M / k; // a ground half-metre, in mercator metres
  const W = Math.max(4, Math.round((e - w) / cell)), H = Math.max(4, Math.round((n - s) / cell));
  const toCell = (x, y) => [(x - w) / cell, (n - y) / cell];
  const toGrid = (line) => line.map((p) => { const [x, y] = toMerc(p); return toCell(x, y); });
  const lines = [];
  let walks = 0, roads = 0;
  for (const r of ov.roads || []) for (const line of r.lines || []) { if (line.length < 2) continue; lines.push(toGrid(line)); if (r.walk) walks++; else roads++; }
  return { W, H, line: nearness(lines, W, H, LINE_REACH_M / CELL_M), counts: { walks, roads } };
}

async function main() {
  const frames = process.env.FRAMES || 'frames', out = process.env.OUT || 'overture';
  mkdirSync(out, { recursive: true });
  const { PNG } = await import('pngjs');
  const scale = JSON.parse(readFileSync(join(frames, 'scale.json'), 'utf8'));
  const boxes = scale.boxes || {};
  const ids = Object.keys(boxes).filter((id) => existsSync(join(frames, `${id}.png`))).sort();
  const summary = { cell: CELL_M, lineReachM: LINE_REACH_M, frames: {}, skipped: {} };
  let withWalk = 0, withRoad = 0, withAny = 0;
  console.log(`${ids.length} frames; OpenStreetMap's road and sidewalk centrelines (via Overture) over each, as one channel\n`);
  for (const id of ids) {
    const box = boxes[id];
    const pad = LINE_REACH_M * 4; // mercator metres past the box, so a line just outside still counts
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
    const r = rasterise(box, { roads: ov.roads.filter((rd) => rd.lines.some(near)) });
    const png = new PNG({ width: r.W, height: r.H });
    for (let i = 0; i < r.W * r.H; i++) {
      const v = Math.round(255 * r.line[i]);
      png.data[i * 4] = v; png.data[i * 4 + 1] = v; png.data[i * 4 + 2] = v; png.data[i * 4 + 3] = 255;
    }
    writeFileSync(join(out, `${id}-overture.png`), PNG.sync.write(png));
    let on = 0;
    for (let i = 0; i < r.line.length; i++) if (r.line[i] > 0) on++;
    const rec = { ...r.counts, nearLine: on / r.line.length };
    summary.frames[id] = rec;
    if (rec.walks) withWalk++; if (rec.roads) withRoad++; if (rec.walks || rec.roads) withAny++;
    console.log(`  ${id.slice(0, 30).padEnd(30)} ${String(rec.roads).padStart(3)} road lines, ${String(rec.walks).padStart(3)} sidewalk or path lines (${(100 * rec.nearLine).toFixed(1)}% of the frame within ${LINE_REACH_M} m of one)`);
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  const n = Object.keys(summary.frames).length;
  console.log(`\n${n} frames written, ${Object.keys(summary.skipped).length} skipped; a line on ${withAny} (a road on ${withRoad}, a sidewalk or path on ${withWalk}).`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); process.exit(1); });
