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
 */

import { encodeModel } from '../lib/lidar-model.js';
import { NOTHING, BUILDING, TREE, SOLID_TREE, STRUCTURE, UNKNOWN } from './structures.js';

export const KINDS = { NOTHING, BUILDING, TREE, SOLID_TREE, STRUCTURE, UNKNOWN };

/**
 * { meta, arrays } for lidar-model.js from the trees step's finished state
 * (trees-ui.js `finished()`): model (canopy.js), season (seasonal.js, with
 * `built` from structures.js), erasedMask (Uint8 per column or null),
 * erasedCubes (indices k*nz+l). `lidar`, `flown`, `photo`, `basedOn` go into
 * the header as they are.
 */
export function finishedModel({ model, season, erasedMask = null, erasedCubes = [], lidar = null, flown = null, photo = null, basedOn = null, now = new Date() }) {
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
  const meta = {
    v: 1, tool: 'shade', at: now.toISOString(), basedOn: basedOn || null,
    grid: { w, h, x0: grid.x0, y1: grid.y1, cell: grid.cell, cellY: grid.cellY || grid.cell, lat: grid.lat },
    layers: { z0, dz, nz },
    lidar: lidar ? { url: lidar.url, name: lidar.name, epoch: lidar.epoch, shift: lidar.shift || null, fit: lidar.fit || null, flown: flown ? { start: flown.start, mid: flown.mid, end: flown.end } : null } : null,
    photo: photo ? { id: photo.id, date: photo.date, source: photo.source } : null,
    rule: { kinds: KINDS },
    leaves: { mu: 'as flown: leaf-off branches, trunk space emptied to the branch floor, low structures solid; erasures applied', muOn: 'every deciduous crown in full summer leaf; erasures applied' },
    erased,
    counts: built?.counts || null,
  };
  const arrays = { ground: Float32Array.from(ground), kind, why, top, mu };
  if (muOn) arrays.muOn = muOn;
  return { meta, arrays };
}

/** The bytes to PUT. Over `maxBytes`, muOn is left out, then the file is still written. */
export function modelBytes(finished, { maxBytes = 24 * 1024 * 1024 } = {}) {
  let bytes = encodeModel(finished.meta, finished.arrays);
  if (bytes.byteLength > maxBytes && finished.arrays.muOn) {
    const { muOn, ...rest } = finished.arrays;
    bytes = encodeModel({ ...finished.meta, leaves: { ...finished.meta.leaves, muOn: 'left out: the file would be over the size the server takes' } }, rest);
  }
  return bytes;
}
