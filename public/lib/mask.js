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

/**
 * How much of the SUM of these shapes is distinct ground, as a fraction.
 *
 * Geodesic area has no way to know two shapes cover the same lawn -- it adds
 * them up, so a shape drawn twice measures double. Working it out properly
 * means intersecting polygons, which is the genuinely hard problem this file
 * exists to avoid; rasterising and counting is exact for any shape, holes
 * included, and needs no library.
 *
 * A RATIO RATHER THAN AN AREA, deliberately. Returning square metres would
 * mean converting pixels to ground units and mixing a raster estimate into a
 * geodesic figure -- two methods, one number, disagreeing in the last digits
 * even when nothing overlaps at all. A dimensionless fraction needs no scale,
 * so the caller keeps its exact geodesic total and merely scales it.
 *
 * Which gives the property that matters: for shapes that do not overlap, the
 * union and the sum contain exactly the same pixels, so this returns exactly 1
 * and the measurement is bit-for-bit what it was before. A correction that
 * cannot fire on ordinary lawns is a correction that cannot break them.
 *
 * `shapes` is a list of GeoJSON-style ring lists (outer first, then holes).
 * A shape too thin to light a single pixel contributes nothing here and keeps
 * its full geodesic area, which errs toward the old behaviour rather than
 * against it.
 */
export function distinctFraction(shapes, width, height, project) {
  if (!Array.isArray(shapes) || shapes.length < 2) return 1;

  const union = new Uint8Array(width * height);
  let sum = 0;

  for (const rings of shapes) {
    const m = rasterizePolygon(rings, width, height, project);
    for (let p = 0; p < m.length; p++) {
      if (!m[p]) continue;
      sum++;
      union[p] = 1;
    }
  }
  if (!sum) return 1;

  let distinct = 0;
  for (let p = 0; p < union.length; p++) if (union[p]) distinct++;
  return distinct / sum;
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
export function binarize(image, threshold = 128, { autoPolarity = true } = {}) {
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

  /*
   * A mask that is almost entirely "on" is an inverted one (dark subject on a
   * light field). Nothing we segment legitimately covers >90% of the frame --
   * the frame is sized to the parcel, which always includes a house and a
   * driveway -- so treat that as polarity, not as a very large lawn.
   *
   * That premise is FALSE for a subtract-mode mask, which is why the caller
   * can switch this off. When the prompt names everything that is not lawn,
   * ">90% on" is an ordinary answer for a wooded lot, and flipping it here
   * would hand the caller the woods to invert back into "lawn" -- a confident,
   * silent, exactly-wrong measurement. Two plausible readings of one bitmap,
   * and no way to tell them apart from inside this function: the caller knows
   * what it asked for, so the caller decides.
   */
  if (autoPolarity && on > 0.9 * bin.length) {
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
/**
 * Shrink or grow a binary mask by a distance, in pixels.
 *
 * This is the sensitivity control that a hard mask actually admits. The
 * brightness cut in binarize() only means something when the detector returns
 * mid-tones; both models in use return pure black and white, so there is
 * nothing between to move the line to. What CAN be moved is the edge itself:
 * pull it in and less counts as lawn, push it out and more does.
 *
 * Done with a two-pass chamfer distance transform rather than repeated
 * erosion, so the cost is one sweep of the image regardless of the distance
 * asked for. Chamfer (3, 4) approximates Euclidean distance to within about
 * 6%, which is far finer than the question being asked -- the caller is
 * choosing how generous to be about a lawn edge, not measuring one.
 *
 * Positive grows, negative shrinks, zero returns the input untouched.
 */
export function growMask(bin, width, height, px) {
  if (!px) return bin;

  const r = Math.abs(px) * 3; // chamfer units: 3 per orthogonal step
  const grow = px > 0;

  /*
   * Seed the transform from whichever side we are measuring away from.
   * Growing measures how far each background pixel is from lawn; shrinking
   * measures how far each lawn pixel is from the outside.
   */
  const INF = 0x3fffffff;
  const d = new Int32Array(width * height);
  for (let i = 0; i < d.length; i++) {
    const isSeed = grow ? bin[i] === 1 : bin[i] === 0;
    d[i] = isSeed ? 0 : INF;
  }

  const at = (x, y) => d[y * width + x];

  // Forward: up-left neighbours.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y > 0) {
        if (x > 0) best = Math.min(best, at(x - 1, y - 1) + 4);
        best = Math.min(best, at(x, y - 1) + 3);
        if (x < width - 1) best = Math.min(best, at(x + 1, y - 1) + 4);
      }
      if (x > 0) best = Math.min(best, at(x - 1, y) + 3);
      d[i] = best;
    }
  }

  // Backward: down-right neighbours.
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y < height - 1) {
        if (x < width - 1) best = Math.min(best, at(x + 1, y + 1) + 4);
        best = Math.min(best, at(x, y + 1) + 3);
        if (x > 0) best = Math.min(best, at(x - 1, y + 1) + 4);
      }
      if (x < width - 1) best = Math.min(best, at(x + 1, y) + 3);
      d[i] = best;
    }
  }

  const out = new Uint8Array(bin.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = grow
      ? (bin[i] || d[i] <= r) ? 1 : 0     // background within r of lawn joins it
      : (bin[i] && d[i] > r) ? 1 : 0;     // lawn within r of the edge is dropped
  }
  return out;
}

