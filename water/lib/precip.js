/**
 * THE WATER EACH PART OF THE LAWN GETS (water session; owner, 2026-10-20: "precipitation per hr based on
 * everything prior, rendered on the map to show gaps/dry spots").
 *
 * Every head lays its flow (gpm at the pressure it gets, lib/hydraulics.js) over its arc out to its throw
 * (lib/arcs.js), not evenly but by its kind's radial profile -- how its water falls with distance
 * (PROFILES, from lib/hydraulics/profiles.json). On a grid over the lawn:
 *
 *   by zone     the zone's own rate, in/h, cell by cell (each zone runs alone)
 *   coverage    each zone run long enough to put down its average depth, summed over the zones: 1.0 where the
 *               lawn gets what the schedule assumes, under it where it is dry, over it where zones overlap
 *   uniformity  the lower-quarter distribution uniformity of that coverage over the lawn (the auditors' DUlq:
 *               the driest quarter's mean over the whole's)
 *
 * Pure. heads: [{ zone, at [lng, lat], gpm, radiusM, arc (deg; null for a strip), dir (deg from north),
 * strip: { type, widthM, lengthM } | null, kind }].
 */

import { enu } from './heads.js';

/**
 * Radial profiles: [r / R, relative rate], by kind. Until lib/hydraulics/profiles.json is read in
 * (setProfiles), a flat profile to 0.7 of the throw, falling to nothing at its edge: the common shape of a
 * well-run spray or rotor in the catch-can literature (an ESTIMATE until replaced).
 */
export let PROFILES = {
  spray: [[0, 1], [0.7, 1], [1, 0.15]],
  rotary: [[0, 1], [0.7, 1], [1, 0.15]],
  rotor: [[0, 1], [0.7, 1], [1, 0.15]],
  impact: [[0, 1], [0.7, 1], [1, 0.15]],
};
export function setProfiles(p) { if (p) PROFILES = { ...PROFILES, ...p }; }

const kindOf = (k) => (k === 'rotary' ? 'rotary' : k === 'rotor' ? 'rotor' : k === 'impact' ? 'impact' : 'spray');

/** A profile's value at rho (linear between its points, 0 past the throw). */
export function profileAt(points, rho) {
  if (rho < 0 || rho > 1) return 0;
  for (let k = 1; k < points.length; k++) {
    const [a, fa] = points[k - 1], [b, fb] = points[k];
    if (rho <= b) return fa + ((rho - a) / Math.max(1e-9, b - a)) * (fb - fa);
  }
  return points[points.length - 1][1];
}
/** 2 * the integral of f(rho) rho drho over 0-1: the profile's mean over a circle's area. */
export function profileMean(points) {
  let s = 0;
  const n = 200;
  for (let k = 0; k < n; k++) { const rho = (k + 0.5) / n; s += profileAt(points, rho) * rho; }
  return (2 * s) / n;
}

/** in/h at a point east, north (m) of a head, from its water. */
export function rateAt(h, e, n) {
  const ft2PerM2 = 10.7639;
  if (h.strip) {
    // a strip: even over its rectangle
    const t = (h.dir * Math.PI) / 180, along = e * Math.sin(t) + n * Math.cos(t), across = e * Math.cos(t) - n * Math.sin(t);
    const L = h.strip.lengthM, W = h.strip.widthM, type = h.strip.type;
    const inside = type === 'center' ? Math.abs(along) <= L / 2 && Math.abs(across) <= W / 2
      : type === 'side' ? along >= 0 && along <= W && Math.abs(across) <= L / 2
        : along >= 0 && along <= L && Math.abs(across) <= W / 2;
    return inside ? (96.25 * h.gpm) / (L * W * ft2PerM2) : 0;
  }
  const r = Math.hypot(e, n);
  if (r > h.radiusM || !(h.radiusM > 0)) return 0;
  if (h.arc < 359) {
    const bearing = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
    let off = Math.abs(bearing - h.dir) % 360; if (off > 180) off = 360 - off;
    if (off > h.arc / 2) return 0;
  }
  const pts = PROFILES[kindOf(h.kind)];
  const areaFt2 = Math.PI * h.radiusM * h.radiusM * (h.arc / 360) * ft2PerM2;
  return ((96.25 * h.gpm) / areaFt2) * (profileAt(pts, r / h.radiusM) / profileMean(pts));
}

/**
 * The lawn's water. grid: { W, H, cellM, at(c, r) -> [lng, lat] of a cell's middle, lawn(i) -> bool };
 * heads as above. -> { byZone: Map zone -> Float32Array in/h, coverage: Float32Array (share of the zone's
 * average depth, summed), zoneMean: Map zone -> in/h over the lawn it reaches, du (lower quarter), dryShare,
 * wetShare, missed (lawn cells no head reaches) }
 */
export function precipitation(grid, heads) {
  const N = grid.W * grid.H, byZone = new Map();
  const centres = new Array(N);
  for (let r = 0; r < grid.H; r++) for (let c = 0; c < grid.W; c++) centres[r * grid.W + c] = grid.at(c, r);
  for (const h of heads) {
    if (!(h.gpm > 0)) continue;
    if (!byZone.has(h.zone)) byZone.set(h.zone, new Float32Array(N));
    const out = byZone.get(h.zone), reach = h.strip ? Math.max(h.strip.lengthM, h.strip.widthM) : h.radiusM;
    for (let i = 0; i < N; i++) {
      const [e, n] = enu(h.at, centres[i]);
      if (Math.abs(e) > reach + grid.cellM || Math.abs(n) > reach + grid.cellM) continue;
      out[i] += rateAt(h, e, n);
    }
  }
  // each zone's average over the lawn it waters: what a run time would be set by
  const zoneMean = new Map();
  for (const [z, a] of byZone) {
    let s = 0, k = 0;
    for (let i = 0; i < N; i++) if (grid.lawn(i) && a[i] > 0) { s += a[i]; k++; }
    zoneMean.set(z, k ? s / k : 0);
  }
  const coverage = new Float32Array(N);
  for (const [z, a] of byZone) { const m = zoneMean.get(z); if (m > 0) for (let i = 0; i < N; i++) coverage[i] += a[i] / m; }
  const vals = [];
  let missed = 0;
  for (let i = 0; i < N; i++) if (grid.lawn(i)) { vals.push(coverage[i]); if (coverage[i] <= 0) missed++; }
  vals.sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
  const q = vals.slice(0, Math.max(1, Math.floor(vals.length / 4)));
  const du = mean > 0 ? q.reduce((s, v) => s + v, 0) / q.length / mean : 0;
  return {
    byZone, coverage, zoneMean, du, missed, lawnCells: vals.length,
    dryShare: vals.filter((v) => v < 0.6).length / Math.max(1, vals.length),
    wetShare: vals.filter((v) => v > 1.5).length / Math.max(1, vals.length),
  };
}
