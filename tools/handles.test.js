/**
 * Where corner handles go, and when they refuse to go anywhere.
 *
 * The whole value of this module is the cases a person cannot check by looking
 * at a phone: a spike whose bisector runs back along its own edges, a
 * straight-through corner with no bisector at all, two corners close enough
 * that only one handle fits. Those are the ones here.
 *
 *   node tools/handles.test.js
 */

import {
  planHandles, handleDirections, distToSegment, insideRing,
  HANDLE_REACH_PX, HANDLE_CLEAR_PX,
} from '../public/lib/handles.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const P = (x, y) => ({ x, y });
/** A square, big enough that nothing on it crowds anything else. */
const square = (s = 400) => [P(0, 0), P(s, 0), P(s, s), P(0, s)];

/* ------------------------------------------------------------- the maths */
{
  check('distance to a segment stops at its ends',
    distToSegment(P(-10, 0), P(0, 0), P(10, 0)) === 10,
    'not the distance to the infinite line, which would be 0');
  check('and is perpendicular in the middle',
    distToSegment(P(5, 7), P(0, 0), P(10, 0)) === 7);

  check('a point in the middle of a square is inside it',
    insideRing(P(200, 200), square()));
  check('and one outside is not', !insideRing(P(-5, 200), square()));

  const dirs = handleDirections(P(0, 10), P(0, 0), P(10, 0));
  check('a right-angled corner has two opposite directions',
    dirs.length === 2
      && Math.abs(dirs[0].x + dirs[1].x) < 1e-9
      && Math.abs(dirs[0].y + dirs[1].y) < 1e-9,
    JSON.stringify(dirs));
  check('and they are unit length',
    Math.abs(Math.hypot(dirs[0].x, dirs[0].y) - 1) < 1e-9);

  /*
   * A STRAIGHT-THROUGH CORNER, which is the one that produces NaN if the
   * bisector is taken naively: the two edge directions cancel exactly, and
   * normalising a zero vector gives a handle at no coordinates that silently
   * never draws. Perpendicular to the line is the answer.
   */
  const straight = handleDirections(P(-10, 0), P(0, 0), P(10, 0));
  check('a straight-through corner still gets a direction',
    straight.length === 2 && Number.isFinite(straight[0].x) && Number.isFinite(straight[0].y),
    JSON.stringify(straight));
  check('and it leaves the line rather than running along it',
    Math.abs(straight[0].x) < 1e-9 && Math.abs(Math.abs(straight[0].y) - 1) < 1e-9,
    JSON.stringify(straight[0]));

  check('a corner with a zero-length edge is refused rather than guessed at',
    handleDirections(P(0, 0), P(0, 0), P(10, 0)).length === 0);
}

/* ------------------------------------------------- an ordinary square lot */
{
  const { handles, crowded } = planHandles([square()]);
  check('every corner of a roomy square gets a handle',
    handles.length === 4 && !crowded, `${handles.length} handles`);

  check('each sits about a fingertip from its corner',
    handles.every((h) => Math.abs(Math.hypot(h.at.x - h.from.x, h.at.y - h.from.y) - HANDLE_REACH_PX) < 1e-6));

  /*
   * OUTWARD, which is the refinement over "obtuse or acute": the inside of the
   * polygon is where the fill and every other edge live, so out is the emptier
   * side almost always, and it only has to be preferred rather than proven.
   */
  check('and all four stick out of the shape rather than into it',
    handles.every((h) => !insideRing(h.at, square())),
    handles.map((h) => `${Math.round(h.at.x)},${Math.round(h.at.y)}`).join(' '));

  check('each handle names the corner it drives',
    handles.every((h, i) => h.ring === 0 && h.index === i));
}

/* --------------------------------------------------------------- a spike */
{
  const spike = [P(0, 0), P(300, 4), P(300, -4)];
  const { handles } = planHandles([spike]);
  const tip = handles.find((h) => h.index === 0);

  /*
   * The bisector at a spike tip runs back INTO the spike, between two edges a
   * few pixels apart. Its opposite runs straight out into nothing, which is
   * why measuring both and taking the roomier one matters more here than
   * anywhere: the obvious direction is the unusable one.
   */
  check('a spike tip puts its handle away from the spike, not up the middle',
    Boolean(tip) && tip.at.x < tip.from.x,
    tip ? `handle at ${Math.round(tip.at.x)},${Math.round(tip.at.y)}` : 'no handle');
  check('and the blunt end of the same spike is handled too',
    handles.length >= 2, `${handles.length} handles`);
}

