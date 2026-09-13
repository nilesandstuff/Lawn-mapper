/**
 * Cutting a measured lawn into pieces you can actually walk.
 *
 * WHAT THIS IS FOR, because the shape of the answer follows from it. You are
 * about to spread something at a rate per thousand square feet. If you treat
 * the whole lawn and only then weigh what is left in the hopper, you find out
 * you were 30% off after it is on the ground and there is nothing to do about
 * it. So the lawn gets divided into known-size pieces: do one, check the bag,
 * correct, do the next.
 *
 * That purpose sets three requirements that ordinary polygon subdivision does
 * not have.
 *
 * 1. A PIECE MUST SPAN THE LAWN, edge to edge. A piece whose end sits in the
 *    middle of an open expanse is useless, because standing on the grass there
 *    is no way to see where it stops. Every cut here runs clean across, so the
 *    two things bounding a piece are the lawn's own edges and a line to the far
 *    side. This is the constraint that rules out quadtrees, equal-area splits
 *    and every other tidy recursive scheme.
 *
 * 2. A PIECE IS A WHOLE NUMBER OF PASSES. You walk it with a spreader of some
 *    width, so a piece four and a half passes deep is one you have to walk
 *    wrong. Depth is quantised to the application width before area is
 *    considered, which means the area of a piece is approximate and its pass
 *    count is exact -- the right way round, since the pass count is what you
 *    execute and the area is what you check against.
 *
 * 3. IT HAS TO ADMIT WHEN IT CANNOT. Lawns wrap around houses. A band crossing
 *    the front of a house comes out as two disconnected strips, which is not a
 *    piece, and pretending otherwise would have somebody treating one side and
 *    counting both. Those are found and reported rather than drawn.
 *
 * HOW. Rasterise, then sweep.
 *
 * Analytic polygon clipping would give exact edges and would have to solve
 * concave-polygon-against-strip clipping, hole handling, and splitting into
 * disconnected components -- three problems the raster path already has
 * solved code for in mask.js, which is how the lawn got clipped to the
 * property line in the first place. The cost is a pixel of edge resolution on
 * a shape whose own edges came from a segmentation model and a person's
 * finger. That is the right trade here, and the same one made there.
 */

import { makeFrame, FEET_PER_METRE } from './edges.js';
import { rasterizePolygon, labelComponents, polygonsFromBinary } from './mask.js';
import { SQM_PER_SQFT } from './area.js';

/** The sizes the tool offers, in square feet. */
export const MIN_SEGMENT_SQFT = 1000;
export const MAX_SEGMENT_SQFT = 30000;
export const SEGMENT_STEP_SQFT = 1000;

/** Spreader and sprayer widths that exist, in feet. */
export const MIN_WIDTH_FT = 2;
export const MAX_WIDTH_FT = 12;
export const DEFAULT_WIDTH_FT = 5;

/**
 * Below this, a leftover is a sliver rather than a piece.
 *
 * The last band of a section is whatever is left over, and it is often small.
 * A quarter of the target is the line between "a small last piece, do it and
 * move on" and "a strip the tool should be honest about", picked so that a
 * 1,000 sq ft target does not produce 250 sq ft slivers people are asked to
 * measure against.
 */
const SLIVER_FRACTION = 0.25;

/**
 * A piece of a band small enough to ignore when deciding whether a band split.
 *
 * Rasterising a diagonal lawn edge leaves single pixels clinging to a corner,
 * and calling a band "split in two" because of nine square feet of stair-step
 * would make the warning worthless by making it constant.
 */
const SPLINTER_FRACTION = 0.06;

const sqFt = (sqM) => sqM / SQM_PER_SQFT;

/**
 * A grid fine enough to be honest and coarse enough to be quick.
 *
 * Two constraints, and the tighter one wins. The lawn has to fit in a
 * reasonable number of pixels, AND one application pass has to be several
 * pixels deep -- because a pass is the unit the whole answer is quantised to,
 * and a two-foot pass rounded to one pixel would make every band's depth wrong
 * by up to half a pass.
 */
function chooseResolution(spanM, widthM, gridMax) {
  const fromSpan = spanM / gridMax;
  const fromPass = widthM / 4;
  // Never finer than 5cm: past that the grid is modelling the raster of the
  // satellite photograph rather than the lawn.
  return Math.max(0.05, Math.min(fromSpan, fromPass));
}

