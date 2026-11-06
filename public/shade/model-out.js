/**
 * THE FINISHED MODEL, AS THE FILE EVERY TOOL READS (owner, 2026-11-04, via
 * the core session: "there should be one base set of files for making 3d
 * maps from lidar... When a map goes into the shade map, the lidar gets
 * built, aligned, points get sorted/classified, then the finished output
 * is saved. The AR shouldn't be rebuilding lidar maps from scratch").
 *
 * public/lib/lidar-model.js is the format (the core's); this gathers the
 * shade map's finished numbers into it: the grid the canopy was built on
 * (the cloud's shift already applied), the ground, each column's kind and
 * why (structures.js, after the person's erasures), its highest return,
 * and the canopy's cubes two ways -- `mu` as the laser flew it (leaf-off
 * branches, a tree's trunk space emptied to its branch floor, a low
 * structure solid; seasonal.js), and `muOn` with every deciduous crown in
 * full summer leaf -- both after erasures. A reader wanting a day in
 * between blends them by the leaf share, as the light worker does.
 * Written by public/shade.js when the trees are built and after each
 * erasure, to PUT /api/maps/model?id=&tool=shade.
 *
 * WHAT THE LASER HIT IN THIS VERY METRE (2026-11-04; the owner: blue walls
 * under canopies in the AR where the shade map shows open space). `mu` is
 * for light: where a column caught fewer than 4 pulses of its own, canopy.js
 * pools it with the 3 x 3 metres round it, so one trunk return gives nine
 * columns a low cube. On the owner's lot 59% of the crowned tree columns the
 * AR called solid at standing height were so only through a neighbour's
 * return. Two extra arrays (lidar-model.js keeps extra arrays) say what each
 * column's OWN returns were, for a reader asking "is something here":
 *   returns  Uint8 w*h*nz  the column's own returns in each cube, as mu
 *                          counts them (non-noise, over GRASS_M, under
 *                          MAX_OVER_M; strays already class 18), not pooled,
 *                          not weighted, capped at 255; erasures applied
 *   low      Float32 w*h   the lowest of them, m over the ground, exact (not
 *                          snapped to a cube); NaN where none
 *   lowDx, lowDy  Int16 w*h where in its metre the column's own returns
 *                          between STAND_LOW_M and STAND_HIGH_M over the
 *                          ground fall: their mean offset from the column's
 *                          centre, cm east and north, clamped to +-50; 0
 *                          where none (core session, 2026-11-05: the AR draws
 *                          a trunk as a thin post, the owner: "trunks
 *                          currently get averaged to 1m, so let's just make
 *                          those a thin line")
 *   intensity  Uint16 w*h  the median intensity of the column's own GROUND
 *                          returns (class 2, the ones ground.js builds the
 *                          surface from); 0 where none. Raw sensor units:
 *                          they differ between flights, so the header's
 *                          own.intensityMedian (the lot's ground median) is
 *                          there to calibrate per property (the owner,
 *                          2026-11-03: "calibrated per property")
 *   gIntens    Uint8 w*h   how many ground returns that median came from,
 *                          capped at 255 (core session, 2026-11-06: pavement
 *                          edges from lidar brightness, for placing an AR
 *                          walk with no marked references)
 *
 * THE POINTS THEMSELVES (core session, 2026-11-06, the owner: "if the shade
 * map can just pass along all of that at the highest resolution possible,
 * great"): every return the shade map kept over the model's grid, after its
 * filters -- the noise classes and the flagged strays out; in an erased
 * column or cube only the ground returns (class 2) stay -- with the kind of
 * the 1 m column it falls in, so the classification travels with it:
 *   ptX, ptY  Int32  cm (3857 units x 100) from the grid's (x0, y1) corner,
 *                    east and SOUTH (the way columns and rows run), the
 *                    cloud's shift applied: column = floor(ptX / (cell*100))
 *   ptZ       Int32  cm, absolute
 *   ptI       Uint16 intensity as read
 *   ptCls     Uint8  the ASPRS class as read (2 ground, ...)
 *   ptRet     Uint8  (return number << 4) | number of returns
 *   ptKind    Uint8  structures.js kind of its column, after erasures
 * meta.points = { n, spacingM: null (not thinned), frame, ... }.
 *
 * THE BLOCK AROUND (surround.js; core session, 2026-11-06, the AR's skyline):
 *   surroundGround, surroundTop  Float32 on their own grid (meta.surround:
 *                          the lot's box 100 m wider each way, 2 m cells),
 *                          the same meaning as `ground` and `top`; absent
 *                          until the page has read them (a second save)
 *
 * SENT GZIPPED (core session, 2026-11-05; the owner: "there are definitely
 * larger lots out there"): the server keeps every model gzipped, 48 MB at
 * most. A lot is mostly empty air, so the owner's 23.1 MB file goes up as
 * 1.3 MB on every save (measured 2026-11-05, 0.5 s to pack).
 */

