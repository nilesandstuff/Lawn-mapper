/**
 * LINING THE SESSION UP WITH THE MAP FROM REFERENCE POINTS (core session, docs/SCAN-PLAN.md 3.2).
 *
 * CARRIED FROM THE WATER SESSION'S water/lib/ar-align.js (FINDINGS H64-H66), with their agreement: fitRigid (Kabsch in
 * 2D), apply, and the walk weighting (a mark made far back in the walk says less about now). Their edge marks, mixed
 * fit and drift fit stay in their file for now; this tool's second line of defence is the lidar match
 * (scan/lib/lidar.js), not more kinds of mark.
 *
 * A reference is a spot on the ground the owner can find on the photo and aim at: a driveway, sidewalk or patio
 * corner first (the lidar and the photo see the ground there), a fence post or shed corner next, a house corner last
 * (its roof may overhang the wall). Marked in AR, it pairs the session's level position [u, v] with the map's [e, n].
 * Two or more such pairs give the turn and shift (and report the scale as a check, without using it).
 */

/** AR (u, v) -> map (e, n), with the fit's scale (T.s, 1 when it has none). */
export function apply(T, [u, v]) {
  const k = T.s ?? 1, c = Math.cos(T.theta) * k, s = Math.sin(T.theta) * k;
  return [c * u - s * v + T.tx, s * u + c * v + T.ty];
}

/** map (e, n) -> AR (u, v): the inverse, for drawing map things in the session. */
export function unapply(T, [e, n]) {
  const k = T.s ?? 1, c = Math.cos(T.theta), s = Math.sin(T.theta);
  const a = (e - T.tx) / k, b = (n - T.ty) / k;
  return [c * a + s * b, -s * a + c * b];
}

/**
 * pairs: [{ ar: [u, v], map: [e, n], w? }] (at least 2 apart; w a weight, 1 if left out). -> { theta (radians, AR to
 * map), tx, ty, s: 1, scale (the spreads' ratio: 1 if AR and the map agree on distance), residuals, rms, n } or null.
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
  const T = { theta, tx, ty, s: 1, scale: Math.sqrt(sb / sa) };
  T.residuals = pairs.map(({ ar, map }) => { const [e, nn] = apply(T, ar); return Math.hypot(e - map[0], nn - map[1]); });
  T.rms = Math.sqrt(pairs.reduce((a, p, i) => a + wOf(p) * T.residuals[i] ** 2, 0) / W);
  T.n = n;
  return T;
}

/**
 * THE PHONE'S DRIFT: a mark made far back in the walk says less about now. 1 / (1 + (d / L)^4): a mark five times
 * farther in the walk counts a six-hundredth as much. L is the water session's 12 m (H66), to be re-measured here.
 */
export const DRIFT_L = 12;
export const walkWeight = (d, L = DRIFT_L) => 1 / (1 + (Math.abs(d) / L) ** 4);

/** The fit for the moment the phone had walked `odo` metres: marks [{ ar: [u, v], map, odo }], two different places at least. */
export function fitAt(marks, odo, L = DRIFT_L) {
  const places = new Set(marks.map((m) => `${m.map[0].toFixed(2)},${m.map[1].toFixed(2)}`));
  if (places.size < 2) return null;
  return fitRigid(marks.map((m) => ({ ar: m.ar, map: m.map, w: walkWeight(odo - m.odo, L) })));
}

/**
 * How far a reference lands from its place when the OTHER marks line the session up: the sign of a reference placed
 * wrong on the photo (or aimed wrong). marks as fitAt's, each with an id; -> metres, or null with too few others.
 */
export function leftOut(marks, id) {
  const mine = marks.filter((m) => m.id === id), others = marks.filter((m) => m.id !== id);
  if (!mine.length || !others.length) return null;
  const last = mine[mine.length - 1];
  const T = fitAt(others, last.odo);
  if (!T) return null;
  const [e, n] = apply(T, last.ar);
  return Math.hypot(e - last.map[0], n - last.map[1]);
}

/**
 * The column-major 4x4 that takes a map point (e, z, n) -- east, height, north -- into the session frame (x, y, z)
 * under the fit T, with dy added to heights (the session's ground height minus the lidar's there). For drawing the
 * lidar in the camera view: one matrix, a static mesh. The level part is unapply().
 */
export function mapToSession(T, dy = 0) {
  const k = T.s ?? 1, c = Math.cos(T.theta), s = Math.sin(T.theta);
  return new Float32Array([
    c / k, 0, s / k, 0,
    0, 1, 0, 0,
    s / k, 0, -c / k, 0,
    -(c * T.tx + s * T.ty) / k, dy, -(s * T.tx - c * T.ty) / k, 1,
  ]);
}
