/**
 * WHERE THE ERROR LIVES, along two axes the existing columns cannot see.
 *
 * THE OBSERVATION THIS EXISTS TO TEST (H12, and it is the owner's reading of
 * the renderings rather than a number): the 1280px model handles the ground
 * everyone assumed was hard — dappled shade, tree lines, ambiguous edges — and
 * fails on the ground everyone assumed was easy. Driveway and sidewalk edges,
 * which are as unambiguous as a boundary gets. Dense shade thrown by a
 * building, as against shade thrown by a tree.
 *
 * If that is right, the work has been aimed at the wrong half of the problem
 * for weeks (see H4, E3, S2 — all about occlusion and context). If it is
 * wrong, it is an impression formed from two dozen pictures at midnight. The
 * only way to tell is to measure it, which is what this file is for.
 *
 * THE TWO SPLITS, and both turn on the same quantity.
 *
 * What separates a driveway edge from a tree line is not where it is, it is
 * how SHARP it is: concrete against grass is a step change in brightness
 * inside a cell or two, while a tree line fades over a metre. Likewise a
 * building's shadow has a hard rim and a tree's does not. So one gradient map
 * serves both questions:
 *
 *   1. Of the cells along the lawn's boundary, is the error worse on the
 *      CRISP half or the SOFT half?
 *   2. Of the cells in shadow, is the error worse where the shadow has a HARD
 *      rim or a soft one?
 *
 * THE CUT IS EACH LAWN'S OWN MEDIAN, not a fixed number, for exactly the
 * reason the shade split already works that way: these frames range over
 * 5–38 cm a cell and every kind of light, so a threshold chosen in advance
 * would call one lawn all-crisp and the next all-soft and report nothing. A
 * median split asks a within-lawn question — "of YOUR boundary, is the sharper
 * half worse" — which is the question that has an answer.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It does not identify driveways; it
 * identifies sharp boundaries, of which driveways and paths are the common
 * case on a lot. It does not identify buildings; it identifies hard-rimmed
 * shade. If the crisp column comes back worse, that is evidence for S8 and not
 * proof of it — the honest next step would be a real surface mask.
 */

import { growMask } from '../public/lib/mask.js';
import { FEATURE_COUNT } from '../public/lib/features.js';

/**
 * How far from the boundary still counts as "on the boundary", in cells.
 *
 * Four, which is 40–50 cm on a typical frame and about 1.5 m on the largest.
 * The band has to be wide enough to hold the error — a model that reads a
 * driveway as grass is wrong for the width of the driveway, not for one cell —
 * and narrow enough that it does not swallow the interior it is being compared
 * against. On a typical lot this band is roughly a pace either side of the
 * line, which is about the distance a person would call "the edge".
 */
export const EDGE_REACH = 4;

/** Luma, as the feature block already computed it. */
export const lumaOf = (cheap, i) => cheap[i * FEATURE_COUNT + 5];

/**
 * How sharply brightness changes at each cell — a Sobel magnitude over luma.
 *
 * Sobel rather than a plain difference because a plain difference answers a
 * one-cell question and is dominated by sensor noise at this resolution; the
 * 3x3 weighting averages across the edge it is measuring. Magnitude only: the
 * DIRECTION of an edge says which way the driveway runs, which nothing here
 * asks.
 */
export function sharpness(cheap, grid, gridH = grid) {
  const out = new Float32Array(grid * gridH);
  const at = (x, y) => lumaOf(cheap, y * grid + x);

  for (let y = 1; y < gridH - 1; y++) {
    for (let x = 1; x < grid - 1; x++) {
      const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
        - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      out[y * grid + x] = Math.hypot(gx, gy);
    }
  }
  /* The one-cell frame around the outside keeps 0 rather than a guess. It is
     4/512 of the picture and is always outside the parcel in practice. */
  return out;
}

/**
 * The cells within EDGE_REACH of where the lawn stops being lawn.
 *
 * Both sides of the line, deliberately. An over-call and a miss at the same
 * boundary are the same failure seen from either side, and a band that held
 * only the lawn side would count one and not the other.
 */
