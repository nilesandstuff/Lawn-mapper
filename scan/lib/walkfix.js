/**
 * THE WHOLE WALK PLACED AT ONCE, LIVE (core session, 2026-11-08; SCAN-H25: the live fix, placing the last 25 ft at a
 * time, was 24 ft off on the owner's 907 ft walk while one placement for the whole walk after it was 2.7 ft; ARCore's
 * own drift was a median 0.1-0.3 m. After the walk, the GPS / Street View trail's placement refined by the ground's
 * shape alone gave 3.0 and 3.6 ft on the two app-1.8 walks: the walk's extent is what pins it.)
 *
 *   walkPrior(gpsTrail, geoTrail)   the trail's placement (postfix.js gpsPrior), from Street View's readings when there
 *                                   are enough (each with its own accuracy), else from GPS's
 *   groundScore(dem, ground, T)     ARCore's ground points [u, v, y] against the lidar's ground under placement T: the
 *                                   share within GROUND_TOL of the median height offset (Gaussian), and that offset
 *   refineGround(dem, ground, T0)   coarse to fine round T0, the after-walk study's own steps (pavement_study.py)
 *   walkFix(dem, ground, prior)     the placement, its share, and how much better it is than the best placement a few
 *                                   metres away (a flat lot gives none: then it is not used)
 *
 * dem: { box: [e0, n0, e1, n1], cell, W, H, data: Float32Array (absolute m, NaN where none), rows from the north }.
 */
import { gpsPrior } from './postfix.js';

export const GROUND_TOL = 0.15;
export const WALK_MIN_POINTS = 300;
export const WALK_MIN_SHARE = 0.45;     // the truth had 74-81% on the owner's walks
export const WALK_MIN_MARGIN = 0.02;    // better than any placement 2 m or 5 degrees away by this share
const STEPS = [[4, 2], [2, 1], [0.5, 0.3], [0.25, 0.1]];

/** The trail's placement: Street View's readings (in map metres, with their accuracy) when 10 or more, else GPS's. */
export function walkPrior(gpsTrail = [], geoTrail = []) {
  const geo = (geoTrail || []).filter((g) => Array.isArray(g.at) && Array.isArray(g.phone) && Number.isFinite(g.hacc) && g.hacc <= 10)
    .map((g) => ({ at: g.at, phone: g.phone, acc: Math.max(1, g.hacc), odo: g.odo }));
  const p = geo.length >= 10 ? gpsPrior(geo) : null;
  if (p) return { ...p, from: p.from.replace('the GPS trail', 'the Street View trail') };
  return gpsPrior(gpsTrail);
}

function sample(dem, e, n) {
  const c = Math.floor((e - dem.box[0]) / dem.cell), r = Math.floor((dem.box[3] - n) / dem.cell);
  return c >= 0 && r >= 0 && c < dem.W && r < dem.H ? dem.data[r * dem.W + c] : NaN;
}

/** ARCore's ground points against the lidar's ground under T: { share, tz, n }. */
export function groundScore(dem, ground, T) {
  const c = Math.cos(T.theta), s = Math.sin(T.theta), dz = [];
  for (const [u, v, y] of ground) {
    const z = sample(dem, c * u - s * v + T.tx, s * u + c * v + T.ty);
    if (Number.isFinite(z)) dz.push(z - y);
  }
  if (dz.length < 50) return { share: 0, tz: null, n: dz.length };
  const sorted = dz.slice().sort((a, b) => a - b), tz = sorted[sorted.length >> 1];
  let sum = 0;
  for (const d of dz) { const x = (d - tz) / GROUND_TOL; sum += Math.exp(-0.5 * x * x); }
  return { share: sum / dz.length, tz, n: dz.length };
}

/** Coarse to fine round T0: each step tries turns of -3..3 x deg and shifts of -4..4 x m, and moves to the best. */
export function refineGround(dem, ground, T0, steps = STEPS) {
  let T = { theta: T0.theta, tx: T0.tx, ty: T0.ty, s: 1 }, best = groundScore(dem, ground, T);
  for (const [deg, m] of steps) {
    let cand = null;
    for (let a = -3; a <= 3; a++) for (let x = -4; x <= 4; x++) for (let y = -4; y <= 4; y++) {
      if (!a && !x && !y) continue;
      const C = { theta: T.theta + (a * deg * Math.PI) / 180, tx: T.tx + x * m, ty: T.ty + y * m, s: 1 };
      const sc = groundScore(dem, ground, C);
      if (sc.share > (cand ? cand.sc.share : best.share)) cand = { C, sc };
    }
    if (cand) { T = cand.C; best = cand.sc; }
  }
  return { T, ...best };
}

/** The walk's placement from the trail's: { ok, T, share, tz, margin, why }. */
export function walkFix(dem, ground, prior) {
  if (!prior?.T) return { ok: false, why: 'no trail to start from (GPS or Street View, 25 m of walking)' };
  if ((ground || []).length < WALK_MIN_POINTS) return { ok: false, why: `${(ground || []).length} ground points; ${WALK_MIN_POINTS} wanted` };
  const r = refineGround(dem, ground, prior.T);
  if (r.tz == null) return { ok: false, why: 'the ground points fall off the lidar' };
  // how distinct: the best of the placements 2-4 m or 5-10 degrees off, refined only finely
  let other = 0;
  for (const [a, x, y] of [[0, 3, 0], [0, -3, 0], [0, 0, 3], [0, 0, -3], [8, 0, 0], [-8, 0, 0]]) {
    const C = { theta: r.T.theta + (a * Math.PI) / 180, tx: r.T.tx + x, ty: r.T.ty + y };
    const q = refineGround(dem, ground, C, [[0.5, 0.2]]);
    const apart = Math.hypot(q.T.tx - r.T.tx, q.T.ty - r.T.ty) > 2 || Math.abs(q.T.theta - r.T.theta) > (5 * Math.PI) / 180;
    if (apart) other = Math.max(other, q.share);
  }
  const margin = r.share - other;
  const ok = r.share >= WALK_MIN_SHARE && margin >= WALK_MIN_MARGIN;
  return { ok, T: r.T, share: r.share, tz: r.tz, margin, n: r.n, why: ok ? null : r.share < WALK_MIN_SHARE ? `only ${Math.round(r.share * 100)}% of the ground points sit on the lidar's ground` : 'a placement a few metres off fits about as well' };
}
