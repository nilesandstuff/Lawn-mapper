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
import { geoPrior, geoFit } from './geo.js';

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
/* LOOSENED (owner, 2026-11-03: "The reference points are inherently flawed because it's just extremely difficult,
   borderline impossible, to accurately place dots and mark the dots perfectly... So yes, loosen it. Because the goal is
   to get rid of reference points when we're able to"). Was 2 m and 10 degrees; SCAN-H4's lawn-edge fixes sat 0.6-3.4 m
   and 9-20 degrees from three close references. The references now only stop a lock that is plainly elsewhere. */
/* TIGHTENED AGAIN (2026-11-05, measured): on the owner's walks of 2026-11-04 22:02 and 2026-11-05 20:26 the references
   put the check points 6 in to 6 ft off (C2, C3, C4 within 6 in on the second), while the kept lidar fixes sat a
   median 2.2 m and 4.8 m from them; on the second, two such fixes became the held fit and put C2 25 ft off. Until the
   lidar is shown to beat the references, a fix must sit within 2 m and 8 degrees of them. A walk without references
   is judged by the lidar alone, as before. */
export const REF_TOL_M = 2, REF_TOL_DEG = 8, MIN_HITS_ALONE = 0.65;
/* A fix this far (m, degrees) from the last kept one is a jump, held until a second fix agrees with it this closely. */
/* TRUST THE AR ENGINE (owner, 2026-11-05: "behavior was jittery. Seems to update too often. I think we should
   trust the ar engine for longer periods of time, then update fixes when needed"). The walk of 2026-11-04 22:02 kept
   71 fixes, a new one every few seconds, each drawn at once; standing still at one spot it kept four in a row, each
   a little different. So the page HOLDS one fit and lets ARCore carry it. A fix close to the held one (HOLD_M,
   HOLD_DEG) changes nothing but says the held fit is still good. The held fit moves only when AGREE_N fixes in a
   row agree with each other (AGREE_M, AGREE_DEG) and not with it, at most once every MOVE_GAP_MS; it then becomes
   their mean. It stands for HOLD_REACH metres of walk past the last fix that vouched for it. */
export const HOLD_M = 0.4, HOLD_DEG = 2;
export const AGREE_N = 3, AGREE_M = 0.5, AGREE_DEG = 3;
export const MOVE_GAP_MS = 5000;
export const HOLD_REACH = 60;
export const BANDS = { groundTol: 0.2, standLow: 0.4, standHigh: 2.4, highTop: 12, near: 0.4, far: 8 };

export function newLocate({ scale = 1 } = {}) {
  return { marks: [], fixes: [], holds: [], streak: [], cloud: new Map(), cols: new Map(), groundY: null, gps: null, scale, asks: 0, refused: {}, last: null, lastAsk: 0, pending: null, nextId: 1, log: [] };
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
/* SCAN-H7 (the owner's walk at work, 2026-11-03, with check points vouching for the references): the S21 has no
   depth sensor; ARCore's depth is estimated from motion, and noisy. Two things followed. A column's floor was its
   LOWEST point, and the lowest of hundreds of noisy samples sits well below the ground, so within 2 m of the phone 86%
   of the "standing" points were the ground itself. And past 3 m, 83-91% of the standing points stood on nothing in
   the lidar, 82% of those inside the mowed lawn: phantoms from depth that was off along the ray. So: the floor is a
   column's densest height, not its minimum (nor a low percentile, which the tail also fools); and a standing point
   farther than STAND_RANGE from the camera, or a ground point farther than GROUND_RANGE, is not kept for the match. */
export const FLOOR_BIN = 0.05;   // m: the column's height histogram's bin
export const STAND_RANGE = 3.5;  // m from the camera: standing points farther than this are not kept
export const GROUND_RANGE = 6;   // m from the camera: ground points farther than this are not kept
/**
 * The ground under a point: the lowest point seen in its 1 m column or the eight round it (SCAN-H2's lesson: one
 * ground height from the crosshair misreads a slope, a step or a drop, and a wall's foot becomes "ground" or a lawn
 * "standing"); failing any, the crosshair's slow average.
 */
export const OWN_COLUMN_N = 12; // points a column needs for its own floor to stand alone (else the lowest round it)
export function groundUnder(L, p) {
  const cx = Math.floor(p.x / COL), cz = Math.floor(p.z / COL), gy = L.groundY;
  // the point's own column when it has seen enough: the lowest of nine is low on a slope (SCAN-H7)
  const own = L.cols.get(`${cx},${cz}`);
  if (own && own.n >= OWN_COLUMN_N && (gy == null || own.y <= gy + FLOOR_ABOVE)) return own.y;
  let g = Infinity;
  // a column whose lowest point is well above the general ground has no ground in it (a wall seen from afar, a
  // deck top): it does not count as a floor. Below the general ground anything goes (a drop, a hollow).
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const c = L.cols.get(`${cx + dx},${cz + dz}`); if (c && c.y < g && (gy == null || c.y <= gy + FLOOR_ABOVE)) g = c.y; }
  return Number.isFinite(g) ? g : gy;
}

