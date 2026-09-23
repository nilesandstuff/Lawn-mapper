/**
 * Draw the outline the detector would have handed you, on the photograph it
 * drew it from.
 *
 * WHAT THIS IS FOR, and it is not accuracy.
 *
 * The table says 28.2% and the earlier version of this file painted where that
 * 28.2% was -- red for missed, orange for over-called. That answers "how wrong
 * is it". It does not answer the question that decides whether the detector is
 * useful NOW, which is:
 *
 *   if this outline appeared on the map, how long would it take to fix by hand?
 *
 * Those are different questions and they can disagree completely. An outline
 * that is 30% wrong in one clean sweep -- the whole back lawn missed, edges
 * crisp everywhere else -- is two brush strokes and a minute. An outline that
 * is 15% wrong as a hundred crumbs along every boundary is worse than starting
 * from nothing, because now you are deleting as well as drawing. A mistake map
 * cannot tell those apart; a picture of the actual shape can, instantly.
 *
 * That matters because the corpus is the bottleneck. Hand-tracing lawns is the
 * slow step in everything here, and a detector that is not accurate enough to
 * ship can still be accurate enough to START from -- which would make every
 * subsequent map faster to add. This page is how that moment gets noticed.
 *
 * SO IT IS THE TRACE, NOT THE MASK. The model answers per grid cell; what the
 * app puts on the map is that answer run through the tracer -- smoothed to
 * TRACE_TOLERANCE_M, capped at MAX_TRACE_VERTICES, speckle below the area floor
 * dropped, only the biggest few pieces kept. Drawing the raw mask would show a
 * shape nobody would ever be handed. Drawing the trace shows the handles you
 * would actually be dragging, at the count you would actually be dragging them.
 *
 * What is drawn, in order:
 *
 *   the property line           a thin white outline, and outside it dimmed --
 *                               not scored, but it is the context that explains
 *                               an over-call at the boundary. The line is drawn
 *                               because every "inside/outside" number under
 *                               these pictures is unreadable without it
 *   the true lawn               a pale green wash, the same green the console
 *                               draws a finished map in
 *   inferred areas              purple outline: "known to be lawn, not visible"
 *   THE MODEL'S TRACE           the detector's own colour, with a dot at every
 *                               vertex, drawn last so it sits on top of
 *                               everything
 *
 * Read it as: wash with no outline over it is lawn it gave up on; outline over
 * bare ground is lawn it invented. Both still legible -- but now they are
 * legible as SHAPES, which is the thing being judged.
 */

import {
  polygonsFromBinary, rasterizePolygon, TRACE_TOLERANCE_M, MAX_TRACE_VERTICES,
} from '../public/lib/mask.js';

/*
 * The console's colours, as bytes.
 *
 * Deliberately the same three that public/lib/review-draw.js paints a stored
 * map in -- lawn green, detector red, inferred purple -- because the person
 * looking at these has just come from the review card and should not have to
 * learn a second vocabulary for the same three things. tools/markup.test.js
 * checks these against REVIEW_COLOURS, and the legend in console.css against
 * these.
 */
export const TRACE = [226, 114, 91];          // REVIEW_COLOURS.ai, #e2725b
export const TRUTH_FILL = [78, 194, 106];     // REVIEW_COLOURS.lawn, #4ec26a
export const INFERRED_EDGE = [179, 136, 255]; // REVIEW_COLOURS.inferred, #b388ff

/**
 * The property line itself.
 *
 * WHY IT IS DRAWN AT ALL. Everything outside the parcel was dimmed and nothing
 * marked where the parcel ended, so a reader could see that SOME ground was
 * being discounted but not where the boundary ran. That matters more than it
 * sounds: half the numbers under these pictures are "inside the line" versus
 * "outside it", and a picture that cannot show the line cannot be checked
 * against them. Reported by somebody reading the canopy renderings and finding
 * they could not tell which trees were on the property.
 *
 * White, because the other three colours are taken and each already means
 * something specific. A boundary is not a claim about the ground; it is the
 * edge of what anybody is claiming.
 */
export const PARCEL_EDGE = [255, 255, 255];