/**
 * One mask image -> one binary layer, read literally or flipped.
 *
 * Split out of maskToPolygons because exclude mode needs several of these
 * before anything is traced, and because "what does this bitmap mean" is a
 * different question from "what shape is it". The caller says which reading it
 * wants; this does not guess.
 */
export function maskBinary(image, { threshold = 128, invert = false, autoPolarity } = {}) {
  // Inverting and auto-polarity are two answers to the same question, and only
  // one of them can be right. See binarize: a caller that has said "this mask
  // is the opposite of what I want" has already told us the polarity, so
  // guessing on top of that would flip it back.
  const auto = autoPolarity === undefined ? !invert : autoPolarity;
  const bin = binarize(image, threshold, { autoPolarity: auto });
  if (invert) for (let p = 0; p < bin.length; p++) bin[p] ^= 1;
  return bin;
}

/**
 * Everything any of these masks found, in one layer.
 *
 * The union is what makes stacking work: three concepts, three predictions,
 * and a pixel is excluded if ANY of them claimed it. Intersecting instead
 * would ask for pixels that are simultaneously a tree and a driveway, which is
 * nothing.
 */
export function unionMasks(masks) {
  const first = masks[0];
  if (!first) return null;
  const out = new Uint8Array(first.length);
  for (const m of masks) {
    for (let p = 0; p < out.length; p++) if (m[p]) out[p] = 1;
  }
  return out;
}

/**
 * The property, minus what was found on it.
 *
 * This is the whole of exclude mode's arithmetic, and it is deliberately the
 * opposite end of the same operation that `invert` performs. Inverting flips a
 * mask and then clips it to the parcel; this starts from the parcel and takes
 * the mask away. For ONE mask the two produce identical pixels. For several,
 * only this one accumulates -- which is the reason it exists.
 */
export function subtractMasks(base, remove) {
  const out = new Uint8Array(base.length);
  for (let p = 0; p < out.length; p++) out[p] = base[p] && !remove?.[p] ? 1 : 0;
  return out;
}

/** How much of `base` a mask claims, as a fraction. Zero base reads as zero. */
export function coverage(mask, base) {
  let on = 0;
  let total = 0;
  for (let p = 0; p < base.length; p++) {
    if (!base[p]) continue;
    total++;
    if (mask[p]) on++;
  }
  return total ? on / total : 0;
}

