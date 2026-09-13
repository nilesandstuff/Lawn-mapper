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
 * 3. A PIECE IS CONTINUOUS, and one that is not is NOT DRAWN. Lawns wrap
 *    around houses; a band crossing the front of one comes out as two strips
 *    with a building between them, and somebody treating one side and counting
 *    both is the failure this whole tool exists to prevent. A gap you step
 *    over -- a tree, a post, a bed -- is still one piece; MAX_GAP_FT is where
 *    that line sits.
 *
 * 4. ONLY THE GOOD ONES ARE OFFERED. Nothing here tiles a lawn. A piece is
 *    drawn when it is continuous AND close to the size that was asked for, and
 *    the ground where no such piece fits is reported as uncovered instead.
 *    Two thirds of a lawn with pieces you can trust beats all of it with
 *    pieces you cannot: the number on a piece is going to be checked against a
 *    bag, and a wrong one sends somebody to correct a rate that was fine.
 *
 * And the lines run along the LAWN'S OWN EDGES -- parallel to a long straight
 * boundary where possible, starting from a square corner where there is one.
 * A fence is a thing you can see while standing on the grass; a bearing
 * derived from the shape's statistics is not.
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
import {
  rasterizePolygon, labelComponents, polygonsFromBinary, growMask,
} from './mask.js';
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
 * A piece of a band small enough to ignore when deciding whether a band split.
 *
 * Rasterising a diagonal lawn edge leaves single pixels clinging to a corner,
 * and calling a band "split in two" because of nine square feet of stair-step
 * would make the warning worthless by making it constant.
 */
const SPLINTER_FRACTION = 0.06;

/**
 * The widest gap a piece may have in it, in feet.
 *
 * A PIECE HAS TO BE CONTINUOUS, and this is where that rule gets its number.
 * Walking a piece that is really two pieces means crossing something to get
 * between them, and whether that is fine depends entirely on what it is: step
 * round a tree and you have not lost your place; walk round a house and you
 * have no idea which side you already did.
 *
 * Ten feet is the owner's line and a good one -- wider than any tree trunk,
 * bed or post, narrower than any driveway, path or building. Under it the two
 * parts are the same piece with something in the middle; over it they are two
 * pieces pretending.
 */
export const MAX_GAP_FT = 10;

/**
 * How far from the requested size a piece may be and still be offered.
 *
 * THE TOOL'S ONE JOB IS A NUMBER YOU CAN CHECK A BAG AGAINST. A piece that is
 * "about 1,000 sq ft, give or take 40%" cannot do that job -- it would have
 * somebody correcting a rate that was never wrong. So pieces outside this are
 * not drawn at all, and the ground they were on is reported as uncovered
 * instead. Better a plan that covers two thirds of a lawn accurately than one
 * that covers all of it approximately.
 */
const AREA_TOLERANCE = 0.2;

/** An edge has to be this long to be worth steering by. */
const MIN_EDGE_FT = 15;

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
 * The directions worth sweeping in, best first, taken from the lawn's own
 * straight edges.
 *
 * WHY NOT THE PRINCIPAL AXIS, which is what this used to use. A covariance
 * eigenvector describes the blob the lawn makes; it knows nothing about the
 * lines somebody will actually walk along. On a lawn whose long boundary runs
 * at 8 degrees to its overall elongation -- which is most lawns, because a
 * front garden is a rectangle with a driveway bitten out of it -- the bands
 * come out at a slight angle to the fence, and every pass ends in a wedge.
 *
 * The fence is the thing you steer by. So the candidates are the bearings of
 * the long straight edges of the outline, and the band lines run PARALLEL to
 * them where possible: walking beside a boundary you can see beats walking on
 * a bearing you have to guess. Perpendicular is offered too, since a lawn's
 * best line is sometimes across its frontage rather than along it.
 *
 * A NEAR-RIGHT-ANGLED CORNER SCORES HIGHEST of all, because a corner is
 * somewhere to start: two visible edges meeting, so the first pass has a known
 * beginning and a known direction rather than a guessed offset.
 *
 * Returned as radians of the SWEEP direction -- perpendicular to the band
 * lines -- so a band parallel to an edge of bearing b sweeps at b + 90.
 */
