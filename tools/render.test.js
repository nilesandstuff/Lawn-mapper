/**
 * The picture of the outline the detector drew.
 *
 * WHY THIS IS TESTED AT ALL, when it only draws a diagnostic: because a
 * diagnostic that is wrong is worse than no diagnostic. This picture decides
 * whether a model is good enough to start hand-corrections from -- which is
 * the thing that would make building the corpus faster -- and a rendering that
 * flattered the shape would have that decision made confidently, by somebody
 * who had LOOKED at the evidence.
 *
 * So the checks below are about meaning rather than pixels:
 *
 *   is the thing drawn the TRACE the drawing tools would receive, rather than
 *     the raw mask behind it -- same tolerance, same vertex cap, same floors;
 *   is it an OUTLINE rather than a fill, so the ground underneath stays
 *     readable and the two kinds of mistake stay visible as absences;
 *   is every handle marked, since the handle count is most of the answer to
 *     "how long would this take to fix";
 *   and does the ground outside the property line stay out of the judgement.
 *
 *   node tools/render.test.js
 */

import {
  drawPrediction, drawLayers, LAYERS, tracePrediction, traceMask, traceDrift, mistakeCounts,
  TRACE, TRUTH_FILL, INFERRED_EDGE,
} from './render-prediction.js';
import {
  polygonsFromBinary, TRACE_TOLERANCE_M, MAX_TRACE_VERTICES,
} from '../public/lib/mask.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const GRID = 128;
const N = GRID * GRID;
const zeros = () => new Uint8Array(N);
const ones = () => new Uint8Array(N).fill(1);
/* A flat mid-grey photograph, so anything painted on it is unambiguous. */
const photo = () => {
  const p = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    p[i * 4] = 100; p[i * 4 + 1] = 100; p[i * 4 + 2] = 100; p[i * 4 + 3] = 255;
  }
  return p;
};
const at = (out, x, y) => {
  const p = (y * GRID + x) * 4;
  return [out[p], out[p + 1], out[p + 2]];
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Fill an axis-aligned block of a mask. */
const block = (mask, x0, y0, x1, y1) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * GRID + x] = 1;
  return mask;
};

/* ------------------------------------------- the trace, not the mask */
{
  /*
   * THE WHOLE POINT OF THE REWRITE. What the app puts on the map is the model's
   * answer run through the tracer: smoothed, capped, speckle dropped. A picture
   * of the mask would be a picture of a shape nobody is ever handed, and the
   * question being asked -- could I fix this by hand -- would be answered about
   * the wrong object.
   */
  const predicted = block(zeros(), 30, 30, 90, 90);
  const t = tracePrediction({ predicted, within: null, grid: GRID, mpp: 0.5 });

  check('a solid square comes back as one piece',
    t.pieces === 1, `${t.pieces} pieces`);
  check('and as a handful of handles, not a hundred',
    t.vertices >= 4 && t.vertices <= 12, `${t.vertices} handles`);
  check('the rings are closed, so a ring can be drawn as drawn',
    t.rings.length === 1 && same(t.rings[0][0], t.rings[0][t.rings[0].length - 1]),
    JSON.stringify(t.rings[0]?.slice(0, 2)));

  /*
   * TRACED WITH THE APP'S OWN NUMBERS, and this is the check that says so.
   *
   * The tracer's own defaults are a different tolerance and a far looser
   * vertex budget. Drawn with those, a ragged edge comes back finer and busier
   * than anything the drawing tools would ever hand a person -- so the picture
   * would answer "could I fix this" about a shape that does not exist. A
   * ragged edge is used because that is the only place the two settings part
   * company: a clean square traces the same either way.
   */
  const noisy = block(zeros(), 20, 20, 100, 100);
  for (let y = 20; y <= 100; y += 2) {
    for (let j = 1; j <= 6; j++) noisy[y * GRID + 100 + j] = 1;
  }
  const mpp = 0.15; // a typical frame: see docs/DETECTOR-FINDINGS.md, H1
  const mine = tracePrediction({ predicted: noisy, within: null, grid: GRID, mpp });

  const asApp = polygonsFromBinary(
    Uint8Array.from(noisy), GRID, GRID, (x, y) => [x, y],
    { tolerance: TRACE_TOLERANCE_M / mpp, maxVertices: MAX_TRACE_VERTICES }
  );
  const asDefault = polygonsFromBinary(
    Uint8Array.from(noisy), GRID, GRID, (x, y) => [x, y], {}
  );
  const rings = (polys) => JSON.stringify(polys.flatMap((p) => p.coordinates));

  check('a ragged edge is traced exactly as the drawing tools would get it',
    JSON.stringify(mine.rings) === rings(asApp), `${mine.vertices} handles`);
  check('and not with the tracer\'s own looser defaults',
    rings(asApp) !== rings(asDefault),
    'if these ever agree, this check has stopped testing anything');
}