/**
 * A lawn this small, with the tree pass applied, is probably over-trimmed.
 *
 * MEASURED, on 22004 White Trellis Lane -- a 12,830 sq ft lot the owner
 * reported the tree box ruining. Four real predictions:
 *
 *   "woods"     @ 0.2   6,590 sq ft   51% of the parcel   3 pieces
 *   "woods"     @ 0.5       0 sq ft    0%                 0
 *   "man-made"  @ 0.2   3,887 sq ft   30%                 4 pieces
 *   "man-made"  @ 0.5   3,853 sq ft   30%                 4 pieces
 *
 * The parcel minus both is about 2,350 sq ft, 18% of the lot, against 3,700
 * the owner drew by hand. Nothing collapsed -- 51% is an ordinary-looking
 * number and COLLAPSE_FRACTION is nowhere near it -- so no existing guard
 * said anything, and the answer arrived looking confident and wrong.
 *
 * The cause is already written down beside the woods prompt: it reads about
 * 25% wider than the trees really are. On a big lot that is a rounding error.
 * Here the lawn IS the leftover strip between two masks that both read wide,
 * so the same overshoot takes a third of it.
 *
 * WHAT THIS IS NOT. It does not correct anything and it does not drop a pass.
 * It decides whether to say a sentence, because the fix already exists -- the
 * edge stepper re-traces the mask already paid for -- and the only thing
 * missing was anything on screen connecting a too-small number to it.
 *
 * 0.25 is a judgement, not a measurement. probe-sam3.js puts a believable
 * residential lawn at 30-70% of the lot; this sits below that band so an
 * ordinarily small lawn stays quiet. One lot is one lot: if this nags people
 * whose lawn really is a quarter of their property, the number is wrong and
 * not the idea.
 *
 * Gated on the tree pass having actually been applied, because that is the
 * pass with the documented overshoot. A small lawn behind buildings alone is
 * a different claim with no evidence behind it, and "man-made" was stable to
 * within 1% across the whole threshold range on the lot above.
 */
export const TIGHT_REMAINDER_FRACTION = 0.25;

export function overTrimmed({ subtractive, trimmedTrees, lawnSqFt, parcelSqFt }) {
  if (!subtractive || !trimmedTrees) return false;
  if (!(parcelSqFt > 0)) return false;
  // Zero has its own message -- "everything was excluded, untick a box" -- and
  // two sentences about the same emptiness is one too many.
  if (!(lawnSqFt > 0)) return false;
  return lawnSqFt / parcelSqFt < TIGHT_REMAINDER_FRACTION;
}

/**
 * WHAT A HAND EDIT IS ALLOWED TO THROW AWAY: as close to nothing as is safe.
 *
 * The defaults below drop small pieces and small holes and keep only the six
 * biggest shapes. That is right for a model's mask -- speckle is noise, and
 * forty crumbs of lawn is not an editing surface. It is wrong for a brush
 * stroke, where every pixel that changed changed because somebody deliberately
 * painted it.
 *
 * THIS IS THE "the brush would not remove my shed" BUG. The limits are
 * fractions of the whole frame, and the frame a brush edit traces in is padded
 * by some forty metres on every side, so on a small lot a hole had to be
 * around 250 sq ft to survive being traced. A shed is smaller than that, so
 * the hole was filled in the instant it was made: the stroke landed, the shape
 * came back whole, and the tool looked broken rather than opinionated. Nothing
 * on screen named the threshold, so the nearest visible suspect -- "count
 * grass under trees", the one option that is about filling gaps -- took the
 * blame for it.
 *
 * Absolute pixel counts rather than fractions of the frame, so the answer does
 * not depend on how much empty ground happens to be in shot.
 *
 * TWO FLOORS, NOT ONE, because the two things being measured are not alike.
 *
 * A hole is made on purpose. Rasterising a solid polygon does not produce one,
 * so anything that is there is there because somebody cut it, and the floor
 * only has to be above a stray pixel: twelve of them is well under a square
 * foot at any grid this runs on.
 *
 * A separate PIECE can be an artefact. Where a stroke almost-but-not-quite
 * severs a shape the grid leaves slivers a few pixels wide along the cut, and
 * those are dust rather than lawn. So the floor for a piece is higher -- two
 * hundred pixels, around twenty square feet on an ordinary lot -- which is
 * still far below the tracer's own default of roughly 350 sq ft, and that
 * default is large enough to silently drop a real strip of grass that a stroke
 * across a lawn legitimately makes.
 *
 * `maxPolygons` is large rather than absent for the same reason it exists at
 * all -- a runaway would be a wall of handles -- but rubbing a line across a
 * lawn legitimately makes a dozen pieces, and six was never that number.
 */