/**
 * A column's floor from its height histogram: the DENSEST height (each bin with its neighbours), looking only under
 * `cap` when given (the crosshair's ground plus FLOOR_ABOVE: a wall face is dense too, but not the floor). The ground
 * is the densest surface in a column; noisy depth puts a long thin tail under it, which a minimum or a low percentile
 * both fall into (SCAN-H7: the 15th percentile still read 83% of the ground as standing).
 */
export function floorOf(c, cap = Infinity) {
  const bins = [...c.hist.keys()].sort((a, b) => a - b);
  let best = null, bestN = -1;
  for (const b of bins) {
    if ((b + 0.5) * FLOOR_BIN > cap) break;
    const n = (c.hist.get(b - 1) || 0) + c.hist.get(b) + (c.hist.get(b + 1) || 0);
    if (n > bestN) { bestN = n; best = b; }
  }
  if (best == null) best = bins[0];
  return (best + 0.5) * FLOOR_BIN;
}

/**
 * Depth points round the phone, kept one to a VOX cell as ground ('g') or standing ('s'), with the walk they were
 * seen at. cam: the camera's position {x, y, z} when they were seen (for the range cap), or its height alone.
 */
export const STAND_SEEN = 2;     // sightings a standing point's cell needs before the match uses it (noise scatters)
export function addDepth(L, points, odo, cam = null, { standing = true } = {}) {
  const camY = cam == null ? null : typeof cam === 'number' ? cam : cam.y;
  const camPos = cam && typeof cam === 'object' ? cam : null;
  if (L.groundY == null && camY != null) L.groundY = camY - 1.35;
  if (L.groundY == null) return 0;
  // first the columns' floors from this batch (a point can only be "standing" above something lower seen near it)
  const touched = new Set();
  for (const p of points) {
    const k = `${Math.floor(p.x / COL)},${Math.floor(p.z / COL)}`;
    let c = L.cols.get(k);
    if (!c) { c = { y: p.y, odo, hist: new Map(), n: 0 }; L.cols.set(k, c); }
    const b = Math.floor(p.y / FLOOR_BIN);
    c.hist.set(b, (c.hist.get(b) || 0) + 1); c.n++; c.odo = odo; touched.add(c);
  }
  for (const c of touched) c.y = floorOf(c, L.groundY + FLOOR_ABOVE);
  let kept = 0;
  for (const p of points) {
    const range = camPos ? Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z) : 0;
    const h = p.y - groundUnder(L, p);
    if (range > GROUND_RANGE && h < BANDS.standHigh) continue;
    p.g = p.y - h; // the ground the page took under it, for the twin's record
    if (range > STAND_RANGE && h > BANDS.standLow && h < BANDS.standHigh) continue;
    // 'h': high up (gutters, a roof's edge, the bottom of a crown), matched against the lidar's roof edge
    const cls = Math.abs(h) < BANDS.groundTol ? 'g' : h > BANDS.standLow && h < BANDS.standHigh ? 's' : h >= BANDS.standHigh && h < BANDS.highTop ? 'h' : null;
    if (!cls) continue;
    /* standing points: only from a pass that knows their colour (app.js, once a second), and never grass-coloured
       (SCAN-H7: of the standing points that landed on the lidar none was grass; of those that landed on nothing,
       1,574 were -- the lawn itself, floated up by depth that was off along the ray) */
    if (cls === 's') { if (!standing) continue; if (p.surf === 'grass') { L.dropped = (L.dropped || 0) + 1; continue; } }
    // a ground point the camera saw the colour of carries 'grass' or 'pave' (scan/lib/surface.js), kept apart
    const surf = cls === 'g' && (p.surf === 'grass' || p.surf === 'pave') ? p.surf : null;
    const key = `${Math.floor(p.x / VOX)},${Math.floor(p.z / VOX)},${cls}${surf ? `:${surf}` : ''}`, was = L.cloud.get(key);
    L.cloud.set(key, { u: p.x, v: -p.z, y: p.y, odo, cls, surf, n: (was ? was.n : 0) + 1 });
    kept++;
  }
  if (L.cloud.size > 8000) for (const [k, p] of L.cloud) if (p.odo < odo - KEEP_M) L.cloud.delete(k);
  if (L.cols.size > 4000) for (const [k, c] of L.cols) if (c.odo < odo - KEEP_M) L.cols.delete(k);
  return kept;
}

