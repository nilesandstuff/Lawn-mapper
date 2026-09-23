/**
 * The brush must not move the parts of an outline it never touched.
 *
 * REPORTED THREE TIMES. "The brush tools cause edges to creep in across the
 * whole shape" -- then, after a fix that spared shapes the stroke came nowhere
 * near, "now it doesn't happen when the brush doesn't actually change
 * anything, but actual brush strokes do still change things."
 *
 * Which was exactly right, and names the half that was missed: within a shape
 * the brush DOES touch, the whole outline was going through rasterise-and-
 * retrace, with a tolerance meant for smoothing model noise (0.8m) and a cap
 * of 30 vertices. Ninety percent of that outline is nowhere near the stroke,
 * and all of it moved.
 *
 * So these tests measure the thing the report is about: how far a vertex FAR
 * FROM THE STROKE moves, and whether it keeps moving when you do it again.
 * Accumulation is the property that matters -- a single sub-millimetre shift
 * is invisible, and twenty of them are a lawn that has visibly shrunk.
 *
 *   node tools/stitch.test.js
 */

import { restoreAway, distanceToPath, nearestOnRings, dropCollinear } from '../public/lib/stitch.js';
import { makeFrame } from '../public/lib/edges.js';
import { measure } from '../public/lib/area.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const FT = 0.3048;
const LAT = 43.0;
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const at = (eastFt, northFt) => [
  -85.6 + (eastFt * FT) / mPerDegLng(LAT),
  LAT + (northFt * FT) / M_PER_DEG_LAT,
];
const frame = makeFrame(at(0, 0));
const metresBetween = (a, b) => {
  const [ax, ay] = frame.toXY(a);
  const [bx, by] = frame.toXY(b);
  return Math.hypot(ax - bx, ay - by);
};

/* A 200ft x 100ft lawn with a corner at a known place. */
const lawn = [
  at(0, 0), at(200, 0), at(200, 100), at(0, 100), at(0, 0),
];

/**
 * What the tracer does to a ring: snap every vertex to a pixel grid and shave
 * it inward a touch. Not a mock of the real tracer -- a deliberately crude
 * stand-in for the ONE property that matters, that the round trip perturbs
 * every vertex of the whole outline whether or not the brush went near it.
 */
function perturb(ring, metres) {
  return ring.map(([lng, lat]) => {
    const [x, y] = frame.toXY([lng, lat]);
    // Inward, because that is the direction the report describes.
    const towardX = x > 100 * FT ? -metres : metres;
    const towardY = y > 50 * FT ? -metres : metres;
    return frame.toLngLat([x + towardX, y + towardY]);
  });
}

/* ----------------------------------------------- a stroke in one corner */
/*
 * The brush is dabbed in the bottom-left corner. The far corner, 200ft away,
 * must come back exactly where it started.
 */
{
  const stroke = [at(5, 5), at(12, 8), at(18, 6)];
  const traced = perturb(lawn, 0.4);   // 40cm of drift on every vertex

  const before = traced[1];            // the (200, 0) corner, far from the stroke
  const [fixed] = restoreAway([traced], {
    originals: [lawn], stroke, reachM: 3, snapM: 1.0,
  });

  const farBefore = metresBetween(before, at(200, 0));
  const farAfter = metresBetween(
    fixed.find((p) => metresBetween(p, at(200, 0)) < 2) || fixed[1],
    at(200, 0)
  );

  check('the tracer really does move a far corner, or this proves nothing',
    farBefore > 0.3, `${farBefore.toFixed(3)}m of drift going in`);

  check('and a corner far from the brush is put back where it was',
    farAfter < 0.01, `${farAfter.toFixed(4)}m off after restoring`);

  /*
   * AND THE CORNER UNDER THE BRUSH IS LEFT ALONE. Snapping everything back
   * would undo the edit, which is the opposite failure and just as wrong.
   */
  const nearOriginal = at(0, 0);
  const nearVertex = fixed.reduce((best, p) =>
    (metresBetween(p, nearOriginal) < metresBetween(best, nearOriginal) ? p : best), fixed[0]);
  check('while the corner under the brush keeps what the stroke did to it',
    metresBetween(nearVertex, nearOriginal) > 0.1,
    `${metresBetween(nearVertex, nearOriginal).toFixed(3)}m from the old corner`);
}