/* --------------------------------------------- what the tracer throws away */
{
  /*
   * SPECKLE IS DROPPED AND SAID SO. It has to be dropped -- the app drops it,
   * and a wall of crumbs is not an editing surface -- but a model whose answer
   * is mostly crumbs looks TIDY once they are gone, which is the one way this
   * picture could mislead in the flattering direction.
   */
  const predicted = block(zeros(), 40, 40, 80, 80);
  for (const [x, y] of [[10, 10], [12, 100], [110, 20]]) block(predicted, x, y, x + 1, y + 1);

  const t = tracePrediction({ predicted, within: null, grid: GRID, mpp: 0.5 });
  check('specks too small to trace are dropped',
    t.pieces === 1, `${t.pieces} pieces`);
  check('and counted, so the picture cannot quietly flatter the model',
    t.droppedPieces === 3 && t.droppedPx === 12,
    `${t.droppedPieces} dropped, ${t.droppedPx}px`);
}

/* ------------------------------- the caption describes the picture */
{
  /*
   * THE BUG THIS PINS, because it was found by eye and could only be found by
   * eye. A caption read "of the ground marked inferred, it missed 17.8%" under
   * a rendering whose outline covered that ground completely. Neither was
   * wrong: the number came from the model's raw mask, the picture is the
   * trace, and the tracer does not trace a hole below 0.15% of the frame --
   * about 60 sq ft on a typical lot.
   *
   * The filling is wanted. Lawns are not polka dots and a shape full of
   * pinholes is not an editing surface. What is not wanted is a number
   * describing a different object from the picture it sits under, so the
   * page's per-lawn figures are asked of the traced outline.
   */
  const truth = block(zeros(), 30, 30, 100, 100);
  const inferred = block(zeros(), 50, 50, 80, 80);
  const predicted = block(zeros(), 30, 30, 100, 100);
  const within = ones();

  /* A scatter of pinholes through the inferred patch, each far too small to
     survive tracing. */
  let punched = 0;
  for (let y = 52; y < 79; y += 3) {
    for (let x = 52; x < 79; x += 3) { predicted[y * GRID + x] = 0; punched++; }
  }

  const onMask = mistakeCounts({ truth, predicted, within, inferred });
  check('the raw mask really does miss ground inside the inferred patch',
    onMask.missedInferredPct > 5, `${onMask.missedInferredPct.toFixed(1)}% (${punched} cells)`);

  const t = tracePrediction({ predicted, within, grid: GRID, mpp: 0.12 });
  const traced = traceMask({ shapes: t.shapes, within, grid: GRID });
  const onTrace = mistakeCounts({ truth, predicted: traced, within, inferred });

  check('but the outline drawn from it does not, because the holes are filled',
    onTrace.missedInferredPct === 0,
    `${onTrace.missedInferredPct.toFixed(1)}% -- this is the number the page must print`);

  /*
   * AND THE TIDYING IS REPORTED RATHER THAN SILENT. Filling holes makes the
   * picture tidier than the model's answer, which is exactly how a rendering
   * could flatter a model without anybody lying.
   */
  const drift = traceDrift({ predicted, traced, within });
  check('and the square footage the tracer filled in is counted',
    drift.added >= punched, `${drift.added} cells filled, ${punched} punched`);

  /*
   * A HOLE BIG ENOUGH TO MEAN SOMETHING STILL SURVIVES. If filling were
   * unconditional, a shed or a pool would be swallowed and the outline would
   * be confidently wrong about a thing anybody can see.
   */
  const withShed = block(zeros(), 30, 30, 100, 100);
  for (let y = 55; y < 80; y++) for (let x = 55; x < 80; x++) withShed[y * GRID + x] = 0;
  const shedTrace = tracePrediction({ predicted: withShed, within, grid: GRID, mpp: 0.12 });
  const shedMask = traceMask({ shapes: shedTrace.shapes, within, grid: GRID });
  check('a hole big enough to be an object is kept, not filled',
    shedMask[67 * GRID + 67] === 0 && shedMask[35 * GRID + 35] === 1,
    `${shedTrace.rings.length} rings -- the outer ring plus the hole`);
}

