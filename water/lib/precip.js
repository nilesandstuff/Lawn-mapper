/**
 * THE WATER EACH PART OF THE LAWN GETS (water session; owner, 2026-10-20: "precipitation per hr based on
 * everything prior, rendered on the map to show gaps/dry spots").
 *
 * Every head lays its flow (gpm at the pressure it gets, lib/hydraulics.js) over its arc out to its throw
 * (lib/arcs.js), not evenly but by its kind's radial profile -- how its water falls with distance
 * (profileFor, from lib/hydraulics/profiles.json). On a grid over the lawn:
 *
 *   by zone     the zone's own rate, in/h, cell by cell (each zone runs alone)
 *   coverage    each zone run long enough to put down its average depth, summed over the zones: 1.0 where the
 *               lawn gets what the schedule assumes, under it where it is dry, over it where zones overlap
 *   uniformity  the lower-quarter distribution uniformity of that coverage over the lawn (the auditors' DUlq:
 *               the driest quarter's mean over the whole's)
 *
 * Pure. heads: [{ zone, at [lng, lat], gpm, radiusM, arc (deg; null for a strip), dir (deg from north),
 * strip: { type, widthM, lengthM } | null, profile: 'rotor' | 'rotor-la' | 'rotary' | 'spray-he' | 'spray' | 'impact' }].
 */

import { enu } from './heads.js';

/**
 * RADIAL PROFILES (lib/hydraulics/profiles.json; how each kind of head spreads its water with distance): rel at
 * rho = r / R, its area-weighted mean 1, so the water over the sector is the head's flow whatever the shape.
 *   rotor            gear rotors: the mean of CIT's zero-wind tests (Hunter I-20, PGJ, Rain Bird 5000, Toro T5)
 *   rotor-la         low-angle rotor nozzles (Toro T5 LA)
 *   rotary           multi-stream rotary nozzles (Toro PRN, Hunter MP Rotator)
 *   spray-he         high-efficiency sprays (Toro Precision, Rain Bird HE-VAN), wetting to 1.3 R
 *   spray            conventional fixed sprays: NO measured profile was found; an ASSUMED wedge with a dry
 *                    ring about 2 ft round the head (a Rain Bird patent's description), built for each radius
 *   impact           CIT's farm impact heads, standing in for residential ones
 * Before the file loads, a flat profile to 0.7 R falling to the edge (an estimate). The near-head spike of a
 * measured profile rests on one catch can: clamped at NEAR_CLAMP, the profile renormalized.
 */
export const NEAR_CLAMP = 3;
const FALLBACK = [[0, 1], [0.7, 1], [1, 0.15]];
let TYPICAL = { rotor: FALLBACK, 'rotor-la': FALLBACK, rotary: FALLBACK, 'spray-he': FALLBACK, impact: FALLBACK };
let measured = false;
const fromRel = (rel, rhoMax = 1) => rel.map((v, k) => [(k * rhoMax) / (rel.length - 1), Math.min(NEAR_CLAMP, v)]);
/** Read lib/hydraulics/profiles.json. */
export function setProfiles(json) {
  const t = json?.typical;
  if (!t) return;
  const pick = (k) => (t[k]?.rel ? fromRel(t[k].rel, t[k].rhoMax || 1) : null);
  TYPICAL = { rotor: pick('rotor') || TYPICAL.rotor, 'rotor-la': pick('rotor-low-angle') || pick('rotor') || TYPICAL['rotor-la'], rotary: pick('rotary-nozzle') || TYPICAL.rotary, 'spray-he': pick('spray-high-efficiency') || TYPICAL['spray-he'], impact: pick('impact') || TYPICAL.impact };
  measured = true;
}
export const profilesMeasured = () => measured;

/** The conventional spray's assumed wedge for a throw of `radiusFt` (profiles.json sprayTraditionalAssumed):
    g = 0.1 + 0.9 rho / rho0 inside rho0 = 2 ft / R, then (1 - rho) / (1 - rho0) to the edge. */
export function sprayProfile(radiusFt) {
  const rho0 = Math.min(0.5, 2 / Math.max(4, radiusFt));
  const pts = [];
  for (let k = 0; k <= 20; k++) { const rho = k / 20; pts.push([rho, rho < rho0 ? 0.1 + (0.9 * rho) / rho0 : (1 - rho) / (1 - rho0)]); }
  return pts;
}

/** The profile a head's water follows: its kind's, or a conventional spray's for its throw; a rotor or impact
    shortened by its screw (h.cut < 1) with the water it no longer throws piled up past the first few metres. */
export function profileFor(h) {
  if (h._pts) return h._pts;
  if (h.profile === 'spray' || !h.profile) return measured ? sprayProfile(h.radiusM * 3.2808) : FALLBACK;
  const base = TYPICAL[h.profile] || FALLBACK;
  return h.cut < 1 && /^rotor|^impact/.test(h.profile) ? screwedProfile(base, h.cut, h.radiusM / h.cut) : base;
}

/**
 * A rotor's or impact head's spread with its radius screw in (Hunter, Irrigation Notes "Reduced Sprinkler
 * Radius", LIT-085: a PGP cut from 42 to 30 ft laid "minimal increase ... within 10 feet of the head. But in
 * the area 10 feet to 20 feet from the head, the application rate has doubled"). Over the shortened throw
 * (rho 0-1 of it): the full spread at rho k, raised past INNER_M (or a third of the throw) by 1/k^2, which at
 * k = 0.71 is that doubling; the total still adds up to the head's flow (rateAt normalises). One test: an
 * estimate.
 */
export const INNER_M = 3;
export function screwedProfile(base, k, fullRadiusM) {
  const rIn = Math.min(1 / 3, INNER_M / Math.max(1e-6, fullRadiusM)), m = 1 / (k * k), top = base[base.length - 1][0];
  const pts = [];
  for (let j = 0; j <= 40; j++) { const rho = j / 40, rf = rho * k; pts.push([rho, rf > top ? 0 : profileAt(base, rf) * (rf > rIn ? m : 1)]); }
  return pts;
}

/** A profile's value at rho (linear between its points, 0 past the throw). */
export function profileAt(points, rho) {
  if (rho < 0 || rho > points[points.length - 1][0]) return 0;
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
  const top = points[points.length - 1][0];
  for (let k = 0; k < n; k++) { const rho = ((k + 0.5) / n) * top; s += profileAt(points, rho) * rho; }
  return (2 * s * top) / n;
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
  const r = Math.hypot(e, n), pts = profileFor(h), top = pts[pts.length - 1][0];
  if (r > h.radiusM * top || !(h.radiusM > 0)) return 0;
  if (h.arc < 359) {
    const bearing = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
    let off = Math.abs(bearing - h.dir) % 360; if (off > 180) off = 360 - off;
    if (off > h.arc / 2) return 0;
  }
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
    if (!h.strip) h._pts = profileFor(h);
    if (!byZone.has(h.zone)) byZone.set(h.zone, new Float32Array(N));
    const out = byZone.get(h.zone), reach = h.strip ? Math.max(h.strip.lengthM, h.strip.widthM) : h.radiusM * profileFor(h).at(-1)[0];
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
