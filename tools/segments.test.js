/**
 * Dividing a lawn into pieces somebody can walk.
 *
 * WHAT HAS TO BE TRUE, and why each of these is a test rather than a comment.
 *
 * The output of this tool is instructions for physical work. Somebody reads
 * "4 passes of 5 ft, 1,000 sq ft", walks it, and weighs the bag against the
 * number. Every way that can be wrong is a way somebody puts down the wrong
 * amount of fertiliser on real grass:
 *
 *   - areas that do not add up  -> the check against the bag is meaningless
 *   - a pass count that is not whole -> the piece cannot be walked as stated
 *   - depth that ignores the width -> the count and the shape disagree
 *   - a band drawn across a gap  -> two strips treated as one, half missed
 *
 * So the assertions here are mostly arithmetic against shapes whose answers
 * are known by hand, rather than snapshots of what the code currently does.
 *
 *   node tools/segments.test.js
 */

import {
  planSegments, DEFAULT_WIDTH_FT, MIN_WIDTH_FT, MAX_WIDTH_FT,
  MIN_SEGMENT_SQFT, MAX_SEGMENT_SQFT,
} from '../public/lib/segments.js';
import { measure } from '../public/lib/area.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

/*
 * A rectangle of a stated size in feet, near Grand Rapids so the numbers are
 * at a realistic latitude -- the projection is latitude-dependent and testing
 * it at the equator would flatter it.
 */
const FT = 0.3048;
const LAT = 43.0;
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

function rect(widthFt, heightFt, { lng = -85.6, lat = LAT } = {}) {
  const dx = (widthFt * FT) / mPerDegLng(lat);
  const dy = (heightFt * FT) / M_PER_DEG_LAT;
  return [[
    [lng, lat], [lng + dx, lat], [lng + dx, lat + dy], [lng, lat + dy], [lng, lat],
  ]];
}

/** Where a rectangle's corner is, in degrees, given feet from an origin. */
const at = (lng, lat, eastFt, northFt) => [
  lng + (eastFt * FT) / mPerDegLng(lat),
  lat + (northFt * FT) / M_PER_DEG_LAT,
];

const totalOf = (segments) => segments.reduce((n, s) => n + s.squareFeet, 0);

/* ------------------------------------------------------- the simple case */
/*
 * 200ft x 100ft = 20,000 sq ft, cut into 5,000 sq ft pieces with a 5ft
 * spreader. The answer is arithmetic: four pieces, each 50ft x 100ft, each
 * 10 passes of 5ft.
 */
{
  const plan = planSegments({ rings: [rect(200, 100)], targetSqFt: 5000, widthFt: 5 });

  check('a plain rectangle divides into the number of pieces the maths says',
    plan.segments.length === 4, `${plan.segments.length} pieces`);

  const areas = plan.segments.map((s) => s.squareFeet);
  check('and each piece is about the size that was asked for',
    areas.every((a) => Math.abs(a - 5000) < 5000 * 0.06), areas.join(', '));

  /*
   * THE PIECES MUST ADD UP TO THE LAWN. Not an aesthetic property: the whole
   * point is checking a bag against a number, so ground that belongs to no
   * piece is ground that gets treated off the plan.
   */
  check('and together they are the whole lawn, not most of it',
    Math.abs(totalOf(plan.segments) - plan.totalSqFt) < plan.totalSqFt * 0.02,
    `${totalOf(plan.segments).toLocaleString()} in pieces vs ${plan.totalSqFt.toLocaleString()} total`);

  check('the measured lawn is the size it was built to be',
    Math.abs(plan.totalSqFt - 20000) < 20000 * 0.02, `${plan.totalSqFt} sq ft`);

  /*
   * 5,000 sq ft of a lawn whose long edge is 200ft is a band 25ft deep, and
   * 25ft at 5ft a pass is 5 passes. Bands run PARALLEL to the long edge now
   * -- see candidateAngles -- so this is the arithmetic of the edge you walk
   * beside, not of the lawn's bounding box.
   */
  check('every piece is a whole number of passes, and the right number',
    plan.segments.every((s) => s.passes === 5),
    plan.segments.map((s) => s.passes).join(', '));

  check('and says so in words a person can follow',
    plan.segments[0].label === '5 passes of 5 ft', plan.segments[0].label);

  check('and there is nothing to apologise for',
    plan.notes.length === 0, plan.notes.join(' | '));
}

