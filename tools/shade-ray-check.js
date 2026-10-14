/**
 * WHERE THE MODEL'S SHADE COMES FROM, ALONG EACH READING'S RAY TO THE SUN
 * (owner, 2026-10-14, looking at the 4:28 PM stop with the sun low: "Are you
 * sure the leaf filling method isn't falsely lowering canopies closer to the
 * ground than they actually are?").
 *
 * Two things in the model put stuff below where the laser saw a tree:
 *
 *   LEAVES BELOW THE BRANCHES. seasonal.js gives a deciduous crown its
 *   summer leaves evenly from the CLUMP's crown base (the 10th percentile of
 *   all its returns over 2 m, so a clump with low shrubs in it starts at
 *   2 m) to each column's top. Under a tall tree whose lowest branch is at
 *   8 m that is a leafy curtain where the trunks stand in open air -- which
 *   only a low sun, coming in sideways under the crowns, would notice.
 *
 *   SOLID UNDER A DENSE LAYER. canopy.js fills a column solid from the
 *   highest layer under which almost no pulse got through down to the grass
 *   -- right for a roof (the walls the laser cannot see), a pillar under a
 *   dense crown.
 *
 * For each scored reading the ray from the phone to the sun is walked
 * exactly as rays.js walks it, and its optical depth split into:
 *   measured   what the laser itself measured (leaf-off, as flown)
 *   fill       the solid fill under a dense crown (trees only, not roofs)
 *   leafLow    leaves added below the lowest branch the laser saw there
 *   leafHigh   leaves added among the branches
 * and the same readings scored with each removed: the what-ifs.
 * Counts and heights only, never a place.
 */

import { buildCanopy, GRASS_M } from '../public/shade/canopy.js';
import { cellOf } from '../public/shade/grid.js';
import { cellMetres } from '../public/shade/rays.js';
import { CROWN_ABOVE_M } from '../public/shade/seasonal.js';

const NOISE = new Set([7, 18]);

/** Per column, the height over the ground of the lowest crown return in the 3 x 3 around it (5 x 5 where that has none); NaN with none. */
export function branchFloor(site) {
  const { cols, model, shift } = site;
  const { w, h, ground, grid } = model;
  const low = new Float32Array(w * h).fill(Infinity);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const k = cellOf(grid, cols.x[i], cols.y[i], shift);
    if (k < 0) continue;
    const over = cols.z[i] - ground[k];
    if (over > CROWN_ABOVE_M && over < 80 && over < low[k]) low[k] = over;
  }
  const out = new Float32Array(w * h).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (const r of [1, 2]) {
      let m = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && low[yy * w + xx] < m) m = low[yy * w + xx];
      }
      if (Number.isFinite(m)) { out[y * w + x] = m; break; }
    }
  }
  return out;
}

/**
 * The model's canopy for `muCal` (the calendar's leaves) in its parts, and
 * the what-ifs: { parts: { measured, fill, leafLow, leafHigh } (mu arrays
 * summing to muCal), noLowLeaves, noFill, neither }.
 */
export function canopyParts(site, muCal) {
  const { model, season, cols, grid, shift } = site;
  const { w, h, nz, dz, z0, ground } = model;
  const bare = season.muOff;
  const open = buildCanopy(cols, grid, { shift, fillUnder: false }).mu;
  const floorH = branchFloor(site);
  const n = w * h * nz;
  const measured = new Float32Array(n), fill = new Float32Array(n), leafLow = new Float32Array(n), leafHigh = new Float32Array(n);
  for (let k = 0; k < w * h; k++) {
    const tree = season.kind[k] === 2 || season.kind[k] === 3;
    for (let l = 0; l < nz; l++) {
      const i = k * nz + l;
      const asFlown = tree ? Math.min(open[i], bare[i]) : bare[i];
      measured[i] = asFlown;
      fill[i] = bare[i] - asFlown;
      const leaf = Math.max(0, muCal[i] - bare[i]);
      /* A layer entirely below the lowest branch seen here (or with no branch seen at all). */
      const below = !(z0 + (l + 1) * dz > ground[k] + floorH[k]);
      if (below) leafLow[i] = leaf; else leafHigh[i] = leaf;
    }
  }
  const sum = (...ps) => { const o = new Float32Array(n); for (const p of ps) for (let i = 0; i < n; i++) o[i] += p[i]; return o; };
  return {
    parts: { measured, fill, leafLow, leafHigh },
    noLowLeaves: sum(measured, fill, leafHigh),
    noFill: sum(measured, leafLow, leafHigh),
    neither: sum(measured, leafHigh),
  };
}

/**
 * Walk the ray from (gx, gy, z) toward the sun as rays.js transmittance does,
 * splitting its optical depth by part. Returns { tau: { part: value }, total,
 * heightOver (tau-weighted height over the ground where the light was
 * stopped), distM (tau-weighted distance along the ground) }.
 */
export function rayParts(model, parts, gx, gy, z, dir, { stepM = 0.5 } = {}) {
  const cm = cellMetres(model);
  const [e, nn, u] = dir;
  const out = { tau: Object.fromEntries(Object.keys(parts).map((p) => [p, 0])), total: 0, heightOver: NaN, distM: NaN, hill: false };
  if (u <= 0) return out;
  const { w, h, nz, dz, z0, ground, top } = model;
  const sx = (e / cm) * stepM, sy = (-nn / cm) * stepM, sz = u * stepM;
  let x = gx, y = gy, zz = z, hw = 0, dw = 0;
  const flat = Math.hypot(e, nn) * stepM;
  for (let i = 1; i < 100000; i++) {
    x += sx; y += sy; zz += sz;
    if (zz >= top) break;
    if (x < 0 || y < 0 || x >= w || y >= h) break;
    const c = (y | 0) * w + (x | 0);
    if (zz < ground[c] - 0.3) { out.hill = true; break; }
    const l = Math.floor((zz - z0) / dz);
    if (l < 0 || l >= nz) continue;
    let here = 0;
    for (const p of Object.keys(parts)) { const v = parts[p][c * nz + l] * stepM; out.tau[p] += v; here += v; }
    out.total += here;
    hw += here * (zz - ground[c]); dw += here * i * flat;
  }
  if (out.total > 0) { out.heightOver = hw / out.total; out.distM = dw / out.total; }
  return out;
}

export { GRASS_M };