import { packModel } from '../lib/lidar-model.js';
import { NOTHING, BUILDING, TREE, SOLID_TREE, STRUCTURE, UNKNOWN, NOISE } from './structures.js';
import { GRASS_M, MAX_OVER_M } from './canopy.js';
import { cellOf } from './grid.js';
import { mercScale } from './ept.js';

export const STAND_LOW_M = 0.4, STAND_HIGH_M = 2.4; // the heights a person standing on the lawn sees (scan/lib/locate.js BANDS)

export const KINDS = { NOTHING, BUILDING, TREE, SOLID_TREE, STRUCTURE, UNKNOWN };

/**
 * { meta, arrays } for lidar-model.js from the trees step's finished state
 * (trees-ui.js `finished()`): model (canopy.js), season (seasonal.js, with
 * `built` from structures.js), erasedMask (Uint8 per column or null),
 * erasedCubes (indices k*nz+l). `lidar`, `flown`, `photo`, `basedOn` go into
 * the header as they are.
 */
export function finishedModel({ model, season, cols = null, shift = null, surround = null, erasedMask = null, erasedCubes = [], lidar = null, flown = null, photo = null, basedOn = null, now = new Date() }) {
  const { grid, w, h, nz, dz, z0, ground } = model;
  const N = w * h;
  const built = season?.built;
  const kind = built ? Uint8Array.from(built.kind) : new Uint8Array(N);
  const why = built ? Uint8Array.from(built.why) : new Uint8Array(N);
  const top = new Float32Array(N);
  for (let k = 0; k < N; k++) { const t = built?.stats?.top?.[k]; top[k] = Number.isFinite(t) && t > -1e9 ? t : NaN; }
  const mu = Float32Array.from(season?.muOff || model.mu);
  const muOn = season?.muOn ? Float32Array.from(season.muOn) : null;
  let erased = 0;
  if (erasedMask) {
    for (let k = 0; k < N; k++) {
      if (!erasedMask[k]) continue;
      erased++;
      kind[k] = NOTHING; why[k] = 0; top[k] = NaN;
      mu.fill(0, k * nz, (k + 1) * nz);
      if (muOn) muOn.fill(0, k * nz, (k + 1) * nz);
    }
  }
  for (const i of erasedCubes) if (i >= 0 && i < mu.length) { mu[i] = 0; if (muOn) muOn[i] = 0; }
  const own = cols ? ownReturns(cols, model, { shift, erasedMask, erasedCubes }) : null;
  const meta = {
    v: 1, tool: 'shade', at: now.toISOString(), basedOn: basedOn || null,
    grid: { w, h, x0: grid.x0, y1: grid.y1, cell: grid.cell, cellY: grid.cellY || grid.cell, lat: grid.lat },
    layers: { z0, dz, nz },
    lidar: lidar ? { url: lidar.url, name: lidar.name, epoch: lidar.epoch, shift: lidar.shift || null, fit: lidar.fit || null, flown: flown ? { start: flown.start, mid: flown.mid, end: flown.end } : null } : null,
    photo: photo ? { id: photo.id, date: photo.date, source: photo.source } : null,
    rule: { kinds: KINDS },
    leaves: { mu: 'as flown: leaf-off branches, trunk space emptied to the branch floor, low structures solid; erasures applied', muOn: 'every deciduous crown in full summer leaf; erasures applied' },
    own: own ? { returns: "the column's own returns per cube, not pooled with its neighbours (mu is, where a column caught under 4 pulses); erasures applied", low: "the lowest own return over the grass, m over the ground, exact; NaN where none", grassM: GRASS_M, lowDx: "mean offset east of the column's centre, cm (Int16, +-50), of its own returns between standLowM and standHighM; 0 where none", lowDy: 'the same, north', standLowM: STAND_LOW_M, standHighM: STAND_HIGH_M, ...(own.intensity ? { intensity: "median intensity of the column's own ground (class 2) returns, raw sensor units; 0 where none", gIntens: 'ground returns behind that median, capped at 255', intensityMedian: own.intensityMedian } : { intensity: 'not written: this cloud carries no intensity' }) } : null,
    erased,
    counts: built?.counts || null,
    surround: surround ? { grid: { w: surround.grid.w, h: surround.grid.h, x0: surround.grid.x0, y1: surround.grid.y1, cell: surround.grid.cell, cellY: surround.grid.cellY || surround.grid.cell, lat: surround.grid.lat }, cellM: surround.cellM, aroundM: surround.aroundM, surroundGround: 'the ground, absolute m, mean of the ground returns, gaps filled', surroundTop: 'the highest return over that ground, m; 0 where nothing stands' } : null,
  };
  const arrays = { ground: Float32Array.from(ground), kind, why, top, mu };
  if (muOn) arrays.muOn = muOn;
  const pts = cols ? keptPoints(cols, model, { shift, kind, erasedMask, erasedCubes }) : null;
  if (pts) Object.assign(arrays, pts.arrays);
  if (pts) meta.points = pts.meta;
  if (surround) { arrays.surroundGround = Float32Array.from(surround.ground); arrays.surroundTop = Float32Array.from(surround.top); }
  if (own) { arrays.returns = own.returns; arrays.low = own.low; arrays.lowDx = own.lowDx; arrays.lowDy = own.lowDy; if (own.intensity) { arrays.intensity = own.intensity; arrays.gIntens = own.gIntens; } }
  return { meta, arrays };
}

