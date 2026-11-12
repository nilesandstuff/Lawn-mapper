/**
 * ROOF CORNERS AS THE WALK'S REFERENCES (core session, 2026-11-11; docs/SCAN-PLAN.md section 24, the owner's option
 * 2: "Use 2-4 roof corners as references? Not walls, roof corners"). The photo leaves the problem: a roof corner's
 * place is the lidar's own (two long roof edges, each set by many returns, meet there), and the person need not find
 * it on any picture, only on the house.
 *
 * WHICH CORNERS (roofCorners): the owner's rules. A building's outline corner that the laser pins, turning outward,
 * each of its two edges 2.5 m or more; its eave no more than MAX_EAVE_M over the ground ("it would probably be wise
 * to limit the height from the ground"); within NEAR_LAWN_M (15 ft) of a lawn edge when a lawn is traced.
 *
 * HOW ONE IS MARKED IN AR (newSight / sight): by aiming UP at the corner itself (the owner: "straight down guess could
 * be quite inaccurate, and vary unpredictably between users"), from two places. Each aim is a sight line from the
 * phone through the crosshair; two sight lines from different places cross at the corner. That needs no depth
 * reading, which is weakest exactly at a thin roof edge against the sky; it needs only where the phone is and which
 * way it points, the two things AR tracks best over a few steps. The owner asked for a prescribed, checked procedure
 * with the mark made automatically, in as few steps and as little waiting as possible ("Patience is a limited
 * resource"), so:
 *   1. "Aim at the roof corner and hold." Taken by itself when the phone has been steady for HOLD_MS. Checked: the aim
 *      is upward; where the sight line reaches the eave's height (the lidar's) is a sensible distance off.
 *   2. "Step sideways" until the corner is seen from TURN_DEG or more round (counted down in steps), then "aim at the
 *      same corner and hold". Taken by itself.
 *   3. The two lines must pass within MISS_M of each other, and their crossing must be at the eave's height within
 *      EAVE_TOL_M. Then it is marked, with no tap. If not: one more sight from another place (the worst is dropped),
 *      up to MAX_SIGHTS, then it says what was wrong.
 * Pure: no page, no camera. Session frame: y up, the camera looks down its own -z.
 */

export const MAX_EAVE_M = 4.6;     // 15 ft: a single storey's eave, a porch's; not a second storey's
export const NEAR_LAWN_M = 4.57;   // 15 ft from a lawn edge (the owner's number)
export const LOOSE_EAVE_M = 5.5;   // 18 ft, and
export const LOOSE_LAWN_M = 9.14;  // 30 ft: the looser distances, used only when the first give fewer than three corners
export const MIN_SIDE_M = 2.5;
export const HOLD_MS = 700;        // steady this long and the sight is taken
export const STEADY_DEG = 0.7;     // the aim may wander this much while held
export const STEADY_M = 0.05;      // and the phone move this much
export const TURN_DEG = 25;        // the second sight from at least this far round the corner
export const MISS_M = 0.15;        // how near two sight lines must pass
export const EAVE_TOL_M = 0.8;     // the crossing's height against the lidar's eave (a slope under the phone is in it)
export const EAVE_TOL_PLACED_M = 1.6; // and when the crossing is where the lined-up map puts this corner (EXPECT_M): a real corner, at the right place
export const EXPECT_M = 2.5;       // how near (on the level) the crossing must be to where the map puts the corner, for that
export const MIN_UP_DEG = 8;       // an aim at a roof corner looks up
export const NEAR_M = 1.5, FAR_M = 14; // how near and far the corner may be from the phone, on the level
export const MAX_SIGHTS = 4;
export const DEPTH_TOL = 0.35, DEPTH_TOL_M = 1.2; // the camera's depth against the expected range: within 35% or 1.2 m
export const FIRST_KEEPS_MS = 60000; // a first aim with no second in a minute is let go (it may have been at something else)
const STEP_M = 0.7;

/* ---------------------------------------------------------------- which corners */

