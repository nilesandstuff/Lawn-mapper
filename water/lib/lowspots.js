/**
 * STEP 1, THE LOW-SPOT MAP, END TO END (water session).
 *
 * points (lib/ept.js) -> ground surface and roofs (lib/surface.js) ->
 * low spots, flow, the ground beside each building (lib/hydro.js) ->
 * one plain object a page or a report can draw from.
 *
 * Positions in the result are grid cells; `lngLat(row, col)` turns one back
 * into a place. Nothing here knows or keeps an address.
 */

import { fromMerc } from './ept.js';
import { makeColumns } from './las.js';
import { gridFor, groundSurface, inpaint, buildingMask } from './surface.js';
import { lowSpots, flow, foundation, MIN_AREA } from './hydro.js';
import { nad83Correction } from './datum.js';
import { rng, gauss } from './synthetic.js';
import { sortSpots } from './kinds.js';
import { shadeRoofs } from './roofs.js';

/**
 * HOW DEEP A SPOT PURE NOISE DIGS, ON THIS FLIGHT (the noise floor).
 *
 * Flat ground, the same box, the same number of ground points per square
 * meter and the same scatter as the real cloud, `runs` times over with fresh
 * noise; the deepest spot of MIN_AREA or more inside `within` (the lot, in
 * cells) in each run. The floor is the deepest of those: a real spot has to
 * beat what noise did in every one of the runs. Flat is the worst case --
 * noise digs deepest where nothing drains -- so on a sloping yard this
 * floor is cautious. It answers the owner's second bar (7 of 10 predicted
 * spots really wet) before the field check, not after it.
 */
export function noiseFloor(bbox, lat, groundPerM2, scatter, { runs = 8, within = null, seed = 7 } = {}) {
  const g = gridFor(bbox, lat);
  const n = Math.round(groundPerM2 * g.W * g.H * g.cell * g.cell);
  const deepest = [];
  for (let k = 0; k < runs; k++) {
    const r = rng(seed + 7919 * k);
    const cols = makeColumns(n);
    for (let i = 0; i < n; i++) {
      cols.x[i] = bbox[0] + r() * (bbox[2] - bbox[0]);
      cols.y[i] = bbox[1] + r() * (bbox[3] - bbox[1]);
      cols.z[i] = scatter * gauss(r);
      cols.cls[i] = 2; cols.nret[i] = 1;
    }
    const raw = groundSurface(g, cols);
    const z = inpaint(g, raw.z);
    const se = Float32Array.from(raw.se, (v) => (Number.isFinite(v) ? v : 0.05));
    const { spots } = lowSpots(g, z, se, new Uint8Array(g.W * g.H));
    let d = 0;
    for (const s of spots) {
      if (s.area < MIN_AREA) continue;
      if (within && !(s.col >= within[0] && s.col < within[2] && s.row >= within[1] && s.row < within[3])) continue;
      d = Math.max(d, s.depth);
    }
    deepest.push(d);
  }
  deepest.sort((a, b) => a - b);
  return { floor: deepest[deepest.length - 1], runs: deepest };
}

/**
 * cols: the cloud's columns over `bbox` (EPSG:3857). lat: the box's middle.
 * epoch: the flight's decimal year (for the datum, lib/datum.js), or null to
 * leave the cloud where the octree put it.
 */
