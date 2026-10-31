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
 * phone walked between it and the moment in question (before or after): 1 / (1 + (d / L)^4), L metres -- steep, so
 * a mark five times farther in the walk counts a six-hundredth as much (the drift is a slide: old marks are biased, not
 * merely noisy).
 */
export const DRIFT_L = 12;
export const walkWeight = (d, L = DRIFT_L) => 1 / (1 + (Math.abs(d) / L) ** 4);

/** The fit for the moment the phone had walked `odo` metres: marks [{ ar: [u, v], map, odo }]. */
export function fitAt(marks, odo, L = DRIFT_L) {
  return fitRigid(marks.map((m) => ({ ar: m.ar, map: m.map, w: walkWeight(odo - m.odo, L) })));
}

/** AR (u, v) -> map (e, n), with the fit's scale (T.s, 1 when it has none). */
export function apply(T, [u, v]) {
  const k = T.s ?? 1, c = Math.cos(T.theta) * k, s = Math.sin(T.theta) * k;
  return [c * u - s * v + T.tx, s * u + c * v + T.ty];
}

/**
 * POINTS AND EDGES TOGETHER, WITH OR WITHOUT A SCALE (owner, 2026-10-31: "build the edge references"; the second walk:
 * AR measured 3.6% short of the photo, the first 4.4%, every reference about equally off -- H66).
 *
 * cons: [{ kind: 'pt', ar: [u, v], map: [e, n], w? } | { kind: 'edge', ar: [u, v], a: [e, n], b: [e, n], w? }]
 * A point must land on its place; an edge mark anywhere on the line through a and b (a driveway's or sidewalk's edge
 * marked at any spot along it). opts.scale: 'fit' to fit AR's scale as well, or a number to hold it at (1: none).
 * Weighted Gauss-Newton on (turn, shift, log scale), started from the points' own fit. -> T (apply-able, with s, the
 * residuals per constraint and rms) or null without two separate points.
 */
export function fitMixed(cons, { scale = 1 } = {}) {
  const wOf = (c) => (Number.isFinite(c.w) && c.w > 0 ? c.w : 1);
  const pts = cons.filter((c) => c.kind !== 'edge');
  const k0 = scale === 'fit' ? 1 : scale;
  const start = fitRigid(pts.map((c) => ({ ar: [c.ar[0] * k0, c.ar[1] * k0], map: c.map, w: wOf(c) })));
  if (!start) return null;
  const edges = cons.filter((c) => c.kind === 'edge').map((c) => {
    const dx = c.b[0] - c.a[0], dy = c.b[1] - c.a[1], L = Math.hypot(dx, dy) || 1;
    return { ...c, n: [-dy / L, dx / L] };
  });
  const fitS = scale === 'fit';
  let th = start.theta, tx = start.tx, ty = start.ty, ls = Math.log(k0);
  const np = fitS ? 4 : 3;
  if (edges.length || fitS) {
    for (let it = 0; it < 30; it++) {
      const H = Array.from({ length: np }, () => new Array(np).fill(0)), g = new Array(np).fill(0);
      const c = Math.cos(th), sn = Math.sin(th), k = Math.exp(ls);
      const add = (J, r, w) => { for (let i = 0; i < np; i++) { g[i] += w * J[i] * r; for (let j = 0; j < np; j++) H[i][j] += w * J[i] * J[j]; } };
      const terms = (u, v) => ({ q: [k * (c * u - sn * v) + tx, k * (sn * u + c * v) + ty], dth: [k * (-sn * u - c * v), k * (c * u - sn * v)], dls: [k * (c * u - sn * v), k * (sn * u + c * v)] });
      for (const p of pts) {
        const { q, dth, dls } = terms(p.ar[0], p.ar[1]), w = wOf(p);
        add(fitS ? [dth[0], 1, 0, dls[0]] : [dth[0], 1, 0], q[0] - p.map[0], w);
        add(fitS ? [dth[1], 0, 1, dls[1]] : [dth[1], 0, 1], q[1] - p.map[1], w);
      }
      for (const e of edges) {
        const { q, dth, dls } = terms(e.ar[0], e.ar[1]), w = wOf(e), [nx, ny] = e.n;
        const J = [nx * dth[0] + ny * dth[1], nx, ny]; if (fitS) J.push(nx * dls[0] + ny * dls[1]);
        add(J, nx * (q[0] - e.a[0]) + ny * (q[1] - e.a[1]), w);
      }
      for (let i = 0; i < np; i++) H[i][i] += 1e-9 * (H[i][i] + 1);
      const d = solve(H, g.map((x) => -x));
      if (!d) break;
      th += d[0]; tx += d[1]; ty += d[2]; if (fitS) ls += d[3];
      if (Math.hypot(...d) < 1e-10) break;
    }
  }
  const T = { theta: th, tx, ty, s: Math.exp(ls), scale: start.scale * (scale === 'fit' ? 1 : k0) };
  T.residuals = cons.map((con) => {
    const q = apply(T, con.ar);
    if (con.kind !== 'edge') return Math.hypot(q[0] - con.map[0], q[1] - con.map[1]);
    return edgeOff(con, q);
  });
  const W = cons.reduce((a, c) => a + wOf(c), 0);
  T.rms = Math.sqrt(cons.reduce((a, c, i) => a + wOf(c) * T.residuals[i] ** 2, 0) / W);
  return T;
}

