/**
 * ARCORE'S SCENE SEMANTICS AND ANCHORS ON THE PAGE (core session, 2026-11-07; the app's bridge 2; docs/SCAN-PLAN.md
 * section 11, road map 1-3).
 *
 * Semantics: the app labels each depth cell (sky, building, tree, road, sidewalk, terrain, structure, object, vehicle,
 * person, water) with ARCore's confidence, and sends the share of each label in the picture twice a second.
 *   keepPoint(label, conf)   people and cars are not the yard: their points are dropped (when ARCore is sure)
 *   viewFromSem(sem, pitch)  the nudges' "a roofline against the sky" and "pavement in view", from the shares
 *   newSemCount / noteSem / semSummary   what the walk saw, by label, and a check that the labels line up with the
 *                            depth (Google does not say how the label image sits on the screen; sky with near depth
 *                            would say they do not)
 *
 * Anchors as a drift log: an anchor dropped every CRUMB_M along the walk; ARCore moves an anchor when it corrects its
 * own map, so how far each has moved by the end is ARCore's drift, admitted.
 *   newCrumbs / crumbDue / addCrumb / crumbMoves
 */

/** Sure enough of a label to act on it (ARCore's confidence, 0..1). */
export const SEM_SURE = 0.5;
const DROP = new Set(['person', 'vehicle']);

/** Is a depth point kept? Not when ARCore is sure it is on a person or a vehicle. */
export const keepPoint = (label, conf) => !(label && DROP.has(label) && (conf == null || conf >= SEM_SURE));

/* The nudges from the label shares: a skyline wants sky and something standing against it (a building, or trees
   along a roofline); pavement wants road or sidewalk, the camera looking down. */
export const SKY_SHARE = 0.08;
export const EDGE_SHARE = 0.05;
export const PAVE_SHARE = 0.15;
export function viewFromSem(sem, pitch = 0) {
  if (!sem) return null;
  const sky = sem.sky || 0, building = sem.building || 0, pave = (sem.road || 0) + (sem.sidewalk || 0);
  return {
    sky: pitch > -15 && sky >= SKY_SHARE && building >= EDGE_SHARE,
    pave: pitch < -10 && pave >= PAVE_SHARE,
    skyShare: +sky.toFixed(2), paveShare: +pave.toFixed(2), buildingShare: +building.toFixed(2),
    from: 'semantics',
  };
}

/** The labels the walk's depth cells carried. */
export const newSemCount = () => ({ cells: 0, sure: 0, by: {}, skyNear: 0, sky: 0, dropped: 0 });
/** One depth cell: its label, the label's confidence and its depth in metres (0 = none). */
export function noteSem(c, label, conf, d) {
  if (!label) return;
  c.cells++;
  if (conf != null && conf < SEM_SURE) return;
  c.sure++;
  c.by[label] = (c.by[label] || 0) + 1;
  if (label === 'sky') { c.sky++; if (d > 0 && d < 8) c.skyNear++; }
}
/** For the walk's summary: shares by label (of the sure cells) and the alignment check. */
export function semSummary(c) {
  if (!c || !c.cells) return null;
  const by = {};
  for (const [k, n] of Object.entries(c.by)) by[k] = +(n / Math.max(1, c.sure)).toFixed(3);
  return { cells: c.cells, sure: +(c.sure / c.cells).toFixed(3), by, skyWithNearDepth: c.sky ? +(c.skyNear / c.sky).toFixed(3) : null, dropped: c.dropped };
}

/** The drift log: an anchor every CRUMB_M walked, at most CRUMB_MAX. */
export const CRUMB_M = 10;
export const CRUMB_MAX = 48;
export const newCrumbs = () => ({ list: [], lastOdo: -Infinity, asked: 0, refused: 0 });
export const crumbDue = (c, odo) => c.list.length + c.refused < CRUMB_MAX && odo - c.lastOdo >= CRUMB_M;
/** An anchor asked for at `at` (the session point) when `odo` metres had been walked; handle null when refused. */
export function addCrumb(c, handle, at, odo) {
  c.lastOdo = odo; c.asked++;
  if (handle == null) { c.refused++; return; }
  c.list.push({ handle, odo, at0: { x: at.x, y: at.y, z: at.z } });
}
/**
 * How far ARCore moved each anchor since it was dropped: anchorAt(handle) -> its place now, or null (lost).
 * -> { n, held, lost, medianM, maxM, maxLevelM, worstOdo, list: [{ odo, m, level }] } (metres, session frame).
 */
export function crumbMoves(c, anchorAt) {
  const list = [];
  let lost = 0;
  for (const k of c.list) {
    const p = anchorAt(k.handle);
    if (!p) { lost++; continue; }
    const dx = p.x - k.at0.x, dy = p.y - k.at0.y, dz = p.z - k.at0.z;
    list.push({ odo: +k.odo.toFixed(1), m: +Math.hypot(dx, dy, dz).toFixed(3), level: +Math.hypot(dx, dz).toFixed(3), at: { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) }, at0: k.at0 });
  }
  const ms = list.map((x) => x.m).sort((a, b) => a - b);
  const worst = list.reduce((b, x) => (!b || x.m > b.m ? x : b), null);
  return {
    n: c.list.length, held: list.length, lost, refused: c.refused,
    medianM: ms.length ? ms[ms.length >> 1] : null, maxM: ms.length ? ms[ms.length - 1] : null,
    maxLevelM: list.length ? Math.max(...list.map((x) => x.level)) : null, worstOdo: worst ? worst.odo : null,
    list,
  };
}