/* ------------------------------------------------- two corners very close */
{
  /* Two corners 6 px apart on an otherwise roomy shape. */
  const pinched = [P(0, 0), P(400, 0), P(400, 400), P(203, 400), P(197, 400), P(0, 400)];
  const { handles } = planHandles([pinched]);
  const near = handles.filter((h) => h.index === 3 || h.index === 4);

  /*
   * NOT "one of them loses". Both can be served if they leave by opposite
   * sides, which is the whole of the rule: measure each direction, take the
   * one with more room. The first corner takes the roomy outward side and the
   * second, finding it occupied, goes inward where nothing else is.
   */
  check('two corners six pixels apart both get handles, on opposite sides',
    near.length === 2 && (near[0].at.y - 400) * (near[1].at.y - 400) < 0,
    near.map((h) => `${h.index}: ${Math.round(h.at.x)},${Math.round(h.at.y)}`).join('  '));
  check('and the roomy corners of the same shape are unaffected',
    handles.some((h) => h.index === 0) && handles.some((h) => h.index === 1),
    'suppression is per corner, not per shape');

  /* Nothing placed may sit on top of anything else placed. */
  for (let i = 0; i < handles.length; i++) {
    for (let j = i + 1; j < handles.length; j++) {
      const d = Math.hypot(handles[i].at.x - handles[j].at.x, handles[i].at.y - handles[j].at.y);
      if (d < HANDLE_CLEAR_PX) {
        check('no two handles are placed within the clearance', false,
          `${i} and ${j} are ${d.toFixed(1)} px apart`);
      }
    }
  }
  check('no two handles are placed within the clearance', true,
    `${handles.length} handles, all separated`);
}

/* ------------------------------------------------- nowhere left to put one */
/*
 * A corner with geometry close on BOTH sides. Its own shape is a thin bar, so
 * inward is a few pixels from the far wall; another outline sits just beyond
 * it, so outward is a few pixels from that. Neither direction clears, and the
 * honest answer is no handle rather than one sitting on a line it cannot move.
 */
{
  const bar = [P(0, 0), P(400, 0), P(400, 20), P(0, 20)];
  const above = [P(-100, -40), P(500, -40), P(500, -30), P(-100, -30)];
  const { handles, suppressed } = planHandles([bar, above]);

  const corner = handles.find((h) => h.ring === 0 && h.index === 0);
  check('a corner boxed in on both sides gets no handle at all',
    !corner,
    'outward lands on the outline above, inward lands on its own far wall');
  check('and the run reports how many it had to drop',
    suppressed > 0, `${suppressed} suppressed, ${handles.length} placed`);
}

/* ----------------------------------------------------- a crowded viewport */
{
  /* A circle of 300 corners: at this zoom they are pixels apart. */
  const many = Array.from({ length: 300 }, (_, i) => {
    const a = (i / 300) * Math.PI * 2;
    return P(200 + Math.cos(a) * 150, 200 + Math.sin(a) * 150);
  });
  const { handles, crowded } = planHandles([many]);
  check('three hundred corners on screen produce no handles at all',
    handles.length === 0 && crowded === true,
    'they would every one be suppressed for lack of room, so the arithmetic '
    + 'is declined rather than spent proving it three hundred times');
}

/* ------------------------------------------------------ several outlines */
{
  const two = [square(300), [P(600, 0), P(900, 0), P(900, 300), P(600, 300)]];
  const { handles } = planHandles(two);
  check('handles are planned across every outline, not just the first',
    handles.some((h) => h.ring === 0) && handles.some((h) => h.ring === 1),
    `${handles.length} across two shapes`);

  /*
   * A SECOND SHAPE IS AN OBSTACLE TOO. Two outlines all but touching would
   * otherwise each place handles into the other's edges, because nothing in
   * one ring's own geometry says the other is there.
   */
  const touching = [square(300), [P(310, 0), P(610, 0), P(610, 300), P(310, 300)]];
  const planned = planHandles(touching).handles;
  const inTheGap = planned.filter((h) => h.at.x > 300 && h.at.x < 310);
  check('and one outline does not put a handle inside another',
    inTheGap.length === 0,
    'the ten-pixel gap between the two shapes stays empty');
}

/* ----------------------------------------------------------- degenerates */
{
  check('no rings, no handles', planHandles([]).handles.length === 0);
  check('a two-point ring is not a shape', planHandles([[P(0, 0), P(10, 0)]]).handles.length === 0);
  check('rubbish in the list is ignored rather than thrown on',
    planHandles([null, undefined, square()]).handles.length === 4);

  const { handles } = planHandles([square()]);
  check('every placed handle has finite coordinates',
    handles.every((h) => Number.isFinite(h.at.x) && Number.isFinite(h.at.y)),
    'a NaN here draws nothing and reports nothing');
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
