/**
 * Pushing a boundary edge outward without losing its bearing.
 *
 * Recorded parcel lines often stop short of the road: the right-of-way
 * easement belongs to the road authority, but the homeowner mows right up to
 * the kerb. So the lawn is genuinely bigger than the parcel, along one edge.
 *
 * Dragging those two corners by hand loses the one thing the county record is
 * actually good for -- the direction of the line. A frontage that is truly
 * parallel to the street ends up slightly skewed, and every later
 * measurement inherits that. So instead of moving corners, this moves the
 * *edge*: it slides out along its own normal, staying exactly parallel, and
 * the two corners slide along the neighbouring edges to meet it. Every edge
 * in the polygon keeps the bearing the survey gave it; only the two adjacent
 * edges change length.
 *
 * All geometry happens in a local metres frame and returns to WGS84 lng/lat,
 * because that is the only thing area.js will accept.
 */

const R = 6378137; // WGS84 semi-major axis
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/**
 * A local flat frame centred on `origin`.
 *
 * Equirectangular about the origin: at parcel scale (a few hundred metres)
 * the error is millimetres, and unlike Web Mercator it does not distort
 * distance with latitude -- which matters, because the whole point here is
 * moving an edge by a stated number of feet.
 */
export function makeFrame([lng0, lat0]) {
  const k = Math.cos(toRad(lat0));
  return {
    toXY: ([lng, lat]) => [toRad(lng - lng0) * R * k, toRad(lat - lat0) * R],
    toLngLat: ([x, y]) => [lng0 + toDeg(x / (R * k)), lat0 + toDeg(y / R)],
  };
}

/** Drop a ring's repeated closing vertex, if present. */
export function openRing(ring) {
  if (ring.length < 2) return ring.slice();
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring.slice(0, -1) : ring.slice();
}

const closeRing = (pts) => [...pts, pts[0]];

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
const scale = (p, s) => [p[0] * s, p[1] * s];
const cross = (p, q) => p[0] * q[1] - p[1] * q[0];

function normalise(v) {
  const len = Math.hypot(v[0], v[1]);
  return len < 1e-12 ? null : [v[0] / len, v[1] / len];
}

/** Where two infinite lines meet, or null if they are (near) parallel. */
function intersect(p1, d1, p2, d2) {
  const denom = cross(d1, d2);
  // Near-parallel: the intersection shoots off to infinity and is useless.
  if (Math.abs(denom) < 1e-9) return null;
  const t = cross(sub(p2, p1), d2) / denom;
  return add(p1, scale(d1, t));
}

/** Perpendicular distance from p to segment ab, and the closest point on it. */
function distanceToSegment(p, a, b) {
  const ab = sub(b, a);
  const len2 = ab[0] ** 2 + ab[1] ** 2;
  if (len2 < 1e-12) return Math.hypot(...sub(p, a));
  let t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(...sub(p, add(a, scale(ab, t))));
}

/**
 * Which edge of a ring a point is nearest to.
 * Returns { index, distanceM } — the index is the edge from vertex i to i+1.
 */
export function nearestEdge(ring, point) {
  const verts = openRing(ring);
  if (verts.length < 2) return null;

  const frame = makeFrame(verts[0]);
  const xy = verts.map(frame.toXY);
  const p = frame.toXY(point);

  let best = { index: 0, distanceM: Infinity };
  for (let i = 0; i < xy.length; i++) {
    const d = distanceToSegment(p, xy[i], xy[(i + 1) % xy.length]);
    if (d < best.distanceM) best = { index: i, distanceM: d };
  }
  return best;
}

/** Length of one edge, in metres. */
export function edgeLength(ring, index) {
  const verts = openRing(ring);
  if (verts.length < 2) return 0;
  const frame = makeFrame(verts[0]);
  const a = frame.toXY(verts[index % verts.length]);
  const b = frame.toXY(verts[(index + 1) % verts.length]);
  return Math.hypot(...sub(b, a));
}

/** The midpoint of one edge, in lng/lat — where to hang a UI handle. */
export function edgeMidpoint(ring, index) {
  const verts = openRing(ring);
  const a = verts[index % verts.length];
  const b = verts[(index + 1) % verts.length];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Slide edge `index` outward by `metres`, keeping it parallel to itself.
 *
 * Negative distances pull the edge inward, which is the same operation and is
 * how the user backs off an overshoot.
 *
 * Returns a new closed ring. The two vertices at either end of the edge move;
 * every other vertex, and every other edge's bearing, is untouched.
 */
export function offsetEdge(ring, index, metres) {
  const verts = openRing(ring);
  const n = verts.length;
  if (n < 3 || !Number.isFinite(metres)) return closeRing(verts);

  const i = ((index % n) + n) % n;
  const frame = makeFrame(verts[0]);
  const xy = verts.map(frame.toXY);

  const a = xy[i];
  const b = xy[(i + 1) % n];
  const dir = normalise(sub(b, a));
  if (!dir) return closeRing(verts); // degenerate edge

  // Outward normal. For a counter-clockwise ring the outward side of an edge
  // running a->b is (dy, -dx); clockwise rings flip it.
  const ccw = signedArea(xy) > 0;
  const normal = ccw ? [dir[1], -dir[0]] : [-dir[1], dir[0]];

  const shifted = add(a, scale(normal, metres));

  // The neighbouring edges, as infinite lines. The moved corners slide along
  // these, which is what keeps their bearings intact.
  const prev = xy[(i - 1 + n) % n];
  const next = xy[(i + 2) % n];
  const prevDir = normalise(sub(a, prev));
  const nextDir = normalise(sub(next, b));

  // If a neighbour is parallel to this edge there is no meeting point; the
  // honest fallback is to translate that corner with the edge.
  const newA = (prevDir && intersect(shifted, dir, prev, prevDir)) || add(a, scale(normal, metres));
  const newB = (nextDir && intersect(shifted, dir, next, nextDir)) || add(b, scale(normal, metres));

  const out = xy.slice();
  out[i] = newA;
  out[(i + 1) % n] = newB;

  return closeRing(out.map(frame.toLngLat));
}

/** Compass bearing of an edge, in degrees from north. For display and tests. */
export function edgeBearing(ring, index) {
  const verts = openRing(ring);
  const n = verts.length;
  const frame = makeFrame(verts[0]);
  const a = frame.toXY(verts[index % n]);
  const b = frame.toXY(verts[(index + 1) % n]);
  const [dx, dy] = sub(b, a);
  return (toDeg(Math.atan2(dx, dy)) + 360) % 360;
}

export const FEET_PER_METRE = 3.280839895;
export const feetToMetres = (ft) => ft / FEET_PER_METRE;
export const metresToFeet = (m) => m * FEET_PER_METRE;
