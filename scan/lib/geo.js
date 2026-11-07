/**
 * ARCORE'S GEOSPATIAL POSE ON THE MAP (core session, 2026-11-07; the owner: "If it's accurate, use it live. Or atleast
 * use it to narrow the fix from other sources").
 *
 * The Android app (bridge 1) sends, about once a second while Earth is tracking, the camera's latitude, longitude and
 * East-Up-South orientation with ARCore's own accuracies (hacc metres, yawAcc degrees), in the same frame as the
 * session's pose. One such reading is a whole placement: where the phone stands on the map AND which way the session's
 * axes point, so it gives the turn GPS never could.
 *
 *   geoReading(geo, pose, origin)  -> { at: [e, n], phone: [u, v], theta, hacc, yawAcc } in the map's local metres
 *   geoT(r)                        -> the transform it implies (align.js apply: session [u, v] -> map [e, n])
 *   geoPrior(r, now)               -> where the next lidar search starts, by how sure ARCore says it is
 *   geoFit(r, now)                 -> the placement to draw with when ARCore is sure enough to use it alone
 *
 * ARCore's accuracies are its own estimates (about 68% confidence), not yet measured here: SCAN-PLAN says what the
 * walks found. Without Street View coverage Earth falls back to GPS and the compass and says so through larger
 * accuracies; those readings still narrow the search, by place only.
 */
import { toLocal } from './frames.js';

/** Sure enough to draw with, before any lidar fix: within GEO_FIT_M and GEO_FIT_DEG (ARCore's own figures). */
export const GEO_FIT_M = 2;
export const GEO_FIT_DEG = 5;
/** Sure enough to give the search its turn as well as its place. */
export const GEO_TURN_M = 5;
export const GEO_TURN_DEG = 12;
/** Worse than this is no better than nothing (GPS's own floor is about this). */
export const GEO_PLACE_M = 20;
/** A reading older than this says nothing about now (the session drifts as it walks). */
export const GEO_FRESH_MS = 10000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Rotate v by the unit quaternion q ({x, y, z, w}). */
export function rotate(q, [x, y, z]) {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}
const mul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const conj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

/**
 * One reading on the map. geo: the app's { state, lat, lng, hacc, yawAcc, eus: [x, y, z, w] }; pose: the session's
 * { position, quaternion } for the same frame; origin: the map's [lng, lat]. -> null when the reading is not whole.
 *
 * Both orientations describe the same camera, so eus * conj(session) turns the session's axes into East-Up-South;
 * both frames are right-handed with y up, so that is a turn about up alone, read off the session's x axis.
 * Session [u, v] = [x, -z]; map [e, n] = [E, -S].
 */
export function geoReading(geo, pose, origin) {
  if (!geo || !pose?.position || !pose?.quaternion || !origin) return null;
  if (![geo.lat, geo.lng, geo.hacc].every(Number.isFinite) || !Array.isArray(geo.eus) || geo.eus.length !== 4) return null;
  const [ex, ey, ez, ew] = geo.eus.map(Number);
  if (![ex, ey, ez, ew].every(Number.isFinite)) return null;
  const R = mul({ x: ex, y: ey, z: ez, w: ew }, conj(pose.quaternion));
  const [E, , S] = rotate(R, [1, 0, 0]);
  if (Math.hypot(E, S) < 1e-6) return null;
  const p = pose.position;
  return {
    at: toLocal(origin, [geo.lng, geo.lat]),
    phone: [p.x, -p.z],
    theta: Math.atan2(-S, E),
    hacc: +geo.hacc,
    yawAcc: Number.isFinite(geo.yawAcc) ? +geo.yawAcc : 180,
    t: geo.t ?? null,
  };
}

/** The transform one reading implies: session [u, v] -> map [e, n]. */
export function geoT(r) {
  const c = Math.cos(r.theta), s = Math.sin(r.theta);
  return { theta: r.theta, tx: r.at[0] - (c * r.phone[0] - s * r.phone[1]), ty: r.at[1] - (s * r.phone[0] + c * r.phone[1]), s: 1 };
}

const fresh = (r, now) => r && Number.isFinite(r.t) && now - r.t < GEO_FRESH_MS;

/**
 * Where the next lidar search starts from Street View, or null: its whole placement searched round as widely as
 * ARCore's accuracies say (when it is sure of the turn), else its place alone, any turn (as GPS).
 */
export function geoPrior(r, now = Date.now()) {
  if (!fresh(r, now) || !(r.hacc <= GEO_PLACE_M)) return null;
  if (r.hacc <= GEO_TURN_M && r.yawAcc <= GEO_TURN_DEG) {
    return { T: geoT(r), searchM: clamp(2 * r.hacc, 1.5, 6), searchDeg: clamp(2 * r.yawAcc, 6, 25), from: 'Street View' };
  }
  return { at: r.at, phone: r.phone, radiusM: clamp(1.5 * r.hacc, 4, 20), from: 'Street View (place only)' };
}

/** The placement to draw with when there is no lidar fix and no references, if ARCore is sure enough; else null. */
export function geoFit(r, now = Date.now()) {
  if (!fresh(r, now) || !(r.hacc <= GEO_FIT_M) || !(r.yawAcc <= GEO_FIT_DEG)) return null;
  return geoT(r);
}
