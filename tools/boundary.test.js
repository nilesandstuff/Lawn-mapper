/**
 * Where the error lives: sharp boundaries against soft ones.
 *
 * WHY THIS IS TESTED HARDER THAN IT LOOKS LIKE IT NEEDS TO BE. This
 * measurement exists to decide whether weeks of work went at the wrong half of
 * the problem (H12/S8 in docs/DETECTOR-FINDINGS.md). A split that quietly put
 * soft edges in the sharp column would answer that question backwards, and it
 * would answer it CONFIDENTLY, with a table. The checks below are about
 * meaning: does "sharp" mean sharp, is the control a real control, and does an
 * empty class say nothing rather than zero.
 *
 *   node tools/boundary.test.js
 */

import {
  sharpness, boundaryBand, splitBySharpness, classesFor,
  errorByClass, interiorError, medianWhere, classOverlap,
  EDGE_REACH, SOFT, CRISP, NOWHERE,
} from './boundary.js';
import { FEATURE_COUNT } from '../public/lib/features.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const GRID = 64;
const N = GRID * GRID;

/** A feature block carrying only the luma channel these functions read. */
const cheapFrom = (luma) => {
  const c = new Float32Array(N * FEATURE_COUNT);
  for (let i = 0; i < N; i++) c[i * FEATURE_COUNT + 5] = luma[i];
  return c;
};
const zeros = () => new Uint8Array(N);
const ones = () => new Uint8Array(N).fill(1);

/* ------------------------------------------- sharpness means sharpness */
{
  /*
   * A STEP AND A RAMP, side by side, both from dark to light by the same
   * amount. The whole measurement rests on telling these apart: concrete
   * against grass is the step, a tree line is the ramp.
   */
  const luma = new Float32Array(N);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      // Left half: a hard step at x = 16. Right half: a ramp over 20 cells.
      const v = x < 32
        ? (x < 16 ? 40 : 200)
        : Math.max(40, Math.min(200, 40 + ((x - 36) / 20) * 160));
      luma[y * GRID + x] = v;
    }
  }
  const sharp = sharpness(cheapFrom(luma), GRID);
  const atStep = sharp[32 * GRID + 16];
  const atRamp = sharp[32 * GRID + 46];

  check('a hard step reads sharper than a gradual ramp of the same size',
    atStep > atRamp * 3, `step ${atStep.toFixed(0)} vs ramp ${atRamp.toFixed(0)}`);
  check('and flat ground reads as nothing at all',
    sharp[32 * GRID + 5] === 0, String(sharp[32 * GRID + 5]));
}

/* --------------------------------------------------- the boundary band */
{
  const truth = zeros();
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) truth[y * GRID + x] = 1;

  const band = boundaryBand(truth, GRID);

  /*
   * BOTH SIDES OF THE LINE, deliberately. An over-call and a miss at the same
   * boundary are one failure seen from either side, and a band holding only
   * the lawn side would count one and miss the other.
   */
  check('the band covers ground inside the lawn edge',
    band[32 * GRID + 21] === 1, String(band[32 * GRID + 21]));
  check('and ground outside it',
    band[32 * GRID + 18] === 1, String(band[32 * GRID + 18]));
  check('and it stops within reach of the line',
    band[32 * GRID + 32] === 0 && band[32 * GRID + 5] === 0,
    `middle ${band[32 * GRID + 32]}, far ${band[32 * GRID + 5]}`);
  check('reach is about what was asked for',
    band[32 * GRID + (20 - EDGE_REACH)] === 1
    && band[32 * GRID + (20 - EDGE_REACH - 3)] === 0,
    `at -${EDGE_REACH} and beyond`);
}

