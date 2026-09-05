/**
 * Ground-truth tests for edge offsetting.
 *
 * The whole point of this feature is that pushing an edge out to the road
 * must NOT rotate anything. A version that quietly skews the frontage by a
 * couple of degrees still looks fine on a map and still produces a plausible
 * number, so "the bearings are unchanged" is asserted directly rather than
 * inferred from the area coming out about right.
 *
 *   node tools/edges.test.js
 */

import {
  offsetEdge,
  nearestEdge,
  nearestVertex,
  moveVertex,
  insertVertex,
  deleteVertex,
  edgeLength,
  edgeBearing,
  edgeMidpoint,
  signedArea,
  openRing,
  makeFrame,
  feetToMetres,
  metresToFeet,
} from '../public/lib/edges.js';
import { measure, geometryAreaSqM } from '../public/lib/area.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};
const closeTo = (actual, expected, tolerance, name) =>
  check(name, Math.abs(actual - expected) <= tolerance,
    `got ${actual.toFixed(3)}  expected ~${expected.toFixed(3)}`);

const poly = (ring) => ({ type: 'Polygon', coordinates: [ring] });

/* A rectangular lot in Hudsonville, built in metres so the expected numbers
 * are exact rather than reverse-engineered from the code under test. */
const ORIGIN = [-85.8637, 42.8703];
const frame = makeFrame(ORIGIN);
const rect = (w, h) => [
  frame.toLngLat([0, 0]),
  frame.toLngLat([w, 0]),
  frame.toLngLat([w, h]),
  frame.toLngLat([0, h]),
  frame.toLngLat([0, 0]),
];

const LOT = rect(30, 45); // 30 m of frontage, 45 m deep

/* --------------------------------------------------------------- basics */
{
  check('openRing drops the closing vertex', openRing(LOT).length === 4);
  closeTo(edgeLength(LOT, 0), 30, 0.05, 'edge 0 is the 30 m frontage');
  closeTo(edgeLength(LOT, 1), 45, 0.05, 'edge 1 is the 45 m side');

  const mid = edgeMidpoint(LOT, 0);
  const [mx, my] = frame.toXY(mid);
  check('edge midpoint sits halfway along', Math.abs(mx - 15) < 0.05 && Math.abs(my) < 0.05,
    `(${mx.toFixed(2)}, ${my.toFixed(2)})`);

  closeTo(geometryAreaSqM(poly(LOT)), 30 * 45, 2, 'the test lot really is 1350 m^2');
}

/* ------------------------------------------------- the offset itself */
{
  const FEET = 15;
  const metres = feetToMetres(FEET);
  const moved = offsetEdge(LOT, 0, metres);

  // Edge 0 runs along y = 0 with the lot above it, so "outward" is downward:
  // the area must grow by frontage x distance.
  const before = geometryAreaSqM(poly(LOT));
  const after = geometryAreaSqM(poly(moved));
  closeTo(after - before, 30 * metres, 1.5,
    `extending 30 m of frontage by ${FEET} ft adds frontage x distance`);

  check('the ring still has the same number of corners',
    openRing(moved).length === openRing(LOT).length);

  // The point of the whole exercise.
  for (let i = 0; i < 4; i++) {
    const was = edgeBearing(LOT, i);
    const now = edgeBearing(moved, i);
    const drift = Math.abs(((now - was + 540) % 360) - 180);
    check(`edge ${i} keeps its bearing`, drift < 0.01,
      `${was.toFixed(3)}° -> ${now.toFixed(3)}°`);
  }

  // Only the two corners of the moved edge should shift.
  const a = openRing(LOT);
  const b = openRing(moved);
  const shifted = a.map((p, i) => Math.hypot(...frame.toXY(b[i]).map((v, k) => v - frame.toXY(p)[k])));
  check('exactly two corners moved',
    shifted.filter((d) => d > 0.01).length === 2, shifted.map((d) => d.toFixed(2)).join(', '));
  closeTo(shifted[0], metres, 0.02, 'corner 0 moved by the requested distance');
  closeTo(shifted[1], metres, 0.02, 'corner 1 moved by the requested distance');

  // The two side edges get longer by the same amount.
  closeTo(edgeLength(moved, 1), 45 + metres, 0.02, 'the side edge grew to meet it');
  closeTo(edgeLength(moved, 0), 30, 0.02, 'the frontage kept its length');
}

/* ----------------------------------------------------- pulling inward */
{
  const metres = feetToMetres(10);
  const out = offsetEdge(LOT, 0, metres);
  const back = offsetEdge(out, 0, -metres);
  const a = openRing(LOT);
  const b = openRing(back);
  const worst = Math.max(...a.map((p, i) => Math.hypot(
    ...frame.toXY(b[i]).map((v, k) => v - frame.toXY(p)[k])
  )));
  check('out then back returns to the original', worst < 0.02, `worst drift ${worst.toFixed(4)} m`);
}

