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
/* THE REFERENCES ARE THE JUDGE (SCAN-H2, 2026-11-02: a lidar fix with 52-71% of points landing put a check point 8.9 m
   off while two cleanly marked references were to hand). A fix that puts the phone more than REF_TOL_M or turns it
   more than REF_TOL_DEG from where the references' fit puts it is refused; with no references at all a fix needs
   MIN_HITS_ALONE of its points landing. */
export const REF_TOL_M = 2, REF_TOL_DEG = 10, MIN_HITS_ALONE = 0.65;
const BANDS = { groundTol: 0.2, standLow: 0.4, standHigh: 2.4, near: 0.4, far: 8 };

export function newLocate({ scale = 1 } = {}) {
  return { marks: [], fixes: [], cloud: new Map(), cols: new Map(), groundY: null, gps: null, scale, asks: 0, refused: {}, last: null, lastAsk: 0, pending: null, nextId: 1, log: [] };
}
export const LOG_MAX = 150;

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

export const COL = 1; // m: the ground is remembered per column this wide
export const FLOOR_ABOVE = 0.5; // m: a column floor higher than this above the crosshair's ground is not a floor
/**
 * The ground under a point: the lowest point seen in its 1 m column or the eight round it (SCAN-H2's lesson: one
 * ground height from the crosshair misreads a slope, a step or a drop, and a wall's foot becomes "ground" or a lawn
 * "standing"); failing any, the crosshair's slow average.
 */
export function groundUnder(L, p) {
  const cx = Math.floor(p.x / COL), cz = Math.floor(p.z / COL), gy = L.groundY;
  let g = Infinity;
  // a column whose lowest point is well above the general ground has no ground in it (a wall seen from afar, a
  // deck top): it does not count as a floor. Below the general ground anything goes (a drop, a hollow).
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const c = L.cols.get(`${cx + dx},${cz + dz}`); if (c && c.y < g && (gy == null || c.y <= gy + FLOOR_ABOVE)) g = c.y; }
  return Number.isFinite(g) ? g : gy;
}

/** Depth points round the phone, kept one to a VOX cell as ground ('g') or standing ('s'), with the walk they were seen at. */
export function addDepth(L, points, odo, camY = null) {
  if (L.groundY == null && camY != null) L.groundY = camY - 1.35;
  if (L.groundY == null) return 0;
  // first the columns' floors from this batch (a point can only be "standing" above something lower seen near it)
  for (const p of points) {
    const k = `${Math.floor(p.x / COL)},${Math.floor(p.z / COL)}`, c = L.cols.get(k);
    if (!c || p.y < c.y) L.cols.set(k, { y: p.y, odo }); else c.odo = odo;
  }
  let kept = 0;
  for (const p of points) {
    const h = p.y - groundUnder(L, p);
    const cls = Math.abs(h) < BANDS.groundTol ? 'g' : h > BANDS.standLow && h < BANDS.standHigh ? 's' : null;
    if (!cls) continue;
    L.cloud.set(`${Math.floor(p.x / VOX)},${Math.floor(p.z / VOX)},${cls}`, { u: p.x, v: -p.z, y: p.y, odo, cls });
    kept++;
  }
  if (L.cloud.size > 8000) for (const [k, p] of L.cloud) if (p.odo < odo - KEEP_M) L.cloud.delete(k);
  if (L.cols.size > 4000) for (const [k, c] of L.cols) if (c.odo < odo - KEEP_M) L.cols.delete(k);
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

/** Is it time to ask, and with what? pos: the camera's session position now. -> { id, stand, ground, prior, s } or { why } */
export function nextAsk(L, odo, now = Date.now(), pos = null) {
  if (L.pending) return { why: 'a match is running' };
  if (now - L.lastAsk < ASK_EVERY_MS) return { why: 'too soon' };
  const { stand, ground } = recent(L, odo);
  if (stand.length < MIN_STAND) return { why: `the camera has ${stand.length} points on walls, fences, bushes or trunks within 25 ft (${MIN_STAND} wanted): look round at them` };
  const prior = priorFor(L, odo, now);
  if (!prior) return { why: 'waiting for GPS (or two references) to start from' };
  const id = L.nextId++;
  L.pending = { id, odo, from: prior.from, at: now, phone: pos ? level(pos) : null, refs: refFit(L, odo), stand: stand.length, ground: ground.length };
  L.lastAsk = now; L.asks++;
  return { id, stand: thin(stand, 600), ground: thin(ground, 300), prior, s: L.scale };
}
export const thin = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));

/** How far two fits disagree: where each puts the phone (m) and their turns (degrees). */
export function disagreement(Ta, Tb, phone) {
  const pa = apply(Ta, phone), pb = apply(Tb, phone);
  const deg = Math.abs(((((Ta.theta - Tb.theta) * 180) / Math.PI + 540) % 360) - 180);
  return { m: Math.hypot(pa[0] - pb[0], pa[1] - pb[1]), deg };
}