/**
 * How strongly the true lawn is washed over the photograph.
 *
 * Low on purpose. The question is what KIND of ground it got wrong -- gravel,
 * shade, a flat roof -- and that means the ground has to stay readable through
 * the wash. This is the same weight the review card fills a lawn with.
 */
const TRUTH_ALPHA = 0.28;
/** Outside the property line: visible, obviously not part of the judgement. */
const OUTSIDE_DIM = 0.45;

const mix = (under, over, a) => Math.round(under * (1 - a) + over * a);

/**
 * The model's answer, as the polygons the app would put on the map.
 *
 * Every option here is the app's own, because a rendering traced any other way
 * is a picture of something that will never happen. `mpp` is metres per grid
 * cell, so the tolerance converts to pixels exactly as it does in a detection.
 *
 * `within` goes in as the clip mask rather than being applied first, matching
 * the detect path: the property line is the last word on what counts.
 */
export function tracePrediction({ predicted, within, grid, mpp, gridH = grid }) {
  const bin = new Uint8Array(grid * gridH);
  for (let i = 0; i < bin.length; i++) bin[i] = predicted[i] ? 1 : 0;

  const polygons = polygonsFromBinary(bin, grid, gridH, (x, y) => [x, y], {
    tolerance: mpp ? TRACE_TOLERANCE_M / mpp : 1.5,
    maxVertices: MAX_TRACE_VERTICES,
    clipMask: within || null,
  });

  const rings = [];
  let vertices = 0;
  for (const poly of polygons) {
    for (const ring of poly.coordinates) {
      rings.push(ring);
      /* A ring repeats its first point to close; that is one point on screen
         and one handle in the editor, not two. */
      vertices += Math.max(0, ring.length - 1);
    }
  }

  return {
    /*
     * Grouped, as well as flat. Drawing wants every ring and does not care
     * which shape owns it; rasterising back does care, because a polygon's
     * second ring is a HOLE and filling it solid would be the opposite of
     * what the shape says.
     */
    shapes: polygons.map((p) => p.coordinates),
    rings,
    pieces: polygons.length,
    vertices,
    /*
     * What the tracer threw away: pieces under the area floor, and anything
     * past the sixth. Worth reporting because it is invisible in the picture
     * BY DEFINITION -- and a model whose answer is mostly speckle looks
     * deceptively tidy once the speckle has been dropped.
     */
    droppedPieces: polygons.droppedCount || 0,
    droppedPx: polygons.droppedPx || 0,
  };
}

/**
 * The traced outline, back as a mask, so the same questions can be asked of it.
 *
 * WHY THIS EXISTS, and it is a caption bug found by looking at a picture.
 *
 * A reader saw "of the ground marked inferred, it missed 17.8%" under a
 * rendering whose outline covered that ground completely. Both were right. The
 * number was measured on the model's raw mask; the picture is the trace, and
 * the tracer does not trace a hole below `minHoleFraction` — 0.15% of the
 * frame, which is about 60 sq ft on a typical lot. So a scatter of small gaps
 * inside a patch is real in the mask and simply absent from the polygon.
 *
 * That behaviour is wanted: lawns are not polka dots, and a shape full of
 * pinholes is not an editing surface. What is not wanted is a caption
 * describing a different object from the picture it sits under. So the page's
 * per-lawn numbers are asked of THIS mask, the one the outline would actually
 * deliver, and the run's own error figure stays on the raw mask where it
 * remains comparable to the table and to docs/DETECTOR-FINDINGS.md.
 *
 * Rasterised per shape rather than all at once: even-odd across two separate
 * polygons that happened to overlap would cancel them both.
 */
export function traceMask({ shapes, within, grid, gridH = grid }) {
  const out = new Uint8Array(grid * gridH);
  for (const rings of shapes || []) {
    if (!rings?.length) continue;
    const m = rasterizePolygon(rings, grid, gridH, ([x, y]) => [x, y]);
    for (let i = 0; i < out.length; i++) if (m[i]) out[i] = 1;
  }
  /* The property line has the last word here as everywhere else. A traced
     vertex can land a hair outside the parcel where the mask was clipped to
     it, and that hair must not count as lawn. */
  if (within) for (let i = 0; i < out.length; i++) out[i] &= within[i] ? 1 : 0;
  return out;
}