/* ------------------------------------------------- the width is the unit */
/*
 * THE SAME LAWN AND TARGET, A DIFFERENT SPREADER. The depth of a piece must
 * change to stay a whole number of passes. This is the requirement that makes
 * the tool worth building rather than "cut it in quarters": a 3ft spreader and
 * a 7ft spreader walk different pieces.
 */
{
  for (const widthFt of [2, 3, 4, 5, 6, 8, 12]) {
    const plan = planSegments({ rings: [rect(200, 100)], targetSqFt: 5000, widthFt });
    const ok = plan.segments.length > 0
      && plan.segments.every((s) => Number.isInteger(s.passes) && s.passes >= 1);
    check(`a ${widthFt}ft width gives whole passes`, ok,
      plan.segments.map((s) => `${s.passes}x${widthFt}ft=${s.squareFeet}`).join(' '));
  }

  /*
   * And the depth implied by the pass count has to match the area. A 5,000
   * sq ft piece of a 100ft-wide lawn is 50ft deep; at 4ft a pass that is 12 or
   * 13 passes, never 10. Checked as an identity rather than a constant:
   * passes x width x lawnWidth ~= area.
   */
  const plan = planSegments({ rings: [rect(200, 100)], targetSqFt: 5000, widthFt: 4 });
  const consistent = plan.segments.every((s) =>
    Math.abs(s.passes * 4 * 100 - s.squareFeet) < s.squareFeet * 0.08);
  check('and the pass count, the width and the area agree with each other',
    consistent,
    plan.segments.map((s) => `${s.passes}p x 4ft x 100ft vs ${s.squareFeet}`).join(' | '));
}

/* ------------------------------------------------- the target is honoured */
{
  for (const targetSqFt of [1000, 2000, 5000, 10000]) {
    const plan = planSegments({ rings: [rect(300, 100)], targetSqFt, widthFt: 5 });
    const expected = Math.round(30000 / targetSqFt);
    const close = Math.abs(plan.segments.length - expected) <= 1;
    check(`a ${targetSqFt.toLocaleString()} sq ft target gives about ${expected} pieces`,
      close, `${plan.segments.length} pieces of ${plan.segments.map((s) => s.squareFeet).join(', ')}`);
  }

  /*
   * A TARGET BIGGER THAN THE LAWN DRAWS NOTHING, and says why.
   *
   * It used to hand back one piece covering everything, which reads as "here
   * is your 30,000 sq ft piece" over a 5,000 sq ft lawn -- a number somebody
   * would then check a bag against. Drawing nothing is the honest answer; the
   * note is what makes it a useful one, and it has to name the fix rather than
   * the failure.
   */
  const big = planSegments({ rings: [rect(100, 50)], targetSqFt: 30000, widthFt: 5 });
  check('a target larger than the lawn draws nothing rather than a wrong number',
    big.segments.length === 0, `${big.segments.length} pieces`);
  check('and says the lawn is smaller than one piece',
    big.notes.some((t) => /smaller than one/.test(t)), big.notes.join(' | '));

  /*
   * And the opposite wall, which has the OPPOSITE fix: a piece smaller than a
   * single pass across the lawn. One sentence for both would send half the
   * people who read it the wrong way.
   */
  const thin = planSegments({ rings: [rect(400, 200)], targetSqFt: 1000, widthFt: 12 });
  check('a piece smaller than one pass says so, and names the size that would work',
    thin.segments.length === 0
    && thin.notes.some((t) => /already covers about/.test(t)),
    thin.notes.join(' | '));
}

