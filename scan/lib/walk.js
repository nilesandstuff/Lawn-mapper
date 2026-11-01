/**
 * ONE WALK OF THE LAWN: ITS BOOKKEEPING (core session, docs/SCAN-PLAN.md phase 1).
 *
 * What the test page measures on both phones, in the session's own frame
 * (no map yet, no GPS, no coordinates anyone could place):
 *   - the walk: metres walked, in steps of STEP so the hand's sway is not
 *     walking (the water session counted 508 m of sway in ten minutes, water
 *     FINDINGS H66, carried here); times tracking was lost; frame resets;
 *     turns faster than FAST_TURN degrees a second;
 *   - pins: a pin dropped where the crosshair met the ground; later, aiming
 *     at the same spot and tapping Check says how far the tracking has
 *     carried the pin from the spot (the phase 1 test: walk 20 m away and back);
 *   - measurements: two taps, the distance between them, against a tape.
 *
 * Pure: the page feeds it frames and taps; it never touches the DOM or the
 * engines, so Node tests it. Positions are {x, y, z} in the session frame.
 */
import { level, levelDist, dist3, yawOf, turnBetween } from './frames.js';

export const STEP = 0.5;        // m: a move this long counts as walking
export const FAST_TURN = 90;    // degrees a second
export const LOSS_WALK = 10;    // m added to the walk when tracking is lost (what came before counts for less, later)
export const RESET_WALK = 1000; // m added when the engine says its frame jumped
export const AIM_FAR = 3.5;     // m: aiming from farther than this is worth a warning (water H65-H67)

export function newWalk({ engine, phone = '', startedAt = Date.now() } = {}) {
  return {
    engine, phone, startedAt, endedAt: null,
    odo: 0, lastPos: null, lastYaw: null, lastYawT: 0, tracking: null, fast: false,
    stats: { walked: 0, losses: 0, resets: 0, fastTurns: 0, frames: 0, trackedFrames: 0, limitedMs: 0, lastT: null },
    pins: [], measures: [], pendingMeasure: null, events: [], points: { seen: 0, maxAtOnce: 0 },
  };
}

function log(w, what, extra = {}) {
  w.events.push({ t: Date.now() - w.startedAt, walkedM: +w.odo.toFixed(1), what, ...extra });
  if (w.events.length > 400) w.events.splice(0, w.events.length - 400);
}

/**
 * One frame. { t: ms, pos, quat, tracking: 'normal' | 'limited' | 'lost', reset?: bool, points?: number }
 * Returns the warnings this frame raised: 'lost', 'found', 'reset', 'fast'.
 */
export function step(w, { t, pos, quat, tracking, reset = false, points = 0 }) {
  const out = [];
  w.stats.frames++;
  if (w.stats.lastT != null && tracking === 'limited') w.stats.limitedMs += Math.max(0, t - w.stats.lastT);
  w.stats.lastT = t;
  if (points) { w.points.seen += points; w.points.maxAtOnce = Math.max(w.points.maxAtOnce, points); }
  if (reset) { w.odo += RESET_WALK; w.stats.resets++; w.lastPos = null; log(w, 'frame reset'); out.push('reset'); }
  const tracked = tracking === 'normal' || tracking === 'limited';
  if (w.tracking !== null && w.tracking !== 'lost' && tracking === 'lost') { w.stats.losses++; w.odo += LOSS_WALK; log(w, 'lost its place'); out.push('lost'); }
  if (w.tracking === 'lost' && tracked) { w.lastPos = null; log(w, 'found its place'); out.push('found'); }
  w.tracking = tracking;
  if (!tracked || !pos) return out;
  w.stats.trackedFrames++;
  if (w.lastPos) {
    const d = levelDist(w.lastPos, pos);
    if (d >= STEP) { w.odo += d; w.stats.walked += d; w.lastPos = pos; }
  } else w.lastPos = pos;
  if (quat) {
    const yaw = yawOf(quat);
    if (w.lastYaw != null && t > w.lastYawT) {
      const rate = Math.abs(turnBetween(w.lastYaw, yaw)) / ((t - w.lastYawT) / 1000);
      const fast = rate > FAST_TURN;
      if (fast && !w.fast) { w.stats.fastTurns++; log(w, 'fast turn', { degPerS: Math.round(rate) }); out.push('fast'); }
      w.fast = fast;
    }
    w.lastYaw = yaw; w.lastYawT = t;
  }
  return out;
}

