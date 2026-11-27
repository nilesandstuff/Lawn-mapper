/**
 * EVERY PLANE THE WALK SAW, NOT ONLY THOSE HELD AT THE END (core session, 2026-11-27). The app (bridge 10) sends the
 * planes ARCore holds NOW, every 2 s: [id, kind (0 facing up, 1 facing down, 2 a wall), tracking (0 now, 1 paused),
 * [outline x, y, z, ...]]. ARCore drops a plane it stops tracking and folds one into another as it goes, so keeping
 * only the latest set lost most of a walk's walls (the first two walks on app 1.28: 6 walls and 0, on walks of 288 and
 * 509 pictures). Each id keeps its latest outline; one the app no longer sends stays, marked tracking 2 (no longer held).
 */
export function mergePlanes(kept, list) {
  const m = new Map((kept || []).map((p) => [p[0], p[2] === 2 ? p : [p[0], p[1], 2, p[3]]]));
  for (const p of list || []) if (Array.isArray(p) && p.length > 3) m.set(p[0], p);
  return [...m.values()];
}