/* ------------------------------------------------ the split is a split */
{
  /*
   * A LAWN WITH ONE SHARP EDGE AND ONE SOFT ONE, which is the case the whole
   * file is about: a lot with a driveway down one side and a tree line down
   * the other.
   */
  const truth = zeros();
  const luma = new Float32Array(N).fill(120);
  /* A strip the full height of the frame, so the only boundaries are the two
     being compared. A lawn with invisible top and bottom edges would drag the
     median to zero and tell us nothing about either side. */
  for (let y = 0; y < GRID; y++) {
    for (let x = 16; x < 48; x++) truth[y * GRID + x] = 1;
    // Left edge: a step to bright concrete. Right edge: a slow fade to shade.
    for (let x = 0; x < 16; x++) luma[y * GRID + x] = 230;
    for (let x = 44; x < 60; x++) {
      luma[y * GRID + x] = Math.max(60, 120 - (x - 44) * 5);
    }
  }
  const within = ones();
  const classes = classesFor({ cheap: cheapFrom(luma), truth, within, grid: GRID });

  const leftEdge = classes.edge[32 * GRID + 16];
  const rightEdge = classes.edge[32 * GRID + 47];
  check('the step edge lands in the sharp half',
    leftEdge === CRISP, `class ${leftEdge}`);
  check('and the fading edge lands in the soft half',
    rightEdge === SOFT, `class ${rightEdge}`);
  check('and ground away from any boundary is in neither',
    classes.edge[32 * GRID + 32] === NOWHERE, String(classes.edge[32 * GRID + 32]));
}

/* ------------------------------- the split is not just "transition vs flat" */
{
  /*
   * THE FAILURE THIS PINS WAS THE FIRST VERSION OF THIS FILE, and it would
   * have produced a confident, wrong table rather than an obvious bug.
   *
   * Splitting cells by their OWN gradient puts the median in the flat range,
   * because a band four cells either side of an edge is mostly flat ground
   * with the step occupying the middle of it. Every real transition then comes
   * out above the median and the "sharp" column quietly means "is a boundary
   * at all" — which would have reported sharp boundaries as carrying all the
   * error on any lawn whatsoever, and looked exactly like a confirmation of
   * the theory it was built to test.
   *
   * A lawn with two SOFT edges and nothing sharp anywhere is the case that
   * catches it: nothing here should land in the sharp column.
   */
  const truth = zeros();
  const luma = new Float32Array(N).fill(120);
  for (let y = 0; y < GRID; y++) {
    for (let x = 16; x < 48; x++) truth[y * GRID + x] = 1;
    /* Both edges fade at the same gentle rate, all the way to the frame edge
       so there is no accidental cliff for the peak to find. */
    for (let x = 0; x < 16; x++) luma[y * GRID + x] = 120 + (16 - x) * 2.5;
    for (let x = 48; x < GRID; x++) luma[y * GRID + x] = 120 - (x - 48) * 2.5;
  }
  const classes = classesFor({
    cheap: cheapFrom(luma), truth, within: ones(), grid: GRID,
  });

  /*
   * THE DISCRIMINATOR: across a band of uniform sharpness the class must be
   * uniform too. The old per-cell version would have marked the two or three
   * transition cells sharp and the flat cells either side of them soft — an
   * alternating pattern that tracks "is this cell on the step" instead of "is
   * this edge a sharp one", on every lawn, whatever its edges are like.
   */
  const row = 32;
  const near = [14, 15, 16, 17, 18].map((x) => classes.edge[row * GRID + x]);
  const same = near.every((c) => c !== NOWHERE && c === near[0]);
  check('the flat ground beside a step is classed with the step, not against it',
    same,
    same ? `x=14..18 all class ${near[0]}` : `x=14..18 are ${near.join('')}`);

  /*
   * And the extreme of the same fault: a boundary with no visible contrast at
   * all must produce NO sharp half rather than an entirely sharp one.
   */
  const flat = classesFor({
    cheap: cheapFrom(new Float32Array(N).fill(120)), truth, within: ones(), grid: GRID,
  });
  let anyCrisp = 0, anySoft = 0;
  for (let i = 0; i < N; i++) {
    if (flat.edge[i] === CRISP) anyCrisp++;
    else if (flat.edge[i] === SOFT) anySoft++;
  }
  check('an invisible boundary has no sharp half at all',
    anyCrisp === 0 && anySoft > 0,
    `${anyCrisp} sharp, ${anySoft} soft`);
}

