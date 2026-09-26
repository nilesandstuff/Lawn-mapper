/**
 * A brush stroke applied to the outline itself, not to a picture of it.
 *
 * THE BUG THIS REPLACES. A stroke used to be applied by rasterising every
 * shape it touched, painting the stroke into the pixels and tracing the
 * whole shape back out. lib/stitch.js then put vertices far from the brush
 * back onto the old outline -- but it can only move vertices the re-trace
 * PRODUCED, and cannot bring back corners the re-trace dropped. On a large
 * lawn that loss is a few centimetres nobody sees; on a small shape somebody
 * has been fine-tuning, every corner is a pixel or two from the next and the
 * whole outline came back rebuilt, far from where the brush went.
 *
 * So the stroke is turned into a polygon of its own (traced from the painted
 * pixels, which is where the brush's own roundness comes from) and combined
 * with the shapes by polygon clipping: union to add, difference to erase.
 * Clipping only ever adds vertices where the stroke's edge crosses the
 * shape's, so every corner the stroke did not cover comes back EXACTLY --
 * the same numbers, not a snapped approximation of them.
 *
 * `clip` is the polygon-clipping library (lib/vendor, a global in the page),
 * passed in so this can be tested in node.
 */

import { makeFrame } from './edges.js';

/** Planar area of one ring, in m², in the given frame. */
function ringAreaM2(ring, frame) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = frame.toXY(ring[i]);
    const [x2, y2] = frame.toXY(ring[(i + 1) % n]);
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * shapes:  Polygon coordinate arrays (or MultiPolygon ones) the stroke touched
 * stroke:  Polygon coordinate arrays of the painted stroke
 * paint:   true to add, false to erase
 * minAreaM2: slivers and pinholes the clip leaves smaller than this are
 *            dropped, as the pixel path's tracer dropped specks.
 *
 * Returns Polygon geometries, or null when the clip failed and the caller
 * should fall back to the raster path.
 */
export function strokeOnShapes(shapes, stroke, { paint, clip, minAreaM2 = 0.05 }) {
  if (!clip || !stroke.length) return null;
  let out;
  try {
    out = paint
      ? clip.union(...shapes, ...stroke)
      : (shapes.length ? clip.difference(clip.union(...shapes), ...stroke) : []);
  } catch {
    return null;
  }
  const anchor = out[0]?.[0]?.[0] || stroke[0]?.[0]?.[0];
  if (!anchor) return [];
  const frame = makeFrame(anchor);
  const geoms = [];
  for (const poly of out) {
    const [outer, ...holes] = poly;
    if (!outer || outer.length < 4 || ringAreaM2(outer, frame) < minAreaM2) continue;
    geoms.push({
      type: 'Polygon',
      coordinates: [outer, ...holes.filter((h) => h.length >= 4 && ringAreaM2(h, frame) >= minAreaM2)],
    });
  }
  return geoms;
}
