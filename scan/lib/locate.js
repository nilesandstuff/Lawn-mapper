/**
 * WHERE AM I ON THE MAP: THE FIX'S BOOKKEEPING (core session, docs/SCAN-PLAN.md 3.2).
 *
 * Two frames: the session's (metres, y up, where the phone started) and the map's (metres east and north of the
 * map's point). The fix between them, for any moment of the walk, comes from:
 *   - the lidar: what the depth picture has seen in the last RECENT_M metres of walking, matched against the lot's
 *     3DEP grids (scan/lib/lidar.js register, run in scan/public/lidar-worker.js); a fix stands for FIX_REACH metres;
 *   - the references: spots marked on the photo and aimed at in AR (scan/lib/align.js fitAt), weighted by the walk;
 *   - GPS, only as a place to start the lidar search from.
 * The way the water session's test page kept these (water/public/ar.js, H68) is carried here into a pure module so
 * Node tests it. Positions here are session {x, y, z} or level [u, v]; map points are [e, n].
 */
import { level, levelDist } from './frames.js';
import { apply, unapply, fitAt } from './align.js';

export const FIX_REACH = 20;   // m of walk a lidar fix stands for
export const VOX = 0.2;        // m: the phone's depth points kept one to a cell this size
export const RECENT_M = 25;    // m of walk whose points go into a match
export const KEEP_M = 40;      // m of walk after which old points are dropped
export const MIN_STAND = 30;   // standing points a match wants (lidar.js register's minStand)
export const ASK_EVERY_MS = 1500;
const BANDS = { groundTol: 0.2, standLow: 0.4, standHigh: 2.4, near: 0.4, far: 8 };

export function newLocate({ scale = 1 } = {}) {
  return { marks: [], fixes: [], cloud: new Map(), groundY: null, gps: null, scale, asks: 0, refused: {}, last: null, lastAsk: 0, pending: null, nextId: 1 };
}

/* ------------------------------------------------------------- references */

/** A reference (or check point) aimed at in AR: pairs its map place with the session's level position at this moment of the walk. */
export function mark(L, ref, hit, odo) {
  const m = { id: ref.id, kind: ref.kind || 'ref', map: ref.map, ar: level(hit.position), y: hit.position.y, odo, aim: hit.distance ?? null, by: hit.type || null };
  L.marks.push(m);
  return m;
}
const refMarks = (L) => L.marks.filter((m) => m.kind === 'ref');
/** The references' fit for a moment of the walk, or null before two different references are marked. */
export const refFit = (L, odo) => fitAt(refMarks(L), odo);

/* -------------------------------------------------------- the depth cloud */

/** The ground near the phone, from what the crosshair's depth says is the ground: a slow average. */
export function noteGround(L, y) {
  L.groundY = L.groundY == null ? y : 0.9 * L.groundY + 0.1 * y;
}

/** Depth points round the phone, kept one to a VOX cell as ground ('g') or standing ('s'), with the walk they were seen at. */
export function addDepth(L, points, odo, camY = null) {
  const gy = L.groundY ?? (camY != null ? camY - 1.35 : null);
  if (gy == null) return 0;
  let kept = 0;
  for (const p of points) {
    const h = p.y - gy;
    const cls = Math.abs(h) < BANDS.groundTol ? 'g' : h > BANDS.standLow && h < BANDS.standHigh ? 's' : null;
    if (!cls) continue;
    L.cloud.set(`${Math.floor(p.x / VOX)},${Math.floor(p.z / VOX)},${cls}`, { u: p.x, v: -p.z, y: p.y, odo, cls });
    kept++;
  }
  if (L.cloud.size > 8000) for (const [k, p] of L.cloud) if (p.odo < odo - KEEP_M) L.cloud.delete(k);
  return kept;
}

/** The points of the last RECENT_M metres of walking, as the match wants them. */
export function recent(L, odo, m = RECENT_M) {
  const stand = [], ground = [];
  for (const p of L.cloud.values()) {
    if (p.odo < odo - m) continue;
    if (p.cls === 's') stand.push([p.u, p.v]); else ground.push([p.u, p.v, p.y]);
  }
  return { stand, ground };
}

/* ------------------------------------------------------------- the fixes */

export const nearestFix = (L, odo) => L.fixes.reduce((b, f) => (!b || Math.abs(f.odo - odo) < Math.abs(b.odo - odo) ? f : b), null);

/** The fit for a moment: the lidar's fix nearest it in the walk, within FIX_REACH; else the references'; else null. */
export function fitFor(L, odo) {
  const f = nearestFix(L, odo);
  if (f && Math.abs(f.odo - odo) <= FIX_REACH) return f.T;
  return refFit(L, odo);
}
/** Which the fit came from: 'fix', 'refs' or null. */
export function fitSource(L, odo) {
  const f = nearestFix(L, odo);
  if (f && Math.abs(f.odo - odo) <= FIX_REACH) return 'fix';
  return refFit(L, odo) ? 'refs' : null;
}