/**
 * The direction to sweep in: the section's long axis.
 *
 * Cutting across the long axis is what makes a band wide and shallow rather
 * than long and thin, which is both the more rectangle-like shape and the one
 * with fewer turns to walk. Found by the principal axis of the section's own
 * pixels -- a covariance eigenvector, which for 2x2 is one arctangent and no
 * iteration.
 *
 * A perfectly round section has no long axis and the covariance is isotropic;
 * the formula then returns an arbitrary but stable angle, which is the correct
 * behaviour because for a circle every direction is equally good.
 */
function principalAngle(pixels, width) {
  let sx = 0;
  let sy = 0;
  for (const p of pixels) { sx += p % width; sy += (p / width) | 0; }
  const n = pixels.length;
  const mx = sx / n;
  const my = sy / n;

  let vxx = 0;
  let vyy = 0;
  let vxy = 0;
  for (const p of pixels) {
    const dx = (p % width) - mx;
    const dy = ((p / width) | 0) - my;
    vxx += dx * dx; vyy += dy * dy; vxy += dx * dy;
  }

  // The major eigenvector's angle. atan2 with the doubled angle form, which
  // avoids the divide-by-zero an eigenvector solve would hit on an axis-aligned
  // rectangle -- the single most common lawn there is.
  return 0.5 * Math.atan2(2 * vxy, vxx - vyy);
}

/**
 * Bands for one section: runs of whole passes, each as near the target area as
 * a whole number of passes allows.
 *
 * The greedy walk takes passes until adding one more would overshoot the
 * target by MORE than stopping short undershoots it. Greedy is right here
 * rather than merely easy: the alternative is balancing the error across the
 * whole section, which would move every cut line to make the last one tidier,
 * and the person walking it does the first piece first. A tidy last piece is
 * worth nothing; a first piece that matches the number on the bag is worth
 * everything.
 */
function bandRuns(passAreas, targetSqM) {
  const runs = [];
  let start = 0;

  while (start < passAreas.length) {
    let area = 0;
    let end = start;

    while (end < passAreas.length) {
      const next = area + passAreas[end];
      // Always take at least one pass, or a section whose every pass is bigger
      // than the target would produce an infinite run of empty bands.
      if (end > start && Math.abs(next - targetSqM) > Math.abs(area - targetSqM)) break;
      area = next;
      end++;
    }

    runs.push({ start, end, area });
    start = end;
  }

  return runs;
}

/**
 * Divide a measured lawn into walkable pieces.
 *
 * `rings` is one entry per lawn polygon, each a GeoJSON-style ring list (outer
 * first, then holes) in lng/lat -- the same shape the rest of this app passes
 * around.
 *
 * Returns the pieces, and the notes about what could not be done. The notes
 * are part of the answer and not a side channel: a plan that silently covers
 * 60% of a lawn is worse than no plan, because the missing 40% is invisible
 * until somebody is standing on it.
 */