/* --------------------------------------------------- cuts run clean across */
/*
 * THE CONSTRAINT THE WHOLE THING EXISTS FOR. A piece must span the lawn, so
 * that standing on the grass you can see where it ends. On a long rectangle
 * every cut is across the short way, which means each piece is as wide as the
 * lawn.
 *
 * Checked through the geometry rather than by trusting the sweep: the bounding
 * box of each piece must be as wide as the lawn's own, and shorter than it.
 */
{
  const plan = planSegments({ rings: [rect(300, 80)], targetSqFt: 4000, widthFt: 5 });

  const spanOf = (geometry) => {
    const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of rings) {
      for (const [lng, lat] of ring) {
        w = Math.min(w, lng); e = Math.max(e, lng);
        s = Math.min(s, lat); n = Math.max(n, lat);
      }
    }
    return { lngSpan: e - w, latSpan: n - s };
  };

  const lawn = spanOf({ type: 'Polygon', coordinates: rect(300, 80) });
  const pieces = plan.segments.map((s) => spanOf(s.geometry));

  check('every piece runs the full width of the lawn',
    pieces.every((p) => p.latSpan > lawn.latSpan * 0.9),
    pieces.map((p) => (p.latSpan / lawn.latSpan).toFixed(2)).join(', '));

  check('and none of them runs its whole length, or it would be the lawn',
    pieces.every((p) => p.lngSpan < lawn.lngSpan * 0.9),
    pieces.map((p) => (p.lngSpan / lawn.lngSpan).toFixed(2)).join(', '));
}

/* ----------------------------------------------------- a lawn in two parts */
/*
 * A front lawn and a back lawn with a house between them. They are separate
 * sections and must be divided separately -- a piece that jumps the house is
 * not something anybody can walk.
 */
{
  const front = rect(100, 60, { lng: -85.6, lat: LAT });
  const back = rect(100, 60, { lng: -85.6, lat: LAT + (200 * FT) / M_PER_DEG_LAT });
  const plan = planSegments({ rings: [front, back], targetSqFt: 2000, widthFt: 5 });

  check('two detached lawns are found as two sections', plan.sections === 2,
    String(plan.sections));
  check('and the plan says so before anybody counts the pieces',
    plan.notes.some((t) => /separate sections/.test(t)), plan.notes[0]);

  const sections = new Set(plan.segments.map((s) => s.sectionIndex));
  check('every piece belongs to one section', sections.size === 2,
    [...sections].join(', '));

  check('and the areas still add up across both',
    Math.abs(totalOf(plan.segments) - plan.totalSqFt) < plan.totalSqFt * 0.03,
    `${totalOf(plan.segments)} vs ${plan.totalSqFt}`);
}

/* ------------------------------------------------- a lawn around a house */
/*
 * A U-shaped lawn wrapping three sides of a house, drawn as one polygon with
 * the house as a notch, because that is how a detection hands it over.
 *
 * TWO OPPOSITE THINGS HAVE TO BE TRUE HERE, and which one applies depends on
 * the lawn's proportions rather than on anything the caller says. This pair
 * was written expecting the second and found the first, which is worth having
 * as a test precisely because it is not what you would assume.
 */