const distToRing = (ring, p) => {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
};
const areaOf = (ring) => { let a = 0; for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/**
 * The roof corners a walk may use. marks: lidar-marks.js lidarMarks' result; pts: its returns (returnsFrom), for each
 * corner's eave height; lawn: the traced lawn's rings ([[e, n]]), may be empty.
 * Returns [{ at: [e, n], eaveM, of (the building's id), label ("north-east corner"), sure, lawnM, sidesM: [a, b] }],
 * the surest first.
 */
export function roofCorners(marks, pts, lawn = [], opts = {}) {
  // THE OWNER'S TIERS (2026-11-11: "Still try to find 3 corners with the original requirement, then if there's not 3
  // good corners we can go to the next best at the higher threshold. Then if there's really just [not] 3 good
  // candidates at the next threshold, fall back to 2"): the original rules; with fewer than three, the looser
  // distances' corners are added after them (tier 2); what the walk does with two is walkref.js referenceFit's.
  //
  // A NEIGHBOUR'S ROOF IS OFFERED BUT DOES NOT COUNT (the owner, after the first walk with them, 2026-11-11: "I kinda
  // like the ability to use a neighbor's roof if needed. What is a problem is that it counts for the tier system...
  // ignore neighbor's roofs for the sake of the tier rule, but still do the roof shapes and make them available").
  // opts.lot: the property line's rings. A corner of a building whose middle is outside them is `offLot`; only the
  // lot's own corners are counted against three.
  if (opts.maxEaveM != null || opts.nearLawnM != null) return cornersWithin(marks, pts, lawn, opts);
  const lot = (opts.lot || []).filter((r) => r && r.length >= 3);
  const inLot = (p) => !lot.length || lot.some((ring) => { let c = false; for (let i = 0, j2 = ring.length - 1; i < ring.length; j2 = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j2]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; });
  const mids = new Map((marks?.objects || []).map((o) => [o.id, o.middle || (o.ring?.length ? [o.ring.reduce((t, q) => t + q[0], 0) / o.ring.length, o.ring.reduce((t, q) => t + q[1], 0) / o.ring.length] : null)]));
  const tag = (c, tier) => ({ ...c, tier, offLot: !(mids.get(c.of) ? inLot(mids.get(c.of)) : inLot(c.at)) });
  const first = cornersWithin(marks, pts, lawn, {}).map((c) => tag(c, 1));
  if (first.filter((c) => !c.offLot).length >= 3) return first;
  const more = cornersWithin(marks, pts, lawn, { maxEaveM: LOOSE_EAVE_M, nearLawnM: LOOSE_LAWN_M })
    .filter((c) => !first.some((f) => Math.hypot(f.at[0] - c.at[0], f.at[1] - c.at[1]) < 0.05)).map((c) => tag(c, 2));
  return [...first, ...more];
}
function cornersWithin(marks, pts, lawn = [], { maxEaveM = MAX_EAVE_M, nearLawnM = NEAR_LAWN_M } = {}) {
  const out = [];
  const roofs = [];
  for (let i = 0; i < pts.n; i++) if (pts.kind(i) === 1) { const h = pts.hag(i); if (h >= 1.5) roofs.push([pts.e(i), pts.nn(i), h]); }
  for (const o of marks?.objects || []) {
    if (o.kind !== 'building' || !o.ring || o.ring.length < 4 || !o.square) continue;
    const ring = o.ring, sign = Math.sign(areaOf(ring)) || 1, n = ring.length;
    const mid = o.middle || [ring.reduce((t, p) => t + p[0], 0) / n, ring.reduce((t, p) => t + p[1], 0) / n];
    for (let i = 0; i < n; i++) {
      const p = ring[i], a = ring[(i + n - 1) % n], b = ring[(i + 1) % n];
      const la = Math.hypot(p[0] - a[0], p[1] - a[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
      if (la < MIN_SIDE_M || lb < MIN_SIDE_M) continue;
      // turning outward: the same way round as the whole outline
      const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      if (Math.sign(cross) !== sign) continue;
      const c = (marks.corners || []).find((k) => k.of === o.id && k.kind === 'corner' && Math.hypot(k.at[0] - p[0], k.at[1] - p[1]) < 0.05);
      if (!c) continue;
      // the eave: the low roof returns within 2 m of the corner (the roof rises away from its edge)
      const hs = roofs.filter((r) => Math.hypot(r[0] - p[0], r[1] - p[1]) <= 2).map((r) => r[2]).sort((x, y) => x - y);
      if (hs.length < 3) continue;
      const eaveM = eaveOf(hs);
      if (eaveM > maxEaveM) continue;
      const lawnM = lawn.length ? Math.min(...lawn.map((r) => distToRing(r, p))) : null;
      if (lawnM != null && lawnM > nearLawnM) continue;
      const ang = (Math.atan2(p[0] - mid[0], p[1] - mid[1]) * 180) / Math.PI; // 0 north, clockwise
      out.push({ at: [+p[0].toFixed(2), +p[1].toFixed(2)], eaveM: +eaveM.toFixed(2), of: o.id, label: `${COMPASS[Math.round(((ang + 360) % 360) / 45) % 8]} corner`, sure: !!c.sure, within: c.within ?? null, lawnM: lawnM == null ? null : +lawnM.toFixed(1), sidesM: [+la.toFixed(1), +lb.toFixed(1)] });
    }
  }
  return out.sort((x, y) => (y.sure - x.sure) || ((x.within ?? 9) - (y.within ?? 9)));
}

/**
 * THE EAVE AT A CORNER IS ITS LOWEST ROOF, NOT A SHARE OF EVERYTHING NEAR IT (the owner's walk, 2026-11-12: R2's two
 * aims met cleanly "3.9 ft below this roof's edge" and were refused; "there was a higher roof peak in view"). The
 * eave was the 20th percentile of the roof returns within 2 m, so where a higher roof stands within 2 m of a lower
 * one's corner and has most of the returns, the number was the higher roof's. Now: the lowest level that holds a
 * real share of them (4 returns or 8%, within 0.4 m of each other; a wall's few stray returns at odd heights do
 * not make a level), and the old percentile when no such level is found. hs: heights, sorted low to high.
 */
export function eaveOf(hs) {
  const n = hs.length, need = Math.max(4, Math.ceil(n * 0.08));
  for (let i = 0; i + need <= n; i++) {
    let j = i; while (j < n && hs[j] <= hs[i] + 0.4) j++;
    if (j - i >= need) return hs[i + ((j - i) >> 1)];
  }
  return hs[Math.floor(n * 0.2)];
}

/* ---------------------------------------------------------------- the sighting */

/** Which way a camera looks: its -z turned by its quaternion. */
export function lookOf(q) {
  const { x, y, z, w } = q;
  return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const angDeg = (a, b) => (Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180) / Math.PI;

/** The point nearest all the sight lines ([{ o, d }], d unit), and how far each passes from it. */
export function crossing(rays) {
  // sum over rays of (I - d d^T) p = sum of (I - d d^T) o
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const { o, d } of rays) for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { const m = (i === j ? 1 : 0) - d[i] * d[j]; A[i][j] += m; b[i] += m * o[j]; } }
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  if (Math.abs(det) < 1e-9) return null;
  const col = (k) => A.map((r, i) => r.map((v, j) => (j === k ? b[i] : v)));
  const d3 = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  const p = [d3(col(0)) / det, d3(col(1)) / det, d3(col(2)) / det];
  const miss = rays.map(({ o, d }) => { const v = sub(p, o), t = dot(v, d); return Math.hypot(v[0] - t * d[0], v[1] - t * d[1], v[2] - t * d[2]); });
  return { p, miss, behind: rays.some(({ o, d }) => dot(sub(p, o), d) <= 0) };
}

/** A new sighting of one roof corner. eaveM: the lidar's eave height there; groundY: the ground's y in the session. */
export function newSight({ eaveM, groundY, eaveY = null, expect = null }) {
  // eaveY: the eave's height in the session when it is known better than "the ground under the phone + eaveM" (from a
  // roof corner already marked: its own crossing, and the lidar's difference between the two eaves). expect: { x, z },
  // where the lined-up map puts this corner, when there is a fit.
  return { eaveM, groundY, eaveY, expect, rays: [], win: [], state: 'aim', say: 'Aim at the roof corner and hold still', detail: '', first: null, tries: 0, done: null, log: [] };
}

/**
 * One camera frame into a sighting. f: { t (ms), pos: { x, y, z }, quat, tracking }. Returns the sighting, whose
 * `say` is the instruction to show, `detail` the small print, `progress` 0..1 of the present hold, and, when
 * finished, `done`: { ok, position: { x, y, z }, missM, sights, turnDeg, eaveOffM } or { ok: false, why }.
 */
export function sight(S, f) {
  if (S.done) return S;
  S.progress = 0;
  if (!f.pos || !f.quat || f.tracking === 'lost') { S.win = []; S.detail = 'Tracking lost: move the phone slowly'; return S; }
  const o = [f.pos.x, f.pos.y, f.pos.z], d = norm(lookOf(f.quat));
  const upDeg = (Math.asin(Math.max(-1, Math.min(1, d[1]))) * 180) / Math.PI;
  // where this aim reaches the eave's height: the corner, if the aim is on it
  const eaveY = S.eaveY ?? S.groundY + S.eaveM, t = d[1] > 1e-3 ? (eaveY - o[1]) / d[1] : NaN;
  const reach = Number.isFinite(t) && t > 0 ? [o[0] + t * d[0], eaveY, o[2] + t * d[2]] : null;
  const levelTo = reach ? Math.hypot(reach[0] - o[0], reach[2] - o[2]) : NaN;

  if (S.state === 'move' && S.rays.length === 1 && S.took && f.t - S.took > FIRST_KEEPS_MS) {
    // a minute and no second aim: start again (the first may have been taken while the phone was held up at nothing)
    S.rays = []; S.first = null; S.turnDeg = null; S.tries = 0; S.win = []; S.state = 'aim'; S.say = 'Aim at the roof corner and hold still'; S.detail = '';
  }
  if (S.state === 'move') {
    // seen from how far round, against the first sight
    const c = S.first.reach, a = [S.first.o[0] - c[0], 0, S.first.o[2] - c[2]], b2 = [o[0] - c[0], 0, o[2] - c[2]];
    const turned = angDeg(a, b2), dist = Math.hypot(b2[0], b2[2]);
    S.turnDeg = turned;
    if (dist < NEAR_M) { S.say = 'Too close: back away from the corner'; S.detail = ''; S.win = []; return S; }
    if (dist > FAR_M) { S.say = 'Too far: walk back toward the corner'; S.detail = ''; S.win = []; return S; }
    if (turned < TURN_DEG) {
      const need = 2 * dist * Math.sin(((TURN_DEG - turned) * Math.PI) / 360);
      // WHICH WAY (the owner, 2026-11-12: "It was saying to step to the side, but it didn't say which direction"):
      // either works, so it names one and keeps to it -- the way the phone has already gone once it has moved a
      // foot, to the right before that
      const fo = S.first.o, right = norm([-(c[2] - fo[2]), 0, c[0] - fo[0]]), gone = (o[0] - fo[0]) * right[0] + (o[2] - fo[2]) * right[2];
      if (!S.side || Math.abs(gone) > 0.3) S.side = gone < -0.3 ? 'left' : gone > 0.3 ? 'right' : S.side || 'right';
      const steps = Math.max(1, Math.ceil(need / STEP_M));
      S.say = `Step to your ${S.side}: ${steps} more step${steps > 1 ? 's' : ''}`;
      S.detail = 'Walk round the corner in an arc, keeping the circle near it. Then aim at it again.'; S.win = []; return S;
    }
    S.state = 'aim'; S.say = 'Aim at the same roof corner and hold still'; S.detail = '';
  }

  // aiming: is it an aim at a roof corner at all?
  if (upDeg < MIN_UP_DEG) { S.win = []; S.detail = 'Tilt up: the circle goes on the corner of the roof itself'; return S; }
  if (!reach || levelTo < NEAR_M) { S.win = []; S.detail = 'Too close under it: step back a little'; return S; }
  if (levelTo > FAR_M) { S.win = []; S.detail = 'Too far: walk closer to the corner'; return S; }
  if (S.rays.length && S.turnDeg != null && S.turnDeg < TURN_DEG * 0.8) { S.state = 'move'; S.win = []; return S; }
  S.detail = '';
  // WHAT THE CAMERA'S DEPTH READS THERE, AGAINST WHAT IT SHOULD (the owner, 2026-11-11: "getting live shape/depth
  // readings and checking them against expectations"). f.depths: the range (m) read at the crosshair and just round
  // it, null where the camera reads nothing (sky). A roof corner is an edge: something at about the range where this
  // aim reaches the eave, and sky or something far beside it. Nothing near that range means the aim is on something
  // else (a branch in front, a wall behind): said, and not taken. A phone that reads no depth at all is not held up.
  const range = t;
  const read = (f.depths || []).filter((v) => v != null && Number.isFinite(v) && v > 0);
  S.depth = null;
  if (f.depths && f.depths.length) {
    const tol = Math.max(DEPTH_TOL_M, DEPTH_TOL * range);
    const on = read.filter((v) => Math.abs(v - range) <= tol);
    const edge = f.depths.some((v) => v == null || !Number.isFinite(v) || v <= 0 || v > range + tol);
    const nearest = read.length ? read.reduce((a, b) => (Math.abs(b - range) < Math.abs(a - range) ? b : a)) : null;
    S.depth = { range, read: nearest, on: on.length, edge };
    if (read.length >= 3 && !on.length) {
      S.win = [];
      S.detail = `The camera reads ${(nearest * 3.281).toFixed(0)} ft there; this corner should be about ${(range * 3.281).toFixed(0)} ft away. Put the circle on the roof's corner itself.`;
      return S;
    }
    S.detail = on.length ? `Reads ${(nearest * 3.281).toFixed(0)} ft, as expected (${(range * 3.281).toFixed(0)} ft)${edge ? ', with sky beside it' : ''}. Hold.` : 'Hold still…';
  }
  // steady? every frame of the last HOLD_MS within STEADY_DEG and STEADY_M of this one
  S.win.push({ t: f.t, o, d });
  while (S.win.length && (angDeg(S.win[0].d, d) > STEADY_DEG || Math.hypot(...sub(S.win[0].o, o)) > STEADY_M)) S.win.shift();
  const held = f.t - S.win[0].t;
  S.progress = Math.min(1, held / HOLD_MS);
  if (held < HOLD_MS || S.win.length < 5) return S;

  // taken: the mean of the hold
  const n = S.win.length, mo = [0, 0, 0], md = [0, 0, 0];
  for (const w of S.win) for (let i = 0; i < 3; i++) { mo[i] += w.o[i] / n; md[i] += w.d[i] / n; }
  const ray = { o: mo, d: norm(md), t: f.t, reach };
  S.rays.push(ray); S.win = []; S.progress = 0; S.tries++;
  S.log.push({ t: f.t, upDeg: +upDeg.toFixed(1), levelM: +levelTo.toFixed(2) });
  if (S.rays.length === 1) { S.first = ray; S.turnDeg = 0; S.side = null; S.state = 'move'; S.say = 'Got it. Now step to your right'; S.detail = 'Or left, if a wall is in the way: walk round the corner in an arc, keeping it in view.'; S.took = f.t; return S; }

  // two or more: do they cross, at the eave?
  let rays = S.rays, X = crossing(rays);
  if (X && rays.length > 2 && Math.max(...X.miss) > MISS_M) {
    // one sight was off: leave the worst out, if the rest then agree
    const worst = X.miss.indexOf(Math.max(...X.miss)), rest = rays.filter((_, i) => i !== worst), Y = crossing(rest);
    if (Y && Math.max(...Y.miss) <= MISS_M) { rays = rest; X = Y; S.rays = rest; }
  }
  const miss = X ? Math.max(...X.miss) : Infinity;
  const eaveOff = X ? X.p[1] - eaveY : Infinity;
  let turn = 0; if (X) for (let i = 0; i < rays.length; i++) for (let j = i + 1; j < rays.length; j++) turn = Math.max(turn, angDeg([rays[i].o[0] - X.p[0], 0, rays[i].o[2] - X.p[2]], [rays[j].o[0] - X.p[0], 0, rays[j].o[2] - X.p[2]]));
  const lv = X ? Math.min(...rays.map((r) => Math.hypot(X.p[0] - r.o[0], X.p[2] - r.o[2]))) : 0;
  const why = !X || X.behind ? 'the two aims do not meet in front of you'
    : miss > MISS_M ? `the aims pass ${(miss * 39.37).toFixed(0)} in apart: not the same spot`
      : Math.abs(eaveOff) > (S.expect && Math.hypot(X.p[0] - S.expect.x, X.p[2] - S.expect.z) <= EXPECT_M ? EAVE_TOL_PLACED_M : EAVE_TOL_M) ? `your aims meet ${Math.abs(eaveOff * 3.281).toFixed(1)} ft ${eaveOff > 0 ? 'above' : 'below'} the roof edge the lidar has for this corner. Aim at the corner of the ${eaveOff > 0 ? 'lower' : 'higher'} roof edge there, or pick another corner`
        : turn < TURN_DEG * 0.8 ? 'the two places are too close together'
          : lv < NEAR_M * 0.7 ? 'too close under the corner' : null;
  S.log.push({ t: f.t, sights: rays.length, missM: Number.isFinite(miss) ? +miss.toFixed(3) : null, eaveOffM: Number.isFinite(eaveOff) ? +eaveOff.toFixed(2) : null, turnDeg: +turn.toFixed(0), why });
  if (!why) { S.done = { ok: true, position: { x: X.p[0], y: X.p[1], z: X.p[2] }, missM: miss, sights: rays.length, turnDeg: turn, eaveOffM: eaveOff, distance: lv }; S.say = 'Marked'; S.detail = ''; return S; }
  if (S.tries >= MAX_SIGHTS) { S.done = { ok: false, why }; S.say = 'Could not mark this corner'; S.detail = why; return S; }
  // one more, from another place
  S.first = rays[rays.length - 1]; S.turnDeg = 0; S.side = null; S.state = 'move';
  S.say = 'Once more from another spot: step to your right'; S.detail = `That did not agree (${why}).`;
  return S;
}
