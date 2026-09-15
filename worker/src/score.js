/**
 * How wrong is the detector, in square feet, against maps a person approved?
 *
 * THE QUESTION THIS EXISTS TO STOP BEING AN ARGUMENT.
 *
 * "Would a different model be better?" "Is that prompt an improvement?" "Did
 * the trim work?" Every one of those was answerable only by looking at a
 * screenshot and forming an impression, and an impression cannot be compared
 * with last week's impression. The corpus already holds both outlines for
 * every approved map -- the detector's own answer and the one somebody
 * corrected it into -- so the comparison is sitting in the database waiting to
 * be subtracted.
 *
 * SQUARE FEET, NOT IoU, per Rule 6 of docs/training-data.md. IoU is the metric
 * the literature uses and it is not the thing anybody buys: a lawn care quote
 * is priced per thousand square feet, so an error that matters is one that
 * moves the price. A model can gain three IoU points and lose money.
 *
 * TWO NUMBERS, DELIBERATELY, because square footage alone can be right for the
 * wrong reasons. A detection that grabs the neighbour's hedge and misses the
 * same area of back lawn has the correct total and is wrong everywhere:
 *
 *   signedSqFt  detected minus truth -- the number on the invoice, and the one
 *               whose SIGN says whether the fault is overshoot or undershoot
 *   wrongSqFt   ground the two disagree about, either way round -- which
 *               cannot cancel, and is the honest "how much did it get wrong"
 *
 * Pure, and separate from anything that fetches: the scoring can be checked
 * against made-up outlines with no database, no imagery and no money spent.
 */

import { measure } from '../../public/lib/area.js';
import { rasterizePolygon, unionMasks } from '../../public/lib/mask.js';
import { lngLatToFramePx, metresPerPixel, zoomToFit } from '../../public/lib/mercator.js';

const SQM_PER_SQFT = 0.09290304;

/*
 * How finely the disagreement is measured.
 *
 * Not the 1280 the editor rasterises at. This runs once per map rather than
 * once per frame of a drag, but it also runs over every approved map in the
 * corpus, and the answer wanted is an AREA rather than an outline: at 512
 * across a 150 m frame each pixel is about 3 sq ft, so a hundred square feet
 * of disagreement is some thirty pixels. Far more resolution than a figure
 * quoted to the nearest ten needs.
 */
const SCORE_GRID = 512;

/** Every ring list in a list of geometries, for rasterising as one shape. */
function ringLists(geometries) {
  return (geometries || [])
    .map((g) => (g?.type === 'Feature' ? g.geometry : g))
    .filter((g) => g?.type === 'Polygon' && Array.isArray(g.coordinates))
    .map((g) => g.coordinates);
}

/** The geodesic area of a list of geometries, in square feet, holes subtracted. */
export function areaSqFt(geometries) {
  return ringLists(geometries).reduce(
    (sum, coordinates) => sum + measure({ type: 'Polygon', coordinates }).squareFeetRaw,
    0
  );
}

/** A bounding box round everything passed in, or null if there is nothing. */
function boundsOf(...groups) {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  let any = false;
  for (const group of groups) {
    for (const rings of ringLists(group)) {
      for (const ring of rings) {
        for (const [lng, lat] of ring) {
          any = true;
          w = Math.min(w, lng); e = Math.max(e, lng);
          s = Math.min(s, lat); n = Math.max(n, lat);
        }
      }
    }
  }
  return any ? [w, s, e, n] : null;
}

/**
 * Score one map: the detector's outline against the one a person approved.
 *
 * `parcel` clips both before comparing, which is not tidying -- it is the only
 * way the two are comparable. The app trims what it shows to the property
 * line, so scoring an untrimmed detection against a trimmed truth would charge
 * the model for the neighbours' grass, which it was never allowed to keep.
 *
 * Returns null when there is nothing to compare, rather than a zero: a map
 * with no stored detection is missing from the measurement, and counting it as
 * a perfect score would quietly improve every average by adding nothing.
 */