/**
 * What the tracer added and what it took away, against the mask it traced.
 *
 * The honest companion to the pictures. Hole-filling and smoothing make an
 * outline tidier than the answer underneath it, which is the point — and it
 * also means a picture can look better than the model is. This says by how
 * much, in square feet, in both directions.
 */
export function traceDrift({ predicted, traced, within }) {
  let added = 0, removed = 0;
  for (let i = 0; i < traced.length; i++) {
    if (within && !within[i]) continue;
    const mask = Boolean(predicted[i]);
    const poly = Boolean(traced[i]);
    if (poly && !mask) added++;
    else if (mask && !poly) removed++;
  }
  return { added, removed };
}

/* ----------------------------------------------------------- the painting */

/* Every painter takes the picture's width and height: a grid is a rectangle
   since the frames were cropped to the parcel (2026-09-23). */
const put = (out, grid, gridH, x, y, colour) => {
  if (x < 0 || y < 0 || x >= grid || y >= gridH) return;
  const p = (y * grid + x) * 4;
  out[p] = colour[0];
  out[p + 1] = colour[1];
  out[p + 2] = colour[2];
};

/** A filled square, used for line thickness and for vertex dots. */
const blob = (out, grid, gridH, cx, cy, half, colour) => {
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) put(out, grid, gridH, cx + dx, cy + dy, colour);
  }
};

/**
 * The boundary of a mask, stamped at the same weight as everything else.
 *
 * An edge cell is one with a neighbour outside the mask. Used for the true
 * lawn and for the inferred areas, neither of which exists as a polygon by the
 * time it reaches here -- both arrive rasterised, on the grid the model was
 * scored on, which is the grid the comparison has to happen on anyway.
 */
function outline(out, grid, gridH, mask, colour, half) {
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < grid; x++) {
      const i = y * grid + x;
      if (!mask[i]) continue;
      const edge = x === 0 || y === 0 || x === grid - 1 || y === gridH - 1
        || !mask[i - 1] || !mask[i + 1] || !mask[i - grid] || !mask[i + grid];
      if (edge) blob(out, grid, gridH, x, y, half, colour);
    }
  }
}