/**
 * The cleaned cloud over the model's grid (see the header): the arrays and
 * meta.points. `kind` is the column kinds after erasures.
 */
export function keptPoints(cols, model, { shift = null, kind, erasedMask = null, erasedCubes = [] } = {}) {
  const { grid, nz, dz, z0 } = model;
  const gone = erasedCubes.length ? new Set(erasedCubes) : null;
  const cy = grid.cellY || grid.cell, sx = shift ? shift[0] : 0, sy = shift ? shift[1] : 0;
  const keep = new Int32Array(cols.n);
  let n = 0;
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    if (cols.cls[i] !== 2) {
      if (erasedMask && erasedMask[k]) continue;
      if (gone && gone.has(k * nz + Math.min(nz - 1, Math.max(0, Math.floor((cols.z[i] - z0) / dz))))) continue;
    }
    keep[n++] = i;
  }
  const ptX = new Int32Array(n), ptY = new Int32Array(n), ptZ = new Int32Array(n), ptI = new Uint16Array(n);
  const ptCls = new Uint8Array(n), ptRet = new Uint8Array(n), ptKind = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    const i = keep[j];
    const x = cols.x[i] + sx, y = cols.y[i] + sy;
    ptX[j] = Math.round((x - grid.x0) * 100);
    ptY[j] = Math.round((grid.y1 - y) * 100);
    ptZ[j] = Math.round(cols.z[i] * 100);
    ptI[j] = cols.intensity ? cols.intensity[i] : 0;
    ptCls[j] = cols.cls[i];
    ptRet[j] = ((Math.min(15, cols.ret?.[i] || 1)) << 4) | Math.min(15, cols.nret?.[i] || 1);
    ptKind[j] = kind[cellOf(grid, cols.x[i], cols.y[i], shift)];
  }
  return {
    arrays: { ptX, ptY, ptZ, ptI, ptCls, ptRet, ptKind },
    meta: { n, spacingM: null, frame: "ptX east and ptY SOUTH of the grid's (x0, y1) corner in 3857 units x 100 (real cm = value x cos(lat)), the cloud's shift applied; ptZ absolute cm", kept: 'noise classes and flagged strays out; in an erased column or cube only the ground returns stay', ret: '(return number << 4) | number of returns', cellCm: grid.cell * 100, cellYCm: cy * 100 },
  };
}

/**
 * Each column's own returns per cube and its lowest one (see the header):
 * the returns canopy.js turns into cubes, counted where they fell, before
 * any pooling. Returns in an erased column or an erased cube are left out.
 */