function candidateAngles(ringsXY, minEdgeM) {
  const bearings = new Map(); // 5-degree bucket -> { score, angle }

  const add = (angle, score) => {
    // Bands have no direction, so a bearing and its opposite are one line.
    let a = angle % Math.PI;
    if (a < 0) a += Math.PI;
    const key = Math.round((a * 180) / Math.PI / 5);
    const prev = bearings.get(key);
    if (!prev || score > prev.score) bearings.set(key, { angle: a, score: (prev?.score || 0) + score });
    else prev.score += score;
  };

  for (const ringList of ringsXY) {
    for (const ring of ringList) {
      const n = ring.length - 1;
      if (n < 2) continue;

      const edges = [];
      for (let i = 0; i < n; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[(i + 1) % n];
        const len = Math.hypot(bx - ax, by - ay);
        edges.push({ len, angle: Math.atan2(by - ay, bx - ax) });
      }

      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e.len < minEdgeM) continue;

        // Length is the weight: a 30m boundary is a better thing to steer by
        // than a 5m one, and squaring it makes the long edges decisive rather
        // than merely ahead.
        add(e.angle, e.len * e.len);

        /*
         * A corner worth starting in: this edge and the next, both long, meeting
         * near a right angle. Scored on the pair, so a lawn with one square
         * corner and a lot of wandering boundary still starts in the corner.
         */
        const next = edges[(i + 1) % edges.length];
        if (next.len < minEdgeM) continue;
        let turn = Math.abs(next.angle - e.angle) % Math.PI;
        if (turn > Math.PI / 2) turn = Math.PI - turn;
        const square = Math.abs(turn - Math.PI / 2) < (10 * Math.PI) / 180;
        if (square) add(e.angle, e.len * next.len);
      }
    }
  }

  const ranked = [...bearings.values()].sort((a, b) => b.score - a.score).slice(0, 3);

  /*
   * Parallel first, then perpendicular, in score order. The caller tries them
   * in this order and keeps the first that works as well as any later one, so
   * the order IS the preference: parallel to the longest edge, then across it,
   * then the next edge, and so on.
   */
  const out = [];
  for (const { angle } of ranked) out.push(angle + Math.PI / 2);
  for (const { angle } of ranked) out.push(angle);
  return out;
}