export function scoreMap({ truth, detected, parcel = null, grid = SCORE_GRID } = {}) {
  const truthRings = ringLists(truth);
  const detectedRings = ringLists(detected);
  if (!truthRings.length || !detectedRings.length) return null;

  const bbox = boundsOf(truth, detected, parcel ? [parcel] : []);
  if (!bbox) return null;

  /*
   * THE ZOOM CLAMP COMES OFF, because nothing here is being fetched.
   *
   * zoomToFit stops at 20 for imagery: that is the deepest any provider
   * actually serves, and asking for 22 gets an upscaled blur. This grid is
   * arithmetic, so the ceiling only costs resolution -- a small courtyard lot
   * would be measured across about 180 pixels instead of the 450 the grid
   * could give it, and a metric should not be coarser on small lawns than on
   * large ones when nothing forces it to be.
   *
   * An ordinary suburban lot does not reach the clamp at all (a 37 m lot fits
   * at zoom 19.4), so this changes nothing for most of the corpus. It is a
   * floor under the small ones, not a fix for a bug.
   */
  const frame = {
    lng: (bbox[0] + bbox[2]) / 2,
    lat: (bbox[1] + bbox[3]) / 2,
    zoom: zoomToFit(bbox, grid, { minZoom: 0, maxZoom: 28 }),
    size: grid,
  };
  const project = (ll) => lngLatToFramePx(frame, ll, grid, grid);

  const paint = (rings) => unionMasks(rings.map((r) => rasterizePolygon(r, grid, grid, project)));
  const inside = parcel ? rasterizePolygon(ringLists([parcel])[0] || [], grid, grid, project) : null;

  const a = paint(truthRings);
  const b = paint(detectedRings);

  let both = 0;
  let onlyTruth = 0;
  let onlyDetected = 0;
  for (let p = 0; p < a.length; p++) {
    if (inside && !inside[p]) continue;
    const t = a[p];
    const d = b[p];
    if (t && d) both++;
    else if (t) onlyTruth++;
    else if (d) onlyDetected++;
  }

  const mPerPx = metresPerPixel(frame, grid);
  const px = (mPerPx * mPerPx) / SQM_PER_SQFT;

  /*
   * The totals come from the RASTER rather than from geodesic area, so that
   * every number in the row is measured the same way and they add up. Mixing
   * an exact geodesic total with a rastered disagreement gives a row where
   * truth + extra - missed does not equal detected, by a few square feet that
   * are pure method difference and look like a bug.
   */
  const truthSqFt = (both + onlyTruth) * px;
  const detectedSqFt = (both + onlyDetected) * px;
  const extraSqFt = onlyDetected * px;
  const missedSqFt = onlyTruth * px;
  const wrongSqFt = extraSqFt + missedSqFt;

  return {
    truthSqFt,
    detectedSqFt,
    /* The number on the invoice. Positive means it claimed too much lawn. */
    signedSqFt: detectedSqFt - truthSqFt,
    /* Grass it invented, and grass it missed. These never cancel. */
    extraSqFt,
    missedSqFt,
    wrongSqFt,
    /*
     * As a share of the real lawn, which is how an error is actually felt.
     *
     * BOTH SIDES IN SQUARE FEET. The first version divided a PIXEL COUNT by a
     * square footage and reported 333% on a lawn that was 25% too big -- an
     * answer that moves when the grid resolution changes and has no units at
     * all. It looked like a plausible percentage, which is what makes a units
     * error in a metric worth a test rather than a careful read.
     */
    errorPct: truthSqFt > 0 ? (100 * wrongSqFt) / truthSqFt : null,
    signedPct: truthSqFt > 0 ? (100 * (detectedSqFt - truthSqFt)) / truthSqFt : null,
  };
}

/** The middle value, which is what to quote when one bad lot can skew a mean. */
export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The canopy grades, named for a reader rather than for the column.
 *
 * `null` is its own bucket and not folded into "none": a map nobody graded is
 * missing from this breakdown, and counting it as treeless would make the easy
 * column look bigger and better than it is.
 */
export const CANOPY_LABEL = {
  0: 'no canopy',
  1: 'some canopy',
  2: 'canopy decided the edge',
  ungraded: 'not graded yet',
};