/* ------------------------------------------------------- accumulation */
/*
 * THE PROPERTY THE REPORT IS ACTUALLY ABOUT. One stroke shaving a lawn by a
 * few centimetres would never be noticed. Twenty strokes shaving it twenty
 * times is a lawn that has visibly pulled in, and a square footage that is
 * quietly wrong.
 */
{
  const stroke = [at(5, 5), at(12, 8)];

  let withFix = lawn;
  let without = lawn;
  for (let i = 0; i < 20; i++) {
    without = perturb(without, 0.3);
    [withFix] = restoreAway([perturb(withFix, 0.3)], {
      originals: [lawn], stroke, reachM: 3, snapM: 1.0,
    });
  }

  /*
   * MEASURED ON THE VERTICES AWAY FROM THE BRUSH, not on the area.
   *
   * The corner under the stroke is exempt by design -- that is where the edit
   * happens, and holding it still would mean the brush did nothing. It is the
   * only vertex allowed to move, so an area figure mixes the bug (every other
   * corner creeping) with the feature (this one changing), and a test that
   * cannot tell them apart would fail on a correct implementation.
   *
   * The report is about the rest of the outline. So: how far has the rest of
   * the outline moved after twenty strokes.
   */
  const farCorners = [at(200, 0), at(200, 100), at(0, 100)];
  const worst = (ring) => Math.max(...farCorners.map(
    (corner) => Math.min(...ring.map((p) => metresBetween(p, corner)))
  ));

  check('twenty strokes without this walk the whole outline inward',
    worst(without) > 3,
    `${worst(without).toFixed(2)}m of creep at the corners furthest from the brush`);

  check('and with it the far corners have not moved at all',
    worst(withFix) < 0.01,
    `${worst(withFix).toFixed(4)}m after twenty strokes`);

  /*
   * And the lawn is only as much smaller as the one corner being edited can
   * account for -- not the whole outline's worth.
   */
  const area = (ring) => measure({
    type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
  }).squareFeet;
  const start = area(lawn);
  check('so the total loses only what the edited corner explains',
    (start - area(withFix)) / start < (start - area(without)) / start / 3,
    `${(((start - area(withFix)) / start) * 100).toFixed(1)}% with, `
    + `${(((start - area(without)) / start) * 100).toFixed(1)}% without`);
}

/* --------------------------------------------------- corners are kept */
/*
 * The vertex cap was the other half of the damage: a shape with more corners
 * than the cap lost the surplus, and which ones went shifted with the pixel
 * grid. Nothing here can restore a vertex the tracer deleted, so the caller
 * traces with a high cap -- what this checks is that restoring does not
 * ITSELF drop corners that are real.
 */
{
  const zigzag = [
    at(0, 0), at(40, 0), at(40, 20), at(80, 20), at(80, 0), at(120, 0),
    at(120, 100), at(0, 100), at(0, 0),
  ];
  const stroke = [at(5, 5)];
  const [fixed] = restoreAway([perturb(zigzag, 0.2)], {
    originals: [zigzag], stroke, reachM: 3, snapM: 1.0,
  });

  check('a corner that is a real corner survives being restored',
    fixed.length >= zigzag.length - 1,
    `${zigzag.length} corners in, ${fixed.length} out`);

  for (const corner of [at(40, 20), at(80, 20), at(120, 0)]) {
    const nearest = Math.min(...fixed.map((p) => metresBetween(p, corner)));
    check(`and lands back on (${Math.round(frame.toXY(corner)[0] / FT)}ft)`,
      nearest < 0.01, `${nearest.toFixed(4)}m off`);
  }
}