/** A match's answer. -> the fix added, or null when refused (the reason counted). */
export function answer(L, fix, id, now = Date.now()) {
  if (!L.pending || L.pending.id !== id) return null;
  const { odo, from, phone, refs, at, stand, ground } = L.pending;
  L.pending = null;
  // the log: one line per ask, so a wrong lock can be traced afterwards (SCAN-H2)
  const r2 = (v) => (v == null || !Number.isFinite(v) ? null : +Number(v).toFixed(2));
  const entry = { odo: r2(odo), ms: now - at, from: from[0] === 't' ? from.split(' ').pop() : from, stand, ground, ok: !!fix?.ok, hits: r2(fix?.hits), cost: fix?.cost != null ? +fix.cost.toFixed(4) : null, runnerUp: fix?.runnerUp ? { ratio: r2(fix.runnerUp.cost / (fix.cost || 1e-9)), apartM: r2(fix.runnerUp.apartM), apartDeg: r2(fix.runnerUp.apartDeg) } : null, tz: r2(fix?.tz), why: null, agreeM: null, agreeDeg: null, kept: false };
  L.log.push(entry); if (L.log.length > LOG_MAX) L.log.shift();
  const refuse = (why) => { entry.why = why; L.last = { ok: false, why, hits: fix?.hits ?? null, from, odo }; const k = why.replace(/\d+(\.\d+)?/g, '#'); L.refused[k] = (L.refused[k] || 0) + 1; return null; };
  if (!fix?.ok) return refuse(fix?.why || 'unknown');
  let agree = null;
  if (refs && phone) {
    agree = disagreement(fix.T, refs, phone);
    entry.agreeM = r2(agree.m); entry.agreeDeg = r2(agree.deg);
    if (agree.m > REF_TOL_M || agree.deg > REF_TOL_DEG) return refuse(`disagrees with the references by ${agree.m.toFixed(1)} m and ${agree.deg.toFixed(0)} degrees`);
  } else if ((fix.hits ?? 0) < MIN_HITS_ALONE) return refuse(`only ${Math.round((fix.hits ?? 0) * 100)}% landed and no references to check it against`);
  entry.kept = true;
  L.last = { ok: true, why: null, hits: fix.hits ?? null, from, odo };
  const f = { T: fix.T, odo, hits: fix.hits, cost: fix.cost, tz: fix.tz ?? null, from, runnerUp: fix.runnerUp || null, agreeM: agree ? +agree.m.toFixed(2) : null, agreeDeg: agree ? +agree.deg.toFixed(1) : null };
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

/** A check point aimed at: how far the fit puts the crosshair from the check's place on the map, and what each source alone would say. */
export function checkError(L, check, hit, odo) {
  const m = mapOf(L, hit.position, odo);
  if (!m) return null;
  const f = nearestFix(L, odo), r = refFit(L, odo), u = level(hit.position);
  const off = (T) => { if (!T) return null; const q = apply(T, u); return Math.hypot(q[0] - check.map[0], q[1] - check.map[1]); };
  return { errorM: Math.hypot(m[0] - check.map[0], m[1] - check.map[1]), by: fitSource(L, odo), errorFixM: f && Math.abs(odo - f.odo) <= FIX_REACH ? off(f.T) : null, errorRefsM: off(r), walkedSinceFixM: f ? Math.abs(odo - f.odo) : null, aim: hit.distance ?? null };
}

/** A session position's distance to the nearest named map point, by the fit used and by the references alone: { name, m, byRefsM } or null. */
export function nearestNamed(L, pos, odo, points) {
  const m = mapOf(L, pos, odo);
  if (!m || !points?.length) return null;
  let best = null;
  for (const p of points) { const d = Math.hypot(m[0] - p.map[0], m[1] - p.map[1]); if (!best || d < best.m) best = { name: p.name, m: d, p }; }
  const r = refFit(L, odo);
  let byRefsM = null;
  if (r) { const q = apply(r, level(pos)); byRefsM = Math.hypot(q[0] - best.p.map[0], q[1] - best.p.map[1]); }
  return { name: best.name, m: best.m, byRefsM };
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

/**
 * The phone's recent standing points sorted by whether they land on the lidar under the fit for this moment:
 * { on: [{x, y, z}], off: [...] } in the session frame, for drawing; dist: the lidar's distance grid
 * { box, cell, W, H, data } as the worker sends it. Empty without a fit.
 */
export function agreement(L, odo, dist, within = 0.3) {
  const T = fitFor(L, odo);
  const on = [], off = [];
  if (!T || !dist) return { on, off };
  const { stand } = recent(L, odo);
  for (const [u, v] of stand) {
    const [e, n] = apply(T, [u, v]);
    const c = Math.floor((e - dist.box[0]) / dist.cell), r = Math.floor((dist.box[3] - n) / dist.cell);
    const d = c >= 0 && r >= 0 && c < dist.W && r < dist.H ? dist.data[r * dist.W + c] : Infinity;
    const y = (L.cloud.get(`${Math.floor(u / VOX)},${Math.floor(-v / VOX)},s`)?.y) ?? L.groundY ?? 0;
    (d <= within ? on : off).push({ x: u, y, z: -v });
  }
  return { on, off };
}

/** For the walk's copy: counts and errors, no positions. */
export function summaryOf(L) {
  return {
    asksLog: L.log,
    marks: L.marks.length, references: new Set(refMarks(L).map((m) => m.id)).size,
    fixes: L.fixes.length, asks: L.asks, refused: L.refused,
    fixHits: L.fixes.map((f) => +(f.hits || 0).toFixed(2)), fixAgreeM: L.fixes.map((f) => f.agreeM), fixFrom: L.fixes.reduce((a, f) => { a[f.from] = (a[f.from] || 0) + 1; return a; }, {}),
    cloud: L.cloud.size, scale: L.scale,
  };
}