/* ----------------------------------------- the property line clips the trace */
{
  /*
   * Same rule as the measurement: the parcel is the last word on what counts.
   * An outline that ran over the boundary would be a picture of work the app
   * would never hand anybody.
   */
  const predicted = block(zeros(), 20, 20, 100, 100);
  const within = block(zeros(), 50, 50, 110, 110);
  const t = tracePrediction({ predicted, within, grid: GRID, mpp: 0.5 });
  const xs = t.rings.flat().map((p) => p[0]);
  const ys = t.rings.flat().map((p) => p[1]);
  check('nothing is drawn outside the property line',
    Math.min(...xs) >= 49 && Math.min(...ys) >= 49,
    `starts at ${Math.min(...xs)}, ${Math.min(...ys)}`);
}

/* -------------------------------------------------- an outline, not a fill */
{
  const truth = block(zeros(), 30, 30, 90, 90);
  /* A square ring, drawn by hand so the test does not depend on the tracer. */
  const ring = [[40, 40], [80, 40], [80, 80], [40, 80], [40, 40]];
  const out = drawPrediction({
    photo: photo(), truth, within: null, inferred: null, rings: [ring], grid: GRID,
  });

  check('the outline is painted in the detector\'s colour',
    same(at(out, 60, 40), TRACE), JSON.stringify(at(out, 60, 40)));

  /*
   * THE INSIDE IS NOT FILLED. A filled shape hides the ground it is sitting
   * on, and the ground is what the failures have to be read against -- gravel,
   * shade, a flat roof. It would also make the two mistakes unreadable, since
   * both are now absences rather than colours.
   */
  const inside = at(out, 60, 60);
  check('and the ground inside it stays visible',
    !same(inside, TRACE) && inside[1] > inside[0],
    `${JSON.stringify(inside)} -- should be the green wash, not the outline`);

  /*
   * EVERY VERTEX IS MARKED, because the handle count is most of the answer to
   * "how long would this take to fix". Twenty handles round a lawn is a shape
   * somebody nudges; two hundred is one they delete and redraw.
   */
  const corner = at(out, 40, 40);
  check('every handle is marked where it would be dragged',
    !same(corner, TRACE) && corner[0] > 240 && corner[2] > 200,
    `${JSON.stringify(corner)} -- the pale core of a vertex dot`);

  /*
   * AND THE HAND-TRACED LAWN IS OUTLINED, NOT ONLY WASHED.
   *
   * The wash alone says "greener here", which on a photograph that is already
   * mostly grass needs something to compare against. The comparison IS the
   * page: two outlines, one a person's and one the model's, close together or
   * not. A green line alone is lawn it gave up on.
   */
  check('the hand-traced lawn is outlined too, so the two can be compared',
    same(at(out, 30, 60), TRUTH_FILL), JSON.stringify(at(out, 30, 60)));

  /* Inside that outline it is a wash, so a missed area reads as green ground
     rather than as bare photograph. */
  const washed = at(out, 35, 60);
  check('the real lawn is washed green, and left readable underneath',
    washed[1] > washed[0] && washed[1] > washed[2] && washed[1] < 160,
    JSON.stringify(washed));
  check('and ground that is neither is left as the photograph',
    same(at(out, 100, 100), [100, 100, 100]), JSON.stringify(at(out, 100, 100)));
}

/* ----------------------------------------- outside the property line */
{
  /*
   * Dimmed, not painted and not cropped. It is not scored, so it must not read
   * as part of the judgement -- but it is the context that explains half of
   * the over-calls, because a boundary over-call usually means the neighbour's
   * lawn runs on.
   */
  const truth = ones();
  const within = block(zeros(), 0, 0, GRID - 1, 63);
  const out = drawPrediction({
    photo: photo(), truth, within, inferred: null, rings: [], grid: GRID,
  });

  const outside = at(out, 60, 100);
  check('ground outside the property line is dimmed',
    outside[0] < 100 && outside[0] === outside[1] && outside[1] === outside[2],
    JSON.stringify(outside));
  check('and not washed as lawn, however much lawn is out there',
    !(outside[1] > outside[0]), JSON.stringify(outside));
  /*
   * The lawn's own outline stops at the line as well. A green edge running out
   * through the dimmed ground would read as scored lawn, which is the one
   * thing the dimming exists to prevent.
   */
  check('and the hand-traced outline stops at the line too',
    same(at(out, 60, 70), outside) && same(at(out, 60, GRID - 1), outside),
    `${JSON.stringify(at(out, 60, 70))} / ${JSON.stringify(at(out, 60, GRID - 1))}`);
  check('and it stays visible rather than being blacked out',
    outside[0] > 20, String(outside[0]));
}

