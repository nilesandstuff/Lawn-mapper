/**
 * THE MINI MAP AND THE ARROWS ON THE AR SCREEN (core session, 2026-11-03; the owner: "add a mini map on the ar screen
 * for finding reference and check points... the mini map should be zoom able and pan able. And the initial view
 * should contain all reference and check points, then auto zoom in once there's a lock. Once there's a lock, show a
 * small arrow pointing to the Cx and Rx points when they're not in frame.")
 *
 * Pure: the view sums and the arrows' places; scan/public/app.js draws them. A view is { cx, cy, mpp } -- the map
 * point (local metres, east and north) at the canvas centre, and metres per canvas pixel; canvas y runs down.
 */

export const FOLLOW_SPAN_M = 30;   // what the canvas's shorter side shows once there is a lock
export const MIN_MPP = 0.02, MAX_MPP = 5;

/** A view holding every point given, with `pad` pixels to spare; a span of at least 20 m. */
export function viewToFit(pts, w, h, pad = 18) {
  if (!pts.length) return { cx: 0, cy: 0, mpp: 40 / Math.min(w, h) };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const sx = Math.max(20, x1 - x0), sy = Math.max(20, y1 - y0);
  const mpp = Math.max(sx / Math.max(1, w - 2 * pad), sy / Math.max(1, h - 2 * pad));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, mpp: clampMpp(mpp) };
}
/** A view on the phone, FOLLOW_SPAN_M across the shorter side, and always closer than `fit` (the view of every
 *  point) when one is given, so a lock zooms in on a small yard too. */
export const followView = (me, w, h, fit = null) => ({ cx: me[0], cy: me[1], mpp: Math.min(FOLLOW_SPAN_M / Math.min(w, h), fit ? fit.mpp * 0.6 : Infinity) });

const clampMpp = (m) => Math.min(MAX_MPP, Math.max(MIN_MPP, m));
export const toScreen = (v, [x, y], w, h) => [w / 2 + (x - v.cx) / v.mpp, h / 2 - (y - v.cy) / v.mpp];
export const fromScreen = (v, [sx, sy], w, h) => [v.cx + (sx - w / 2) * v.mpp, v.cy - (sy - h / 2) * v.mpp];
/** Zoomed by f (2: twice as close) about a canvas point, which stays where it is. */
export function zoomAt(v, f, at, w, h) {
  const before = fromScreen(v, at, w, h), mpp = clampMpp(v.mpp / f);
  const n = { ...v, mpp };
  const after = fromScreen(n, at, w, h);
  return { cx: n.cx + before[0] - after[0], cy: n.cy + before[1] - after[1], mpp };
}
/** Dragged by (dx, dy) canvas pixels: the map moves with the finger. */
export const pan = (v, dx, dy) => ({ ...v, cx: v.cx - dx * v.mpp, cy: v.cy + dy * v.mpp });

/**
 * Where an arrow goes for a point in the session's frame: null when the point is in the camera's picture, else
 * { x, y, angle } in viewport pixels, `inset` in from the edge, pointing (angle, radians, 0 = right, clockwise) the
 * way to turn. view: the world-to-view matrix, proj: the projection (column-major, as WebXR gives them).
 */
export function edgeArrow(p, view, proj, vw, vh, inset = 28) {
  const m = (M, x, y, z, w) => [M[0] * x + M[4] * y + M[8] * z + M[12] * w, M[1] * x + M[5] * y + M[9] * z + M[13] * w, M[2] * x + M[6] * y + M[10] * z + M[14] * w, M[3] * x + M[7] * y + M[11] * z + M[15] * w];
  const e = m(view, p.x, p.y, p.z, 1), c = m(proj, e[0], e[1], e[2], e[3]);
  const behind = c[3] <= 1e-6;
  let nx = c[0] / Math.abs(c[3] || 1e-6), ny = c[1] / Math.abs(c[3] || 1e-6);
  if (!behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1) return null;
  // behind the camera: divided by |w|, the side is already the side to turn to; straight behind, point down
  if (behind && Math.abs(nx) < 1e-6 && Math.abs(ny) < 1e-6) ny = -1;
  // from the centre towards it, on screen (y down), out to the inset rectangle
  const dx = nx * (vw / 2), dy = -ny * (vh / 2);
  const hw = vw / 2 - inset, hh = vh / 2 - inset;
  const s = Math.min(hw / Math.max(1e-6, Math.abs(dx)), hh / Math.max(1e-6, Math.abs(dy)));
  return { x: vw / 2 + dx * s, y: vh / 2 + dy * s, angle: Math.atan2(dy, dx) };
}
