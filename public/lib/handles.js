/**
 * Where to put a drag handle for each corner, so a fingertip can reach it.
 *
 * THE PROBLEM THIS SOLVES is not that corners are small. It is that a corner
 * and the two edges meeting at it occupy the same pixels, so every pixel given
 * to the corner is taken from the edge -- and sliding an edge is the operation
 * that preserves a surveyed bearing. VERTEX_GRAB_PX has been stuck between
 * those two for that reason.
 *
 * A handle breaks the tie. It is a second target for the corner alone, sitting
 * far enough away that no edge is near it, connected back by a thin leader so
 * it is obvious which corner it drives. Corners get a finger-sized target and
 * edges keep their pixels.
 *
 * EVERYTHING HERE IS SCREEN PIXELS, not degrees. Whether two handles collide is
 * a question about what a thumb can distinguish, which is a question about the
 * screen -- and the same lawn at two zoom levels has entirely different answers.
 * The caller projects, this decides, the caller draws.
 *
 * Pure on purpose: no map, no DOM. The interesting cases are geometric -- a
 * spike, a straight-through vertex, two corners a few pixels apart -- and those
 * are worth checking against made-up numbers rather than by pinching at a phone.
 */

/** How far from its corner a handle sits. About a fingertip's width. */
export const HANDLE_REACH_PX = 34;
/** The dot's drawn radius. */
export const HANDLE_DOT_PX = 11;
/**
 * How much empty space a handle needs before it is worth drawing.
 *
 * Below this it is touching something else -- another handle, a corner, an
 * edge -- and a handle you cannot tell apart from its neighbour is worse than
 * no handle, because it looks like it will work.
 */
export const HANDLE_CLEAR_PX = 15;
/**
 * How far past the clearance an outward placement is preferred.
 *
 * Both directions get measured; this only breaks near-ties. Outward is almost
 * always the emptier side -- the fill, the far edges and the rest of the
 * outline are all inward -- so when the two sides are similar, out is better
 * even if the numbers say otherwise by a pixel.
 */
export const OUTWARD_BIAS_PX = 8;

/**
 * Above this many corners on screen, no handles at all.
 *
 * A safety valve rather than a policy. At a zoom where three hundred corners
 * are visible they are a few pixels apart, so every one of them would be
 * suppressed for lack of clearance anyway -- this just declines to spend the
 * arithmetic proving it one corner at a time.
 */
export const HANDLE_MAX_CORNERS = 120;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = (a) => Math.hypot(a.x, a.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function norm(a) {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : null;
}

/** Distance from a point to a line SEGMENT, not to its infinite line. */
export function distToSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 < 1e-12) return dist(p, a);
  let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, add(a, scale(ab, t)));
}

/**
 * Is a point inside this ring? Ray casting, which does not care about winding.
 *
 * Used only to label a direction "outward", so a wrong answer on a
 * self-touching outline costs a handle pointing the duller way rather than
 * anything incorrect.
 */
export function insideRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const straddles = (a.y > p.y) !== (b.y > p.y);
    if (straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * The two directions a handle could leave this corner by.
 *
 * The bisector of the two edges, and its opposite. For an ordinary corner one
 * of these points into the wedge and the other away from it; which of those is
 * "outward" depends on the shape, not on the arithmetic, so the caller decides
 * that separately.
 *
 * A STRAIGHT-THROUGH CORNER has no bisector -- the two edge directions cancel,
 * and normalising a zero vector is how a handle ends up at NaN and silently
 * never draws. Those get the perpendicular to the edge instead, which is the
 * sensible answer to "which way is away from this line".
 */
export function handleDirections(prev, v, next) {
  const u = norm(sub(prev, v));
  const w = norm(sub(next, v));
  if (!u || !w) return [];

  const sum = add(u, w);
  const bisector = len(sum) > 1e-6
    ? norm(sum)
    : norm({ x: -(next.y - prev.y), y: next.x - prev.x });
  if (!bisector) return [];
  return [bisector, { x: -bisector.x, y: -bisector.y }];
}

/**
 * Plan a handle for every corner, dropping the ones with nowhere to go.
 *
 * `rings` are OPEN rings of screen-space points -- no repeated closing vertex;
 * the closing edge is implied and is checked like any other.
 *
 * Placed greedily in order, and each handle becomes an obstacle for the ones
 * after it. Greedy rather than optimal because the alternative is packing
 * circles, and the difference between a good arrangement and the best one is
 * invisible on a phone.
 */
export function planHandles(rings, {
  reach = HANDLE_REACH_PX,
  clearance = HANDLE_CLEAR_PX,
  bias = OUTWARD_BIAS_PX,
  maxCorners = HANDLE_MAX_CORNERS,
} = {}) {
  const usable = (rings || []).map((r) => (Array.isArray(r) ? r : []));
  const corners = usable.reduce((n, r) => n + (r.length >= 3 ? r.length : 0), 0);
  if (!corners || corners > maxCorners) return { handles: [], crowded: corners > maxCorners };

  /* Every corner and every edge, once, as obstacles for every candidate. */
  const points = [];
  const segments = [];
  usable.forEach((ring, r) => {
    if (ring.length < 3) return;
    ring.forEach((p, i) => {
      points.push({ r, i, p });
      segments.push([p, ring[(i + 1) % ring.length]]);
    });
  });

  const handles = [];
  let suppressed = 0;

  for (const { r, i, p } of points) {
    const ring = usable[r];
    const dirs = handleDirections(ring[(i - 1 + ring.length) % ring.length], p, ring[(i + 1) % ring.length]);
    if (!dirs.length) { suppressed++; continue; }

    let best = null;
    for (const dir of dirs) {
      const at = add(p, scale(dir, reach));

      let clear = Infinity;
      for (const other of points) {
        if (other.r === r && other.i === i) continue;
        clear = Math.min(clear, dist(at, other.p));
        if (clear < clearance) break;
      }
      if (clear >= clearance) {
        for (const [a, b] of segments) {
          clear = Math.min(clear, distToSegment(at, a, b));
          if (clear < clearance) break;
        }
      }
      if (clear >= clearance) {
        for (const h of handles) {
          clear = Math.min(clear, dist(at, h.at));
          if (clear < clearance) break;
        }
      }

      /*
       * Outward gets its thumb on the scale for CHOOSING, never for passing.
       * A cramped outward handle is still cramped, and letting a preference
       * wave one through would put a dot on top of an edge.
       */
      const outward = !insideRing(add(p, scale(dir, 2)), ring);
      const score = clear + (outward ? bias : 0);
      if (!best || score > best.score) best = { at, clear, score };
    }

    if (best && best.clear >= clearance) handles.push({ ring: r, index: i, from: p, at: best.at });
    else suppressed++;
  }

  return { handles, suppressed, crowded: false };
}