/* -------------------------------------------------- the inferred outline */
{
  /*
   * An outline rather than a fill, drawn under the trace and over the wash.
   * The question it answers is "does it give up exactly where the reviewer
   * said I know it is lawn and cannot see it", which needs the trace and the
   * marking visible at the same time.
   */
  const truth = zeros();
  const inferred = block(zeros(), 40, 40, 60, 60);
  const out = drawPrediction({
    photo: photo(), truth, within: null, inferred, rings: [], grid: GRID,
  });

  check('marked ground is outlined in purple',
    same(at(out, 40, 50), INFERRED_EDGE), JSON.stringify(at(out, 40, 50)));
  check('and outlined rather than filled, so the ground in it can be judged',
    same(at(out, 50, 50), [100, 100, 100]), JSON.stringify(at(out, 50, 50)));

  /* The trace goes on top of it: the marking is context, the outline is the
     subject. */
  const over = drawPrediction({
    photo: photo(),
    truth,
    within: null,
    inferred,
    rings: [[[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]]],
    grid: GRID,
  });
  check('and the detector\'s outline is drawn on top of it',
    same(at(over, 50, 40), TRACE), JSON.stringify(at(over, 50, 40)));
}

/* --------------------------------------- the colours mean the same as before */
{
  /*
   * These are the console's own three, so that somebody arriving from the
   * review card reads one vocabulary rather than two. tools/markup.test.js
   * checks them against REVIEW_COLOURS and against the page's legend; here
   * they only have to be distinguishable from each other on a photograph.
   */
  const apart = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  check('the outline, the lawn and the inferred mark are told apart at a glance',
    apart(TRACE, TRUTH_FILL) > 150 && apart(TRACE, INFERRED_EDGE) > 150
    && apart(TRUTH_FILL, INFERRED_EDGE) > 150,
    `${apart(TRACE, TRUTH_FILL)} / ${apart(TRACE, INFERRED_EDGE)} / `
    + `${apart(TRUTH_FILL, INFERRED_EDGE)}`);
}

/* ------------------------------------------------------- the counts */
{
  /*
   * Still measured on the mask, not on the trace. These are the run's own
   * numbers -- the ones in the table and in docs/DETECTOR-FINDINGS.md -- and a
   * second set that differed by a percent because of smoothing would be
   * impossible to compare against anything.
   */
  const truth = zeros();
  const predicted = zeros();
  const within = ones();
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
  const half = zeros();
  half[0] = 1;
  const clipped = mistakeCounts({ truth, predicted, within: half, inferred: null });
  check('and ground outside the property line is not counted',
    clipped.lawnPx === 1 && clipped.missed === 0 && clipped.overcalled === 0,
    JSON.stringify(clipped));
}

{
  /* THE LAYERS (owner, 2026-09-26): one transparent frame per layer, in LAYERS
     order, so the page can show slice k the same way on every lawn. */
  const within = zeros();
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID / 2; x++) within[y * GRID + x] = 1;
  const roof = zeros();
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) roof[y * GRID + x] = 1;
  const L = drawLayers({ photo: photo(), within, grid: GRID, masks: { roof, line: within } });
  const k = (id) => LAYERS.findIndex((l) => l.id === id);
  const frame = (id) => L.sprite.subarray(k(id) * N * 4, (k(id) + 1) * N * 4);
  check('the sprite holds one frame per layer', L.sprite.length === N * 4 * LAYERS.length && L.layers.length === LAYERS.length);
  const alphaAt = (id, x, y) => frame(id)[(y * GRID + x) * 4 + 3];
  check('a roof cell is painted on the roof frame', alphaAt('roof', 20, 20) > 0 || alphaAt('roof', 21, 20) > 0);
  check('and nothing is painted on the roof frame away from it', alphaAt('roof', 100, 100) === 0);
  check('a layer with no mask is an empty frame, not an error', frame('naipCanopy').every((v) => v === 0));
  check('the photograph is opaque and dimmed outside the line',
    L.photo[(5 * GRID + 100) * 4 + 3] === 255 && L.photo[(5 * GRID + 100) * 4] < L.photo[(5 * GRID + 5) * 4]);
  check('every layer has a label and a colour', LAYERS.every((l) => l.label && l.colour.length === 3));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
