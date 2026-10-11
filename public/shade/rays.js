/**
 * LIGHT ON THE GRASS, RAY BY RAY (shade map).
 *
 * From a point just above the ground, march toward the sun (or toward a
 * patch of sky) through the canopy model (canopy.js), adding up mu x path:
 *
 *   T = exp( - sum mu ds )     the share of the beam that arrives
 *
 * A roof stops it (T ~ 0), a crown dims it by what the laser measured, the
 * ground itself stops it (a hill), and above the tallest thing in the model
 * nothing more can. A ray that leaves the model's box sideways is counted
 * as clear from there on: things more than the box's margin away are not
 * in the model, which matters only with the sun low.
 *
 * Positions are in the model's grid cells (x east, y SOUTH, as the grid's
 * rows run) plus z in metres. Directions are [east, north, up] unit vectors.
 */

import { GRASS_M } from './canopy.js';
import { clearSky, parMol } from './sun.js';
import { mercScale } from './ept.js';

const START_M = 0.1; // rays start this far above the ground

/** Real metres per grid cell. */
export const cellMetres = (model) => model.grid.cell * mercScale(model.grid.lat);

/** Ground height at fractional cell position (nearest column). */
export function groundAt(model, gx, gy) {
  const x = Math.min(model.w - 1, Math.max(0, Math.floor(gx)));
  const y = Math.min(model.h - 1, Math.max(0, Math.floor(gy)));
  return model.ground[y * model.w + x];
}

/** Share of a beam along `dir` that reaches (gx, gy, z). */
export function transmittance(model, gx, gy, z, dir, { stepM = 0.5, cm = cellMetres(model) } = {}) {
  const [e, n, u] = dir;
  if (u <= 0) return 0;
  const { w, h, nz, dz, z0, mu, ground, top } = model;
  const sx = (e / cm) * stepM, sy = (-n / cm) * stepM, sz = u * stepM;
  let x = gx, y = gy, zz = z, tau = 0;
  for (let i = 0; i < 100000; i++) {
    x += sx; y += sy; zz += sz;
    if (zz >= top) break;
    if (x < 0 || y < 0 || x >= w || y >= h) break;
    const c = (y | 0) * w + (x | 0);
    if (zz < ground[c] - 0.3) return 0; // into the hillside
    const l = Math.floor((zz - z0) / dz);
    if (l >= 0 && l < nz) {
      tau += mu[c * nz + l] * stepM;
      if (tau > 7) return 0;
    }
  }
  return Math.exp(-tau);
}

/**
 * Sample points: every grid cell where mask[k] is set, `sub` x `sub` points
 * per cell. Returns Float32Array [gx, gy, gx, gy, ...] and the cell each is in.
 */
export function samplePoints(model, mask, sub = 1) {
  const pts = [], cells = [];
  for (let y = 0; y < model.h; y++) {
    for (let x = 0; x < model.w; x++) {
      if (!mask[y * model.w + x]) continue;
      for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
        pts.push(x + (i + 0.5) / sub, y + (j + 0.5) / sub);
        cells.push(y * model.w + x);
      }
    }
  }
  return { xy: Float32Array.from(pts), cells: Int32Array.from(cells) };
}

/** The ground's unit normal [east, north, up] at a cell, from its neighbours. */
export function normalAt(model, gx, gy, cm = cellMetres(model)) {
  const g = (dx, dy) => groundAt(model, gx + dx, gy + dy);
  const dzdx = (g(1, 0) - g(-1, 0)) / (2 * cm);
  const dzdn = (g(0, -1) - g(0, 1)) / (2 * cm); // north is -y
  const len = Math.hypot(dzdx, dzdn, 1);
  return [-dzdx / len, -dzdn / len, 1 / len];
}

/** The hemisphere's sample directions and their weights for diffuse light on level ground. */
export function skyDirections(bands = 9, around = 16) {
  const dirs = [];
  let total = 0;
  for (let b = 0; b < bands; b++) {
    const el = ((b + 0.5) / bands) * (Math.PI / 2);
    /* Isotropic sky on a level surface: radiance x cos(zenith) x solid angle. */
    const wgt = Math.sin(el) * Math.cos(el);
    for (let a = 0; a < around; a++) {
      const az = ((a + 0.5) / around) * 2 * Math.PI;
      dirs.push({ dir: [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)], w: wgt });
      total += wgt;
    }
  }
  for (const d of dirs) d.w /= total;
  return dirs;
}

/** Sky view: the share of an open sky's diffuse light each point gets (1 = nothing overhead). */
export function skyView(model, xy, { dirs = skyDirections(), stepM = 0.5 } = {}) {
  const cm = cellMetres(model);
  const out = new Float32Array(xy.length / 2);
  for (let p = 0; p < out.length; p++) {
    const gx = xy[2 * p], gy = xy[2 * p + 1];
    const z = groundAt(model, gx, gy) + START_M;
    let s = 0;
    for (const d of dirs) s += d.w * transmittance(model, gx, gy, z, d.dir, { stepM, cm });
    out[p] = s;
  }
  return out;
}

/** Each point's share of the direct beam with the sun along `dir`. */
export function sunlitNow(model, xy, dir, { stepM = 0.5 } = {}) {
  const cm = cellMetres(model);
  const out = new Float32Array(xy.length / 2);
  for (let p = 0; p < out.length; p++) {
    const gx = xy[2 * p], gy = xy[2 * p + 1];
    out[p] = transmittance(model, gx, gy, groundAt(model, gx, gy) + START_M, dir, { stepM, cm });
  }
  return out;
}

/**
 * One day's light at every point, under a CLEAR sky, from the sun's path
 * (sun.js sunPath, steps `stepMin` apart):
 *
 *   sunHours    hours with at least half the direct beam getting through
 *   beamHours   hours of direct beam, weighted by how much got through
 *   dli         mol/m2/day of photosynthetic light, direct + diffuse (svf)
 *   openDli     the same for open, level ground at this place (the ceiling)
 *
 * The direct beam falls on the ground's own slope (normalAt); the diffuse
 * sky is the open sky's diffuse light times the point's sky view.
 */
export function dayLight(model, xy, path, { stepMin = 10, heightM = 0, svf = null, stepM = 0.5 } = {}) {
  const cm = cellMetres(model);
  const n = xy.length / 2;
  const sunHours = new Float32Array(n), beamHours = new Float32Array(n), dli = new Float32Array(n);
  const dt = stepMin * 60;
  const zs = new Float32Array(n), normals = new Array(n);
  for (let p = 0; p < n; p++) {
    zs[p] = groundAt(model, xy[2 * p], xy[2 * p + 1]) + START_M;
    normals[p] = normalAt(model, xy[2 * p], xy[2 * p + 1], cm);
  }
  let openDli = 0;
  for (const s of path) {
    const sky = clearSky(s.elevation, heightM, s.R);
    openDli += parMol(sky.ghi, dt);
    for (let p = 0; p < n; p++) {
      const T = transmittance(model, xy[2 * p], xy[2 * p + 1], zs[p], s.dir, { stepM, cm });
      const nm = normals[p];
      const cosInc = Math.max(0, nm[0] * s.dir[0] + nm[1] * s.dir[1] + nm[2] * s.dir[2]);
      if (T >= 0.5) sunHours[p] += dt / 3600;
      beamHours[p] += (T * dt) / 3600;
      dli[p] += parMol(sky.dni * cosInc * T + sky.dhi * (svf ? svf[p] : 1), dt);
    }
  }
  return { sunHours, beamHours, dli, openDli };
}
