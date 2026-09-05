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

/**
 * How far a corner may travel, as a multiple of the distance the edge moved.
 *
 * A corner slides along its neighbour, so it legitimately travels further
 * than the edge itself: d/sin(angle). At 45 degrees that is 1.41x, at 15
 * degrees 3.9x. Below that the neighbour is nearly parallel to the edge and
 * the meeting point races away -- on a real digitised parcel, whose outlines
 * are full of nearly-collinear vertices, that turned a 25 ft nudge on a 100
 * ft edge into an extra 294,000 sq ft of "lawn".
 *
 * Past this limit, translating the corner with the edge is the sane answer:
 * it bends one neighbour slightly instead of producing a spike.
 */
const MAX_CORNER_TRAVEL = 4;

/** Where two infinite lines meet, or null if they are (near) parallel. */
function intersect(p1, d1, p2, d2) {
  const denom = cross(d1, d2);
  // sin of the angle between two unit vectors. Below this they are parallel
  // enough that no useful intersection exists.
  if (Math.abs(denom) < 0.02) return null;
  const t = cross(sub(p2, p1), d2) / denom;
  return add(p1, scale(d1, t));
}

/** The intersection, unless it flings the corner implausibly far. */
function slideCorner(corner, newLinePoint, newLineDir, neighbour, neighbourDir, fallback, limit) {
  if (!neighbourDir) return fallback;
  const hit = intersect(newLinePoint, newLineDir, neighbour, neighbourDir);
  if (!hit) return fallback;
  return Math.hypot(...sub(hit, corner)) > limit ? fallback : hit;
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
 * How close two consecutive edges must be in direction to count as one line.
 *
 * A surveyed frontage is rarely one segment in the county's data: it is
 * digitised as a run of two or three that differ by a fraction of a degree.
 * Treating them separately is both wrong for the user -- they think of it as
 * "the edge along the road" -- and numerically hostile, because each segment
 * is then its own near-parallel neighbour.
 */
const COLLINEAR_COS = Math.cos((3 * Math.PI) / 180);

const dot = (p, q) => p[0] * q[0] + p[1] * q[1];

function edgeDir(xy, i) {
  const n = xy.length;
  return normalise(sub(xy[(i + 1) % n], xy[i % n]));
}

/**
 * The maximal run of consecutive edges pointing the same way as edge `index`.
 * Returns { start, end } as edge indices, inclusive, possibly wrapping.
 */
export function edgeRun(ring, index) {
  const verts = openRing(ring);
  const n = verts.length;
  if (n < 3) return { start: 0, end: 0, count: 1 };

  const frame = makeFrame(verts[0]);
  const xy = verts.map(frame.toXY);
  const i = ((index % n) + n) % n;
  const dir = edgeDir(xy, i);
  if (!dir) return { start: i, end: i, count: 1 };

  const aligned = (j) => {
    const d = edgeDir(xy, ((j % n) + n) % n);
    return d && dot(d, dir) > COLLINEAR_COS;
  };

  let start = i;
  let end = i;
  let count = 1;
  // Never swallow the whole ring: a circle-ish polygon would otherwise become
  // one "edge" and the operation would lose all meaning.
  while (count < n - 2 && aligned(start - 1)) { start -= 1; count += 1; }
  while (count < n - 2 && aligned(end + 1)) { end += 1; count += 1; }

  return { start: ((start % n) + n) % n, end: ((end % n) + n) % n, count };
}

/**
 * Slide the edge at `index` outward by `metres`, keeping it parallel.
 *
 * Negative distances pull it inward, which is how the user backs off an
 * overshoot.
 *
 * The whole near-collinear run containing that edge moves together: every
 * vertex in the run is translated by the same vector, so all the bearings
 * inside the run are preserved exactly, and only the two vertices at the ends
 * of the run slide along their outside neighbours. Every other vertex, and
 * every other edge's bearing, is untouched.
 */
export function offsetEdge(ring, index, metres) {
  const verts = openRing(ring);
  const n = verts.length;
  if (n < 3 || !Number.isFinite(metres)) return closeRing(verts);

  const frame = makeFrame(verts[0]);
  const xy = verts.map(frame.toXY);

  const run = edgeRun(ring, index);
  const dir = edgeDir(xy, run.start);
  if (!dir) return closeRing(verts); // degenerate edge

  // Outward normal. For a counter-clockwise ring the outward side of an edge
  // running a->b is (dy, -dx); clockwise rings flip it.
  const ccw = signedArea(xy) > 0;
  const normal = ccw ? [dir[1], -dir[0]] : [-dir[1], dir[0]];
  const shift = scale(normal, metres);

  // Vertices of the run: run.start .. run.end + 1, inclusive, wrapping.
  const idx = [];
  for (let k = 0; k <= run.count; k++) idx.push((run.start + k) % n);

  const out = xy.slice();
  for (const j of idx) out[j] = add(xy[j], shift);

  // The two ends slide along the edges just outside the run, which is what
  // keeps those neighbours' bearings intact.
  const firstV = idx[0];
  const lastV = idx[idx.length - 1];
  const beforeRun = xy[(run.start - 1 + n) % n];
  const afterRun = xy[(run.end + 2) % n];
  const prevDir = normalise(sub(xy[firstV], beforeRun));
  const nextDir = normalise(sub(afterRun, xy[lastV]));
  const limit = Math.max(Math.abs(metres) * MAX_CORNER_TRAVEL, 0.5);

  const startDir = edgeDir(xy, run.start);
  const endDir = edgeDir(xy, run.end);

  out[firstV] = slideCorner(out[firstV], out[firstV], startDir, beforeRun, prevDir, out[firstV], limit);
  out[lastV] = slideCorner(out[lastV], out[lastV], endDir, afterRun, nextDir, out[lastV], limit);

  return closeRing(out.map(frame.toLngLat));
}

/* ------------------------------------------------------- editing vertices */
/*
 * Sliding a whole edge keeps the survey's bearings, which is right for a
 * frontage that runs to the road. It is the wrong tool for a corner the county
 * digitised badly, or a run of three points a foot apart where one would do.
 * Those need the vertices themselves, so: move one, add one, remove one.
 *
 * All three take and return closed rings, so they compose with offsetEdge and
 * with everything downstream that expects a ring it can measure.
 */

/** Move one vertex to a new position. */
export function moveVertex(ring, index, lngLat) {
  const verts = openRing(ring);
  const n = verts.length;
  if (n < 3) return closeRing(verts);
  verts[((index % n) + n) % n] = [lngLat[0], lngLat[1]];
  return closeRing(verts);
}

/**
 * Insert a vertex on the edge at `index`.
 *
 * `at` is where the user tapped, which is never exactly on the line, so it is
 * projected onto the segment first. Dropping the point where they touched
 * instead would put a kink in a boundary they only meant to subdivide.
 */
export function insertVertex(ring, index, at) {
  const verts = openRing(ring);
  const n = verts.length;
  if (n < 2) return closeRing(verts);

  const i = ((index % n) + n) % n;
  const frame = makeFrame(verts[0]);
  const a = frame.toXY(verts[i]);
  const b = frame.toXY(verts[(i + 1) % n]);
  const p = frame.toXY(at);

  const ab = sub(b, a);
  const len2 = ab[0] ** 2 + ab[1] ** 2;
  let t = len2 < 1e-12 ? 0 : ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2;
  t = Math.max(0, Math.min(1, t));

  verts.splice(i + 1, 0, frame.toLngLat(add(a, scale(ab, t))));
  return closeRing(verts);
}

/**
 * Remove one vertex.
 *
 * A polygon needs three, so the third-to-last removal is refused: returning
 * the ring unchanged lets the caller say so rather than producing a degenerate
 * shape whose area is zero and whose failure appears somewhere else entirely.
 */
export function deleteVertex(ring, index) {
  const verts = openRing(ring);
  const n = verts.length;
  if (n <= 3) return null;
  verts.splice(((index % n) + n) % n, 1);
  return closeRing(verts);
}

/**
 * Which vertex of a ring a point is nearest to.
 * Returns { index, distanceM }.
 */
export function nearestVertex(ring, point) {
  const verts = openRing(ring);
  if (!verts.length) return null;

  const frame = makeFrame(verts[0]);
  const p = frame.toXY(point);

  let best = { index: 0, distanceM: Infinity };
  for (let i = 0; i < verts.length; i++) {
    const d = Math.hypot(...sub(frame.toXY(verts[i]), p));
    if (d < best.distanceM) best = { index: i, distanceM: d };
  }
  return best;
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