/* ---------------------------------------------------- the error counts */
{
  const truth = zeros();
  const predicted = zeros();
  const within = ones();
  const classes = new Uint8Array(N);

  /* Four cells of lawn in each class; the model gets the sharp ones wrong. */
  for (let i = 0; i < 4; i++) {
    classes[i] = CRISP; truth[i] = 1;             // wrong: predicted stays 0
    classes[100 + i] = SOFT; truth[100 + i] = 1; predicted[100 + i] = 1; // right
  }

  const e = errorByClass({ classes, predicted, truth, within });
  check('error is counted against the lawn in that class',
    e.crispPct === 100 && e.softPct === 0,
    JSON.stringify({ crisp: e.crispPct, soft: e.softPct }));
  check('and each class says how much ground it is speaking for',
    e.crispPx === 4 && e.softPx === 4, JSON.stringify(e));

  /*
   * AN EMPTY CLASS REPORTS NOTHING, NOT ZERO. Zero reads as "it made no
   * mistakes there", which is a claim about a place that does not exist -- and
   * a zero in this table would look like the best result on the page.
   */
  const empty = errorByClass({ classes: new Uint8Array(N), predicted, truth, within });
  check('a class with no lawn in it reports nothing rather than zero',
    empty.crispPct === null && empty.softPct === null, JSON.stringify(empty));
}

/* ------------------------------------------------------- the control */
{
  /*
   * THE INTERIOR IS THE CONTROL AND THE MEASUREMENT IS WORTHLESS WITHOUT IT.
   * Error concentrates at boundaries in every segmentation model ever built,
   * so "the edge is worse than the middle" is a definition rather than a
   * finding. This checks the control actually excludes the band it is the
   * control for.
   */
  const truth = zeros();
  const predicted = zeros();
  const within = ones();
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) truth[y * GRID + x] = 1;
  const band = boundaryBand(truth, GRID);

  // Every mistake is in the band; the middle is perfect.
  for (let i = 0; i < N; i++) if (truth[i] && !band[i]) predicted[i] = 1;

  const inner = interiorError({ band, predicted, truth, within });
  check('ground away from the boundary is scored apart from the band',
    inner === 0, `${inner}% -- every mistake here was in the band`);

  // And the reverse: a model wrong only in the middle must show up.
  const flipped = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (truth[i] && band[i]) flipped[i] = 1;
  const innerBad = interiorError({ band, predicted: flipped, truth, within });
  check('and a model wrong only in the middle is not hidden by a clean edge',
    innerBad === 100, `${innerBad}%`);
}

/* --------------------------------- are the two columns the same pixels? */
{
  /*
   * BOTH SPLITS KEY OFF ONE GRADIENT MAP, so "hard-rimmed shade" and "a sharp
   * boundary" can be the same ground seen twice -- a dark strip beside a
   * driveway is both. A table that reported one finding in two columns would
   * read as two independent confirmations of it, which is worse than reporting
   * neither.
   */
  const within = ones();

  /* Shade sitting exactly on the sharp boundary: the columns should agree. */
  const edge = zeros();
  const shade = zeros();
  for (let i = 0; i < 100; i++) { edge[i] = CRISP; shade[i] = CRISP; }
  check('overlapping classes are reported as overlapping',
    classOverlap({ edge, shade, within }) === 1,
    'all of this hard shade is also a sharp boundary');

  /* And shade nowhere near a boundary: two genuinely separate failures. */
  const apartEdge = zeros();
  const apartShade = zeros();
  for (let i = 0; i < 100; i++) apartEdge[i] = CRISP;
  for (let i = 500; i < 600; i++) apartShade[i] = CRISP;
  check('and separate classes as separate',
    classOverlap({ edge: apartEdge, shade: apartShade, within }) === 0,
    'none of this hard shade is on a boundary, so the columns are two findings');

  check('with nothing in shade at all it reports nothing, not zero',
    classOverlap({ edge, shade: zeros(), within }) === null,
    'zero would read as "none of it overlaps", which is a claim about ground '
    + 'that does not exist');
}

/* ------------------------------------------- outside the property line */
{
  /* Same rule as everywhere else here: unscored ground takes no part in a
     judgement, including in deciding where the median sits. */
  const values = new Float32Array(N);
  for (let i = 0; i < N; i++) values[i] = i < N / 2 ? 1000 : 1;
  const within = new Uint8Array(N);
  for (let i = N / 2; i < N; i++) within[i] = 1;

  const cut = medianWhere(values, null, within);
  check('the median ignores ground outside the property line',
    cut === 1, String(cut));

  const classes = splitBySharpness(ones(), values, within, GRID);
  check('and nothing outside it is given a class',
    classes[10] === NOWHERE && classes[N - 10] !== NOWHERE,
    `${classes[10]} inside the excluded half, ${classes[N - 10]} inside the kept half`);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
