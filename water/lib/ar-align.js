/**
 * LINING THE PHONE'S AR TRACKING UP WITH THE MAP (owner, 2026-10-31: "an AR tool that you walk the lawn with and point a
 * cursor at the head, tap place, and it puts a pin there"; admin test page public/ar.html; FINDINGS H64).
 *
 * The phone's AR session (WebXR on ARCore) measures where its crosshair meets the ground to a few centimetres, in a frame
 * of its own: metres, level (y up), but with its origin where the session began and its heading wherever the phone
 * pointed. Two or more points marked both on the map and in AR fix the rest: a turn and a shift on the level (the scale
 * is already true -- the fit reports it, as a check, but does not use it). Least squares (Kabsch in 2D) over every
 * marked reference, with each one's residual.
 *
 * AR's level coordinates are (x, -z): x to the right and -z ahead when the session began, seen from above that is a
 * proper turn of east/north, no mirror.
 */

const R_EARTH = 6378137;

/** [lng, lat] -> metres east and north of `origin` ([lng, lat]), on a local plane (good to millimetres across a lot). */
export function toLocal(origin, p) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return [((p[0] - origin[0]) * Math.PI / 180) * R_EARTH * k, ((p[1] - origin[1]) * Math.PI / 180) * R_EARTH];
}
export function fromLocal(origin, [e, n]) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return [origin[0] + (e / (R_EARTH * k)) * (180 / Math.PI), origin[1] + (n / R_EARTH) * (180 / Math.PI)];
}

/** An AR position {x, y, z} on the level, as (u, v). */
export const arLevel = (p) => [p.x, -p.z];

/**
 * pairs: [{ ar: [u, v], map: [e, n], w? }] (at least 2; w a weight, 1 if left out). -> { theta (radians, AR to map),
 * tx, ty, scale (the spreads' ratio: 1 if AR and the map agree on distance), residuals: [m per pair], rms (weighted) }
 * or null with fewer than 2, or all at one spot.
 */
export function fitRigid(pairs) {
  if (!pairs || pairs.length < 2) return null;
  const n = pairs.length, wOf = (p) => (Number.isFinite(p.w) && p.w > 0 ? p.w : 1);
  let W = 0, au = 0, av = 0, be = 0, bn = 0;
  for (const p of pairs) { const w = wOf(p); W += w; au += w * p.ar[0]; av += w * p.ar[1]; be += w * p.map[0]; bn += w * p.map[1]; }
  au /= W; av /= W; be /= W; bn /= W;
  let sxx = 0, sxy = 0, sa = 0, sb = 0;
  for (const p of pairs) {
    const w = wOf(p), ax = p.ar[0] - au, ay = p.ar[1] - av, bx = p.map[0] - be, by = p.map[1] - bn;
    sxx += w * (ax * bx + ay * by); sxy += w * (ax * by - ay * bx);
    sa += w * (ax * ax + ay * ay); sb += w * (bx * bx + by * by);
  }
  if (sa < 1e-6 * W || sb < 1e-6 * W) return null;
  const theta = Math.atan2(sxy, sxx), c = Math.cos(theta), s = Math.sin(theta);
  const tx = be - (c * au - s * av), ty = bn - (s * au + c * av);
  const T = { theta, tx, ty, scale: Math.sqrt(sb / sa) };
  T.residuals = pairs.map(({ ar, map }) => { const [e, nn] = apply(T, ar); return Math.hypot(e - map[0], nn - map[1]); });
  T.rms = Math.sqrt(pairs.reduce((a, p, i) => a + wOf(p) * T.residuals[i] ** 2, 0) / W);
  T.n = n;
  return T;
}

/**
 * THE PHONE'S DRIFT (owner's first walk, 2026-10-31: about right in the front yard, 20 ft off in the back, worse again
 * back in the front). ARCore's frame wanders as the phone walks and turns, so a reference marked 100 ft of walking ago
 * says less about where the phone is now than one marked a moment ago. Each reference mark is weighted by how far the
 * phone walked between it and the moment in question (before or after): 1 / (1 + (d / L)^2), L metres.
 */
export const DRIFT_L = 12;
export const walkWeight = (d, L = DRIFT_L) => 1 / (1 + (Math.abs(d) / L) ** 2);

/** The fit for the moment the phone had walked `odo` metres: marks [{ ar: [u, v], map, odo }]. */
export function fitAt(marks, odo, L = DRIFT_L) {
  return fitRigid(marks.map((m) => ({ ar: m.ar, map: m.map, w: walkWeight(odo - m.odo, L) })));
}

/** AR (u, v) -> map (e, n). */
export function apply(T, [u, v]) {
  const c = Math.cos(T.theta), s = Math.sin(T.theta);
  return [c * u - s * v + T.tx, s * u + c * v + T.ty];
}

/** The phone's heading on the map (degrees from north, clockwise) from its AR orientation quaternion {x, y, z, w}. */
export function headingOf(T, q) {
  // the camera looks along -z: that direction in AR space, flattened to the level
  const fx = -2 * (q.x * q.z + q.w * q.y), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  const [u, v] = [fx, -fz];
  const c = Math.cos(T.theta), s = Math.sin(T.theta);
  const e = c * u - s * v, n = s * u + c * v;
  return ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
}

/** How far apart two references are, metres: under about 5 m the turn is poorly fixed. */
export const baseline = (pairs) => {
  let best = 0;
  for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) best = Math.max(best, Math.hypot(pairs[i].map[0] - pairs[j].map[0], pairs[i].map[1] - pairs[j].map[1]));
  return best;
};
