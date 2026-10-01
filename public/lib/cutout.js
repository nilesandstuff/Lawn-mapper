/**
 * A Cut out that reaches the lawn's edge (owner, 2026-10-01).
 *
 * Cut out snaps its points to the edge of the lawn, so a cut traced around a
 * patio at the edge ends with corners ON that edge -- and a hole has to sit
 * strictly inside its shape, so every such cut was refused with "hangs over
 * the edge". What was meant is a notch: the cut's area taken out of the lawn.
 *
 * Pure: polygons in, polygons out, in whatever coordinates they arrive in.
 * `clip` is polygon-clipping (lib/vendor, a global in the page), passed in so
 * this runs under node too.
 */

/**
 * Take `ring` out of each shape it overlaps.
 *
 * `shapes` is a list of Polygon coordinate arrays ([outer, ...holes]).
 * Returns one entry per shape: null where the cut does not touch it, else the
 * list of polygons left (empty when the cut covered the whole shape).
 */
export function notchShapes(clip, shapes, ring) {
  const cut = [ring];
  return shapes.map((poly) => {
    if (!poly?.length) return null;
    let overlap;
    try { overlap = clip.intersection(poly, cut); } catch { return null; }
    if (!overlap.length) return null;
    try { return clip.difference(poly, cut); } catch { return null; }
  });
}
