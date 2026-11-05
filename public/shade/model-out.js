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

export const KINDS = { NOTHING, BUILDING, TREE, SOLID_TREE, STRUCTURE, UNKNOWN };

/**
 * { meta, arrays } for lidar-model.js from the trees step's finished state
 * (trees-ui.js `finished()`): model (canopy.js), season (seasonal.js, with
 * `built` from structures.js), erasedMask (Uint8 per column or null),
 * erasedCubes (indices k*nz+l). `lidar`, `flown`, `photo`, `basedOn` go into
 * the header as they are.
 */
export function finishedModel({ model, season, cols = null, shift = null, erasedMask = null, erasedCubes = [], lidar = null, flown = null, photo = null, basedOn = null, now = new Date() }) {
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
    own: own ? { returns: "the column's own returns per cube, not pooled with its neighbours (mu is, where a column caught under 4 pulses); erasures applied", low: "the lowest own return over the grass, m over the ground, exact; NaN where none", grassM: GRASS_M } : null,
    erased,
    counts: built?.counts || null,
  };
  const arrays = { ground: Float32Array.from(ground), kind, why, top, mu };
  if (muOn) arrays.muOn = muOn;
  if (own) { arrays.returns = own.returns; arrays.low = own.low; }
  return { meta, arrays };
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
  const gone = erasedCubes.length ? new Set(erasedCubes) : null;
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0 || (erasedMask && erasedMask[k])) continue;
    const over = cols.z[i] - ground[k];
    if (!(over > GRASS_M) || over > MAX_OVER_M) continue;
    const c = k * nz + Math.min(nz - 1, Math.max(0, Math.floor((cols.z[i] - z0) / dz)));
    if (gone?.has(c)) continue;
    if (returns[c] < 255) returns[c]++;
    if (!(low[k] <= over)) low[k] = over;
  }
  return { returns, low };
}

/**
 * The bytes to PUT: the file gzipped (lidar-model.js packModel). Over
 * `maxBytes` gzipped (the server's MODEL_MAX_STORED, worker/src/unified.js),
 * muOn is left out first (no reader uses it yet), then the per-cube
 * `returns` (`low` stays); the file is still written.
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
  return bytes;
}