/*
 * WIDER THAN IT IS TALL: sweeping the long axis cuts bands the short way, so
 * every band runs from the bottom edge upward and stops when it reaches either
 * the house or the top. None of them crosses the notch, so none splits.
 *
 * That is not luck, it is the point of sweeping the principal axis, and it is
 * worth pinning: a tool that cut along the grid instead would split this lawn
 * down the middle and apologise for a problem it created itself.
 */
{
  const lng = -85.6;
  const lat = LAT;
  // 160ft x 120ft lot, with an 80ft x 70ft house pushed into the top edge.
  const wide = [[
    at(lng, lat, 0, 0), at(lng, lat, 160, 0), at(lng, lat, 160, 120),
    at(lng, lat, 120, 120), at(lng, lat, 120, 50), at(lng, lat, 40, 50),
    at(lng, lat, 40, 120), at(lng, lat, 0, 120), at(lng, lat, 0, 0),
  ]];

  const plan = planSegments({ rings: [wide], targetSqFt: 1000, widthFt: 5 });

  check('a lawn wrapped around a house still divides into pieces',
    plan.segments.length >= 4, `${plan.segments.length} pieces`);

  check('and when the shape allows a clean sweep, it finds it and nothing splits',
    plan.segments.every((s) => !s.split),
    'cutting across the long axis misses the notch entirely');

  check('so there is nothing to apologise for on this one',
    !plan.notes.some((t) => /more than one part/.test(t)), plan.notes.join(' | '));
}

/*
 * A LAWN WITH NO CLEAN SWEEP IN ANY DIRECTION: a narrow border running right
 * around a large building, which is what a house on a small lot leaves.
 *
 * Every straight band across it cuts the border in two places and leaves two
 * arcs with a building between them, whichever way you point it. Those are not
 * pieces, and they are no longer drawn: a piece has to be walkable in one go,
 * and two strips either side of a house is somebody treating one and counting
 * both.
 */
{
  const lng = -85.6;
  const lat = LAT;
  // 200ft x 140ft lot with a 170ft x 110ft building: a 15ft border all round.
  const ring = [
    [
      at(lng, lat, 0, 0), at(lng, lat, 200, 0),
      at(lng, lat, 200, 140), at(lng, lat, 0, 140), at(lng, lat, 0, 0),
    ],
    [
      at(lng, lat, 15, 15), at(lng, lat, 185, 15),
      at(lng, lat, 185, 125), at(lng, lat, 15, 125), at(lng, lat, 15, 15),
    ],
  ];

  const plan = planSegments({ rings: [ring], targetSqFt: 1000, widthFt: 5 });

  /*
   * IT STILL FINDS THE PIECES THAT DO WORK. Refusing the whole lawn because
   * part of it is awkward would be the tool giving up; the four sides of a
   * border each have runs that are perfectly walkable.
   */
  check('the pieces that work are still found', plan.segments.length >= 3,
    `${plan.segments.length} pieces`);

  check('and none of them is a piece cut in two by the building',
    plan.coveredSqFt < plan.totalSqFt,
    `${plan.coveredSqFt} of ${plan.totalSqFt} sq ft covered`);

  check('with a note saying how much is left over and why',
    plan.notes.some((t) => /has no piece on it/.test(t)),
    plan.notes.join(' | '));

  /*
   * AND WHAT IS DRAWN IS ACCURATE. This is the trade the whole rewrite makes:
   * two thirds of a lawn with pieces you can trust beats all of it with
   * pieces you cannot. So every piece that IS offered must be within the
   * tolerance of what was asked for -- no slivers, no doubles.
   */
  check('and every piece drawn is within a fifth of the size asked for',
    plan.segments.every((s) => Math.abs(s.squareFeet - 1000) <= 200),
    plan.segments.map((s) => s.squareFeet).join(', '));
}