export function analyse(cols, bbox, lat, { epoch = null, cell = 1, within = null, nullRuns = 8, floor = null, useShadeRoofs = cell === 1 } = {}) {
  const g = gridFor(bbox, lat, cell);
  const raw = groundSurface(g, cols);
  const z = inpaint(g, raw.z);
  const { mask: ownRoofs, fromClass6 } = buildingMask(g, cols, raw.z, z);
  /* ROOFS: the water map's own finder OR the shade map's (lib/roofs.js). Scored on the Chesapeake land use
     (FINDINGS H13): either alone is IoU 0.71-0.72, but they miss different roofs; together they find 91% of
     roof cells (98% within 1 m) at 77% precision (86% within 1 m). A missed roof is the worse error here --
     it becomes a fake low spot and a hole in the walls -- so the union. */
  let wall = ownRoofs;
  if (useShadeRoofs && cols.n) {
    const sh = shadeRoofs(cols, bbox, lat);
    if (sh.w === g.W && sh.h === g.H) wall = Uint8Array.from(ownRoofs, (v, i) => (v || sh.roof[i] ? 1 : 0));
  }
  const groundOk = new Uint8Array(g.W * g.H);
  for (let i = 0; i < groundOk.length; i++) groundOk[i] = !wall[i] && Number.isFinite(raw.z[i]) ? 1 : 0;
  const se = Float32Array.from(raw.se, (v) => (Number.isFinite(v) ? v : 0.05));

  // the flight's own density and scatter, over open ground
  let ground = 0, open = 0;
  const sds = [];
  for (let i = 0; i < cols.n; i++) if (cols.cls[i] === 2) ground++;
  for (let i = 0; i < wall.length; i++) {
    if (wall[i]) continue;
    open++;
    if (Number.isFinite(raw.sd[i]) && raw.n[i] >= 4) sds.push(raw.sd[i]);
  }
  sds.sort((a, b) => a - b);
  const groundPerM2 = ground / Math.max(1, open * g.cell * g.cell);
  const scatter = sds.length ? sds[sds.length >> 1] : 0.03;
  const nf = floor !== null ? { floor, runs: [] } : nullRuns ? noiseFloor(bbox, lat, groundPerM2, scatter, { runs: nullRuns, within }) : { floor: 0, runs: [] };

  const spots = lowSpots(g, z, se, wall, { floor: nf.floor });
  // every return per cell, and the survey's water (class 9): what kind of spot each is (lib/kinds.js)
  const N = g.W * g.H;
  const perCell = { all: new Uint16Array(N), single: new Uint16Array(N), class9: new Uint16Array(N), tall: new Uint16Array(N), groundI: new Float64Array(N), groundN: new Uint16Array(N), roofI: new Float64Array(N), roofN: new Uint16Array(N), groundP75: 0 };
  const gInt = [];
  for (let i = 0; i < cols.n; i++) {
    if (cols.cls[i] === 7 || cols.cls[i] === 18) continue; // noise
    const [fc, fr] = g.toCell(cols.x[i], cols.y[i]);
    const c = Math.floor(fc), r = Math.floor(fr);
    if (c < 0 || r < 0 || c >= g.W || r >= g.H) continue;
    const j = r * g.W + c;
    if (perCell.all[j] < 65535) perCell.all[j]++;
    if (cols.nret[i] <= 1 && perCell.single[j] < 65535) perCell.single[j]++;
    if (cols.cls[i] === 9 && perCell.class9[j] < 65535) perCell.class9[j]++;
    if (cols.cls[i] === 2) { perCell.groundI[j] += cols.intensity[i]; perCell.groundN[j]++; if (!wall[j]) gInt.push(cols.intensity[i]); }
    else if (wall[j]) { perCell.roofI[j] += cols.intensity[i]; perCell.roofN[j]++; }
    else if (!wall[j] && cols.z[i] - z[j] >= 2 && perCell.tall[j] < 65535) perCell.tall[j]++;
  }
  gInt.sort((a, b) => a - b);
  perCell.groundP75 = gInt.length ? gInt[Math.floor(gInt.length * 0.75)] : 0;
  sortSpots(g, spots.spots, spots.depth, perCell, wall);
  const runoff = flow(g, z, wall);
  const beside = foundation(g, z, groundOk, wall);

  // the datum: a 3DEP cloud's NAD83 read as WGS84 sits 0.5-1.2 m off the web map (lib/datum.js)
  const [, midLat] = fromMerc([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
  const [midLng] = fromMerc([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
  const shift = epoch ? nad83Correction(midLat, midLng, epoch) : { east: 0, north: 0 };
  const lngLat = (row, col) => {
    const [x, y] = g.toMerc(col, row);
    const [lng, lat2] = fromMerc([x + shift.east / g.k, y + shift.north / g.k]);
    return [lng, lat2];
  };

  const seVals = Array.from(raw.se).filter(Number.isFinite).sort((a, b) => a - b);

  return {
    grid: g, z, rawZ: raw.z, sd: raw.sd, se, wall, ownRoofs, groundOk, spots, runoff, beside, shift, lngLat, perCell,
    stats: {
      cells: g.W * g.H,
      groundPointsPerM2: groundPerM2,
      scatter,
      medianSe: seVals.length ? seVals[seVals.length >> 1] : null,
      noiseFloor: nf.floor,
      noiseRuns: nf.runs,
      buildingCells: wall.reduce((s, v) => s + v, 0),
      buildingsFromClass6: fromClass6,
      spotsFound: spots.spots.length,
      spotsReported: spots.spots.filter((s) => s.reported).length,
      hollows: spots.spots.filter((s) => s.reported && s.kind === 'hollow').length,
    },
  };
}

/** The spots worth showing, as plain records (no cell lists). */
export function spotRecords(result, { within = null } = {}) {
  const g = result.grid;
  return result.spots.spots.filter((s) => s.reported).filter((s) => {
    if (!within) return true;
    return s.row >= within[1] && s.row < within[3] && s.col >= within[0] && s.col < within[2];
  }).map((s) => ({
    depthCm: +(s.depth * 100).toFixed(1),
    errorCm: +(s.sigma * 100).toFixed(1),
    areaM2: +s.area.toFixed(1),
    volumeL: Math.round(s.volume * 1000),
    againstBuilding: s.againstBuilding,
    atEdge: s.atEdge,
    kind: s.kind,
    measures: s.measures && {
      returnRatio: +s.measures.returnRatio.toFixed(2), class9Share: +s.measures.class9Share.toFixed(2),
      treesShare: +s.measures.treesShare.toFixed(2), intensityRatio: s.measures.intensityRatio === null ? null : +s.measures.intensityRatio.toFixed(2),
      lengthM: +s.measures.length.toFixed(1), widthM: +s.measures.width.toFixed(1), elongation: +s.measures.elongation.toFixed(1),
    },
    row: s.row, col: s.col,
    lngLat: result.lngLat(s.row, s.col).map((v) => +v.toFixed(7)),
    cellSize: g.cell,
  }));
}
