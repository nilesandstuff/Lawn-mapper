/**
 * FRAMES AND MATRICES FOR THE YARD AR TOOL (core session, docs/SCAN-PLAN.md).
 *
 * Three frames meet here:
 *   - the SESSION frame: where the phone's tracking engine says it is. Metres,
 *     y up, x to the right and -z ahead of where the phone pointed when the
 *     session began. WebXR (ARCore) and 8th Wall's engine both use it.
 *   - LOCAL metres: east and north of a map's point ([lng, lat]), on a flat
 *     plane, good to millimetres across a lot.
 *   - [lng, lat] as the map record keeps everything (docs/MAPS.md).
 *
 * toLocal, fromLocal and level are the water session's (water/lib/ar-align.js,
 * FINDINGS H64), carried here with their source named. The matrix helpers are
 * for drawing: column-major 4x4, as WebGL and both engines hand them over.
 * Pure: no DOM, so Node tests it.
 */

const R_EARTH = 6378137;

/** [lng, lat] -> metres east and north of `origin` ([lng, lat]). */
export function toLocal(origin, p) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return [((p[0] - origin[0]) * Math.PI / 180) * R_EARTH * k, ((p[1] - origin[1]) * Math.PI / 180) * R_EARTH];
}
export function fromLocal(origin, [e, n]) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return [origin[0] + (e / (R_EARTH * k)) * (180 / Math.PI), origin[1] + (n / R_EARTH) * (180 / Math.PI)];
}

/** A session position {x, y, z} on the level, as [u, v]: x right, -z ahead. Seen from above, a proper turn of east/north. */
export const level = (p) => [p.x, -p.z];

export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Distance on the level between two session positions (a tape on the ground ignores height). */
export const levelDist = (a, b) => dist2(level(a), level(b));

/** The heading of a camera quaternion on the level, degrees, 0 ahead at the start, clockwise seen from above. */
export function yawOf(q) {
  // the camera looks down its -z; turn that by q and read its direction on the level
  const { x, y, z, w } = q;
  const fx = -(2 * (x * z + w * y));
  const fz = -(1 - 2 * (x * x + y * y));
  return (Math.atan2(fx, -fz) * 180) / Math.PI;
}

/** The smallest turn from heading a to heading b, degrees, -180..180. */
export const turnBetween = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

/* ------------------------------------------------------------- matrices */

/** A column-major 4x4 from a rotation quaternion and a position (the camera's pose in the session frame). */
export function matFromPose(q, p) {
  const { x, y, z, w } = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return new Float32Array([
    1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
    2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
    2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
    p.x, p.y, p.z, 1,
  ]);
}

/** The inverse of a rigid (rotation + shift) matrix: a camera pose becomes a view matrix. */
export function invertRigid(m) {
  const r = new Float32Array(16);
  // transpose the 3x3
  r[0] = m[0]; r[1] = m[4]; r[2] = m[8];
  r[4] = m[1]; r[5] = m[5]; r[6] = m[9];
  r[8] = m[2]; r[9] = m[6]; r[10] = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  r[12] = -(r[0] * tx + r[4] * ty + r[8] * tz);
  r[13] = -(r[1] * tx + r[5] * ty + r[9] * tz);
  r[14] = -(r[2] * tx + r[6] * ty + r[10] * tz);
  r[3] = 0; r[7] = 0; r[11] = 0; r[15] = 1;
  return r;
}

export function multiply(a, b) {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 4; i++) {
      r[c * 4 + i] = a[i] * b[c * 4] + a[4 + i] * b[c * 4 + 1] + a[8 + i] * b[c * 4 + 2] + a[12 + i] * b[c * 4 + 3];
    }
  }
  return r;
}

/** A point through a matrix (w divided out). */
export function transform(m, p) {
  const x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
  const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15] || 1;
  return { x: x / w, y: y / w, z: z / w };
}

/** The camera's position out of a view matrix (the inverse's shift). */
export function cameraOf(view) {
  const inv = invertRigid(view);
  return { x: inv[12], y: inv[13], z: inv[14] };
}