export function planSegments({
  rings,
  targetSqFt = 5000,
  widthFt = DEFAULT_WIDTH_FT,
  gridMax = 520,
} = {}) {
  const notes = [];
  const polygons = (rings || []).filter((r) => Array.isArray(r) && r.length && r[0]?.length >= 3);
  if (!polygons.length) return { segments: [], notes: ['There is no lawn to divide yet.'], coveredSqFt: 0, totalSqFt: 0 };

  const target = Math.max(1, Number(targetSqFt) || 0);
  const width = Math.max(0.5, Number(widthFt) || DEFAULT_WIDTH_FT);
  const widthM = width / FEET_PER_METRE;
  const targetSqM = target * SQM_PER_SQFT;

  /* ---------------------------------------------------------- the plane */
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ringList of polygons) {
    for (const [lng, lat] of ringList[0]) {
      w = Math.min(w, lng); e = Math.max(e, lng);
      s = Math.min(s, lat); n = Math.max(n, lat);
    }
  }
  const frame = makeFrame([(w + e) / 2, (s + n) / 2]);

  const xy = polygons.map((ringList) => ringList.map((ring) => ring.map(frame.toXY)));
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ringList of xy) {
    for (const [x, y] of ringList[0]) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }

  const span = Math.max(x1 - x0, y1 - y0);
  if (!(span > 0)) return { segments: [], notes: ['That lawn is too small to divide.'], coveredSqFt: 0, totalSqFt: 0 };

  const mpp = chooseResolution(span, widthM, gridMax);
  const pad = 2;
  const W = Math.min(2000, Math.ceil((x1 - x0) / mpp) + pad * 2);
  const H = Math.min(2000, Math.ceil((y1 - y0) / mpp) + pad * 2);

  // y is flipped so the grid reads like an image; the inverse below undoes it.
  const toPx = ([x, y]) => [(x - x0) / mpp + pad, (y1 - y) / mpp + pad];
  const fromPx = (px, py) => frame.toLngLat([(px - pad) * mpp + x0, y1 - (py - pad) * mpp]);

  /* ------------------------------------------------------- the whole lawn */
  const bin = new Uint8Array(W * H);
  for (const ringList of xy) {
    const one = rasterizePolygon(ringList, W, H, toPx);
    for (let p = 0; p < bin.length; p++) if (one[p]) bin[p] = 1;
  }

  const pxSqM = mpp * mpp;
  let lawnPx = 0;
  for (let p = 0; p < bin.length; p++) lawnPx += bin[p];
  const totalSqFt = sqFt(lawnPx * pxSqM);
  if (!lawnPx) return { segments: [], notes: ['That lawn is too small to divide.'], coveredSqFt: 0, totalSqFt: 0 };

  /* ---------------------------------------------------------- the sections */
  const { labels, sizes } = labelComponents(bin, W, H);
  const sections = [];
  for (let id = 1; id < sizes.length; id++) {
    // A section smaller than a tenth of a target is a speck of stray detection,
    // not a part of the lawn somebody walks to.
    if (sizes[id] * pxSqM < targetSqM * 0.1) continue;
    sections.push(id);
  }
  if (!sections.length) return { segments: [], notes: ['That lawn is too small to divide.'], coveredSqFt: 0, totalSqFt };

  const segments = [];
  const broken = [];
  let coveredPx = 0;

  for (const [sectionIndex, id] of sections.entries()) {
    const pixels = [];
    for (let p = 0; p < labels.length; p++) if (labels[p] === id) pixels.push(p);

    /*
     * BOTH WAYS, AND KEEP THE ONE THAT BREAKS FEWER PIECES.
     *
     * The long axis is the better default -- it makes bands wide and shallow,
     * which is the more rectangle-like shape and the one with fewer turns to
     * walk. But "better shaped" loses to "in one piece" every time: a band cut
     * across a lawn that wraps a house comes out as two strips, and two strips
     * with a building between them is not something anybody can walk as a unit.
     *
     * A real lot has a house AND a driveway, so one direction is often much
     * worse than the other and there is no way to tell which from the outline
     * alone. Both are a few milliseconds, so both get tried and the answer is
     * measured rather than predicted. Ties go to the long axis.
     */
    const theta = principalAngle(pixels, W);
    const passPx = Math.max(1, widthM / mpp);

    const attempt = (angle) => {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      let uMin = Infinity;
      const us = new Float64Array(pixels.length);
      for (let i = 0; i < pixels.length; i++) {
        const u = (pixels[i] % W) * cos + (((pixels[i] / W) | 0)) * sin;
        us[i] = u;
        if (u < uMin) uMin = u;
      }

      const bucketOf = (u) => Math.floor((u - uMin) / passPx);
      let buckets = 0;
      for (let i = 0; i < pixels.length; i++) buckets = Math.max(buckets, bucketOf(us[i]) + 1);

      const areas = new Float64Array(buckets);
      const inBucket = Array.from({ length: buckets }, () => []);
      for (let i = 0; i < pixels.length; i++) {
        const b = bucketOf(us[i]);
        areas[b] += pxSqM;
        inBucket[b].push(pixels[i]);
      }

      const runs = bandRuns(areas, targetSqM);

      // How many of these bands would come out in more than one piece. This is
      // the number being optimised, so it is counted on the cheap mask rather
      // than by tracing polygons for an orientation that may be discarded.
      let broken = 0;
      for (const run of runs) {
        const region = new Uint8Array(W * H);
        let count = 0;
        for (let b = run.start; b < run.end; b++) {
          for (const p of inBucket[b]) { region[p] = 1; count++; }
        }
        if (!count) continue;
        const parts = labelComponents(region, W, H);
        const real = parts.sizes.slice(1).filter((size) => size > count * SPLINTER_FRACTION);
        if (real.length > 1) broken++;
      }

      return { runs, inBucket, broken };
    };

    const along = attempt(theta);
    const across = attempt(theta + Math.PI / 2);
    const best = across.broken < along.broken ? across : along;
    const { runs, inBucket: passPixels } = best;

    for (const [index, run] of runs.entries()) {
      const region = new Uint8Array(W * H);
      let count = 0;
      for (let b = run.start; b < run.end; b++) {
        for (const p of passPixels[b]) { region[p] = 1; count++; }
      }
      if (!count) continue;

      /*
       * DID THIS BAND COME OUT IN ONE PIECE? The whole promise of the tool is
       * that a piece runs clean across the lawn, and a band crossing a lawn
       * that wraps around a house does not -- it is two strips with a building
       * between them. Splinters from the raster's stair-stepping are ignored;
       * a genuine second piece is reported and the band is still drawn, since
       * seeing the shape is how somebody decides whether to trust it.
       */
      const parts = labelComponents(region, W, H);
      const real = parts.sizes
        .map((size, i) => ({ size, i }))
        .slice(1)
        .filter((c) => c.size > count * SPLINTER_FRACTION);

      const areaSqFt = sqFt(count * pxSqM);
      const passes = run.end - run.start;
      const sliver = areaSqFt < target * SLIVER_FRACTION;

      const shapes = polygonsFromBinary(region, W, H, fromPx, {
        minAreaFraction: 0,
        minHoleFraction: 0.00002,
        tolerance: 1.2,
        maxVertices: 200,
        maxPolygons: 8,
      });
      if (!shapes.length) continue;

      coveredPx += count;
      segments.push({
        sectionIndex,
        index,
        passes,
        widthFt: width,
        squareFeet: Math.round(areaSqFt),
        label: `${passes} pass${passes === 1 ? '' : 'es'} of ${trimNumber(width)} ft`,
        split: real.length > 1,
        sliver,
        geometry: shapes.length === 1
          ? shapes[0]
          : { type: 'MultiPolygon', coordinates: shapes.map((g) => g.coordinates) },
        at: labelPoint(region, W, H, fromPx),
      });

      if (real.length > 1) broken.push(segments.length);
      if (sliver && index === runs.length - 1) {
        notes.push(
          `Piece ${segments.length} is the leftover at the end of a section, `
          + `about ${Math.round(areaSqFt).toLocaleString()} sq ft rather than `
          + `${target.toLocaleString()}. Nothing divides evenly.`
        );
      }
    }
  }

  /*
   * ONE NOTE FOR ALL THE BROKEN PIECES, NOT ONE EACH.
   *
   * A house-and-driveway lot breaks five bands, and five copies of the same
   * sentence is how a warning becomes wallpaper -- the reader stops at the
   * second one and never reaches the note that is actually about their lawn.
   * The piece numbers are what differs, so the piece numbers are the list and
   * the explanation is said once.
   */
  if (broken.length) {
    notes.unshift(
      `${broken.length === 1 ? 'Piece' : 'Pieces'} ${listOf(broken)} came out in `
      + 'more than one part — the lawn wraps around something there, so no single '
      + 'strip crosses it. Treat the parts of a piece together; the areas still hold.'
    );
  }

  if (sections.length > 1) {
    notes.unshift(
      `This lawn is in ${sections.length} separate sections, so each one is divided on `
      + 'its own. Pieces do not run between them.'
    );
  }

  return {
    segments,
    notes,
    sections: sections.length,
    totalSqFt: Math.round(totalSqFt),
    coveredSqFt: Math.round(sqFt(coveredPx * pxSqM)),
    metresPerPixel: mpp,
  };
}