export const EDIT_MIN_HOLE_PX = 12;
export const EDIT_MIN_PIECE_PX = 200;

/** The hole floor alone, for an operation that makes no new pieces. */
export const editHoleLimit = (width, height) => ({
  minHoleFraction: EDIT_MIN_HOLE_PX / (width * height),
});

export const editTraceLimits = (width, height) => ({
  ...editHoleLimit(width, height),
  minAreaFraction: EDIT_MIN_PIECE_PX / (width * height),
  maxPolygons: 200,
});

/**
 * A binary layer -> GeoJSON polygons. The tail half of maskToPolygons, reused
 * by exclude mode, which arrives with its pixels already decided.
 */
export function polygonsFromBinary(bin, width, height, unproject, options = {}) {
  const {
    minAreaFraction = 0.002,
    minHoleFraction = 0.0015,
    tolerance = 1.5,
    maxVertices = 240,
    maxPolygons = 6,
    clipMask = null,
    fillGapsUnderPx = 0,
    growPx = 0,
  } = options;

  const total = width * height;

  /*
   * Grow before clipping, never after. Growing a mask that has already been
   * cut to the property line would push it back over the boundary and count
   * the neighbours' grass again -- the clip has to be the last word.
   */
  if (growPx) bin = growMask(bin, width, height, growPx);

  if (clipMask) {
    for (let p = 0; p < bin.length; p++) bin[p] &= clipMask[p];
  }
  const { labels, sizes } = labelComponents(bin, width, height);

  const components = sizes
    .map((size, id) => ({ size, id }))
    .slice(1)
    .sort((a, b) => b.size - a.size);

  const ranked = components
    .filter((c) => c.size >= minAreaFraction * total)
    .slice(0, maxPolygons);

  /*
   * What the two limits above threw away.
   *
   * Both are presentation limits -- speckle is not worth a draggable shape,
   * and forty handles on a phone is not usable -- but what they discard is
   * lawn, and discarding lawn silently is how a total ends up smaller than
   * the ground with nothing on screen to say why. It matters most in exclude
   * mode: subtracting a second concept cuts the remaining lawn into more
   * pieces, so the press that adds a tick can drop pieces the press before it
   * kept, and neither concept ever claimed that ground.
   */
  const droppedPx = components
    .filter((c) => !ranked.includes(c))
    .reduce((n, c) => n + c.size, 0);
  const droppedCount = components.length - ranked.length;

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
  polygons.droppedCount = droppedCount;
  polygons.droppedPx = droppedPx;
  return polygons;
}

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
    // Move the edge of the mask in (negative) or out (positive), in pixels.
    // See growMask: this is the only sensitivity a hard yes/no mask has.
    growPx = 0,
    /*
     * The mask marks what is NOT lawn, so flip it before doing anything else.
     *
     * For subtract mode, where the detector is asked for buildings, trees,
     * water and beds and the lawn is whatever is left over. Everything
     * downstream -- growing, clipping, component ranking, hole filling -- then
     * operates on an ordinary lawn mask and needs no idea this happened.
     *
     * Order is the whole trick. Inverting BEFORE the clip is what keeps the
     * property line as the last word: the raw inverse covers the entire frame
     * edge to edge, neighbours' land included, and it is the clip that cuts it
     * back to this lot. Invert after clipping and you would get the lot's
     * buildings plus the whole rest of the world.
     */
    invert = false,
  } = options;

  const { width, height } = image;
  return polygonsFromBinary(
    maskBinary(image, { threshold, invert }),
    width, height, unproject,
    { minAreaFraction, minHoleFraction, tolerance, maxVertices, maxPolygons, clipMask, fillGapsUnderPx, growPx }
  );
}