/** A pin where the crosshair met the ground. hit: { position, type, distance }. */
export function dropPin(w, hit, name = null) {
  const pin = { id: `${w.pins.length + 1}`, name: name || `P${w.pins.length + 1}`, at: hit.position, type: hit.type || null, aim: hit.distance ?? null, odo: w.odo, t: Date.now() - w.startedAt, checks: [] };
  w.pins.push(pin);
  log(w, `pin ${pin.name} dropped`, { aimM: pin.aim != null ? +pin.aim.toFixed(2) : null });
  return pin;
}

/** Aiming at the spot a pin was dropped on and tapping: how far the pin has moved from the spot since. */
export function checkPin(w, pin, hit) {
  const off = dist3(pin.at, hit.position), offLevel = levelDist(pin.at, hit.position);
  const c = { offM: off, offLevelM: offLevel, aim: hit.distance ?? null, walkedSinceM: w.odo - pin.odo, t: Date.now() - w.startedAt };
  pin.checks.push(c);
  log(w, `pin ${pin.name} checked`, { offM: +off.toFixed(3), walkedSinceM: +c.walkedSinceM.toFixed(1) });
  return c;
}

/** Two taps: the distance between them, to hold against a tape. Returns the finished measure after the second tap, else null. */
export function measure(w, hit) {
  if (!w.pendingMeasure) { w.pendingMeasure = { a: hit.position, aimA: hit.distance ?? null, odoA: w.odo }; return null; }
  const p = w.pendingMeasure; w.pendingMeasure = null;
  const m = { id: `${w.measures.length + 1}`, m: levelDist(p.a, hit.position), m3: dist3(p.a, hit.position), aimA: p.aimA, aimB: hit.distance ?? null, walkedBetweenM: w.odo - p.odoA, taped: null, t: Date.now() - w.startedAt };
  w.measures.push(m);
  log(w, `measured ${m.m.toFixed(3)} m`);
  return m;
}

/** The owner types what the tape said for a measure, in metres; the error is kept with it. */
export function tapeFor(m, metres) {
  m.taped = Number.isFinite(metres) && metres > 0 ? metres : null;
  return m.taped ? { shortBy: 1 - m.m / m.taped } : null;
}

export function undo(w) {
  if (w.pendingMeasure) { w.pendingMeasure = null; return 'measure'; }
  if (w.pins.length) { const p = w.pins.pop(); log(w, `pin ${p.name} undone`); return 'pin'; }
  return null;
}

export const far = (hit) => hit?.distance != null && hit.distance > AIM_FAR;

/**
 * The walk's results as the owner copies them: relative numbers only. No
 * coordinates, no GPS, nothing that places the lawn (CLAUDE.md).
 */
export function summary(w, extra = {}) {
  const r2 = (v) => (v == null ? null : +Number(v).toFixed(2)), r3 = (v) => (v == null ? null : +Number(v).toFixed(3));
  return {
    page: 'yard AR test v1', engine: w.engine, phone: w.phone, when: new Date(w.startedAt).toISOString(), seconds: Math.round(((w.endedAt || Date.now()) - w.startedAt) / 1000),
    stats: { walkedM: +w.stats.walked.toFixed(1), losses: w.stats.losses, resets: w.stats.resets, fastTurns: w.stats.fastTurns, frames: w.stats.frames, trackedShare: w.stats.frames ? +(w.stats.trackedFrames / w.stats.frames).toFixed(3) : null, limitedS: Math.round(w.stats.limitedMs / 1000) },
    points: { ...w.points, perTrackedFrame: w.stats.trackedFrames ? +(w.points.seen / w.stats.trackedFrames).toFixed(1) : null },
    pins: w.pins.map((p) => ({ name: p.name, type: p.type, aimM: r2(p.aim), checks: p.checks.map((c) => ({ offM: r3(c.offM), offLevelM: r3(c.offLevelM), aimM: r2(c.aim), walkedSinceM: r2(c.walkedSinceM) })) })),
    measures: w.measures.map((m) => ({ metres: r3(m.m), metres3d: r3(m.m3), tapedM: m.taped, shortBy: m.taped ? r3(1 - m.m / m.taped) : null, aimAM: r2(m.aimA), aimBM: r2(m.aimB), walkedBetweenM: r2(m.walkedBetweenM) })),
    events: w.events.slice(-80),
    ...extra,
  };
}
