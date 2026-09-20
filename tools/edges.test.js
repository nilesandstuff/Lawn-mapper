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
  tidyRing,
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
  ringContains,
  ringInsideRing,
  nearestPointOnRing,
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

/* --------------------------------------------------- tidying a boundary */
{
  /*
   * A boundary as a county actually digitises it: the real corners, plus a run
   * of points strung along one edge and a near-duplicate 10 cm from another --
   * the exact spacing measured on the Ottawa parcel this was built against.
   */
  const messy = [
    frame.toLngLat([0, 0]),
    frame.toLngLat([0.1, 0]),      // 10 cm along: no information
    frame.toLngLat([10, 0]),       // strung along the frontage
    frame.toLngLat([20, 0]),
    frame.toLngLat([30, 0]),       // a real corner
    frame.toLngLat([30, 15]),
    frame.toLngLat([30, 45]),      // a real corner
    frame.toLngLat([0, 45]),       // a real corner
    frame.toLngLat([0, 0]),
  ];

  const before = geometryAreaSqM(poly(messy));
  const { ring: tidied, removed } = tidyRing(messy);
  const kept = openRing(tidied).length;

  check('tidying removes the points that carry no shape', removed > 0, `removed ${removed}`);
  check('and keeps the corners that do', kept === 4, `${openRing(messy).length} -> ${kept} corners`);

  /*
   * The area moves slightly, and the honest bound is not the tolerance itself.
   * Removing a point sitting d from the chord between its neighbours changes
   * the area by at most d x chord / 2, so the total is bounded by
   * tolerance x perimeter / 2. Here that is 0.1 x 150 / 2 = 7.5 m^2 on a
   * 1,350 m^2 lot. Asserting the real bound rather than a number that happens
   * to pass keeps this a test of the geometry instead of a record of it.
   */
  const perimeter = 2 * (30 + 45);
  const drift = Math.abs(geometryAreaSqM(poly(tidied)) - before);
  check('the area moves only within the bound the tolerance implies',
    drift <= (0.1 * perimeter) / 2,
    `moved ${drift.toFixed(2)} m^2, bound ${((0.1 * perimeter) / 2).toFixed(2)} m^2`);
  check('and that is a rounding error, not a remeasurement',
    drift / before < 0.005, `${((100 * drift) / before).toFixed(3)}%`);

  /*
   * The guard that matters. Douglas-Peucker would be the reflex here and is
   * the wrong tool: it simplifies to a budget and will cut a real corner to
   * meet it. A 2 m jog is small on a parcel and is still someone's boundary.
   */
  const jog = [
    frame.toLngLat([0, 0]),
    frame.toLngLat([15, 0]),
    frame.toLngLat([15, 2]),
    frame.toLngLat([30, 2]),
    frame.toLngLat([30, 30]),
    frame.toLngLat([0, 30]),
    frame.toLngLat([0, 0]),
  ];
  const jogged = tidyRing(jog);
  check('a real jog in the boundary is never flattened', jogged.removed === 0,
    `removed ${jogged.removed}`);
  closeTo(geometryAreaSqM(poly(jogged.ring)), geometryAreaSqM(poly(jog)), 0.01,
    'so its area is untouched');

  /* Nothing to do is not an error, and a triangle must survive intact. */
  const clean = tidyRing(LOT);
  check('a boundary with nothing redundant is left alone', clean.removed === 0);

  const tri = [frame.toLngLat([0, 0]), frame.toLngLat([20, 0]), frame.toLngLat([10, 20]), frame.toLngLat([0, 0])];
  check('a triangle is never reduced below three points',
    openRing(tidyRing(tri).ring).length === 3);

  /*
   * A run of collinear points needs more than one pass: removing one can make
   * its neighbour redundant in turn. A single sweep would leave some behind.
   */
  const line = [frame.toLngLat([0, 0])];
  for (let i = 1; i <= 8; i++) line.push(frame.toLngLat([i * 3, 0]));
  line.push(frame.toLngLat([24, 20]), frame.toLngLat([0, 20]), frame.toLngLat([0, 0]));
  const collapsed = tidyRing(line);
  check('a whole run of strung-out points collapses to its ends',
    openRing(collapsed.ring).length === 4,
    `${openRing(line).length} -> ${openRing(collapsed.ring).length} corners`);

  /*
   * AND WHY THIS NOW RUNS WITHOUT BEING ASKED.
   *
   * Corners and edges compete for the same pixels, and the corner wins -- which
   * is right, since a corner is a smaller target. On a county boundary studded
   * with redundant points there is no pixel left that belongs to the edge: the
   * middle of the longest run, as far from a real corner as the geometry
   * allows, still has a stray point sitting on it. So dragging an edge out to
   * the kerb -- the main thing property-line mode exists for -- is unreachable
   * on exactly the boundaries that need it.
   *
   * Tidying is what gives the edge its pixels back, and this measures that
   * rather than asserting a corner count: the gap between the midpoint of the
   * longest edge and the nearest corner is the thing a fingertip has to fit in.
   */
  const gap = (ring) => {
    const v = openRing(ring).map((p) => frame.toXY(p));
    let best = null;
    for (let i = 0; i < v.length; i++) {
      const a = v[i];
      const b = v[(i + 1) % v.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!best || len > best.len) best = { len, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    }
    let near = Infinity;
    for (const q of v) near = Math.min(near, Math.hypot(q[0] - best.mid[0], q[1] - best.mid[1]));
    return { longest: best.len, near };
  };

  /*
   * A 40 x 30 lot with a digitiser's points every 2 m around the WHOLE
   * perimeter, which is what a county outline actually looks like -- not one
   * tidy side and one messy one. Every edge is studded, so before tidying
   * there is no long run anywhere.
   */
  const corners2 = [[0, 0], [40, 0], [40, 30], [0, 30]];
  const studded = [];
  for (let c = 0; c < 4; c++) {
    const a = corners2[c];
    const b = corners2[(c + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.round(len / 2);
    for (let i = 0; i < steps; i++) {
      studded.push(frame.toLngLat([
        a[0] + ((b[0] - a[0]) * i) / steps,
        a[1] + ((b[1] - a[1]) * i) / steps,
      ]));
    }
  }
  studded.push(studded[0]);

  const before2 = gap(studded);
  const after2 = gap(tidyRing(studded).ring);

  /* Within one stud of the line everywhere, so nowhere on it is "edge". The
     bound is the stud spacing rather than the exact half of it, which is a
     record of this fixture rather than a fact about studded boundaries. */
  check('a studded boundary leaves no pixel that belongs to an edge',
    before2.near <= 2,
    `nearest corner is ${before2.near.toFixed(2)} m from the middle of the `
    + 'longest edge -- a fingertip cannot miss it');

  check('and tidying gives the edge its own pixels back',
    after2.near > 15 && after2.longest >= 40,
    `${before2.near.toFixed(2)} m -> ${after2.near.toFixed(2)} m of clear edge `
    + 'either side of the midpoint');
}

/* ------------------------------------------- what it means in sq ft */
{
  const metres = feetToMetres(12);
  const moved = offsetEdge(LOT, 0, metres);
  const gained = measure(poly(moved)).squareFeet - measure(poly(LOT)).squareFeet;
  console.log(`\n      a 12 ft easement strip on 30 m of frontage = ${gained.toLocaleString()} sq ft`);
  check('the easement strip is a material amount of lawn', gained > 1000);
}

/* ------------------------------------------------ cutting a shed out */
/*
 * "Cut out a shape" turns a traced outline into a HOLE in the lawn under it,
 * and the one thing it has to get right is which lawn that is. Punching a hole
 * into a shape that does not contain it would move the cut somewhere nobody
 * drew it, and would take square footage off a patch that never had that shed
 * on it.
 *
 * The shed here is 4 m x 3 m, a real one, set well inside a 30 x 45 m lot.
 */
{
  console.log('\n--- what a cut-out sits inside ---');

  const at = (x, y, w, h) => [
    frame.toLngLat([x, y]),
    frame.toLngLat([x + w, y]),
    frame.toLngLat([x + w, y + h]),
    frame.toLngLat([x, y + h]),
    frame.toLngLat([x, y]),
  ];

  const shed = at(12, 20, 4, 3);
  check('a shed in the middle of the lot is inside it', ringInsideRing(shed, LOT));
  check('and its middle reads as inside too',
    ringContains(LOT, frame.toLngLat([14, 21.5])));

  /* The ordinary mistake: a cut drawn half off the lawn. */
  const straddling = at(28, 20, 6, 3);
  check('a cut hanging over the edge is NOT inside',
    ringInsideRing(straddling, LOT) === false,
    'every corner has to be inside, not just one');

  const elsewhere = at(80, 80, 4, 3);
  check('and one drawn off the lawn entirely is not either',
    ringInsideRing(elsewhere, LOT) === false);
  check('nor is a point out there contained',
    ringContains(LOT, frame.toLngLat([82, 81])) === false);

  /*
   * A CORNER OF THE LOT ITSELF is the case ray casting gets wrong when the ray
   * runs exactly along an edge. Not asserted either way -- a point on the
   * boundary is genuinely undefined and no caller asks -- but it must not
   * throw or return something that is neither true nor false.
   */
  check('a point on the boundary answers with a boolean rather than failing',
    typeof ringContains(LOT, LOT[0]) === 'boolean');

  /*
   * THE MEASUREMENT IS WHAT THIS IS FOR. A hole is subtracted by area.js, so
   * the lot with the shed cut out has to be exactly the shed smaller.
   */
  const whole = measure(poly(LOT)).squareFeet;
  const cut = measure({ type: 'Polygon', coordinates: [LOT, shed] }).squareFeet;
  const shedSqFt = measure(poly(shed)).squareFeet;
  closeTo(whole - cut, shedSqFt, 1,
    'cutting the shed out takes exactly the shed off the total');
}

/* ------------------------------------- holding a corner at the line */
/*
 * "Measure outside the property line" gated the Add brush and nothing else, so
 * a corner dragged past the boundary went past it and the total counted the
 * ground beyond -- the option switched off and the line drawn on the map the
 * whole time.
 *
 * A corner is HELD at the line rather than refused. One that stops dead under
 * a moving finger reads as a bug and one that snaps back loses the drag, so
 * the answer is the nearest point on the boundary: where the finger is, as
 * near as the boundary allows, which lets the corner slide along the line.
 */
{
  console.log('\n--- held at the property line ---');

  /* Ten metres past the 30 m frontage, straight out from its middle. */
  const out = frame.toLngLat([15, -10]);
  const held = nearestPointOnRing(LOT, out);
  const [hx, hy] = frame.toXY(held.at);

  closeTo(hy, 0, 0.05, 'a corner dragged out the front is held on the frontage');
  closeTo(hx, 15, 0.05, 'and stays level with the finger rather than snapping to a corner');
  closeTo(held.distanceM, 10, 0.05, 'the hold is exactly as far as it went over');

  /*
   * NEAREST EDGE, NOT NEAREST CORNER. This is the difference that matters on a
   * real lot: snapping to the nearest recorded corner would jump the point
   * fifteen metres sideways from where the finger is.
   */
  const corner = nearestVertex(LOT, out);
  const [cx] = frame.toXY(LOT[corner.index]);
  check('which is not where the nearest corner is',
    Math.abs(hx - cx) > 10,
    `held at x=${hx.toFixed(1)} m, nearest corner at x=${cx.toFixed(1)} m`);

  /* Past a corner diagonally, the nearest point on the ring IS that corner. */
  const past = frame.toLngLat([-8, -8]);
  const atCorner = nearestPointOnRing(LOT, past);
  const [px, py] = frame.toXY(atCorner.at);
  closeTo(px, 0, 0.05, 'dragged past a corner diagonally, it is held at the corner');
  closeTo(py, 0, 0.05, 'in both directions');

  /*
   * And a point already inside is never moved -- the hold has to be invisible
   * for every drag that stays where it belongs, which is nearly all of them.
   */
  const inside = frame.toLngLat([15, 20]);
  check('a corner inside the line is what the caller checks first',
    ringContains(LOT, inside),
    'nothing is held unless it is actually outside');

  check('a degenerate ring answers null rather than throwing',
    nearestPointOnRing([[0, 0]], [1, 1]) === null);
}

/* ------------------------------------------ held inside the lawn */
{
  /*
   * The rule behind "keep inferred patches inside the lawn", and the same one
   * the property line applies to an ordinary corner.
   */
  const { heldInsideRings } = await import('../public/lib/edges.js');

  const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const west = box(0, 0, 1, 1);
  const east = box(3, 0, 4, 1);

  check('a point already inside is left exactly where it is',
    heldInsideRings([west], [0.5, 0.5]).join() === '0.5,0.5',
    'nudging a corner that was never out of bounds would move work nobody '
    + 'asked to move');

  /*
   * INSIDE ANY RING COUNTS. A lawn is often several disconnected pieces, and
   * requiring one particular piece would hold a corner at the edge of a shape
   * it has nothing to do with.
   */
  check('and inside any one of several pieces counts as inside',
    heldInsideRings([west, east], [3.5, 0.5]).join() === '3.5,0.5',
    'a lawn in two halves is still a lawn');

  /*
   * HELD AT THE EDGE RATHER THAN REFUSED. A corner that stops dead under a
   * moving finger reads as a bug; one that snaps back loses the drag.
   */
  const held = heldInsideRings([west], [2, 0.5]);
  check('a point outside is brought to the nearest edge, not rejected',
    Math.abs(held[0] - 1) < 1e-6 && Math.abs(held[1] - 0.5) < 1e-6,
    `${held.join()} -- it should slide along the boundary under the finger`);

  check('and it goes to the nearest piece, not the first one',
    Math.abs(heldInsideRings([west, east], [2.9, 0.5])[0] - 3) < 1e-6,
    'a corner dragged toward the far half must not fly back to the near one');

  /*
   * An empty list holds nothing: being unable to draw an inferred patch on a
   * map with no ordinary lawn yet is a worse rule than letting one go free.
   */
  check('with no lawn at all, nothing is held',
    heldInsideRings([], [9, 9]).join() === '9,9'
    && heldInsideRings(null, [9, 9]).join() === '9,9',
    'the first patch on an empty map would otherwise be undraggable');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