/**
 * THIS PHONE'S AR SCALE, MEASURED WHERE DRIFT IS SMALL (H66). Fitting a scale in the alignment itself soaks up drift
 * (a reference marked after a long walk pulls it), so the scale is measured only between two references marked one
 * soon after the other: the walk between them nearly straight (no more than 1.5 times their distance plus 5 m), and at
 * least 8 m apart. marks: [{ ar: [u, v], map: [e, n], odo, id }] -> { k: photo distance / AR distance (median), n } or null.
 */
export function pairScale(marks, { minM = 8 } = {}) {
  const ks = [];
  for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) {
    const a = marks[i], b = marks[j];
    if (a.id === b.id) continue;
    const dm = Math.hypot(a.map[0] - b.map[0], a.map[1] - b.map[1]), da = Math.hypot(a.ar[0] - b.ar[0], a.ar[1] - b.ar[1]);
    if (dm < minM || da < 1e-6 || Math.abs(a.odo - b.odo) > 1.5 * dm + 5) continue;
    ks.push(dm / da);
  }
  if (!ks.length) return null;
  ks.sort((x, y) => x - y);
  const k = ks.length % 2 ? ks[ks.length >> 1] : (ks[ks.length / 2 - 1] + ks[ks.length / 2]) / 2;
  return { k, n: ks.length };
}

/**
 * THE TURN FROM PAIRS, THE SHIFT FROM WHAT IS NEAR (H66). ARCore's drift is mostly a slide; read as one rigid fit, a
 * reference marked after a slide looks like a turn of the whole lawn, and heads far from it swing feet off. So:
 *   the turn comes from pairs of marks made one soon after the other (two references, or one edge marked twice a few
 *   steps apart), where a slide cannot reach: each pair votes with the square of its length, weighted by how far in
 *   the walk it lies from the moment (Lrot, longer than L: the turn drifts slower than the position);
 *   the shift comes from every point and edge mark, weighted by its walk from the moment (L), the turn and scale held.
 * Without any such pair the turn is the plain weighted fit's (fitMixedAt). cons as fitMixed, each with odo and id.
 */
