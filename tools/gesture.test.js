/**
 * Who a one-finger gesture belongs to.
 *
 * REPORTED: "unable to draw without the map moving around on mobile." The
 * third touch bug here, and like the other two it was a decision rather than
 * plumbing -- which is why the decisions now live in lib/gesture.js where a
 * test can reach them. The capture-phase listeners and Mapbox's handlers
 * cannot run outside a browser; none of the three bugs was in those.
 *
 * The cause, exactly: the press-and-hold that hands the map back needed to
 * know whether the finger was moving, and reused TAP_SLOP_PX -- the 14px a
 * TAP is allowed to wander -- to answer it. A careful stroke on a zoomed-in
 * map stays inside 14px for half a second, so the hold matured, the stroke was
 * discarded as abandoned, and the map started panning under the finger.
 *
 * These tests are in pixels and milliseconds against named gestures, because
 * that is what the bug was made of.
 *
 *   node tools/gesture.test.js
 */

import {
  movedEnoughToCancelHold, isTap, gestureIsOurs,
  HOLD_SLOP_PX, TAP_SLOP_PX, TAP_MAX_MS, HOLD_MS, DRAG_START_PX,
} from '../public/lib/gesture.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const down = (x, y, at = 0) => ({ x, y, at });

/* ------------------------------------------------- the bug, named exactly */
/*
 * THE REGRESSION. A slow, careful stroke -- trimming an edge on a zoomed-in
 * map -- moves maybe eight pixels in the first half second. Under the old
 * shared threshold that counted as "not moving", so the hold matured and threw
 * the stroke away.
 */
{
  const start = down(200, 300);

  check('a careful eight-pixel stroke counts as moving',
    movedEnoughToCancelHold(start, { x: 208, y: 300 }),
    'this is the one that was reported: it used to count as a held press');

  check('and so does a diagonal one of the same length',
    movedEnoughToCancelHold(start, { x: 206, y: 306 }),
    'a stroke does not have to run along an axis to be a stroke');

  /*
   * The two thresholds must not drift back together. Stated as an inequality
   * rather than as two constants, so changing either one keeps the rule.
   */
  check('the hold slop is tighter than the tap slop, and by a real margin',
    HOLD_SLOP_PX < TAP_SLOP_PX / 2,
    `hold ${HOLD_SLOP_PX}px vs tap ${TAP_SLOP_PX}px`);

  check('but loose enough to ignore a resting finger',
    !movedEnoughToCancelHold(start, { x: 202, y: 301 }),
    'about 2px of jitter is a finger being still, not a stroke');

  check('and a finger that has not moved at all is certainly still',
    !movedEnoughToCancelHold(start, { x: 200, y: 300 }));
}

/* ------------------------------------------- measured from where it landed */
/*
 * From the LANDING POINT, not from the previous event. A finger creeping one
 * pixel per event is still creeping away; measured event to event it would
 * never trip the threshold and the hold would mature under a moving finger.
 */
{
  const start = down(100, 100);
  let last = start;
  let cancelled = false;
  for (let i = 1; i <= 10 && !cancelled; i++) {
    const now = { x: 100 + i, y: 100 };
    cancelled = movedEnoughToCancelHold(start, now);
    // The naive version, kept alongside so the difference is the assertion.
    check(`step ${i}: measuring from the last event would say still`,
      !movedEnoughToCancelHold(last, now) || i === 0,
      'one pixel at a time never trips a five-pixel threshold');
    last = now;
    if (cancelled) {
      check('but measuring from where it landed catches the creep',
        i <= HOLD_SLOP_PX + 1, `caught after ${i} pixels`);
    }
  }
  check('a slow creep is eventually caught', cancelled);
}

/* ---------------------------------------------------------------- taps */
{
  const start = down(50, 50, 1000);

  check('a still, quick press is a tap',
    isTap(start, { x: 52, y: 51 }, 1200));

  check('a press that wanders far is not',
    !isTap(start, { x: 50 + TAP_SLOP_PX + 2, y: 50 }, 1200));

  check('and neither is one that lasts too long',
    !isTap(start, { x: 50, y: 50 }, 1000 + TAP_MAX_MS + 1));

  /*
   * A tap may wander further than a hold may, which is the asymmetry the two
   * constants exist to express: being generous about a tap costs nothing,
   * being generous about a hold costs the stroke in progress.
   */
  const wobble = { x: 50 + HOLD_SLOP_PX + 3, y: 50 };
  check('a wobbly press is still a tap even though it cancelled the hold',
    isTap(start, wobble, 1100) && movedEnoughToCancelHold(start, wobble),
    'the two questions have different answers for the same gesture, on purpose');

  check('nothing to compare against is not a tap', !isTap(null, { x: 0, y: 0 }, 0));
}

/* --------------------------------------------------------- who owns it */
/*
 * DECIDED BY WHAT IS UNDER THE FINGER, not by what has already happened. The
 * old version claimed a gesture only once it had produced a visible change,
 * which let the first events of a corner drag reach the map -- and a browser
 * decides whether a touch is a scroll on the first move it sees, so those
 * events cost the whole gesture rather than a few pixels.
 */
{
  check('a finger on a live brush owns the gesture from the first move',
    gestureIsOurs({ touches: 1, painting: true }));

  check('and so does one that has grabbed a corner, before it has moved 4px',
    gestureIsOurs({ touches: 1, grabbed: true }),
    `the ${DRAG_START_PX}px threshold decides select-vs-drag, not who owns it`);

  check('a finger on nothing in particular leaves the map alone',
    !gestureIsOurs({ touches: 1 }),
    'tapping to place a pin must not stop the map panning');

  /*
   * TWO FINGERS ARE ALWAYS THE MAP'S. This is the way out of any tool, and the
   * reason the whole capture-phase arrangement exists rather than just
   * disabling dragPan -- see armLawnPicker.
   */
  check('two fingers are the map\'s even mid-stroke',
    !gestureIsOurs({ touches: 2, painting: true }),
    'pinch and pan stay available without putting the tool down');

  check('and even mid-drag', !gestureIsOurs({ touches: 2, grabbed: true }));

  check('a matured hold is ours, because we drive that pan ourselves',
    gestureIsOurs({ touches: 1, held: true }));
}

/* ------------------------------------------------------------ the timing */
{
  check('the hold is long enough that no stroke begins with one',
    HOLD_MS >= 400, `${HOLD_MS}ms`);
  check('and short enough to be worth waiting through',
    HOLD_MS <= 800, `${HOLD_MS}ms`);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