/** Where to start the next search: the last fix (a small search), the references (a wider one), or GPS (any turn). */
export function priorFor(L, odo, now = Date.now()) {
  const f = nearestFix(L, odo);
  if (f && Math.abs(f.odo - odo) < FIX_REACH) return { T: f.T, searchM: 1.5, searchDeg: 6, from: 'the last fix' };
  const ref = refFit(L, odo);
  if (ref) return { T: ref, searchM: 4, searchDeg: 15, from: 'the references' };
  if (L.gps && now - L.gps.t < 30000) return { at: L.gps.at, phone: L.gps.phone, radiusM: Math.max(6, Math.min(20, L.gps.acc * 1.5)), from: 'GPS' };
  return null;
}

/** Is it time to ask, and with what? -> { id, stand, ground, prior, s } or { why } */
export function nextAsk(L, odo, now = Date.now()) {
  if (L.pending) return { why: 'a match is running' };
  if (now - L.lastAsk < ASK_EVERY_MS) return { why: 'too soon' };
  const { stand, ground } = recent(L, odo);
  if (stand.length < MIN_STAND) return { why: `the camera has ${stand.length} points on walls, fences, bushes or trunks within 25 ft (${MIN_STAND} wanted): look round at them` };
  const prior = priorFor(L, odo, now);
  if (!prior) return { why: 'waiting for GPS (or two references) to start from' };
  const id = L.nextId++;
  L.pending = { id, odo, from: prior.from, at: now };
  L.lastAsk = now; L.asks++;
  return { id, stand: thin(stand, 600), ground: thin(ground, 300), prior, s: L.scale };
}
export const thin = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));

/** A match's answer. -> the fix added, or null when refused (the reason counted). */
export function answer(L, fix, id) {
  if (!L.pending || L.pending.id !== id) return null;
  const { odo, from } = L.pending;
  L.pending = null;
  L.last = { ok: !!fix?.ok, why: fix?.why || null, hits: fix?.hits ?? null, from, odo };
  if (!fix?.ok) { const k = (fix?.why || 'unknown').replace(/\d+/g, '#'); L.refused[k] = (L.refused[k] || 0) + 1; return null; }
  const f = { T: fix.T, odo, hits: fix.hits, cost: fix.cost, from, runnerUp: fix.runnerUp || null };
  L.fixes.push(f);
  if (L.fixes.length > 300) L.fixes.shift();
  return f;
}

/* --------------------------------------------------------- map <-> session */

/** A session position on the map, by the fit for that moment; null without a fit. */
export function mapOf(L, pos, odo) {
  const T = fitFor(L, odo);
  return T ? apply(T, level(pos)) : null;
}
/** A map point in the session's frame, by the current fit, at the ground height near the phone; null without a fit. */
export function sessionOf(L, map, odo, y = null) {
  const T = fitFor(L, odo);
  if (!T) return null;
  const [u, v] = unapply(T, map);
  return { x: u, y: y ?? L.groundY ?? 0, z: -v };
}

/** A check point aimed at: how far the fit puts the crosshair from the check's place on the map. */
export function checkError(L, check, hit, odo) {
  const m = mapOf(L, hit.position, odo);
  if (!m) return null;
  const f = nearestFix(L, odo);
  return { errorM: Math.hypot(m[0] - check.map[0], m[1] - check.map[1]), by: fitSource(L, odo), walkedSinceFixM: f ? Math.abs(odo - f.odo) : null, aim: hit.distance ?? null };
}

/** The distance between two marks of one reference, as the session saw them: how far the frame slid between (level). */
export const slid = (a, b) => levelDist({ x: a.ar[0], y: 0, z: -a.ar[1] }, { x: b.ar[0], y: 0, z: -b.ar[1] });

/** What the HUD says about the fix. */
export function status(L, odo) {
  const src = fitSource(L, odo);
  const f = nearestFix(L, odo);
  if (src === 'fix') return `You are here (lidar fix, ${Math.round(Math.abs(odo - f.odo))} m ago, ${Math.round((f.hits || 0) * 100)}% landed)`;
  if (src === 'refs') return `Lined up by ${refMarks(L).length} reference mark${refMarks(L).length === 1 ? '' : 's'}; no lidar fix${L.last?.why ? ` (${L.last.why})` : ''}`;
  return `Not placed yet: mark two references, or look round at the house and fences${L.last?.why ? ` (${L.last.why})` : ''}`;
}

/** For the walk's copy: counts and errors, no positions. */
export function summaryOf(L) {
  return {
    marks: L.marks.length, references: new Set(refMarks(L).map((m) => m.id)).size,
    fixes: L.fixes.length, asks: L.asks, refused: L.refused,
    fixHits: L.fixes.map((f) => +(f.hits || 0).toFixed(2)), fixFrom: L.fixes.reduce((a, f) => { a[f.from] = (a[f.from] || 0) + 1; return a; }, {}),
    cloud: L.cloud.size, scale: L.scale,
  };
}