/**
 * HOW HIGH TO DRAW THE LIDAR (owner, 2026-11-05: "lidar height jumped around a lot, and for the most part it seemed
 * to place the height too high... Generally 1-6ish feet too high"). The page drew it so the lidar's ground under the
 * phone met L.groundY, the crosshair's last depth hit 0.8-2.5 m below the camera: a hedge top, a slope ahead or grass
 * depth that floats (SCAN-H7) all lifted it, and every glance moved it. Instead, as the match measures it (lidar.js
 * placementCost tz): the median, over the ground points of the last RECENT_M metres, of the lidar's ground at each
 * point's own place under T minus the point's height. -> the session height minus the lidar height, or null with
 * fewer than `min` points. demAt(e, n) -> the lidar's ground there (NaN off the grid).
 */
export function groundOffset(L, odo, T, demAt, { min = 30, m = RECENT_M } = {}) {
  if (!T) return null;
  const d = [];
  for (const p of L.cloud.values()) {
    if (p.cls !== 'g' || p.odo < odo - m) continue;
    const z = demAt(...apply(T, [p.u, p.v]));
    if (Number.isFinite(z)) d.push(p.y - z);
  }
  if (d.length < min) return null;
  d.sort((a, b) => a - b);
  return d[d.length >> 1];
}

/** The points of the last RECENT_M metres of walking, as the match wants them. */
export function recent(L, odo, m = RECENT_M) {
  const stand = [], ground = [], high = [], surface = [];
  for (const p of L.cloud.values()) {
    if (p.odo < odo - m) continue;
    if (p.cls === 's') { if ((p.n || 1) >= STAND_SEEN) stand.push([p.u, p.v]); } else if (p.cls === 'h') high.push([p.u, p.v]);
    else if (p.surf) surface.push([p.u, p.v, p.surf]); else ground.push([p.u, p.v, p.y]);
  }
  return { stand, ground, high, surface };
}

/* ------------------------------------------------------------- the fixes */

export const nearestFix = (L, odo) => L.fixes.reduce((b, f) => (!b || Math.abs(f.odo - odo) < Math.abs(b.odo - odo) ? f : b), null);

/** The held fit for a moment of the walk: the last hold taken at or before it, while within HOLD_REACH of the last
 *  fix that vouched for it; else null. A walk saved before holds (L.legacy, set by twin.js placer) falls back to the
 *  nearest fix, as the page then drew it. */
export function holdAt(L, odo) {
  const H = L.holds || [];
  if (!H.length) {
    if (!L.legacy) return null;
    const f = nearestFix(L, odo);
    return f && Math.abs(f.odo - odo) <= FIX_REACH ? { T: f.T, odo0: f.odo, odo1: f.odo, legacy: true } : null;
  }
  let h = null;
  for (const x of H) if (x.odo0 <= odo + 1e-9) h = x;
  return h && odo - h.odo1 <= HOLD_REACH ? h : null;
}