/** Bresenham, thickened by stamping a square at each step. */
function segment(out, grid, gridH, [x0, y0], [x1, y1], half, colour) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const dx = Math.abs(ex - x);
  const dy = -Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = dx + dy;

  /* A guard, not a limit: a ring is at most a few hundred cells around, and a
     runaway here would be an infinite loop inside CI. */
  for (let step = 0; step <= 4 * (grid + gridH); step++) {
    blob(out, grid, gridH, x, y, half, colour);
    if (x === ex && y === ey) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/**
 * One frame, as RGBA bytes ready for a PNG.
 *
 * `photo` is the RGBA the rest of the tool already works from, at grid
 * resolution -- the same pixels the features were computed from, so what is
 * drawn is what the model actually saw, not a prettier copy of it.
 *
 * `rings` comes from tracePrediction, in grid coordinates.
 *
 * `mask` draws the model's RAW per-pixel answer instead of the trace, for the
 * other half of the toggle on /predictions.html. Pass one or the other: the
 * pair is meant to be flipped between, and a picture carrying both would be a
 * picture of neither.
 *
 * `clipMask: false` says the SHAPES beside this mask are not clipped to the
 * property line either, so the mask must not be. Default is to clip, which is
 * right for the detector because tracePrediction clips its rings. It is wrong
 * for anything drawing unclipped polygons -- see the note at the clip itself.
 */
export function drawPrediction({
  photo, truth, within, inferred, rings, grid, mask, clipMask, gridH = grid,
}) {
  const out = new Uint8Array(grid * gridH * 4);

  for (let i = 0; i < grid * gridH; i++) {
    const p = i * 4;
    let r = photo[p];
    let g = photo[p + 1];
    let b = photo[p + 2];

    if (within && !within[i]) {
      /* Dimmed, not hidden. The ground outside the line is what explains an
         over-call at the edge of it. */
      r = Math.round(r * OUTSIDE_DIM);
      g = Math.round(g * OUTSIDE_DIM);
      b = Math.round(b * OUTSIDE_DIM);
    } else if (truth[i]) {
      r = mix(r, TRUTH_FILL[0], TRUTH_ALPHA);
      g = mix(g, TRUTH_FILL[1], TRUTH_ALPHA);
      b = mix(b, TRUTH_FILL[2], TRUTH_ALPHA);
    }

    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = 255;
  }

  /*
   * Thickness scales with the grid rather than being a fixed pixel count: this
   * is viewed on a phone, where a 512-wide picture is drawn into about 360
   * points and a one-pixel line disappears.
   */
  const half = Math.max(1, Math.round(grid / 512));
  const dot = half + 2;

  /*
   * THE TRUE LAWN GETS AN EDGE AS WELL AS A WASH.
   *
   * The wash alone is a weak signal on a photograph that is already mostly
   * grass -- it says "greener here", which needs something to compare against.
   * An edge gives the comparison directly, and it is the comparison the whole
   * page is about: two outlines side by side, one drawn by a person and one by
   * the model. Green line with no red line near it is lawn it gave up on; red
   * line over bare ground is lawn it invented. That is the same reading the
   * console's review card offers, in the same two colours.
   */
  /*
   * Both outlines are clipped to the property line, exactly as the trace is.
   * A green line running out through the dimmed ground would read as scored
   * lawn, which is the one thing the dimming exists to prevent -- and where a
   * lawn genuinely runs to the boundary, the boundary IS its edge.
   */
  const scored = (mask) => {
    if (!within) return mask;
    const m = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) m[i] = mask[i] && within[i] ? 1 : 0;
    return m;
  };

  /*
   * THE PROPERTY LINE FIRST, so everything meaningful draws on top of it. The
   * dimming already says "not scored"; this says where that starts, which is
   * the question every inside/outside number on the page depends on.
   */
  if (within) outline(out, grid, gridH, within, PARCEL_EDGE, Math.max(1, half - 1));

  outline(out, grid, gridH, scored(truth), TRUTH_FILL, half);

  /*
   * The inferred outline next, over the lawn edge and under the trace. An
   * outline rather than a fill because a fill would hide the ground being
   * asked about -- the question is whether the model gives up exactly where
   * the reviewer said "I know it is lawn, I cannot see it".
   */
  if (inferred) outline(out, grid, gridH, scored(inferred), INFERRED_EDGE, half);

  /*
   * THE RAW MASK, WHERE ONE WAS ASKED FOR, and it replaces the trace rather
   * than joining it.
   *
   * These are the same answer at two stages and the whole point of having both
   * pictures is to see what happens between them. The tracer smooths every
   * edge, fills any hole under about 60 sq ft, drops speckle below the area
   * floor and keeps only the biggest few pieces -- all of it wanted, all of it
   * making the model look tidier than it is. traceDrift() says how much in
   * square feet; this says WHERE, which is the part a number cannot carry.
   *
   * Drawn as a stippled wash rather than a solid fill. A solid one would hide
   * the ground underneath, and "what did it call lawn" is only answerable
   * against what is actually there -- gravel, a flat roof, shade. Every other
   * pixel keeps the photograph, so the texture reads through the colour, and
   * the two-pixel checker survives the resize a phone does to this frame
   * where a one-pixel one would dither into mush.
   */
  if (mask) {
    /*
     * CLIPPED EXACTLY WHEN THE SHAPES ARE, and not otherwise. This is the one
     * thing the two pictures must agree on, and the first version got it wrong
     * in a way that read as a result.
     *
     * The detector's rings come out of tracePrediction, which clips them to
     * the property line, so its mask is clipped too and the pair differ only
     * where the TRACER changed something -- which is the whole point of the
     * flip. Crown rings come straight from the watershed and are never
     * clipped, so clipping the canopy under them made the canopy look like it
     * stopped at the boundary while crown outlines carried on past it. The
     * reader's conclusion was "the mask is being cut off", and they were
     * right.
     *
     * `clipMask: false` says the shapes beside this one are unclipped too.
     */
    const clip = clipMask === false ? null : within;
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < grid; x++) {
        const i = y * grid + x;
        if (!mask[i]) continue;
        if (clip && !clip[i]) continue;
        if (((x >> 1) + (y >> 1)) % 2) continue;
        /*
         * WEAKER OUTSIDE THE LINE where it is shown at all, matching the
         * dimming under it. Beyond the boundary this is a fact about the
         * photograph rather than a claim about the property -- a neighbour's
         * tree is still a tree -- and painting it at full strength would put
         * ground nobody is measuring at the same weight as ground somebody is.
         */
        const own = !within || within[i];
        const p = i * 4;
        const a = own ? 0.85 : 0.5;
        out[p] = mix(out[p], TRACE[0], a);
        out[p + 1] = mix(out[p + 1], TRACE[1], a);
        out[p + 2] = mix(out[p + 2], TRACE[2], a);
      }
    }
    /* Its own boundary, solid, so the shape has an edge to read. Without it a
       stipple has no outline and a thin strip of lawn disappears. */
    outline(out, grid, gridH, clip ? scored(mask) : mask, TRACE, half);
    return out;
  }

  /* THE TRACE LAST, so nothing paints over the thing the picture is of. */
  for (const ring of rings || []) {
    for (let i = 1; i < ring.length; i++) {
      segment(out, grid, gridH, ring[i - 1], ring[i], half, TRACE);
    }
    /*
     * A DOT AT EVERY VERTEX, because the handle count IS the answer to "how
     * long would this take to fix". Twenty handles round a lawn is a shape
     * somebody can nudge; two hundred is a shape they would delete and redraw.
     * A pale core so a dot stays visible where the outline doubles back on
     * itself and the dots would otherwise merge into a stripe.
     */
    const last = ring.length > 1
      && ring[0][0] === ring[ring.length - 1][0]
      && ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1 : ring.length;
    for (let i = 0; i < last; i++) {
      const [x, y] = ring[i];
      blob(out, grid, gridH, Math.round(x), Math.round(y), dot, TRACE);
      blob(out, grid, gridH, Math.round(x), Math.round(y), Math.max(0, dot - 2), [255, 245, 240]);
    }
  }

  return out;
}