export function ownReturns(cols, model, { shift = null, erasedMask = null, erasedCubes = [] } = {}) {
  const { grid, w, h, nz, dz, z0, ground } = model;
  const N = w * h;
  const returns = new Uint8Array(N * nz), low = new Float32Array(N).fill(NaN);
  const sx = new Float32Array(N), sy = new Float32Array(N), sn = new Uint16Array(N);
  const gone = erasedCubes.length ? new Set(erasedCubes) : null;
  const mPer = Number.isFinite(grid.lat) ? mercScale(grid.lat) : 1, cy = grid.cellY || grid.cell;
  const I = cols.intensity, gi = I ? new Int32Array(cols.n).fill(-1) : null; // each ground return's column
  let anyI = false;
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    if (gi && cols.cls[i] === 2) { gi[i] = k; if (I[i]) anyI = true; } // the ground stays the ground under an erasure
    if (erasedMask && erasedMask[k]) continue;
    const over = cols.z[i] - ground[k];
    if (!(over > 0) || over > MAX_OVER_M) continue;
    const c = k * nz + Math.min(nz - 1, Math.max(0, Math.floor((cols.z[i] - z0) / dz)));
    if (gone?.has(c)) continue;
    if (over >= STAND_LOW_M && over <= STAND_HIGH_M && sn[k] < 65535) {
      /* the offset in real metres from the column's centre, after the same shift cellOf applied */
      const x = cols.x[i] + (shift ? shift[0] : 0), y = cols.y[i] + (shift ? shift[1] : 0);
      sx[k] += (x - (grid.x0 + ((k % w) + 0.5) * grid.cell)) * mPer;
      sy[k] += (y - (grid.y1 - (Math.floor(k / w) + 0.5) * cy)) * mPer;
      sn[k]++;
    }
    if (over <= GRASS_M) continue;
    if (returns[c] < 255) returns[c]++;
    if (!(low[k] <= over)) low[k] = over;
  }
  const lowDx = new Int16Array(N), lowDy = new Int16Array(N); // Int16: lidar-model.js takes no Int8
  const cm = (v) => Math.max(-50, Math.min(50, Math.round(v * 100)));
  for (let k = 0; k < N; k++) if (sn[k]) { lowDx[k] = cm(sx[k] / sn[k]); lowDy[k] = cm(sy[k] / sn[k]); }
  if (!anyI) return { returns, low, lowDx, lowDy };
  /* The ground's brightness: each column's ground returns, gathered per column (CSR), their median. */
  const start = new Uint32Array(N + 1);
  for (let i = 0; i < cols.n; i++) if (gi[i] >= 0) start[gi[i] + 1]++;
  for (let k = 0; k < N; k++) start[k + 1] += start[k];
  const vals = new Uint16Array(start[N]), fill = start.slice(0, N);
  for (let i = 0; i < cols.n; i++) if (gi[i] >= 0) vals[fill[gi[i]]++] = I[i];
  const intensity = new Uint16Array(N), gIntens = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const n = start[k + 1] - start[k];
    if (!n) continue;
    const v = vals.subarray(start[k], start[k + 1]).sort();
    intensity[k] = n % 2 ? v[n >> 1] : Math.round((v[(n >> 1) - 1] + v[n >> 1]) / 2);
    gIntens[k] = Math.min(255, n);
  }
  const all = Uint16Array.from(vals).sort();
  const intensityMedian = all.length ? all[all.length >> 1] : 0;
  return { returns, low, lowDx, lowDy, intensity, gIntens, intensityMedian };
}

/**
 * The bytes to PUT: the file gzipped (lidar-model.js packModel). Over
 * `maxBytes` gzipped (the server's MODEL_MAX_STORED, worker/src/unified.js),
 * muOn is left out first (no reader uses it yet), then the per-cube
 * `returns` (`low` stays), then the points; the file is still written.
 */
export async function modelBytes(finished, { maxBytes = 48 * 1024 * 1024 } = {}) {
  let meta = finished.meta, arrays = finished.arrays;
  let bytes = await packModel(meta, arrays);
  const LEFT_OUT = 'left out: the file would be over the size the server takes';
  if (bytes.byteLength > maxBytes && arrays.muOn) {
    const { muOn, ...rest } = arrays;
    arrays = rest; meta = { ...meta, leaves: { ...meta.leaves, muOn: LEFT_OUT } };
    bytes = await packModel(meta, arrays);
  }
  if (bytes.byteLength > maxBytes && arrays.returns) {
    const { returns, ...rest } = arrays;
    arrays = rest; meta = { ...meta, own: { ...meta.own, returns: LEFT_OUT } };
    bytes = await packModel(meta, arrays);
  }
  if (bytes.byteLength > maxBytes && arrays.ptX) {
    const { ptX, ptY, ptZ, ptI, ptCls, ptRet, ptKind, ...rest } = arrays;
    arrays = rest; meta = { ...meta, points: { ...meta.points, n: 0, leftOut: LEFT_OUT } };
    bytes = await packModel(meta, arrays);
  }
  return bytes;
}
