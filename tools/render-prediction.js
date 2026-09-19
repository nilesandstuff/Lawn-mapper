/**
 * Draw what the detector got wrong, on top of the photograph it got it wrong on.
 *
 * WHY A PICTURE. The table says 28.2%. It cannot say that the 28.2% is a gravel
 * drive read as grass, or a shaded strip along a fence line given up on, or the
 * neighbour's lawn taken in over the property line -- and those three findings
 * would each send the work somewhere different. A percentage is a summary of an
 * answer nobody has looked at.
 *
 * WHAT IS DRAWN, and the choice matters more than the colours.
 *
 * Not "here is what it thinks is lawn". That picture hides half the story: a
 * shape that looks plausible on its own is indistinguishable from one that is
 * plausible and wrong. What is drawn is the DISAGREEMENT, four ways:
 *
 *   true lawn, called lawn        the photograph, untouched -- it got this right
 *   true lawn, called NOT         RED        what it missed
 *   not lawn, called lawn         ORANGE     what it over-called
 *   not lawn, called not          the photograph, untouched
 *
 * So the eye goes straight to the mistakes and the correct ground stays legible
 * underneath, which is the whole point: you are looking to find out WHAT KIND
 * of ground it fails on, and that means seeing the ground.
 *
 * Everything outside the property line is dimmed rather than cropped. It is not
 * scored, so it must not be mistaken for a mistake -- but it is the context that
 * explains half of them, because an over-call at the boundary usually means the
 * neighbour's lawn is continuous with this one.
 *
 * Inferred areas get a purple outline. That is the only way to see whether the
 * failures cluster where the reviewer said "I know it is lawn, I cannot see it"
 * -- a question the inferred column cannot currently answer, because it is
 * three percent of a typical map (see docs/DETECTOR-FINDINGS.md, H6).
 */

/* Drawn over the photograph, so they have to survive being blended with grass,
   tarmac and shadow. Both are chosen to be unmistakable on all three. */
export const MISSED = [214, 45, 45];      // true lawn the model did not call
export const OVERCALLED = [255, 150, 20]; // called lawn that is not lawn
export const INFERRED_EDGE = [179, 136, 255];

/** How strongly a mistake is painted over the photograph beneath it. */
const MISTAKE_ALPHA = 0.55;
/** Outside the property line: visible, obviously not part of the judgement. */
const OUTSIDE_DIM = 0.45;

const mix = (under, over, a) => Math.round(under * (1 - a) + over * a);

/**
 * One frame, as RGBA bytes ready for a PNG.
 *
 * `photo` is the RGBA the rest of the tool already works from, at grid
 * resolution -- the same pixels the features were computed from, so what is
 * drawn is what the model actually saw, not a prettier copy of it.
 */
export function drawPrediction({ photo, truth, predicted, within, inferred, grid }) {
  const out = new Uint8Array(grid * grid * 4);

  for (let i = 0; i < grid * grid; i++) {
    const p = i * 4;
    let r = photo[p];
    let g = photo[p + 1];
    let b = photo[p + 2];

    const scored = !within || within[i];
    if (!scored) {
      /* Dimmed, not hidden. See the header: the ground outside the line is
         what explains an over-call at the edge of it. */
      r = Math.round(r * OUTSIDE_DIM);
      g = Math.round(g * OUTSIDE_DIM);
      b = Math.round(b * OUTSIDE_DIM);
    } else {
      const isLawn = Boolean(truth[i]);
      const saidLawn = Boolean(predicted[i]);
      if (isLawn && !saidLawn) {
        r = mix(r, MISSED[0], MISTAKE_ALPHA);
        g = mix(g, MISSED[1], MISTAKE_ALPHA);
        b = mix(b, MISSED[2], MISTAKE_ALPHA);
      } else if (!isLawn && saidLawn) {
        r = mix(r, OVERCALLED[0], MISTAKE_ALPHA);
        g = mix(g, OVERCALLED[1], MISTAKE_ALPHA);
        b = mix(b, OVERCALLED[2], MISTAKE_ALPHA);
      }
      /* Agreement of either kind is left alone. A picture where every pixel
         is painted is a picture of nothing. */
    }

    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = 255;
  }

  /*
   * THE INFERRED OUTLINE LAST, so it sits on top of the mistakes rather than
   * being painted over by them -- the question it answers is "did it fail
   * INSIDE the guessed-at ground", which needs both visible at once.
   *
   * An outline rather than a fill, because a fill would hide exactly the
   * pixels being asked about.
   */
  if (inferred) {
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const i = y * grid + x;
        if (!inferred[i]) continue;
        /* An edge pixel is one with a neighbour outside the marked area. */
        const edge = x === 0 || y === 0 || x === grid - 1 || y === grid - 1
          || !inferred[i - 1] || !inferred[i + 1]
          || !inferred[i - grid] || !inferred[i + grid];
        if (!edge) continue;
        const p = i * 4;
        out[p] = INFERRED_EDGE[0];
        out[p + 1] = INFERRED_EDGE[1];
        out[p + 2] = INFERRED_EDGE[2];
      }
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
