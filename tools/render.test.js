/**
 * The picture of what the detector got wrong.
 *
 * WHY THIS IS TESTED AT ALL, when it only draws a diagnostic: because a
 * diagnostic that is wrong is worse than no diagnostic. The whole point of
 * these pictures is to decide where the work goes next, and a rendering with
 * missed and over-called the wrong way round would send that decision in
 * precisely the opposite direction -- confidently, because you would have
 * LOOKED at it.
 *
 * So the checks below are about meaning rather than pixels: is the red where
 * the lawn was missed, is the orange where it was over-called, and does the
 * ground outside the property line stay out of the judgement.
 *
 *   node tools/render.test.js
 */

import { drawPrediction, mistakeCounts, MISSED, OVERCALLED, INFERRED_EDGE } from './render-prediction.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const GRID = 4;
const N = GRID * GRID;
/* A flat mid-grey photograph, so anything painted on it is unambiguous. */
const photo = () => {
  const p = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    p[i * 4] = 100; p[i * 4 + 1] = 100; p[i * 4 + 2] = 100; p[i * 4 + 3] = 255;
  }
  return p;
};
const zeros = () => new Uint8Array(N);
const at = (out, i) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]];
/* Painted towards a colour: the channel that colour is highest in has moved
   that way from the grey underneath. */
const leaning = (rgb, towards) => {
  const k = towards.indexOf(Math.max(...towards));
  return rgb[k] > 100;
};

/* --------------------------------------------- the two mistakes, apart */
{
  const truth = zeros();
  const predicted = zeros();
  truth[0] = 1;                 // lawn, not called -> MISSED
  predicted[1] = 1;             // called, not lawn -> OVER-CALLED
  truth[2] = 1; predicted[2] = 1; // agreed lawn -> untouched
                                  // 3 is agreed not-lawn -> untouched

  const out = drawPrediction({ photo: photo(), truth, predicted, within: null, inferred: null, grid: GRID });

  check('lawn it missed is painted towards red',
    leaning(at(out, 0), MISSED) && at(out, 0)[0] > at(out, 0)[2],
    JSON.stringify(at(out, 0)));
  check('ground it wrongly called lawn is painted towards orange',
    leaning(at(out, 1), OVERCALLED) && at(out, 1)[1] > at(out, 1)[2],
    JSON.stringify(at(out, 1)));

  /*
   * THE TWO MISTAKES MUST NOT LOOK ALIKE. They mean opposite things -- one is
   * a model giving up, the other is a model reaching -- and a picture that
   * cannot separate them is a picture that cannot be acted on.
   */
  check('and the two are clearly different colours',
    Math.abs(at(out, 0)[1] - at(out, 1)[1]) > 40,
    `${JSON.stringify(at(out, 0))} vs ${JSON.stringify(at(out, 1))}`);

  /*
   * AGREEMENT IS LEFT ALONE, both kinds. A picture where every pixel is
   * painted is a picture of nothing, and the question being asked is what
   * KIND of ground it fails on -- which needs the ground visible.
   */
  check('ground it got right is left as the photograph',
    JSON.stringify(at(out, 2)) === JSON.stringify([100, 100, 100])
    && JSON.stringify(at(out, 3)) === JSON.stringify([100, 100, 100]),
    `${JSON.stringify(at(out, 2))} / ${JSON.stringify(at(out, 3))}`);
}

/* ----------------------------------------- outside the property line */
{
  /*
   * Dimmed, not painted and not cropped. It is not scored, so it must not read
   * as a mistake -- but it is the context that explains half of them, because
   * an over-call at the boundary usually means the neighbour's lawn runs on.
   */
  const truth = zeros();
  const predicted = zeros();
  const within = zeros();
  within[0] = 1;              // inside the line
  truth[1] = 1;               // outside, and lawn, and not called
  predicted[2] = 1;           // outside, and called

  const out = drawPrediction({ photo: photo(), truth, predicted, within, inferred: null, grid: GRID });

  check('ground outside the property line is dimmed',
    at(out, 1)[0] < 100 && at(out, 1)[0] === at(out, 1)[1],
    JSON.stringify(at(out, 1)));
  check('and is never painted as a mistake, however wrong it is there',
    !leaning(at(out, 1), MISSED) && !leaning(at(out, 2), OVERCALLED),
    `${JSON.stringify(at(out, 1))} / ${JSON.stringify(at(out, 2))}`);
  check('and it stays visible rather than being blacked out',
    at(out, 1)[0] > 20, String(at(out, 1)[0]));
}

/* -------------------------------------------------- the inferred outline */
{
  /*
   * An outline rather than a fill, and drawn LAST. The question it answers is
   * "did it fail INSIDE the guessed-at ground", which needs the failure and
   * the marking visible at the same time -- a fill would hide exactly the
   * pixels being asked about.
   */
  const truth = zeros();
  const predicted = zeros();
  const inferred = zeros();
  for (const i of [5, 6, 9, 10]) { inferred[i] = 1; truth[i] = 1; } // a 2x2 block, all missed

  const out = drawPrediction({ photo: photo(), truth, predicted, within: null, inferred, grid: GRID });

  check('marked ground is outlined in purple',
    JSON.stringify(at(out, 5)) === JSON.stringify(INFERRED_EDGE),
    JSON.stringify(at(out, 5)));
  check('and the outline survives the mistake painted underneath it',
    [5, 6, 9, 10].every((i) => JSON.stringify(at(out, i)) === JSON.stringify(INFERRED_EDGE)),
    'every cell of a 2x2 block is an edge cell');
}

/* ------------------------------------------------------- the counts */
{
  const truth = zeros();
  const predicted = zeros();
  const within = new Uint8Array(N).fill(1);
  const inferred = zeros();

  truth[0] = 1; predicted[0] = 1;   // found
  truth[1] = 1;                      // missed
  truth[2] = 1; inferred[2] = 1;     // missed, and it was marked inferred
  predicted[3] = 1;                  // over-called

  const c = mistakeCounts({ truth, predicted, within, inferred });

  check('it counts what was found and what was missed',
    c.right === 1 && c.missed === 2 && c.overcalled === 1 && c.lawnPx === 3,
    JSON.stringify(c));
  check('found is a share of the lawn there actually is',
    Math.abs(c.foundPct - 100 / 3) < 0.01, String(c.foundPct));
  check('and the inferred share is asked only of the marked ground',
    c.inferredPx === 1 && c.missedInferredPct === 100,
    JSON.stringify({ px: c.inferredPx, missed: c.missedInferredPct }));

  /*
   * A map with nothing marked must report null rather than zero. Zero reads
   * as "it missed none of the inferred ground", which is a claim; there is no
   * inferred ground to have missed.
   */
  const none = mistakeCounts({ truth, predicted, within, inferred: null });
  check('a map with nothing marked reports nothing, not zero',
    none.missedInferredPct === null, String(none.missedInferredPct));

  /* Outside the line is outside the judgement, here as well as in the drawing. */
  const half = new Uint8Array(N);
  half[0] = 1;
  const clipped = mistakeCounts({ truth, predicted, within: half, inferred: null });
  check('and ground outside the property line is not counted',
    clipped.lawnPx === 1 && clipped.missed === 0 && clipped.overcalled === 0,
    JSON.stringify(clipped));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