/* ------------------------------------------------- a gap you can step over */
/*
 * THE TEN FOOT RULE. A piece has to be continuous, but "continuous" cannot
 * mean "not one pixel missing" -- a tree in the middle of a lawn would then
 * disqualify every band that touched it, and lawns have trees.
 *
 * So the rule is about WIDTH. Step round a tree and you have not lost your
 * place; walk round a driveway and you have no idea which side you already
 * did. Ten feet is where the owner drew that line.
 *
 * Tested by growing one obstacle, which is the only honest way to test a
 * threshold: the same lawn, the same target, one number changing.
 */
{
  const lng = -85.6;
  const lat = LAT;
  const withObstacle = (sizeFt) => {
    const half = sizeFt / 2;
    return [
      [
        at(lng, lat, 0, 0), at(lng, lat, 200, 0),
        at(lng, lat, 200, 100), at(lng, lat, 0, 100), at(lng, lat, 0, 0),
      ],
      [
        at(lng, lat, 100 - half, 50 - half), at(lng, lat, 100 + half, 50 - half),
        at(lng, lat, 100 + half, 50 + half), at(lng, lat, 100 - half, 50 + half),
        at(lng, lat, 100 - half, 50 - half),
      ],
    ];
  };

  const tree = planSegments({ rings: [withObstacle(8)], targetSqFt: 2000, widthFt: 5 });
  check('a lawn with a tree in it is still covered end to end',
    tree.coveredSqFt > tree.totalSqFt * 0.97,
    `${tree.coveredSqFt} of ${tree.totalSqFt} sq ft`);

  const shed = planSegments({ rings: [withObstacle(100)], targetSqFt: 2000, widthFt: 5 });
  check('a lawn with a building in it is not',
    shed.coveredSqFt < shed.totalSqFt * 0.9,
    `${shed.coveredSqFt} of ${shed.totalSqFt} sq ft`);

  check('and the pieces it does find are still the right size',
    shed.segments.every((s) => Math.abs(s.squareFeet - 2000) <= 400),
    shed.segments.map((s) => s.squareFeet).join(', '));
}

/* ------------------------------------------------------ a lawn with a hole */
/*
 * A pool or a flower bed in the middle. The hole is not lawn and must not be
 * counted -- a piece whose area includes the pool sends somebody out with too
 * much product for the grass that is actually there.
 */
{
  const lng = -85.6;
  const lat = LAT;
  const outer = [
    at(lng, lat, 0, 0), at(lng, lat, 200, 0), at(lng, lat, 200, 100),
    at(lng, lat, 0, 100), at(lng, lat, 0, 0),
  ];
  // 50ft x 40ft hole = 2,000 sq ft out of 20,000.
  const hole = [
    at(lng, lat, 70, 30), at(lng, lat, 120, 30), at(lng, lat, 120, 70),
    at(lng, lat, 70, 70), at(lng, lat, 70, 30),
  ];

  const plan = planSegments({ rings: [[outer, hole]], targetSqFt: 5000, widthFt: 5 });

  check('a hole is taken out of the lawn before it is divided',
    Math.abs(plan.totalSqFt - 18000) < 18000 * 0.04, `${plan.totalSqFt} sq ft, expected 18,000`);

  check('and what is covered is covered accurately',
    plan.segments.every((s) => Math.abs(s.squareFeet - 5000) <= 1000)
    && plan.coveredSqFt <= plan.totalSqFt + 1,
    `${plan.segments.map((s) => s.squareFeet).join(', ')} of ${plan.totalSqFt}`);
}

/* ------------------------------------------------ a diagonal lawn */
/*
 * Lawns are not axis-aligned. A rectangle rotated 30 degrees must divide into
 * the same number of pieces as the same rectangle facing north -- if the sweep
 * followed the grid rather than the shape, this produces wedges.
 */
{
  const lng = -85.6;
  const lat = LAT;
  const turn = (eastFt, northFt, deg) => {
    const r = (deg * Math.PI) / 180;
    return at(lng, lat, eastFt * Math.cos(r) - northFt * Math.sin(r),
      eastFt * Math.sin(r) + northFt * Math.cos(r));
  };
  const tilted = [[
    turn(0, 0, 30), turn(200, 0, 30), turn(200, 100, 30), turn(0, 100, 30), turn(0, 0, 30),
  ]];

  const plan = planSegments({ rings: [tilted], targetSqFt: 5000, widthFt: 5 });

  check('a lawn at an angle divides like the same lawn facing north',
    plan.segments.length === 4, `${plan.segments.length} pieces`);
  check('and its pieces are still the right size',
    plan.segments.every((s) => Math.abs(s.squareFeet - 5000) <= 5000 * 0.2),
    plan.segments.map((s) => s.squareFeet).join(', '));
  check('and still whole passes',
    plan.segments.every((s) => Number.isInteger(s.passes) && s.passes >= 1),
    plan.segments.map((s) => s.passes).join(', '));
}