/**
 * What the picture is of, in numbers, for the page that lists them.
 *
 * Split into the two KINDS of mistake rather than one error figure, because
 * they mean opposite things and the summary error hides which one is
 * happening. A model that misses half the lawn and a model that claims the
 * whole property can score the same and need different work.
 *
 * Measured on the MASK, not on the trace: these are the run's own numbers, the
 * ones in the table and in docs/DETECTOR-FINDINGS.md, and a second set that
 * differed by a percent because of smoothing would be impossible to compare
 * against anything. The trace's own numbers are its piece and handle counts.
 */
export function mistakeCounts({ truth, predicted, within, inferred }) {
  let missed = 0, overcalled = 0, right = 0, lawnPx = 0;
  let missedInferred = 0, inferredPx = 0;

  for (let i = 0; i < truth.length; i++) {
    if (within && !within[i]) continue;
    const isLawn = Boolean(truth[i]);
    const saidLawn = Boolean(predicted[i]);
    if (isLawn) lawnPx++;
    if (inferred && inferred[i]) {
      inferredPx++;
      if (isLawn && !saidLawn) missedInferred++;
    }
    if (isLawn && !saidLawn) missed++;
    else if (!isLawn && saidLawn) overcalled++;
    else if (isLawn) right++;
  }

  return {
    missed,
    overcalled,
    right,
    lawnPx,
    /* Of the lawn there is, how much was found. */
    foundPct: lawnPx ? (100 * right) / lawnPx : null,
    /* Of what it called lawn, how much was not. */
    overPct: lawnPx ? (100 * overcalled) / lawnPx : null,
    /* The same question asked only of the ground the reviewer could not see. */
    inferredPx,
    missedInferredPct: inferredPx ? (100 * missedInferred) / inferredPx : null,
  };
}
