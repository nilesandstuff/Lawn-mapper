/**
 * WHERE A PLACED POINT GOES, for New shape and Cut out (owner, 2026-09-30).
 *
 *   Cut out    snaps to the edges of the lawn already on the map. A cut-out
 *              only means something inside lawn, so a point placed outside
 *              every lawn is pulled onto the nearest lawn edge; inside, a
 *              point near an edge lands on it.
 *   New shape  the same against the property line, unless "Measure outside
 *              the property line" is on.
 *
 * In SCREEN PIXELS on purpose: "near" is about a fingertip, and a fingertip
 * is the same size at every zoom. The caller projects in and out.
 *
 * rings   every edge that can be snapped to, as arrays of [x, y]
 * areas   the regions that count as inside: { outer, holes: [] }
 */

export const SNAP_PX = 14;

/** Even-odd ray cast. Closed or open rings both work. */
export function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The nearest point on any segment of any ring, and whether it is a corner. */
export function nearestOnRings([x, y], rings) {
  let best = null;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const d = Math.hypot(x - px, y - py);
      if (!best || d < best.dist) best = { point: [px, py], dist: d };
    }
  }
  return best;
}

/** The nearest corner of any ring, within `reach`, or null. */
export function nearestCorner([x, y], rings, reach) {
  let best = null;
  for (const ring of rings) {
    for (const [cx, cy] of ring) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= reach && (!best || d < best.dist)) best = { point: [cx, cy], dist: d };
    }
  }
  return best;
}

export const insideAreas = (p, areas) =>
  areas.some((a) => inRing(p, a.outer) && !(a.holes || []).some((h) => inRing(p, h)));

/**
 * Where a tap at `p` should put its point. A corner within reach wins, then an
 * edge within reach; outside every area the point is pulled onto the nearest
 * edge; otherwise it stays where it was tapped.
 */
export function snapPoint(p, { rings, areas, snapPx = SNAP_PX }) {
  if (!rings?.length) return { point: p, snapped: false };
  const corner = nearestCorner(p, rings, snapPx);
  if (corner) return { point: corner.point, snapped: true };
  const edge = nearestOnRings(p, rings);
  if (!edge) return { point: p, snapped: false };
  if (!insideAreas(p, areas) || edge.dist <= snapPx) return { point: edge.point, snapped: true };
  return { point: p, snapped: false };
}