/**
 * Roll a pile of scored maps into the few sentences worth reading on a phone.
 *
 * MEDIAN RATHER THAN MEAN for the headline. One lot where the detector
 * returned the whole parcel moves a mean by more than ten ordinary lots do,
 * and the question being asked is "what does this usually do".
 *
 * BROKEN OUT BY CANOPY GRADE, which is the first real job that grade has. The
 * whole premise of the hard slice is that the fault lives in the tree cases,
 * and that is a claim nobody has ever checked -- if the error turns out to be
 * the same either side of it, the grade is measuring nothing and the effort
 * spent grading belongs somewhere else.
 */
export function summarise(scored = []) {
  const rows = scored.filter((r) => r && Number.isFinite(r.errorPct));

  const group = (list) => {
    if (!list.length) return null;
    const over = list.filter((r) => r.signedSqFt > 0).length;
    return {
      maps: list.length,
      medianErrorPct: median(list.map((r) => r.errorPct)),
      medianSignedPct: median(list.map((r) => r.signedPct)),
      /*
       * Which direction the fault runs, which is the whole reason this was
       * built: a detector that is 20% out at random needs more data, and one
       * that is 20% out in the SAME direction every time needs a trim -- days
       * of work rather than months.
       */
      overshootShare: list.length ? over / list.length : null,
      extraSqFt: list.reduce((n, r) => n + r.extraSqFt, 0),
      missedSqFt: list.reduce((n, r) => n + r.missedSqFt, 0),
    };
  };

  const byCanopy = {};
  for (const key of [0, 1, 2, 'ungraded']) {
    const bucket = group(rows.filter((r) => (r.canopy ?? 'ungraded') === key));
    if (bucket) byCanopy[key] = bucket;
  }

  return { overall: group(rows), byCanopy, skipped: scored.length - rows.length };
}

/**
 * What the run should say at the end, in the words somebody reads on a phone.
 *
 * THE LAST FEW LINES ARE THE REPORT. A log is about eighteen hundred lines and
 * nobody scrolls one on a phone, so whatever was worth running this for is
 * repeated here -- and it is written as a finding rather than as a table,
 * because "18% out, and it overshoots" is a decision and a column of numbers
 * is homework.
 */
export function verdict(summary, { label = 'the detector' } = {}) {
  const o = summary?.overall;
  if (!o) return [`No approved map had both outlines stored, so ${label} could not be scored.`];

  const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '—');
  const lines = [];

  const direction = o.overshootShare >= 0.65 ? 'overshoots'
    : o.overshootShare <= 0.35 ? 'undershoots'
      : 'misses in both directions about equally';

  lines.push(
    `Across ${o.maps} approved map${o.maps === 1 ? '' : 's'}, ${label} is `
    + `${pct(o.medianErrorPct)} out on the middle lot, and it ${direction}.`
  );

  if (o.overshootShare >= 0.65 || o.overshootShare <= 0.35) {
    lines.push(
      `It claims too much on ${Math.round(o.overshootShare * 100)}% of them, `
      + `by ${pct(o.medianSignedPct)} on the middle lot — a fault with a `
      + 'direction is one a trim can fix without training anything.'
    );
  }

  const hard = summary.byCanopy[2];
  const easy = summary.byCanopy[0];
  if (hard && easy) {
    const worse = hard.medianErrorPct - easy.medianErrorPct;
    lines.push(
      `Where canopy decided the edge (${hard.maps}) it is ${pct(hard.medianErrorPct)} out; `
      + `where there is none (${easy.maps}), ${pct(easy.medianErrorPct)}. `
      + (worse > 5
        ? 'The canopy cases really are the hard ones, which is what the grade was for.'
        : 'The two are close, so the fault is NOT mostly about trees — worth knowing '
          + 'before any more effort goes into collecting tree cases.')
    );
  } else {
    lines.push(
      'Not enough graded maps to say whether the canopy cases are the hard ones. '
      + 'Grade some in the console — "Needs a canopy grade" — and run this again.'
    );
  }

  if (summary.skipped) {
    lines.push(
      `${summary.skipped} approved map${summary.skipped === 1 ? ' was' : 's were'} `
      + 'left out for having no stored AI outline to compare against — either '
      + 'drawn by hand, or finished before the app kept one.'
    );
  }

  return lines;
}