export function fitDrift(cons, odo, { L = DRIFT_L, Lrot = 40, scale = 1 } = {}) {
  const k = scale === 'fit' ? 1 : scale;
  const base = (c) => (Number.isFinite(c.w) && c.w > 0 ? c.w : 1);
  const pts = cons.filter((c) => c.kind !== 'edge'), edges = cons.filter((c) => c.kind === 'edge');
  const fallback = fitMixedAt(cons, odo, { L, scale: k });
  if (!fallback) return null;
  const near = (a, b, d) => Math.abs(a.odo - b.odo) <= 1.5 * d + 5;
  let sx = 0, sy = 0;
  const vote = (phi, w) => { sx += w * Math.cos(phi); sy += w * Math.sin(phi); };
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const a = pts[i], b = pts[j];
    if (a.id === b.id) continue;
    const dm = Math.hypot(b.map[0] - a.map[0], b.map[1] - a.map[1]), da = Math.hypot(b.ar[0] - a.ar[0], b.ar[1] - a.ar[1]);
    if (dm < 5 || da < 1e-6 || !near(a, b, dm)) continue;
    const phi = Math.atan2(b.map[1] - a.map[1], b.map[0] - a.map[0]) - Math.atan2(b.ar[1] - a.ar[1], b.ar[0] - a.ar[0]);
    vote(phi, dm * dm * base(a) * base(b) * walkWeight(odo - (a.odo + b.odo) / 2, Lrot));
  }
  const th0 = sx || sy ? Math.atan2(sy, sx) : fallback.theta;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    if (a.id !== b.id) continue;
    const da = Math.hypot(b.ar[0] - a.ar[0], b.ar[1] - a.ar[1]);
    if (da < 3 || !near(a, b, da)) continue;
    // the edge runs one way or the other: the turn nearer the one already found
    let phi = Math.atan2(a.b[1] - a.a[1], a.b[0] - a.a[0]) - Math.atan2(b.ar[1] - a.ar[1], b.ar[0] - a.ar[0]);
    const dd = Math.atan2(Math.sin(phi - th0), Math.cos(phi - th0));
    if (Math.abs(dd) > Math.PI / 2) phi += Math.PI;
    vote(phi, da * da * base(a) * walkWeight(odo - (a.odo + b.odo) / 2, Lrot));
  }
  const fromPairs = !!(sx || sy);
  const theta = fromPairs ? Math.atan2(sy, sx) : fallback.theta;
  // the shift: weighted least squares over points (2D) and edges (across the edge only), turn and scale held
  const c = Math.cos(theta) * k, sn = Math.sin(theta) * k, rot = ([u, v]) => [c * u - sn * v, sn * u + c * v];
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const p of pts) { const w = base(p) * walkWeight(odo - p.odo, L), q = rot(p.ar); a11 += w; a22 += w; b1 += w * (p.map[0] - q[0]); b2 += w * (p.map[1] - q[1]); }
  for (const e of edges) {
    const w = base(e) * walkWeight(odo - e.odo, L), q = rot(e.ar), dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], Ln = Math.hypot(dx, dy) || 1, nx = -dy / Ln, ny = dx / Ln;
    const r = nx * (e.a[0] - q[0]) + ny * (e.a[1] - q[1]);
    a11 += w * nx * nx; a12 += w * nx * ny; a22 += w * ny * ny; b1 += w * nx * r; b2 += w * ny * r;
  }
  const det = a11 * a22 - a12 * a12;
  if (!(Math.abs(det) > 1e-18)) return fallback;
  const T = { theta, tx: (a22 * b1 - a12 * b2) / det, ty: (a11 * b2 - a12 * b1) / det, s: k, scale: fallback.scale, turnFrom: fromPairs ? 'pairs' : 'fit' };
  T.residuals = cons.map((con) => { const q = apply(T, con.ar); return con.kind === 'edge' ? edgeOff(con, q) : Math.hypot(q[0] - con.map[0], q[1] - con.map[1]); });
  const W = cons.reduce((s2, con) => s2 + base(con), 0);
  T.rms = Math.sqrt(cons.reduce((s2, con, i) => s2 + base(con) * T.residuals[i] ** 2, 0) / W);
  return T;
}

/** How far a map point q lies from the line through an edge's a and b, metres. */
export function edgeOff(edge, q) {
  const dx = edge.b[0] - edge.a[0], dy = edge.b[1] - edge.a[1], L = Math.hypot(dx, dy) || 1;
  return Math.abs((-dy * (q[0] - edge.a[0]) + dx * (q[1] - edge.a[1])) / L);
}

/** Small linear system by elimination with pivoting; null when singular. */
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    if (Math.abs(M[p][i]) < 1e-14) return null;
    [M[i], M[p]] = [M[p], M[i]];
    for (let r = 0; r < n; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** fitMixed for the moment the phone had walked `odo` metres: each constraint carries its own odo, and its w is multiplied. */
export function fitMixedAt(cons, odo, { L = DRIFT_L, scale = 1 } = {}) {
  return fitMixed(cons.map((c) => ({ ...c, w: (Number.isFinite(c.w) ? c.w : 1) * walkWeight(odo - c.odo, L) })), { scale });
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