/**
 * The section's long axis, as a last resort.
 *
 * Only used when the outline has no edge straight enough to steer by -- a lawn
 * traced freehand with a finger, where every "edge" is two metres long. A
 * covariance eigenvector, which for 2x2 is one arctangent and no iteration.
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
  let coveredPx = 0;
  let rejected = 0;
  // The smallest piece this lawn can produce: one pass, all the way across.
  // Kept so a target below it can be explained rather than merely refused.
  let onePassSqFt = Infinity;

  const maxGapPx = (MAX_GAP_FT / FEET_PER_METRE) / mpp;
  const minEdgeM = MIN_EDGE_FT / FEET_PER_METRE;
  const angles = candidateAngles(xy, minEdgeM);

  for (const [sectionIndex, id] of sections.entries()) {
    const pixels = [];
    for (let p = 0; p < labels.length; p++) if (labels[p] === id) pixels.push(p);

    const passPx = Math.max(1, widthM / mpp);

    /*
     * IS THIS ONE PIECE, OR IS IT TWO WITH SOMETHING BETWEEN THEM?
     *
     * Splinters -- the stray pixels a diagonal edge leaves clinging to a
     * corner -- are ignored, or every band on every angled lawn would count as
     * broken. Beyond that the question is not "how many parts" but "how far
     * apart", because a piece split by a tree is still a piece and a piece
     * split by a driveway is not.
     *
     * The gap is measured by growing the parts toward each other by half the
     * allowance: anything closer than MAX_GAP_FT closes up and anything wider
     * stays apart. Growing is only paid for when there IS more than one part,
     * which on most bands is never.
     */
    const continuity = (region, count) => {
      const parts = labelComponents(region, W, H);
      const real = parts.sizes.slice(1).filter((size) => size > count * SPLINTER_FRACTION);
      if (real.length <= 1) return { whole: true, parts: 1 };

      const closed = growMask(region, W, H, Math.max(1, Math.round(maxGapPx / 2)));
      const joined = labelComponents(closed, W, H);
      const stillApart = joined.sizes.slice(1).filter((size) => size > count * SPLINTER_FRACTION);
      return { whole: stillApart.length <= 1, parts: real.length };
    };

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

      /*
       * The typical single pass, for explaining a target nothing can reach.
       * The median rather than the mean, because the first and last pass of a
       * section are partial and would drag an average down.
       */
      const sorted = [...areas].filter((a) => a > 0).sort((a, b) => a - b);
      if (sorted.length) {
        onePassSqFt = Math.min(onePassSqFt, sqFt(sorted[Math.floor(sorted.length / 2)]));
      }

      /*
       * SCORED ON THE GROUND IT COVERS WITH PIECES SOMEBODY CAN USE, which is
       * the only thing the caller wants. A band that is broken by a driveway,
       * or that came out half the requested size, is worth nothing here -- so
       * it contributes nothing, and an angle that produces four good pieces
       * beats one that produces nine bad ones.
       */
      const good = [];
      let usable = 0;
      for (const run of runs) {
        const region = new Uint8Array(W * H);
        let count = 0;
        for (let b = run.start; b < run.end; b++) {
          for (const p of inBucket[b]) { region[p] = 1; count++; }
        }
        if (!count) continue;

        const areaSqFt = sqFt(count * pxSqM);
        const offBy = Math.abs(areaSqFt - target) / target;
        const { whole, parts } = continuity(region, count);

        if (whole && offBy <= AREA_TOLERANCE) {
          good.push({ run, region, count, areaSqFt });
          usable += count;
        }
      }

      return { good, usable, tried: runs.length };
    };

    /*
     * Try the lawn's own lines in order of how good a line they are, and keep
     * whichever covers the most ground with usable pieces. The first candidate
     * that ties the best wins, so the preference order in candidateAngles --
     * parallel to the longest edge, then across it -- decides between equals.
     *
     * The principal axis is appended as a fallback for an outline with no
     * straight edge long enough to steer by, which is what a lawn traced
     * freehand with a finger looks like.
     */
    let best = null;
    for (const angle of [...angles, principalAngle(pixels, W)]) {
      const got = attempt(angle);
      if (!best || got.usable > best.usable) best = got;
    }
    if (!best) continue;

    rejected += best.tried - best.good.length;

    for (const [index, band] of best.good.entries()) {
      const { region, count, areaSqFt, run } = band;
      const passes = run.end - run.start;

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
        geometry: shapes.length === 1
          ? shapes[0]
          : { type: 'MultiPolygon', coordinates: shapes.map((g) => g.coordinates) },
        at: labelPoint(region, W, H, fromPx),
      });
    }
  }

  /*
   * WHAT IS NOT COVERED, ONCE, WITH THE REASON.
   *
   * Pieces that were broken by something wider than MAX_GAP_FT, or that came
   * out too far from the requested size, are not drawn at all now -- so the
   * honest report is no longer "piece 7 is in two parts" but "this much of the
   * lawn has no piece on it". That is a better thing to tell somebody: they
   * can see the gaps on the map, and what they need to know is how much lawn
   * they are treating off-plan.
   */
  const uncovered = Math.round(totalSqFt - sqFt(coveredPx * pxSqM));
  if (segments.length && uncovered > totalSqFt * 0.02) {
    notes.push(
      `${uncovered.toLocaleString()} sq ft has no piece on it — the lawn there is `
      + 'broken up by a drive, a building or a bed, so no continuous piece of about '
      + `${target.toLocaleString()} sq ft fits. Treat it by eye, or try a smaller piece size.`
    );
  }

  /*
   * WHEN NOTHING FITS, SAY WHICH WALL WAS HIT.
   *
   * "No piece fits" is true and useless three different ways, and the three
   * have opposite fixes: a target smaller than one pass wants a BIGGER target,
   * a target bigger than the lawn wants a smaller one, and a lawn chopped up
   * by a drive wants a smaller one too. Handing back the same sentence for all
   * three sends two thirds of people the wrong way.
   */
  if (!segments.length) {
    if (totalSqFt < target * (1 - AREA_TOLERANCE)) {
      notes.push(
        `The whole lawn is ${Math.round(totalSqFt).toLocaleString()} sq ft, which is `
        + `smaller than one ${target.toLocaleString()} sq ft piece. Choose a piece size `
        + 'below that and it will divide.'
      );
    } else if (onePassSqFt > target * (1 + AREA_TOLERANCE)) {
      notes.push(
        `One ${trimNumber(width)} ft pass across this lawn already covers about `
        + `${Math.round(onePassSqFt).toLocaleString()} sq ft, so a `
        + `${target.toLocaleString()} sq ft piece cannot span it. Pick a piece size `
        + 'of about that or more, or a narrower application width.'
      );
    } else {
      notes.push(
        `No continuous piece of about ${target.toLocaleString()} sq ft fits in this lawn. `
        + 'A smaller piece size usually finds some — pieces have to be in one part, with '
        + `nothing wider than ${MAX_GAP_FT} ft cutting through them.`
      );
    }
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