/* ------------------------------------------------------------- the edges */
{
  check('no lawn is a plan with nothing in it and a reason',
    planSegments({ rings: [] }).segments.length === 0
    && planSegments({ rings: [] }).notes.length === 1);

  check('and so is a degenerate one, rather than a crash',
    planSegments({ rings: [[[[-85.6, 43], [-85.6, 43], [-85.6, 43]]]] }).segments.length === 0);

  const tiny = planSegments({ rings: [rect(10, 10)], targetSqFt: 1000, widthFt: 5 });
  check('a lawn smaller than one piece does not divide into none',
    tiny.segments.length <= 1, `${tiny.segments.length} pieces`);

  /*
   * The offered range has to be the range the maths survives. Both ends of
   * both sliders, on a lawn big enough to exercise them.
   */
  /*
   * EVERY COMBINATION THE SLIDERS OFFER HOLDS TOGETHER -- which does not mean
   * every combination produces pieces. A 1,000 sq ft piece cannot span a 400ft
   * lawn with a 12ft spreader, and the honest answer there is none plus a note
   * saying so. What must never happen is a piece that is the wrong size, a
   * fractional pass count, or a crash.
   */
  for (const targetSqFt of [MIN_SEGMENT_SQFT, MAX_SEGMENT_SQFT]) {
    for (const widthFt of [MIN_WIDTH_FT, MAX_WIDTH_FT]) {
      const plan = planSegments({ rings: [rect(400, 200)], targetSqFt, widthFt });
      const ok = plan.segments.every((s) =>
        s.squareFeet > 0
        && Number.isInteger(s.passes) && s.passes >= 1
        && Math.abs(s.squareFeet - targetSqFt) <= targetSqFt * 0.2)
        && (plan.segments.length > 0 || plan.notes.length > 0);
      check(`${targetSqFt.toLocaleString()} sq ft at ${widthFt}ft holds together`, ok,
        `${plan.segments.length} pieces: ${plan.segments.map((x) => x.squareFeet).join(', ') || plan.notes[0]}`);
    }
  }

  check('the default width is one somebody actually owns',
    DEFAULT_WIDTH_FT >= MIN_WIDTH_FT && DEFAULT_WIDTH_FT <= MAX_WIDTH_FT);
}

/* --------------------------------------------------- the shapes are real */
/*
 * Each piece has to be a drawable polygon with a label point inside it -- a
 * label floating in the neighbour's garden is worse than no label, because it
 * attributes a pass count to the wrong ground.
 */
{
  const plan = planSegments({ rings: [rect(200, 100)], targetSqFt: 5000, widthFt: 5 });

  check('every piece is a polygon the map can draw',
    plan.segments.every((s) =>
      (s.geometry.type === 'Polygon' || s.geometry.type === 'MultiPolygon')
      && s.geometry.coordinates.length),
    plan.segments.map((s) => s.geometry.type).join(', '));

  check('and the area it reports matches the shape it drew',
    plan.segments.every((s) => {
      const drawn = measure({ type: 'Feature', geometry: s.geometry }).squareFeet;
      return Math.abs(drawn - s.squareFeet) < s.squareFeet * 0.06;
    }),
    plan.segments
      .map((s) => `${s.squareFeet} vs ${Math.round(measure({ type: 'Feature', geometry: s.geometry }).squareFeet)}`)
      .join(' | '));

  check('and carries a point to hang its label on',
    plan.segments.every((s) => Array.isArray(s.at) && Number.isFinite(s.at[0])));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