/* ------------------------------------- a lot that is not a rectangle */
{
  // A pie-slice lot: the frontage is not perpendicular to the sides, which is
  // where naive "just move both corners outward" goes wrong.
  const trapezoid = [
    frame.toLngLat([0, 0]),
    frame.toLngLat([30, 0]),
    frame.toLngLat([38, 45]),
    frame.toLngLat([-8, 45]),
    frame.toLngLat([0, 0]),
  ];

  const metres = feetToMetres(20);
  const moved = offsetEdge(trapezoid, 0, metres);

  for (let i = 0; i < 4; i++) {
    const drift = Math.abs(((edgeBearing(moved, i) - edgeBearing(trapezoid, i) + 540) % 360) - 180);
    check(`angled lot: edge ${i} keeps its bearing`, drift < 0.01, `${drift.toFixed(4)}°`);
  }

  // The corners slide along the splayed sides rather than translating with
  // the edge, so the frontage changes length. This lot widens towards the
  // back, so pushing the frontage outward (downward) narrows it, by exactly
  // the amount the two side slopes converge: 16/45 per metre of travel.
  //
  // A naive "move both corners along the normal" would leave this at 30 m and
  // bend both sides, which is the error this whole module exists to avoid.
  const expectedWidth = 30 - (16 * metres) / 45;
  closeTo(edgeLength(moved, 0), expectedWidth, 0.02,
    'the frontage follows the splayed sides exactly');
  check('so its length really did change',
    Math.abs(edgeLength(moved, 0) - edgeLength(trapezoid, 0)) > 1,
    `${edgeLength(trapezoid, 0).toFixed(2)} m -> ${edgeLength(moved, 0).toFixed(2)} m`);

  check('area increases', geometryAreaSqM(poly(moved)) > geometryAreaSqM(poly(trapezoid)));
}

/* ------------------------------- nearly-collinear corners (the real thing) */
{
  // Real digitised parcels are full of vertices a fraction of a degree off
  // collinear. Sliding a corner along a neighbour that is nearly parallel to
  // the edge sends the meeting point racing away: on the live Hudsonville
  // parcel this turned a 25 ft nudge on a 100 ft edge into an extra 294,000
  // sq ft of lawn. The corner travel limit is what stops it.
  // The frontage is digitised as two segments with a barely perceptible bend
  // at the middle -- the neighbour of edge 0 is edge 1, running back almost
  // exactly parallel to it. That is where the meeting point escapes.
  const nearlyStraight = [
    frame.toLngLat([0, 0]),
    frame.toLngLat([15, 0.1]),   // edge 0 ends here...
    frame.toLngLat([30, 0]),     // ...and edge 1 continues, 0.76 deg off it
    frame.toLngLat([30, 40]),
    frame.toLngLat([0, 40]),
    frame.toLngLat([0, 0]),
  ];

  const metres = feetToMetres(25);
  const moved = offsetEdge(nearlyStraight, 0, metres);

  const before = geometryAreaSqM(poly(nearlyStraight));
  const after = geometryAreaSqM(poly(moved));
  const grew = (after - before) / before;

  check('a nudge stays a nudge on a near-collinear parcel', grew < 0.5,
    `area changed by ${(grew * 100).toFixed(1)}%  (${before.toFixed(0)} -> ${after.toFixed(0)} m^2)`);

  const travel = openRing(nearlyStraight).map((p, i) =>
    Math.hypot(...frame.toXY(openRing(moved)[i]).map((v, k) => v - frame.toXY(p)[k])));
  const worst = Math.max(...travel);
  check('no corner flies off', worst < metres * 4 + 0.01,
    `furthest corner moved ${worst.toFixed(2)} m for a ${metres.toFixed(2)} m offset`);

  // Both segments move as one run, so the strip is the whole 30 m frontage.
  closeTo(after - before, 30 * metres, 25,
    'the whole near-collinear frontage moved as one');

  // And the bend between the two segments must survive untouched.
  for (const i of [0, 1]) {
    const drift = Math.abs(((edgeBearing(moved, i) - edgeBearing(nearlyStraight, i) + 540) % 360) - 180);
    check(`near-collinear segment ${i} keeps its bearing`, drift < 0.01, `${drift.toFixed(4)}°`);
  }
}

/* --------------------------------------------- winding independence */
{
  const reversed = [...LOT].reverse();
  check('input winding differs', signedArea(openRing(LOT).map(frame.toXY)) *
    signedArea(openRing(reversed).map(frame.toXY)) < 0);

  const metres = feetToMetres(12);
  // Edge 0 of the reversed ring is a different edge; find the frontage again.
  const idx = nearestEdge(reversed, edgeMidpoint(LOT, 0)).index;
  const moved = offsetEdge(reversed, idx, metres);
  check('a clockwise ring also grows, not shrinks',
    geometryAreaSqM(poly(moved)) > geometryAreaSqM(poly(reversed)),
    `${geometryAreaSqM(poly(reversed)).toFixed(0)} -> ${geometryAreaSqM(poly(moved)).toFixed(0)} m^2`);
}