/** "1, 2 and 5" -- a list somebody reads out loud, not "1,2,5". */
function listOf(numbers) {
  if (numbers.length === 1) return String(numbers[0]);
  if (numbers.length === 2) return `${numbers[0]} and ${numbers[1]}`;
  return `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
}

/** "5" not "5.0", and "4.5" when somebody really does have a 4.5ft spreader. */
function trimNumber(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/**
 * Somewhere inside the band to put its label.
 *
 * The centroid of a band is not reliably inside it -- a band bent around a
 * corner puts its average in the neighbour's driveway -- so the centroid is
 * only a starting guess, and what is returned is the band pixel nearest to it.
 * That is inside by construction, and for the overwhelmingly common case of a
 * roughly rectangular band it IS the centroid.
 */
function labelPoint(region, width, height, fromPx) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let p = 0; p < region.length; p++) {
    if (!region[p]) continue;
    sx += p % width; sy += (p / width) | 0; n++;
  }
  if (!n) return null;

  const cx = sx / n;
  const cy = sy / n;

  let best = -1;
  let bestD = Infinity;
  for (let p = 0; p < region.length; p++) {
    if (!region[p]) continue;
    const dx = (p % width) - cx;
    const dy = ((p / width) | 0) - cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = p; }
  }
  return fromPx(best % width, (best / width) | 0);
}