/* ------------------------------------------------- collinear cleanup */
/*
 * Snapping a traced staircase back onto the straight edge it came from leaves
 * a row of points along one line. Harmless to the area, not harmless to a
 * phone: every one is a draggable handle, and they accumulate per edit.
 */
{
  const staircase = [
    at(0, 0), at(50, 0), at(100, 0), at(150, 0), at(200, 0),
    at(200, 100), at(0, 100), at(0, 0),
  ];
  const cleaned = dropCollinear(staircase, frame);
  check('points sitting on a straight line between their neighbours are dropped',
    cleaned.length === 5, `${staircase.length} -> ${cleaned.length}`);

  check('and the shape is unchanged by dropping them',
    Math.abs(
      measure({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [cleaned] } }).squareFeet
      - measure({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [staircase] } }).squareFeet
    ) < 1);

  const square = [at(0, 0), at(100, 0), at(100, 100), at(0, 100), at(0, 0)];
  check('a shape with no redundant points is left entirely alone',
    dropCollinear(square, frame).length === square.length);
}

/* ------------------------------------------------------------ the guards */
{
  const stroke = [at(5, 5)];

  check('with nothing to compare against, the trace is returned untouched',
    restoreAway([lawn], { originals: [], stroke })[0] === lawn);

  /*
   * SNAPPING IS A CORRECTION, NOT A SEARCH. A vertex that is genuinely far
   * from the old outline is new boundary -- an erase that cut a bay into the
   * lawn, say -- and dragging it to the nearest old edge would undo the edit
   * somewhere the brush never went.
   */
  const cut = lawn.map((p, i) => (i === 1 ? at(150, 40) : p));
  const [kept] = restoreAway([cut], {
    originals: [lawn], stroke, reachM: 1, snapM: 0.3,
  });
  check('a vertex nowhere near the old outline is left where it is',
    metresBetween(kept[1], at(150, 40)) < 0.01,
    'far from the old line means new boundary, not drift');

  check('an empty ring list comes back empty',
    restoreAway([], { originals: [lawn], stroke }).length === 0);

  check('distance to an empty stroke is infinite, so nothing counts as near',
    distanceToPath(at(0, 0), [], frame) === Infinity);

  check('and the nearest point on no rings at all is nothing',
    nearestOnRings(at(0, 0), [], frame) === null);
}

/* ------------------------------------- nothing vanishes in a brush stroke */
{
  /*
   * THE LAWN-DELETING BUG, as a test.
   *
   * A stroke ends with draw.deleteAll(), so what exists afterwards is exactly
   * what afterStroke returns. That was safe while the brush worked on every
   * shape on the map. Teaching it to work on ONE LAYER narrowed what a stroke
   * may touch -- and, by the same filter, narrowed what got put back. The first
   * inferred stroke on a finished map deleted the map and left the total
   * reading only the patch just drawn.
   *
   * Both halves were individually correct, which is why neither looked wrong.
   * The invariant between them is what this holds.
   */
  const { afterStroke } = await import('../public/lib/stitch.js');

  const lawn = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', tag: 'lawn' } };
  const spared = [lawn, { type: 'Feature', properties: {}, geometry: { tag: 'drive' } }];
  const untouched = [{ type: 'Feature', properties: { inferred: true }, geometry: { tag: 'old-guess' } }];
  const made = [{ type: 'Polygon', tag: 'new' }];

  const out = afterStroke(spared, untouched, made, { inferred: true });

  check('a shape the stroke was never allowed to touch survives it',
    out.includes(lawn),
    'this is the whole bug: the finished lawn was on the other layer, the '
    + 'stroke could not see it, and it was deleted anyway');
  check('every spared and untouched shape comes back, by identity',
    spared.every((f) => out.includes(f)) && untouched.every((f) => out.includes(f)),
    `${out.length} back from ${spared.length + untouched.length} + ${made.length}`);
  check('and the shapes come back as they were, not rebuilt',
    out.find((f) => f.geometry?.tag === 'old-guess') === untouched[0],
    'a shape re-traced when the brush never reached it is the outline-creep '
    + 'bug this whole file exists for');

  const fresh = out.filter((f) => f.geometry?.tag === 'new');
  check('what the stroke made belongs to the layer it was drawn on',
    fresh.length === 1 && fresh[0].properties.inferred === true,
    JSON.stringify(fresh[0]?.properties));
  check('and on the ordinary layer it carries no mark at all',
    afterStroke([], [], made).every((f) => !f.properties.inferred),
    'an unmarked shape must not pick up a flag it was never given');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
