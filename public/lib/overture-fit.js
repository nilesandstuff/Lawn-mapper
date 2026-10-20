/*
 * OVERTURE'S BUILDINGS MOVED ONTO THE LIDAR'S ROOFS, one shift per frame.
 *
 * H101 (workflow 37, 2026-10-20): Overture's footprints sit a median 0.87 m
 * off the lidar's roofs, more than a metre on half the lots, and the error is
 * Overture's own placement -- one shift per lot, with the buildings on a lot
 * scattering only 0.38 m about it. So the correction is a lot-wide shift
 * found by sliding the footprints over the lidar's roof mask for the best
 * overlap. Roads and sidewalks (OpenStreetMap's, not Overture's tracing) do
 * not share the shift and are left where they are.
 *
 * Pure, so the training run (tools/overture-frames.js) and the predictions
 * page (lib/predictions-overture.js, in the browser) fit the same way.
 */
import { frameCorners } from './mercator.js';
import { overtureMasks } from './overture.js';

export const CELL_M = 0.5;
/* A fit is kept only when the moved footprint overlaps the roof at least this
   much and the move gained at least this much overlap; else Overture's own
   placement stands. The search reaches four metres each way. */
export const ALIGN_MIN_IOU = 0.3, ALIGN_MIN_GAIN = 0.02, ALIGN_REACH_M = 4;
const R = 6378137;
const toMerc = ([lng, lat]) => [(lng * Math.PI / 180) * R, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R];

/**
 * The best whole-cell shift of `building` (W x H, 1 inside a footprint) onto
 * `roof` ({ data, w, h }, any size, resampled to the grid), by soft IoU, within
 * `maxCells` each way. Null with no footprint or too little roof to fit to.
 */
export function fitToRoof(building, W, H, roof, maxCells, minRoofCells = 200) {
  const Rm = new Uint8Array(W * H);
  let roofN = 0, bN = 0;
  for (let r = 0; r < H; r++) {
    const rr = Math.min(roof.h - 1, Math.floor(((r + 0.5) * roof.h) / H));
    for (let c = 0; c < W; c++) {
      const cc = Math.min(roof.w - 1, Math.floor(((c + 0.5) * roof.w) / W));
      const v = roof.data[rr * roof.w + cc] ? 1 : 0;
      Rm[r * W + c] = v; roofN += v;
    }
  }
  const cells = [];
  for (let i = 0; i < W * H; i++) if (building[i]) { cells.push(i); bN++; }
  if (!bN || roofN < minRoofCells) return null;
  const iou = (dx, dy) => {
    let inter = 0;
    for (const i of cells) {
      const r = Math.floor(i / W) + dy, c = (i % W) + dx;
      if (r >= 0 && c >= 0 && r < H && c < W && Rm[r * W + c]) inter++;
    }
    return inter / (bN + roofN - inter);
  };
  const iou0 = iou(0, 0);
  let best = { dx: 0, dy: 0, iou: iou0 };
  for (let dy = -maxCells; dy <= maxCells; dy++) for (let dx = -maxCells; dx <= maxCells; dx++) {
    const v = iou(dx, dy);
    if (v > best.iou + 1e-9 || (Math.abs(v - best.iou) <= 1e-9 && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) best = { dx, dy, iou: v };
  }
  return { ...best, iou0, roofCells: roofN, buildingCells: bN };
}

/** The raster moved by (dx east, dy south) cells; what leaves the grid is dropped. */
export function shiftRaster(building, W, H, dx, dy) {
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!building[r * W + c]) continue;
    const rr = r + dy, cc = c + dx;
    if (rr >= 0 && cc >= 0 && rr < H && cc < W) out[rr * W + cc] = 1;
  }
  return out;
}

/**
 * A half-metre grid over a photo frame ({ lng, lat, zoom, size, height }):
 * W x H cells, the frame's box in web-mercator metres, and the cell size in
 * those metres (a ground half-metre is longer in mercator by 1/cos(lat)).
 */
export function frameGrid(frame, cellM = CELL_M) {
  const c = frameCorners(frame); // NW, NE, SE, SW
  const [w, n] = toMerc(c[0]), [e, s] = toMerc(c[2]);
  const k = Math.cos((frame.lat * Math.PI) / 180);
  const cell = cellM / k;
  const W = Math.max(4, Math.round((e - w) / cell)), H = Math.max(4, Math.round((n - s) / cell));
  return { W, H, cell, cellM, k, box: [w, s, e, n], toCell: (x, y) => [(x - w) / cell, (n - y) / cell] };
}

/**
 * The shift that puts Overture's buildings (rings in [lng, lat]) on the
 * lidar's roof mask over a frame: { eastM, southM, iou0, iou, applied }, or
 * null when there is nothing to fit (no building, no roof worth the name).
 * `applied` is false when the best move did not earn its keep, and the
 * caller draws the footprints where Overture put them.
 */
export function fitFrame(frame, buildings, roof) {
  if (!roof || !buildings?.length) return null;
  const g = frameGrid(frame);
  const { building } = overtureMasks(g, { roads: [], buildings });
  const f = fitToRoof(building, g.W, g.H, roof, Math.round(ALIGN_REACH_M / g.cellM));
  if (!f) return null;
  const applied = f.iou >= ALIGN_MIN_IOU && f.iou - f.iou0 >= ALIGN_MIN_GAIN;
  return { eastM: f.dx * g.cellM, southM: f.dy * g.cellM, iou0: f.iou0, iou: f.iou, applied, roofCells: f.roofCells, buildingCells: f.buildingCells };
}