/* ------------------------------------------------------ edge picking */
{
  const hit = nearestEdge(LOT, frame.toLngLat([15, -2]));
  check('a tap just outside the frontage picks the frontage', hit.index === 0, `index ${hit.index}`);
  closeTo(hit.distanceM, 2, 0.1, 'and reports how far the tap was');

  const side = nearestEdge(LOT, frame.toLngLat([31, 22]));
  check('a tap by the side picks the side', side.index === 1, `index ${side.index}`);
}

/* -------------------------------------------------------- robustness */
{
  const tri = [frame.toLngLat([0, 0]), frame.toLngLat([20, 0]), frame.toLngLat([10, 20]), frame.toLngLat([0, 0])];
  check('a triangle still works', openRing(offsetEdge(tri, 0, 3)).length === 3);

  const degenerate = [ORIGIN, ORIGIN, ORIGIN];
  check('degenerate input is returned unchanged, not NaN',
    offsetEdge(degenerate, 0, 5).every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));

  check('a non-finite distance is ignored',
    JSON.stringify(offsetEdge(LOT, 0, NaN)) === JSON.stringify(LOT));

  closeTo(metresToFeet(feetToMetres(37)), 37, 1e-9, 'feet round-trip');
}

/* --------------------------------------------------- editing vertices */
{
  const before = openRing(LOT).length;

  /* --- picking one */
  const near = nearestVertex(LOT, frame.toLngLat([1, 1]));
  check('a tap near a corner picks that corner', near.index === 0, `index ${near.index}`);
  closeTo(near.distanceM, Math.SQRT2, 0.05, 'and reports how far the tap was');

  /* --- moving one */
  const moved = moveVertex(LOT, 0, frame.toLngLat([-5, -5]));
  check('moving a vertex keeps the ring closed',
    moved[0][0] === moved[moved.length - 1][0] && moved[0][1] === moved[moved.length - 1][1]);
  check('moving a vertex does not change how many there are',
    openRing(moved).length === before, `${openRing(moved).length}`);
  check('moving a corner outward enlarges the lot',
    geometryAreaSqM(poly(moved)) > geometryAreaSqM(poly(LOT)));

  /* --- adding one */
  /*
   * The tap is 4 m off the line. The new point belongs ON the line: a person
   * subdividing an edge wants a point to grab, not a dent in their boundary.
   */
  const added = insertVertex(LOT, 0, frame.toLngLat([15, -4]));
  check('adding a point adds exactly one', openRing(added).length === before + 1,
    `${before} -> ${openRing(added).length}`);
  closeTo(geometryAreaSqM(poly(added)), geometryAreaSqM(poly(LOT)), 0.01,
    'and it lands on the line, so the area is unchanged');
  closeTo(edgeBearing(added, 0), edgeBearing(LOT, 0), 1e-6,
    'and the edge it split keeps its bearing');

  const insertedAt = openRing(added)[1];
  closeTo(frame.toXY(insertedAt)[0], 15, 0.01, 'the new point sits where the tap was, along the line');
  closeTo(frame.toXY(insertedAt)[1], 0, 0.01, '...and on the line, not at the tap');

  /* --- and taking one away */
  const removed = deleteVertex(added, 1);
  check('deleting the added point restores the count', openRing(removed).length === before);
  closeTo(geometryAreaSqM(poly(removed)), geometryAreaSqM(poly(LOT)), 0.01,
    'and the lot is back to its original area');

  /*
   * The guard that matters: three points are a polygon, two are nothing. A
   * caller that deletes past this would get a zero-area shape whose failure
   * shows up somewhere far away, so refuse and let it say so.
   */
  const tri = [frame.toLngLat([0, 0]), frame.toLngLat([20, 0]), frame.toLngLat([10, 20]), frame.toLngLat([0, 0])];
  check('deleting below three points is refused', deleteVertex(tri, 0) === null);
  check('deleting the fourth point of a quad is allowed', deleteVertex(LOT, 0) !== null);
}

/* ------------------------------------------- what it means in sq ft */
{
  const metres = feetToMetres(12);
  const moved = offsetEdge(LOT, 0, metres);
  const gained = measure(poly(moved)).squareFeet - measure(poly(LOT)).squareFeet;
  console.log(`\n      a 12 ft easement strip on 30 m of frontage = ${gained.toLocaleString()} sq ft`);
  check('the easement strip is a material amount of lawn', gained > 1000);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