export function boundaryBand(truth, grid, reach = EDGE_REACH, gridH = grid) {
  const line = new Uint8Array(grid * gridH);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < grid; x++) {
      const i = y * grid + x;
      const here = truth[i] ? 1 : 0;
      const edge = (x > 0 && (truth[i - 1] ? 1 : 0) !== here)
        || (x < grid - 1 && (truth[i + 1] ? 1 : 0) !== here)
        || (y > 0 && (truth[i - grid] ? 1 : 0) !== here)
        || (y < gridH - 1 && (truth[i + grid] ? 1 : 0) !== here);
      if (edge) line[i] = 1;
    }
  }
  /* One chamfer sweep rather than `reach` rounds of dilation -- the same
     function the detector uses to grow a mask by a distance. */
  return reach > 0 ? growMask(line, grid, gridH, reach) : line;
}

/**
 * The sharpest thing within reach of each cell.
 *
 * WHY THE RAW GRADIENT IS THE WRONG QUANTITY TO SPLIT ON, which a test caught
 * before this ever ran on real data.
 *
 * Sharpness is a property of a STRETCH OF BOUNDARY, not of a cell. A band four
 * cells either side of a driveway edge is mostly flat — flat grass, flat
 * concrete — with the actual step occupying a cell or two in the middle. Split
 * those cells by their own gradient against the band's median and the median
 * lands in the flat range, so every real transition comes out "above median"
 * and the column stops meaning sharp-versus-soft and starts meaning
 * transition-versus-flat. Which is a fact about rasters, not about lawns.
 *
 * Taking the peak within reach gives every cell of a stretch the sharpness of
 * the edge it belongs to, so the median then splits SHARP EDGES from SOFT
 * EDGES, which is the question being asked.
 *
 * Separable: a horizontal pass then a vertical one, so the cost is 2(2r+1)
 * comparisons a cell rather than (2r+1)^2.
 */
export function peakWithin(values, grid, radius = EDGE_REACH, gridH = grid) {
  const mid = new Float32Array(values.length);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < grid; x++) {
      let best = 0;
      const from = Math.max(0, x - radius);
      const to = Math.min(grid - 1, x + radius);
      for (let k = from; k <= to; k++) {
        const v = values[y * grid + k];
        if (v > best) best = v;
      }
      mid[y * grid + x] = best;
    }
  }

  const out = new Float32Array(values.length);
  for (let y = 0; y < gridH; y++) {
    const from = Math.max(0, y - radius);
    const to = Math.min(gridH - 1, y + radius);
    for (let x = 0; x < grid; x++) {
      let best = 0;
      for (let k = from; k <= to; k++) {
        const v = mid[k * grid + x];
        if (v > best) best = v;
      }
      out[y * grid + x] = best;
    }
  }
  return out;
}

/**
 * The median of a masked quantity, sampled rather than sorted whole.
 *
 * Every seventh cell, which is what the shade split already does: a quarter of
 * a million floats sorted six times per lawn is real time spent, and the
 * median of a 37,000-cell sample of a smooth field is the median.
 */
export function medianWhere(values, mask, within, stride = 7) {
  const sample = [];
  for (let i = 0; i < values.length; i += stride) {
    if (within && !within[i]) continue;
    if (mask && !mask[i]) continue;
    sample.push(values[i]);
  }
  if (!sample.length) return null;
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1];
}

/** The class ids, as small integers, so a lawn carries one byte per cell. */
export const NOWHERE = 0;
export const SOFT = 1;
export const CRISP = 2;

/**
 * Split a region into its softer and sharper halves, by that region's own
 * median sharpness.
 *
 * Returns NOWHERE for everything outside the region, so one array can be
 * walked alongside the prediction without a second lookup.
 */
export function splitBySharpness(region, sharp, within, grid, gridH = grid) {
  const out = new Uint8Array(grid * gridH);
  const cut = medianWhere(sharp, region, within);
  if (cut === null) return out;

  /*
   * A REGION WITH NO SHARPNESS IN IT HAS NO SHARP HALF.
   *
   * A median of zero means most of this boundary is invisible — a lawn running
   * into a tree line, or into more grass. Splitting it anyway would put every
   * cell above-or-equal to zero into the sharp column, and the table would
   * then report the sharp half as holding all the error because it holds
   * everything. Nothing is sharp here, and that is the honest answer.
   */
  if (!(cut > 0)) {
    for (let i = 0; i < out.length; i++) {
      if (within && !within[i]) continue;
      if (region[i]) out[i] = SOFT;
    }
    return out;
  }

  for (let i = 0; i < out.length; i++) {
    if (within && !within[i]) continue;
    if (!region[i]) continue;
    out[i] = sharp[i] >= cut ? CRISP : SOFT;
  }
  return out;
}

