/**
 * Putting back the parts of an outline the brush never touched.
 *
 * THE BUG THIS EXISTS FOR, in full, because it was reported three times and
 * fixed twice without being fixed.
 *
 * A brush stroke is applied by rasterising the shapes, painting the stroke
 * into the pixels, and tracing the result back to a polygon. That round trip
 * is lossy on purpose -- it was built to turn a noisy segmentation mask into a
 * clean outline, so it smooths with a tolerance measured in feet and caps the
 * result at a few dozen vertices. Both are right for a mask off a model.
 *
 * Both are catastrophic for a polygon somebody already corrected by hand. The
 * shape going in is not noisy; it is exactly what the user wants, except for
 * the bit under the brush. Smoothing it again moves every edge on the whole
 * outline, and the vertex cap deletes corners far from the stroke that were
 * placed deliberately. Do that on each stroke and the outline walks inward a
 * little every time.
 *
 * The earlier fixes spared shapes the stroke did not reach at all. That was
 * real and insufficient: within a shape the brush DOES touch, the ninety
 * percent of the outline nowhere near the stroke was still being rebuilt.
 *
 * So: trace the result tightly (that is the caller's business), then bring
 * every vertex that the stroke could not have affected back onto the line it
 * came from. Near the stroke the new outline stands, because there the change
 * is the point. Away from it the old outline is authoritative, because nothing
 * happened there and the only honest edit is none.
 */

import { makeFrame } from './edges.js';

/** Square of the distance from p to the segment ab, all in metres. */
function segDist2([px, py], [ax, ay], [bx, by]) {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = ax + t * vx - px;
  const dy = ay + t * vy - py;
  return { d2: dx * dx + dy * dy, at: [ax + t * vx, ay + t * vy] };
}

/**
 * How far a point is from a path, in metres.
 *
 * Used to ask "could the brush have changed this vertex", so it measures to
 * the stroke's centre line and the caller adds the brush's radius. Measuring
 * to the painted area itself would need a distance field over the whole grid
 * for an answer this coarse.
 */
export function distanceToPath(point, path, frame) {
  if (!path || path.length === 0) return Infinity;
  const p = frame.toXY(point);
  if (path.length === 1) {
    const [ax, ay] = frame.toXY(path[0]);
    return Math.hypot(p[0] - ax, p[1] - ay);
  }
  let best = Infinity;
  let prev = frame.toXY(path[0]);
  for (let i = 1; i < path.length; i++) {
    const cur = frame.toXY(path[i]);
    const { d2 } = segDist2(p, prev, cur);
    if (d2 < best) best = d2;
    prev = cur;
  }
  return Math.sqrt(best);
}

/**
 * The closest point anywhere on a set of rings, and how far away it is.
 *
 * Returns a point ON AN EDGE rather than the nearest corner. That distinction
 * is the whole mechanism: a traced vertex sitting half a pixel off a long
 * straight boundary needs to go back onto that boundary, and the nearest
 * corner of it might be thirty metres away.
 */
export function nearestOnRings(point, rings, frame) {
  const p = frame.toXY(point);
  let best = null;
  let bestD2 = Infinity;
  let corner = null;
  let cornerD2 = Infinity;

  for (const ring of rings) {
    if (!ring || ring.length < 2) continue;
    let prev = frame.toXY(ring[0]);

    // The first vertex is a candidate corner too; the loop below only sees it
    // as the start of a segment.
    {
      const d2 = (p[0] - prev[0]) ** 2 + (p[1] - prev[1]) ** 2;
      if (d2 < cornerD2) { cornerD2 = d2; corner = ring[0]; }
    }

    for (let i = 1; i < ring.length; i++) {
      const cur = frame.toXY(ring[i]);
      const { d2, at } = segDist2(p, prev, cur);
      if (d2 < bestD2) { bestD2 = d2; best = at; }

      const vd2 = (p[0] - cur[0]) ** 2 + (p[1] - cur[1]) ** 2;
      if (vd2 < cornerD2) { cornerD2 = vd2; corner = ring[i]; }

      prev = cur;
    }
  }

  if (!best) return null;
  return {
    point: frame.toLngLat(best),
    distanceM: Math.sqrt(bestD2),
    // The nearest ORIGINAL VERTEX, kept separate because a corner and a point
    // on an edge want different treatment -- see restoreAway.
    corner,
    cornerDistanceM: Math.sqrt(cornerD2),
  };
}