/** The fit for a moment: the held lidar fit; else the references'; else Street View's, when ARCore is sure of it
 *  (L.geo, the latest reading: geo.js; live only, so a walk replayed afterwards never has it); else null. */
export function fitFor(L, odo, now = Date.now()) {
  const h = holdAt(L, odo);
  return h ? h.T : refFit(L, odo) || geoFit(L.geo, now);
}
/** Which the fit came from: 'fix', 'refs', 'geo' or null. */
export function fitSource(L, odo, now = Date.now()) {
  if (holdAt(L, odo)) return 'fix';
  if (refFit(L, odo)) return 'refs';
  return geoFit(L.geo, now) ? 'geo' : null;
}

/** Where to start the next search: the last fix (a small search), the references (a wider one), Street View (its
 *  turn and place when ARCore is sure of both, else its place; geo.js), or GPS (any turn). Street View goes before
 *  GPS unless GPS says it is the closer of the two. */
export function priorFor(L, odo, now = Date.now()) {
  const h = holdAt(L, odo);
  if (h) return { T: h.T, searchM: 1.5, searchDeg: 6, from: 'the last fix' };
  const ref = refFit(L, odo);
  if (ref) return { T: ref, searchM: 6, searchDeg: 25, from: 'the references' }; // as wide as the references are trusted
  const gps = L.gps && now - L.gps.t < 30000 ? { at: L.gps.at, phone: L.gps.phone, radiusM: Math.max(6, Math.min(20, L.gps.acc * 1.5)), from: 'GPS' } : null;
  const geo = geoPrior(L.geo, now);
  if (geo && (!gps || geo.T || L.geo.hacc <= L.gps.acc)) return geo;
  return gps;
}

/** Is it time to ask, and with what? pos: the camera's session position now. -> { id, stand, ground, prior, s } or { why } */
export function nextAsk(L, odo, now = Date.now(), pos = null) {
  if (L.pending) return { why: 'a match is running' };
  if (now - L.lastAsk < ASK_EVERY_MS) return { why: 'too soon' };
  const { stand, ground, high, surface } = recent(L, odo);
  if (stand.length + high.length < MIN_STAND) return { why: `the camera has ${stand.length + high.length} points on walls, fences, bushes, trunks or a roof's edge within 25 ft (${MIN_STAND} wanted): look round, or look up at the gutters` };
  const prior = priorFor(L, odo, now);
  if (!prior) return { why: 'waiting for GPS, Street View or two references to start from' };
  const id = L.nextId++;
  L.pending = { id, odo, from: prior.from, at: now, phone: pos ? level(pos) : null, refs: refFit(L, odo), stand: stand.length, ground: ground.length, high: high.length, surface: surface.length };
  L.lastAsk = now; L.asks++;
  // with the references marked, they judge the fix (answer), so the match may pass on points landed in number
  /* NO LAWN TRACE IN THE MATCH (owner, 2026-11-05: "lawn traces shouldn't be used anymore to get a fix. We can use
     hard edges with vision or lidar brightness, but not the actual geometry of the lawn traces"). On the walk of
     2026-11-04 22:02 the asks carried a median 2,132 grass-and-paving points weighed 8 times against 32 standing
     points, and the kept fixes sat a median 2.2 m from the references, which the check points put within 0.5 m. The
     colour is still read (the twin keeps it); the match is not sent it. */
  return { id, stand: thin(stand, 600), ground: thin(ground, 300), high: thin(high, 300), surface: [], prior, s: L.scale, refs: !!L.pending.refs };
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
  const { odo, from, phone, refs, at, stand, ground, high, surface } = L.pending;
  L.pending = null;
  // the log: one line per ask, so a wrong lock can be traced afterwards (SCAN-H2)
  const r2 = (v) => (v == null || !Number.isFinite(v) ? null : +Number(v).toFixed(2));
  const entry = { odo: r2(odo), ms: now - at, from: from[0] === 't' ? from.split(' ').pop() : from, stand, ground, high, surface: surface ?? 0, surfaceOff: fix?.surface ? fix.surface.off : null, walls: fix?.walls || null, roofHits: fix?.high ? fix.high.hits : null, ok: !!fix?.ok, hits: r2(fix?.hits), landed: fix?.landed ?? null, cost: fix?.cost != null ? +fix.cost.toFixed(4) : null, runnerUp: fix?.runnerUp ? { ratio: r2(fix.runnerUp.cost / (fix.cost || 1e-9)), apartM: r2(fix.runnerUp.apartM), apartDeg: r2(fix.runnerUp.apartDeg) } : null, tz: r2(fix?.tz), why: null, agreeM: null, agreeDeg: null, kept: false };
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
  entry.held = hold(L, f, phone || [0, 0], now);
  return f;
}

