/**
 * SAM mask (a PNG) -> editable GeoJSON polygons.
 *
 * SAM 2 hands back a raster mask. Mapbox GL Draw needs vector rings, and
 * area.js needs WGS84 coordinates. This module bridges the two:
 *
 *   binarise -> label regions -> find enclosed holes -> trace outlines
 *   -> simplify -> unproject to lng/lat
 *
 * Two decisions worth knowing about:
 *
 * 1. Holes are traced, not ignored. A lawn that wraps around a house is a
 *    ring with the house punched out of it. Skipping holes would silently
 *    bill the homeowner's roof as turf -- often 1,500+ sq ft of error on a
 *    typical lot. area.js already subtracts interior rings, so getting them
 *    into the geometry is all that is required.
 *
 * 2. Separate patches stay separate. Front yard and back yard usually come
 *    back as two disconnected blobs with the house between them. Each becomes
 *    its own editable polygon, which is also what a user expects to be able
 *    to delete independently ("I don't mow the back").
 *
 * Everything here is pure: it takes {width, height, data} (an ImageData, or
 * any object shaped like one) so it runs unchanged under Node for tests.
 */

/**
 * Paint a polygon into a pixel mask, so it can be intersected with another.
 *
 * This is how the lawn gets clipped to the property line. The obvious approach
 * -- polygon boolean geometry -- is a genuinely hard problem to get right on
 * real parcel outlines, and a wrong answer there is a wrong square footage.
 * Intersecting two bitmaps is exact for any shape, holes included, needs no
 * library, and lands in the same pixel grid the mask already lives in.
 *
 * `rings` is a GeoJSON-style ring list (outer first, then holes) and `project`
 * turns [lng, lat] into image pixels. Even-odd filling means holes come out
 * right without being special-cased.
 */
