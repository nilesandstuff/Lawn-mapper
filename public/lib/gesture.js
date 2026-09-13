/**
 * Who a one-finger gesture belongs to: the tool, or the map.
 *
 * THE THIRD TOUCH BUG IN THIS FILE'S HISTORY, which is why the rules moved out
 * here where they can be tested. The plumbing -- capture-phase listeners,
 * stopPropagation, Mapbox's handlers -- cannot run outside a browser. The
 * decisions can, and every one of the three bugs was a decision rather than
 * plumbing.
 *
 * The gestures being told apart, all of which start as "one finger touches the
 * map", and all of which a phone must distinguish without a modifier key:
 *
 *   a tap        -- down and up in one place: select this
 *   a stroke     -- down and moving: paint, or drag this corner
 *   a held press -- down and still for half a second: get the tool out of the
 *                   way and let me move the map
 *
 * The distances below are the whole mechanism, and using one for two questions
 * is what broke it: see HOLD_SLOP_PX.
 */

/** Longer than this and a press is a press, not a tap. */
export const TAP_MAX_MS = 700;

/**
 * A finger never lands perfectly still, so a tap is allowed to wander this far
 * and still count as a tap.
 *
 * Generous on purpose. The cost of being too tight is a tap that does nothing,
 * which the user repeats; there is no cost to being loose, because a gesture
 * that travels further is a stroke and gets handled as one.
 */
export const TAP_SLOP_PX = 14;

/**
 * How far a finger must travel before a held press stops being a held press.
 *
 * A SEPARATE NUMBER FROM TAP_SLOP_PX, AND THAT IS THE BUG THIS FILE EXISTS
 * FOR. They were the same constant, because both are "has the finger moved",
 * and they are not the same question:
 *
 *   TAP_SLOP is asked at the END of a gesture, about whether to treat it as a
 *   tap. Generous is right: a wobbly tap is still a tap.
 *
 *   This one is asked DURING a gesture, about whether to throw away what is
 *   being painted and hand the map to a pan. Generous is catastrophic. At 14px
 *   -- about two millimetres of glass -- a careful stroke on a zoomed-in map
 *   stays inside it for the whole half second, so the hold matured, the stroke
 *   in progress was discarded, and the map started moving under the finger.
 *   Which is exactly what "I can't draw without the map moving around" is.
 *
 * Five pixels is above a resting finger's jitter and far below any stroke
 * somebody is deliberately making. A slow, careful edge trim covers five
 * pixels in a fraction of the hold.
 */
export const HOLD_SLOP_PX = 5;

/** Half a second: long enough that no stroke starts with one. */
export const HOLD_MS = 500;

/** Far enough from where a corner was grabbed to count as dragging it. */
export const DRAG_START_PX = 4;

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/**
 * Has this gesture moved far enough that it is a stroke rather than a hold?
 *
 * Measured from where the finger LANDED, not from the last event, so a slow
 * drift accumulates instead of resetting: a finger creeping a pixel per event
 * is still creeping away from where it started.
 */
export function movedEnoughToCancelHold(from, to, slop = HOLD_SLOP_PX) {
  if (!from) return false;
  return dist(from.x, from.y, to.x, to.y) > slop;
}

/**
 * Is a gesture that ended here a tap?
 *
 * Both tests, because either alone is wrong: a press that stays in one place
 * for three seconds is not a tap, and a quick flick across the screen is not
 * one either.
 */
export function isTap(from, to, now, { slopPx = TAP_SLOP_PX, maxMs = TAP_MAX_MS } = {}) {
  if (!from) return false;
  return dist(from.x, from.y, to.x, to.y) <= slopPx && now - from.at <= maxMs;
}

/**
 * Does this gesture belong to the tool rather than to the map?
 *
 * DECIDED BY WHAT IS UNDER THE FINGER, NOT BY HOW FAR IT HAS MOVED, which is
 * the second bug this file exists for. The old version claimed a gesture only
 * once it had produced a visible change -- so the first few events of a corner
 * drag went to the map, which panned a little before the drag engaged.
 *
 * Worse than the visible jump: a browser decides whether a touch is a scroll
 * on the FIRST move, and once it has decided, later preventDefault calls are
 * ignored for the rest of the gesture. Letting the first event through does
 * not cost a few pixels, it costs the whole stroke.
 *
 * So: a finger on a live brush, or on a corner that has been grabbed, owns the
 * gesture from its first movement. Two fingers never do -- that is the map's
 * pan and pinch, and the way out of any tool.
 */
export function gestureIsOurs({ touches = 1, painting = false, grabbed = false, held = false } = {}) {
  if (touches !== 1) return false;
  if (held) return true;      // a matured hold is ours to drive the pan with
  return Boolean(painting || grabbed);
}