const meanT = (fs) => {
  const n = fs.length, c = fs.reduce((a, f) => a + Math.cos(f.T.theta), 0), sn = fs.reduce((a, f) => a + Math.sin(f.T.theta), 0);
  return { theta: Math.atan2(sn, c), tx: fs.reduce((a, f) => a + f.T.tx, 0) / n, ty: fs.reduce((a, f) => a + f.T.ty, 0) / n, s: fs.reduce((a, f) => a + (f.T.s ?? 1), 0) / n };
};
const agreeAll = (fs, phone) => fs.every((a, i) => fs.every((b, j) => j <= i || (() => { const d = disagreement(a.T, b.T, phone); return d.m <= AGREE_M && d.deg <= AGREE_DEG; })()));

/** A kept fix against the held fit (see HOLD_M). -> what it did: 'first', 'vouched', 'moved' or 'waiting'. */
function hold(L, f, phone, now) {
  L.holds = L.holds || [];
  const cur = L.holds.at(-1);
  if (cur) {
    const d = disagreement(f.T, cur.T, phone);
    if (d.m <= HOLD_M && d.deg <= HOLD_DEG) { cur.odo1 = Math.max(cur.odo1, f.odo); cur.vouched++; L.streak = []; return 'vouched'; }
  }
  L.streak = [...(L.streak || []), f].slice(-AGREE_N);
  const need = cur ? AGREE_N : 2;
  if (L.streak.length < need || !agreeAll(L.streak.slice(-need), phone)) return 'waiting';
  if (cur && now - cur.at < MOVE_GAP_MS) return 'waiting';
  L.holds.push({ T: meanT(L.streak.slice(-need)), odo0: f.odo, odo1: f.odo, at: now, vouched: 0 });
  if (L.holds.length > 100) L.holds.shift();
  L.streak = [];
  return cur ? 'moved' : 'first';
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
  const h = holdAt(L, odo);
  if (src === 'fix') return `You are here (lidar fix held ${Math.round(Math.abs(odo - h.odo0))} m, last vouched for ${Math.round(Math.abs(odo - h.odo1))} m ago)`;
  if (src === 'refs') return `Lined up by ${refMarks(L).length} reference mark${refMarks(L).length === 1 ? '' : 's'}; no lidar fix${L.last?.why ? ` (${L.last.why})` : ''}`;
  if (src === 'geo') return `Placed by Street View (within ${Math.round(L.geo.hacc * 3.281)} ft, ${Math.round(L.geo.yawAcc)}° by ARCore's own reckoning); no lidar fix yet${L.last?.why ? ` (${L.last.why})` : ''}`;
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
    fixes: L.fixes.length, asks: L.asks, refused: L.refused, holds: (L.holds || []).length, holdsVouched: (L.holds || []).reduce((a, h) => a + h.vouched, 0), grassDropped: L.dropped || 0,
    fixHits: L.fixes.map((f) => +(f.hits || 0).toFixed(2)), fixAgreeM: L.fixes.map((f) => f.agreeM), fixFrom: L.fixes.reduce((a, f) => { a[f.from] = (a[f.from] || 0) + 1; return a; }, {}),
    cloud: L.cloud.size, scale: L.scale,
  };
}