/**
 * Drop vertices that sit on the straight line between their neighbours.
 *
 * Snapping a traced staircase back onto the edge it came from leaves a row of
 * collinear points along what is really one line. They are harmless to the
 * area and to the look of it, and they are not harmless to the vertex budget:
 * a shape edited twenty times would accumulate hundreds of them, and every one
 * is a draggable handle on a phone.
 *
 * The tolerance is deliberately tiny -- this removes points that are already
 * on the line, and is not a second simplifier.
 */
export function dropCollinear(ring, frame, toleranceM = 0.02) {
  if (!ring || ring.length < 4) return ring;

  const closed = ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring.slice();
  if (pts.length < 4) return ring;

  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = out.length ? out[out.length - 1] : pts[(i - 1 + pts.length) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const { d2 } = segDist2(frame.toXY(pts[i]), frame.toXY(prev), frame.toXY(next));
    if (Math.sqrt(d2) > toleranceM) out.push(pts[i]);
  }

  // Never collapse a ring out of existence: if everything looked collinear,
  // the input was degenerate and the original is the safer answer.
  if (out.length < 3) return ring;
  return closed ? [...out, out[0]] : out;
}

/**
 * Bring an outline back onto the one it was traced from, except near the brush.
 *
 * `rings` is what came out of the tracer, `originals` every ring of the shapes
 * the stroke touched, `stroke` the brush's centre line. A vertex further than
 * `reachM` from the stroke could not have been changed by it, so if it is
 * within `snapM` of the old outline it is put back exactly on it.
 *
 * `snapM` is the honesty limit and wants to stay SMALL -- a couple of pixels
 * of the grid that produced the trace. Too large and a vertex on one side of a
 * narrow neck snaps to the other side of it, which is a fold rather than a
 * correction.
 */
export function restoreAway(rings, {
  originals = [],
  stroke = [],
  reachM = 3,
  snapM = 0.25,
  collinearM = 0.02,
} = {}) {
  if (!rings?.length || !originals.length) return rings;

  // One frame for everything, anchored on the first vertex there is. Distances
  // only have to agree with each other, and at lawn scale an equirectangular
  // frame about any point in the lawn is exact to millimetres.
  const anchor = rings[0]?.[0] || originals[0]?.[0];
  if (!anchor) return rings;
  const frame = makeFrame(anchor);

  return rings.map((ring) => {
    if (!ring || ring.length < 3) return ring;

    const moved = ring.map((vertex) => {
      // Near the brush the new outline is the true one: that is where the
      // change happened, and snapping it back would undo the edit.
      if (distanceToPath(vertex, stroke, frame) <= reachM) return vertex;

      const near = nearestOnRings(vertex, originals, frame);
      if (!near) return vertex;

      /*
       * A CORNER GOES BACK TO THE CORNER, not to the nearest point on an edge.
       *
       * Snapping purely to the closest edge looks right and is not: a vertex
       * drifted diagonally off a right-angled corner is equally close to both
       * edges that meet there, so it lands ON one of them, a few centimetres
       * along -- and the corner is now rounded off. Do that twenty times and
       * the corner has walked down the edge.
       *
       * So if an original vertex is within reach, that is the answer, because
       * a corner is a place somebody chose. Only when there is no corner
       * nearby does the nearest edge win, which is the long-straight-boundary
       * case this is mostly for.
       */
      if (near.corner && near.cornerDistanceM <= snapM) return near.corner;
      return near.distanceM <= snapM ? near.point : vertex;
    });

    // A ring has to stay closed; snapping the two copies of the first vertex
    // independently could part them by a hair, which some consumers read as
    // an open ring.
    if (moved.length > 2) {
      const first = moved[0];
      const last = moved[moved.length - 1];
      if (Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12) {
        moved[moved.length - 1] = first;
      }
    }

    return dropCollinear(moved, frame, collinearM);
  });
}