export function rasterizePolygon(rings, width, height, project) {
  const mask = new Uint8Array(width * height);

  // Every edge, in pixel space, ignoring horizontal ones (they contribute no
  // crossings and would divide by zero below).
  const edges = [];
  for (const ring of rings) {
    const pts = ring.map(project);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      if (y1 !== y2) edges.push([x1, y1, x2, y2]);
    }
    // Close the ring if the caller did not.
    const [fx, fy] = pts[0];
    const [lx, ly] = pts[pts.length - 1];
    if ((fx !== lx || fy !== ly) && fy !== ly) edges.push([lx, ly, fx, fy]);
  }
  if (!edges.length) return mask;

  const xs = [];
  for (let y = 0; y < height; y++) {
    // Sample through the middle of the row: a scanline exactly on a vertex
    // otherwise counts that crossing twice.
    const sy = y + 0.5;
    xs.length = 0;

    for (const [x1, y1, x2, y2] of edges) {
      if ((sy >= y1 && sy < y2) || (sy >= y2 && sy < y1)) {
        xs.push(x1 + ((sy - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    if (xs.length < 2) continue;

    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[i + 1] - 0.5));
      for (let x = from; x <= to; x++) mask[y * width + x] = 1;
    }
  }

  return mask;
}

/** Clockwise Moore neighbourhood, starting due east. */
const MOORE = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/**
 * RGBA -> 1-bit foreground mask.
 *
 * Handles both shapes SAM output takes in the wild: a white silhouette on a
 * transparent background, and a white-on-black opaque bitmap. Alpha wins when
 * present; luminance decides otherwise.
 */
export function binarize(image, threshold = 128) {
  const { width, height, data } = image;
  const bin = new Uint8Array(width * height);
  let on = 0;

  for (let i = 0, p = 0; p < bin.length; i += 4, p++) {
    if (data[i + 3] < threshold) continue; // transparent -> background
    const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    if (lum >= threshold) {
      bin[p] = 1;
      on++;
    }
  }

  // A mask that is almost entirely "on" is an inverted one (dark subject on a
  // light field). Nothing we segment legitimately covers >90% of the frame --
  // the frame is sized to the parcel, which always includes a house and a
  // driveway -- so treat that as polarity, not as a very large lawn.
  if (on > 0.9 * bin.length) {
    for (let p = 0; p < bin.length; p++) bin[p] ^= 1;
  }

  return bin;
}

/**
 * 4-connected connected-component labelling. Returns a label array (0 =
 * background) and per-component sizes.
 *
 * 4-connectivity rather than 8 on purpose: diagonal touching would merge the
 * front and back lawn through the single pixel where they clip the corner of
 * the house, producing one polygon with a bogus pinch point.
 */
export function labelComponents(bin, width, height) {
  const labels = new Int32Array(bin.length);
  const sizes = [0]; // index 0 is background
  const stack = new Int32Array(bin.length);

  for (let seed = 0; seed < bin.length; seed++) {
    if (!bin[seed] || labels[seed]) continue;

    const id = sizes.length;
    let size = 0;
    let sp = 0;
    stack[sp++] = seed;
    labels[seed] = id;

    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const x = p % width;
      const y = (p / width) | 0;

      if (x > 0 && bin[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (x < width - 1 && bin[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && bin[p - width] && !labels[p - width]) { labels[p - width] = id; stack[sp++] = p - width; }
      if (y < height - 1 && bin[p + width] && !labels[p + width]) { labels[p + width] = id; stack[sp++] = p + width; }
    }

    sizes.push(size);
  }

  return { labels, sizes };
}

/**
 * Holes enclosed by component `id`: background regions that cannot reach the
 * image border without crossing the component.
 *
 * Implemented as a flood fill of everything-that-is-not-this-component,
 * started from the border. Whatever the fill cannot reach is, by definition,
 * surrounded -- which is exactly the definition of an interior ring.
 */
export function findHoles(labels, width, height, id, minPixels) {
  const outside = new Uint8Array(labels.length);
  const stack = [];

  const push = (p) => {
    if (labels[p] !== id && !outside[p]) { outside[p] = 1; stack.push(p); }
  };

  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }

  while (stack.length) {
    const p = stack.pop();
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (y > 0) push(p - width);
    if (y < height - 1) push(p + width);
  }

  // Everything not part of the component and not reachable from outside.
  const enclosed = new Uint8Array(labels.length);
  for (let p = 0; p < labels.length; p++) {
    if (labels[p] !== id && !outside[p]) enclosed[p] = 1;
  }

  const { labels: holeLabels, sizes } = labelComponents(enclosed, width, height);
  const holes = [];
  for (let h = 1; h < sizes.length; h++) {
    if (sizes[h] < minPixels) continue; // speckle, not a house
    const region = new Uint8Array(labels.length);
    for (let p = 0; p < holeLabels.length; p++) if (holeLabels[p] === h) region[p] = 1;
    holes.push(region);
  }
  return holes;
}

/**
 * Moore-neighbour boundary tracing. Returns pixel coordinates walking the
 * outline of `region` in order.
 *
 * The scan-order start pixel is the topmost-then-leftmost one, so the cell to
 * its west is guaranteed background -- which gives the trace a valid initial
 * backtrack position without a special case.
 */
export function traceRegion(region, width, height) {
  let start = -1;
  for (let i = 0; i < region.length; i++) if (region[i]) { start = i; break; }
  if (start < 0) return null;

  const sx = start % width;
  const sy = (start / width) | 0;
  const on = (x, y) => x >= 0 && y >= 0 && x < width && y < height && region[y * width + x] === 1;

  let px = sx, py = sy;
  let bx = sx - 1, by = sy;
  const contour = [[sx, sy]];

  // Hard ceiling: a boundary cannot be longer than this, and an unbounded
  // loop here would hang the browser tab rather than fail visibly.
  const maxSteps = 4 * region.length + 8;

  for (let step = 0; step < maxSteps; step++) {
    let bi = 0;
    for (let i = 0; i < 8; i++) {
      if (px + MOORE[i][0] === bx && py + MOORE[i][1] === by) { bi = i; break; }
    }

    let moved = false;
    for (let k = 1; k <= 8; k++) {
      const i = (bi + k) % 8;
      const nx = px + MOORE[i][0];
      const ny = py + MOORE[i][1];
      if (!on(nx, ny)) continue;

      // The background cell we just stepped past becomes the new backtrack.
      const prev = (i + 7) % 8;
      bx = px + MOORE[prev][0];
      by = py + MOORE[prev][1];
      px = nx;
      py = ny;
      moved = true;
      break;
    }

    if (!moved) break;                  // isolated single pixel
    if (px === sx && py === sy) break;  // closed the loop
    contour.push([px, py]);
  }

  return contour;
}

/** Perpendicular distance from p to the segment ab. */
function perpDistance([x, y], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(x - ax, y - ay);
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Douglas-Peucker. Endpoints are always kept. */
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDistance(points[i], points[a], points[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify a closed ring down to at most `maxVertices`.
 *
 * A raw trace of a 1280px mask runs to thousands of points. That is not more
 * accurate -- it is pixel staircase, and it makes every vertex handle in
 * Mapbox GL Draw unusable. Loosening the tolerance until the ring fits the
 * budget keeps the shape while leaving something a human can actually drag.
 */
function simplifyRing(contour, { tolerance, maxVertices }) {
  const closed = [...contour, contour[0]];
  let tol = tolerance;
  let ring = simplify(closed, tol);

  while (ring.length > maxVertices && tol < 256) {
    tol *= 1.6;
    ring = simplify(closed, tol);
  }

  if (ring.length < 4) return null; // degenerate -- not a polygon

  // Douglas-Peucker keeps both endpoints, which were the same point, so the
  // ring is already closed. Belt and braces:
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  return ring;
}

/**
 * Full pipeline: mask image + the frame it was rendered from -> GeoJSON
 * Polygon geometries in WGS84, largest first.
 *
 * `unproject(px, py)` converts image pixel coordinates to [lng, lat]; the
 * caller supplies it so this module stays independent of the projection.
 */
export function maskToPolygons(image, unproject, options = {}) {
  const {
    threshold = 128,
    // Fractions of the frame. A 640-logical-px frame at zoom 19 is roughly a
    // 70m square, so 0.2% is about 10 m^2 -- below a patch of grass anyone
    // would bother mowing, and comfortably above JPEG noise.
    minAreaFraction = 0.002,
    minHoleFraction = 0.0015,
    tolerance = 1.5,
    maxVertices = 240,
    maxPolygons = 6,
    // Pixels outside the property line, zeroed before anything else runs.
    clipMask = null,
    // Gaps smaller than this are kept as lawn rather than subtracted. A tree
    // canopy hides grass that is really there; a pool or a shed does not. Size
    // is the only signal available from overhead, so the caller sets the line
    // and the UI reports what was filled.
    fillGapsUnderPx = 0,
  } = options;

  const { width, height } = image;
  const total = width * height;
  const bin = binarize(image, threshold);

  if (clipMask) {
    for (let p = 0; p < bin.length; p++) bin[p] &= clipMask[p];
  }
  const { labels, sizes } = labelComponents(bin, width, height);

  const ranked = sizes
    .map((size, id) => ({ size, id }))
    .slice(1)
    .filter((c) => c.size >= minAreaFraction * total)
    .sort((a, b) => b.size - a.size)
    .slice(0, maxPolygons);

  const polygons = [];
  let filledGaps = 0;
  let filledGapPx = 0;

  for (const { id } of ranked) {
    const region = new Uint8Array(total);
    for (let p = 0; p < labels.length; p++) if (labels[p] === id) region[p] = 1;

    const outer = traceRegion(region, width, height);
    if (!outer || outer.length < 4) continue;

    const outerRing = simplifyRing(outer, { tolerance, maxVertices });
    if (!outerRing) continue;

    const rings = [outerRing];

    for (const hole of findHoles(labels, width, height, id, minHoleFraction * total)) {
      // A gap small enough to be a tree is counted as lawn: not tracing it
      // leaves it filled.
      const size = hole.reduce((n, v) => n + v, 0);
      if (size < fillGapsUnderPx) {
        filledGaps++;
        filledGapPx += size;
        continue;
      }

      const traced = traceRegion(hole, width, height);
      if (!traced || traced.length < 4) continue;
      const ring = simplifyRing(traced, { tolerance, maxVertices: Math.round(maxVertices / 2) });
      if (ring) rings.push(ring);
    }

    polygons.push({
      type: 'Polygon',
      coordinates: rings.map((ring) => ring.map(([x, y]) => unproject(x, y))),
    });
  }

  // The count travels with the result so the UI can say what it did rather
  // than quietly inflating the number.
  polygons.filledGaps = filledGaps;
  polygons.filledGapPx = filledGapPx;
  return polygons;
}