/**
 * Everything a lawn needs to answer both questions, computed once.
 *
 * ONCE PER LAWN, NOT ONCE PER FOLD. None of this depends on the model or the
 * configuration -- it is a property of the photograph and the hand-traced
 * outline -- so computing it in the scoring loop would redo identical work
 * six times per lawn per run for no reason.
 */
export function classesFor({ cheap, truth, within, grid, gridH = grid }) {
  /* The peak within reach, not the cell's own gradient -- see peakWithin for
     why the raw value splits the wrong thing. */
  const sharp = peakWithin(sharpness(cheap, grid, gridH), grid, EDGE_REACH, gridH);

  const band = boundaryBand(truth, grid, EDGE_REACH, gridH);
  const edge = splitBySharpness(band, sharp, within, grid, gridH);

  /*
   * The dark half of the frame, by the same median rule the shade columns
   * already use -- then split by how hard its rim is. A building's shadow has
   * a rim you could cut yourself on; a tree's does not.
   */
  const dark = new Uint8Array(grid * gridH);
  const lumaAll = new Float32Array(grid * gridH);
  for (let i = 0; i < lumaAll.length; i++) lumaAll[i] = lumaOf(cheap, i);
  const lumaCut = medianWhere(lumaAll, null, within);
  if (lumaCut !== null) {
    for (let i = 0; i < dark.length; i++) {
      if (within && !within[i]) continue;
      if (lumaAll[i] < lumaCut) dark[i] = 1;
    }
  }
  const shade = splitBySharpness(dark, sharp, within, grid, gridH);

  return { edge, shade, band };
}

/**
 * Error rate within each class, on the same terms as every other column here:
 * cells the model got wrong, over the lawn there actually is in that class.
 *
 * Null rather than zero for an empty class. Zero reads as "it made no mistakes
 * there", which is a claim; there was nowhere to make one.
 */
export function errorByClass({ classes, predicted, truth, within }) {
  const wrong = [0, 0, 0];
  const lawn = [0, 0, 0];

  for (let i = 0; i < truth.length; i++) {
    if (within && !within[i]) continue;
    const c = classes[i];
    if (!c) continue;
    if (truth[i]) lawn[c]++;
    if ((predicted[i] ? 1 : 0) !== (truth[i] ? 1 : 0)) wrong[c]++;
  }

  return {
    softPct: lawn[SOFT] ? (100 * wrong[SOFT]) / lawn[SOFT] : null,
    crispPct: lawn[CRISP] ? (100 * wrong[CRISP]) / lawn[CRISP] : null,
    softPx: lawn[SOFT],
    crispPx: lawn[CRISP],
  };
}

/**
 * How much of the hard-rimmed shade is ALSO on a sharp boundary.
 *
 * ASKED BECAUSE THE TWO COLUMNS MAY BE ONE COLUMN. Both splits key off the
 * same gradient map: "hard-rimmed shade" is dark ground with something sharp
 * within reach, and a driveway edge is something sharp. So a dark strip beside
 * a drive lands in both, and the table would report one finding twice while
 * looking like two independent confirmations.
 *
 * Returns the share of hard-shade cells that also sit in the sharp half of the
 * boundary band. Near 1 means the columns are the same pixels and the table
 * should be read as one result; near 0 means they are genuinely separate
 * failures and the shade column is telling us something the boundary column is
 * not.
 */
export function classOverlap({ edge, shade, within }) {
  let hard = 0, both = 0;
  for (let i = 0; i < shade.length; i++) {
    if (within && !within[i]) continue;
    if (shade[i] !== CRISP) continue;
    hard++;
    if (edge[i] === CRISP) both++;
  }
  return hard ? both / hard : null;
}

/**
 * The lawn away from any boundary: the control for both splits above.
 *
 * WITHOUT THIS THE MEASUREMENT PROVES NOTHING. Error concentrates at
 * boundaries in every segmentation model ever built, so "the edge is worse
 * than the middle" is not a finding, it is a definition. The question that has
 * an answer is whether the CRISP edge is worse than the SOFT edge -- and the
 * interior is here to say how much of the edge figure is just being an edge.
 */
export function interiorError({ band, predicted, truth, within }) {
  let wrong = 0, lawn = 0;
  for (let i = 0; i < truth.length; i++) {
    if (within && !within[i]) continue;
    if (band[i]) continue;
    if (truth[i]) lawn++;
    if ((predicted[i] ? 1 : 0) !== (truth[i] ? 1 : 0)) wrong++;
  }
  return lawn ? (100 * wrong) / lawn : null;
}
