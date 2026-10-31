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
 * pairs: [{ ar: [u, v], map: [e, n] }] (at least 2). -> { theta (radians, AR to map), tx, ty, scale (the spreads'
 * ratio: 1 if AR and the map agree on distance), residuals: [m per pair], rms } or null with fewer than 2 or all at
 * one spot.
 */
export function fitRigid(pairs) {
  if (!pairs || pairs.length < 2) return null;
  const n = pairs.length;
  let au = 0, av = 0, be = 0, bn = 0;
  for (const { ar, map } of pairs) { au += ar[0]; av += ar[1]; be += map[0]; bn += map[1]; }
  au /= n; av /= n; be /= n; bn /= n;
  let sxx = 0, sxy = 0, sa = 0, sb = 0;
  for (const { ar, map } of pairs) {
    const ax = ar[0] - au, ay = ar[1] - av, bx = map[0] - be, by = map[1] - bn;
    sxx += ax * bx + ay * by; sxy += ax * by - ay * bx;
    sa += ax * ax + ay * ay; sb += bx * bx + by * by;
  }
  if (sa < 1e-6 || sb < 1e-6) return null;
  const theta = Math.atan2(sxy, sxx), c = Math.cos(theta), s = Math.sin(theta);
  const tx = be - (c * au - s * av), ty = bn - (s * au + c * av);
  const T = { theta, tx, ty, scale: Math.sqrt(sb / sa) };
  T.residuals = pairs.map(({ ar, map }) => { const [e, nn] = apply(T, ar); return Math.hypot(e - map[0], nn - map[1]); });
  T.rms = Math.sqrt(T.residuals.reduce((a, r) => a + r * r, 0) / n);
  return T;
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
