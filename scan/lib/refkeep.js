/**
 * KEEP WHAT IS GOOD OF A WALK, AND BUILD ON IT (core session, 2026-11-15).
 *
 * The owner, after a six minute walk at home whose three roof corners disagreed by 9 ft and so left nothing behind:
 * "The live fix after r3 was good, so there should be data that's usable as a reference. This will literally never
 * work if an entire walk has to be pixel perfect every time. Keep what is good... Future walks should build upon
 * that reference so they get better each time and uncertainty gets corrected rather than contributing to some sort
 * of ongoing error."
 *
 * Until now a walk became its map's reference only when EVERY mark agreed with the map to a foot (walkref.js
 * referenceFit), and a new reference REPLACED the old one. Now:
 *
 *   goodPart   the largest group of the walk's marks that agree with each other (the latest, when two groups are the
 *              same size), and the stretch of the walk they vouch for: from the tracking jump (or the half-way point)
 *              between the group and a mark that disagrees before it, to the same after it.
 *   partOf     the walk's points inside that stretch.
 *   mergeRef   a reference added to the map's earlier one. Where the new part saw the yard (1 m squares), its points
 *              take the place of the old ones there: a part placed by roof corners is placed by the lidar itself, so
 *              it corrects. A part placed only by the earlier reference's own shape ("extend") fills the squares the
 *              reference had nothing in, and leaves the rest alone: it cannot be surer than what placed it.
 *
 * Pure; marks are locate.js L.marks ({ id, ar: [u, v], map: [e, n], odo, by }).
 */
import { fitRigid, fitSimilar, place, VOX, MAX_SCALE, shapeFix } from './walkref.js';
import { fitAt } from './align.js';

export const AGREE_M = 0.45;       // 1.5 ft: how well the marks of a kept part agree with the map, at the least
/* PLANNING IN THE OUTLINE'S ERROR (the owner, 2026-11-16: "since I know we'll never be able to get the outlines
   perfect, are we essentially planning in the error?... we just need to find the best fit overall, and not the best
   fit per individual corner"). The fit was already the best overall; but the test that throws a corner out as marked
   wrong held every corner to a flat 1.5 ft, the size of an outline's own error on a sparse flight (the owner's lot:
   returns 2.4 ft apart), so a good sighting of a slightly-off outline corner could be thrown out as a bad aim (R3 on
   2026-11-15). Now each mark is allowed its own corner's uncertainty (m.tol: the corner's `within` when its sides were
   pinned by the returns, else 0.7 x the return spacing, how far a corner set from two sides each halfway across a
   gap can sit) plus AIM_M for the aim, never less than AGREE_M. A corner off by metres (R1, 9 ft) is still out. */
export const GROSS_M = 1;         // three corners out by this much together: one of them is at the wrong place, not a little off
export const AIM_M = 0.15;
export const allowedOf = (m, floor = AGREE_M) => Math.max(floor, Number.isFinite(m?.tol) ? AIM_M + m.tol : floor);
export const MIN_APART_M = 3;      // the part's marks at least this far apart: nearer, they cannot turn the walk
export const FOOT_M = 1;           // the squares a new part's ground is counted in, for what it replaces
export const MAX_STAND = 60000, MAX_GROUND = 30000;   // walkref.js's own limits

const lastOfEach = (marks) => { const by = new Map(); for (const m of marks || []) if (m?.ar && m?.map && Number.isFinite(m.odo)) by.set(m.id, m); return [...by.values()]; };

/** How a group of marks agrees: the worst distance from its place after their own best fit (two: the difference of
 *  the distance between them as walked and on the map), and the fit. */
export function agreement(group, floor = AGREE_M) {
  // three or more marks spread out: the phone's own scale is fitted too (walkref.js fitSimilar), within 7%
  const T = fitSimilar(group.map((m) => m.ar), group.map((m) => m.map));
  // worst: metres; over: the worst as a share of what that mark is allowed (allowedOf), over 1 meaning it disagrees
  let worst = 0, over = 0;
  if (group.length === 2) {
    worst = Math.abs(Math.hypot(group[0].ar[0] - group[1].ar[0], group[0].ar[1] - group[1].ar[1]) - Math.hypot(group[0].map[0] - group[1].map[0], group[0].map[1] - group[1].map[1]));
    const t = (m) => (Number.isFinite(m.tol) ? m.tol : 0);
    over = worst / Math.max(floor, AIM_M + Math.hypot(t(group[0]), t(group[1])));
    /* THE PHONE MEASURES SHORT (docs/SCAN-PLAN.md 50: 2% short of the map at three places, 5% at the owner's lot, steady
       walk after walk). Two corners 89 ft apart then read 4-6 ft short and failed this test every time, while on
       2026-11-20 a pair holding a corner marked 20 ft from its place passed it by chance and placed the walk. So two
       marks also agree when the walked length is the map's less up to MAX_SCALE (the same 7% the three-corner fit
       allows), or over it by no more than 2%. */
    const mapLen = Math.hypot(group[0].map[0] - group[1].map[0], group[0].map[1] - group[1].map[1]);
    const ratio = mapLen > 0 ? (mapLen + (Math.hypot(group[0].ar[0] - group[1].ar[0], group[0].ar[1] - group[1].ar[1]) - mapLen)) / mapLen : 1;
    if (ratio >= 1 - MAX_SCALE && ratio <= 1.02) over = Math.min(over, 1);
  } else for (const m of group) { const p = place(T, m.ar[0], m.ar[1]), r = Math.hypot(p[0] - m.map[0], p[1] - m.map[1]); worst = Math.max(worst, r); over = Math.max(over, r / allowedOf(m, floor)); }
  const apart = Math.max(...group.flatMap((a) => group.map((b) => Math.hypot(a.map[0] - b.map[0], a.map[1] - b.map[1]))));
  return { T, worst, over, apart };
}

/**
 * marks: the walk's; jumps: the odometer readings (m walked) at which the phone's tracking jumped.
 * -> { ok, T, ids, n, roof, worstM, lo, hi, whole, left: [ids that disagree], why }
 * lo..hi: the stretch of the walk (m walked) the part's marks vouch for; -Infinity / Infinity at the walk's ends.
 */
export function goodPart(marks, jumps = [], { agree = AGREE_M } = {}) {
  const all = lastOfEach(marks), roofs = all.filter((m) => m.by === 'ROOF');
  const use = (roofs.length >= 2 ? roofs : all).sort((a, b) => a.odo - b.odo), roof = roofs.length >= 2;
  if (use.length < 2) return { ok: false, n: use.length, roof, why: 'fewer than two marks' };
  let best = null;
  const n = Math.min(use.length, 10);   // the latest ten, if a walk ever has more
  const pool = use.slice(-n);
  for (let mask = 3; mask < 1 << n; mask++) {
    const g = pool.filter((_, i) => mask & (1 << i));
    if (g.length < 2) continue;
    const a = agreement(g, agree);
    if (a.over > 1 || a.apart < MIN_APART_M) continue;
    const last = g[g.length - 1].odo;
    if (!best || g.length > best.g.length || (g.length === best.g.length && (last > best.last + 1e-9 || (Math.abs(last - best.last) <= 1e-9 && a.worst < best.a.worst)))) best = { g, a, last };
  }
  if (!best) return { ok: false, n: use.length, roof, why: `no two of the ${use.length} marks agree with the map to ${(agree * 3.281).toFixed(1)} ft` };
  /* WHICH CORNER IS WRONG CANNOT ALWAYS BE TOLD (2026-11-22). Three corners, one marked at the wrong place: the three
     together fail, and TWO different pairs can each pass (the wrong corner may sit the right distance from one of the
     others). Picking the later pair, as before, picked the wrong one on 2026-11-20, and the walk placed by it went
     into the owner's lot's reference. When the best that agrees is a pair and another pair with a different corner
     in it agrees as well, nothing is vouched for: the answer is "they disagree, and it cannot be told which". */
  // (three corners exactly: with four, one wrong leaves three that agree together, and two pairs are a walk that drifted)
  // and only when the three are out by a metre or more together: under that, whichever pair is taken the walk sits
  // within the outline's own error, and the old answer (the pair, one corner left out) stands
  if (best.g.length === 2 && pool.length === 3 && agreement(pool, agree).worst >= GROSS_M) {
    const mine = new Set(best.g.map((m) => m.id));
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      // only a pair that SHARES one corner with the best: two pairs with no corner in common are two stretches of a
      // walk that drifted between them, each right for its own stretch (the later one is kept, as before)
      if (mine.has(pool[i].id) === mine.has(pool[j].id)) continue;
      const a = agreement([pool[i], pool[j]], agree);
      if (a.over <= 1 && a.apart >= MIN_APART_M) return { ok: false, n: use.length, roof, ambiguous: true, why: `its ${use.length} corners disagree, and two different pairs of them each agree with the map: it cannot be told which corner was marked wrong` };
    }
  }
  const inIds = new Set(best.g.map((m) => m.id)), out = use.filter((m) => !inIds.has(m.id));
  const first = best.g[0].odo, last = best.g[best.g.length - 1].odo;
  const J = [...jumps].filter(Number.isFinite).sort((a, b) => a - b);
  // before the part: the nearest tracking jump before its first mark; else, when a mark that disagrees came before
  // it, half way between that mark and the part's first
  const before = out.filter((m) => m.odo < first).pop(), after = out.find((m) => m.odo > last);
  const jb = J.filter((j) => j <= first).pop(), ja = J.find((j) => j >= last);
  const lo = jb != null && (!before || jb >= before.odo) ? jb : before ? (before.odo + first) / 2 : jb ?? -Infinity;
  const hi = ja != null && (!after || ja <= after.odo) ? ja : after ? (after.odo + last) / 2 : ja ?? Infinity;
  return { ok: true, T: best.a.T, ids: best.g.map((m) => m.id), n: best.g.length, roof, worstM: best.a.worst, lo, hi, whole: !out.length && lo === -Infinity && hi === Infinity, left: out.map((m) => m.id), why: null };
}

/* DID THE WALK COME BACK TO ITSELF? (2026-11-22, the walk in the rain: its three corners, all marked in its first steps,
   agreed within 7 in, and 930 ft later a pin put on the first corner sat 6 ft 11 in from the mark; the same gutter
   ends pinned twice lay 5 ft 7 in and 6 ft 3 in apart. The corners vouched for the walk's START and nothing else, and
   the walk went into the map's reference, correcting 45,000 of its points.)
   closingOf: the walk's closing error where it can be read: a PLAIN pin put within CLOSE_REACH_M of where a corner was
   marked, CLOSE_AFTER_M or more of walking later (the owner's way: "I placed a point... on r1"), or a corner marked
   again that much later. -> { m, walkedM, by } (the worst there is), or null when the walk gives no reading.
   marks: L.marks ({ id, ar: [u, v], odo, kind }); pins: the walk's ({ at: { x, y, z }, odo, kind? }). */
export const CLOSE_M = 1;          // m: a walk that closes worse than this is not put into a reference
export const CLOSE_REACH_M = 4, CLOSE_AFTER_M = 30;
export function closingOf(marks, pins) {
  const M = (marks || []).filter((m) => m?.ar && Number.isFinite(m.odo) && (m.kind || 'ref') === 'ref');
  const first = new Map(); for (const m of M) if (!first.has(m.id)) first.set(m.id, m);
  let worst = null;
  const take = (m, walkedM, by) => { if (!worst || m > worst.m) worst = { m, walkedM, by }; };
  for (const p of pins || []) {
    if (p?.kind || !p?.at || !Number.isFinite(p.odo)) continue;
    let best = null;
    for (const m of first.values()) { const d = Math.hypot(p.at.x - m.ar[0], -p.at.z - m.ar[1]); if (p.odo - m.odo >= CLOSE_AFTER_M && d <= CLOSE_REACH_M && (!best || d < best.d)) best = { d, m }; }
    if (best) take(best.d, p.odo - best.m.odo, 'a pin on a corner');
  }
  for (const m of M) { const f = first.get(m.id); if (f !== m && m.odo - f.odo >= CLOSE_AFTER_M) take(Math.hypot(m.ar[0] - f.ar[0], m.ar[1] - f.ar[1]), m.odo - f.odo, 'a corner marked again'); }
  return worst;
}

/* EVERY WALK IS KEPT (the owner, 2026-11-16: "When I do a walk, i want it to be saved as a reference... Always" and,
   of a corner sighted again, "A repeat corner check should be a refinement, not throwing away other data"). goodPart
   still says which marks agree, and the walk still asks again for one that does not (locate.js); but what is kept is
   no longer the stretch the agreeing marks vouch for. It is the whole walk, every part of it placed by the marks
   sighted nearest it in the walk (align.js fitAt, the fit the live page uses: a mark far back in the walk counts for
   less, because the phone drifts). A corner sighted twice keeps both marks: the first places the walk around it, in
   the phone's frame of that moment, and the second the walk around it. Only a corner that disagrees with all the
   others and was never sighted again (goodPart's `left`) places nothing; it is a wrong aim, not a drift.

   keepPlan  -> { ok, use: the marks that place the walk, C: one fit for the whole walk (goodPart's when the marks
                agree), agree, g: goodPart's answer, why }
   placeWalk the walk's points on the map, each by the fit for the moment it was seen. */
export function keepPlan(marks, jumps = []) {
  const all = (marks || []).filter((m) => m?.ar && m?.map && Number.isFinite(m.odo));
  const key = (m) => `${m.map[0].toFixed(2)},${m.map[1].toFixed(2)}`;
  const roofs = all.filter((m) => m.by === 'ROOF'), pool = new Set(roofs.map(key)).size >= 2 ? roofs : all;
  const g = goodPart(marks, jumps), left = new Set(g.ok ? g.left : []);
  const use = pool.filter((m) => !left.has(m.id));
  if (new Set(use.map(key)).size < 2) return { ok: false, use, C: null, agree: false, g, why: 'fewer than two roof corners were marked' };
  const odos = use.map((m) => m.odo).sort((a, b) => a - b), mid = odos[odos.length >> 1];
  const C = g.ok ? g.T : fitAt(use, mid);
  if (!C) return { ok: false, use, C: null, agree: false, g, why: 'its corners could not be fitted' };
  return { ok: true, use, C, agree: g.ok && !g.left.length, g, why: null };
}
/* ACROSS A TRACKING JUMP (the owner's home walk of 2026-11-15: the phone's place jumped 8.2 ft at 418 ft walked, and
   every corner was marked before it). A jump is not drift: after it the phone works in another frame, which no mark
   made before it can place. So each stretch between jumps is placed by its own corners (the walk asks for them again
   after a jump: app.js, L.stale); a stretch with fewer than two of its own is left out, and counted. Without jumps
   the whole walk is one stretch. -> { pts: [[e, n, y]], left: points not placed } */
export function placeWalk(points, use, C, jumps = []) {
  const J = [...(jumps || [])].filter(Number.isFinite).sort((a, b) => a - b);
  const segOf = (odo) => { let k = 0; while (k < J.length && J[k] <= odo) k++; return k; };
  const key = (m) => `${m.map[0].toFixed(2)},${m.map[1].toFixed(2)}`;
  const bySeg = new Map();
  for (const m of use) { const k = segOf(m.odo); if (!bySeg.has(k)) bySeg.set(k, []); bySeg.get(k).push(m); }
  const placeable = (k) => new Set((bySeg.get(k) || []).map(key)).size >= 2;
  const fits = new Map(), pts = [];
  let left = 0;
  for (const p of points || []) {
    let T = null;
    if (Number.isFinite(p[3])) {
      const k = segOf(p[3]);
      if (placeable(k)) { const b = `${k}:${Math.round(p[3])}`; if (!fits.has(b)) fits.set(b, fitAt(bySeg.get(k), Math.round(p[3]))); T = fits.get(b); }
    } else if (!J.length) T = C;
    if (!T) { left++; continue; }
    const q = place(T, p[0], p[1]); pts.push([q[0], q[1], p[2]]);
  }
  return { pts, left };
}
/* THE SAVED SHAPE'S MATCH (F) PLACES THE WALK WHOLE, rigidly, so it is used only for a walk whose corners agree and
   whose frame never broke: a walk that drifted (the 1:55 pm walk, 2026-11-16: its corners 5.7 ft farther apart than
   the map has them) or jumped goes in placed by its corners instead, stretch by stretch, filling what the shape
   lacked rather than overwriting it. */
export const matchUsable = (plan, jumps = []) => !!plan?.g?.ok && !(jumps || []).some(Number.isFinite);
export const AS_IS = { theta: 0, tx: 0, ty: 0, s: 1 };
/* ENOUGH CORNERS, BEFORE THE WALK (the owner, 2026-11-16: "the corner selection process should include a check, so a
   walk isn't refused after the walk for not having enough corners"). points: the map's points ({ roof, map }). Null
   when two roof corners at least MIN_APART_M apart are chosen; else what to do, in the owner's words. */
export function cornersShort(points) {
  const roofs = (points || []).filter((p) => p?.roof && Array.isArray(p.map));
  if (roofs.length < 2) return `${roofs.length ? 'Only one roof corner is chosen' : 'No roof corner is chosen'}: a walk needs two to be kept as this map's reference. On the lidar view, tap ${roofs.length ? 'one more building corner' : 'two building corners'} (the white diamonds are surest), well apart.`;
  let far = 0;
  for (const a of roofs) for (const b of roofs) far = Math.max(far, Math.hypot(a.map[0] - b.map[0], a.map[1] - b.map[1]));
  if (far < MIN_APART_M) return `The roof corners chosen are only ${(far * 3.281).toFixed(0)} ft apart: too close to line the walk up. Choose two at least ${Math.ceil(MIN_APART_M * 3.281)} ft apart, the farther the better.`;
  return null;
}

/** The walk's points ([u, v, y, odo]) walked within lo..hi. A point with no odometer reading is kept only when the
 *  part is the whole walk. */
export function partOf(points, lo, hi) {
  const whole = lo === -Infinity && hi === Infinity;
  return (points || []).filter((p) => (Number.isFinite(p[3]) ? p[3] >= lo && p[3] <= hi : whole));
}

const cellOf = (e, n, s) => `${Math.floor(e / s)},${Math.floor(n / s)}`;
function squares(ref, s = FOOT_M) {
  const set = new Set();
  for (const a of [ref.stand, ref.ground]) for (let i = 0; i + 2 < a.length; i += 3) set.add(cellOf(a[i], a[i + 1], s));
  return set;
}
function join(first, second, max) {
  // one point to a VOX cell, the first list's first; then thinned evenly to the limit
  const seen = new Set(), out = [];
  for (const a of [first, second]) for (let i = 0; i + 2 < a.length; i += 3) {
    const k = `${Math.floor(a[i] / VOX)},${Math.floor(a[i + 1] / VOX)},${Math.floor(a[i + 2] / VOX)}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(a[i], a[i + 1], a[i + 2]);
  }
  const n = out.length / 3;
  if (n <= max) return Float32Array.from(out);
  const step = Math.ceil(n / max), thin = [];
  for (let i = 0; i < n; i += step) thin.push(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
  return Float32Array.from(thin);
}

/**
 * old: the map's reference (walkref.js decodeRef) or null; add: the new part (buildRef). mode 'correct': where the
 * new part saw the yard its points replace the old ones; 'extend': the new part only fills squares the old one has
 * nothing in. -> { ref, replaced, added, kept } (points, standing and ground together).
 */
export function mergeRef(old, add, mode = 'correct') {
  const count = (r) => (r.stand.length + r.ground.length) / 3;
  if (!old || !count(old)) return { ref: { stand: add.stand, ground: add.ground, at: add.at }, replaced: 0, added: count(add), kept: 0 };
  const filt = (a, set, keepIn) => { const out = []; for (let i = 0; i + 2 < a.length; i += 3) if (set.has(cellOf(a[i], a[i + 1], FOOT_M)) === keepIn) out.push(a[i], a[i + 1], a[i + 2]); return Float32Array.from(out); };
  let o = old, a = add;
  if (mode === 'correct') { const seen = squares(add); o = { stand: filt(old.stand, seen, false), ground: filt(old.ground, seen, false) }; }
  else { const had = squares(old); a = { stand: filt(add.stand, had, false), ground: filt(add.ground, had, false) }; }
  const ref = { stand: join(a.stand, o.stand, MAX_STAND), ground: join(a.ground, o.ground, MAX_GROUND), at: add.at };
  return { ref, replaced: count(old) - count(o), added: count(a), kept: count(o) };
}

/* ------------------------------------------------- every walk counted (walkref.js, version 3) */
/* THE ACCUMULATION OF EVERY WALK (2026-11-25; the owner: "I don't want it to be a single walk, rather I want it to be
   the accumulation of every walk without the uncertain parts", and 2026-11-22: a walk "only overwrites existing
   reference shapes if there's a high degree of confidence that the new info is actually better"). mergeRef above let
   a walk placed by its corners take the place of everything in each square metre it saw: the walk of 2026-11-24 21:48
   took a reference of 36,434 standing points to 16,820. Here no point is replaced by one walk's word:
     - a new point within LAND_M of a kept one CONFIRMS it (the kept point's count goes up, once a walk); it is not
       added again;
     - a new point near none is ADDED, on its own walk's word (count 1);
     - when `looked` (the walk was placed by the shape itself, so where it looked is known in the shape's frame), a
       kept point in a cell of LOOK_M where the walk saw things at that height, but not near it, is MISSED once; a
       point missed twice and more often than it was confirmed is dropped (a thing moved or taken away);
     - over the limits, the points more walks vouch for are kept first.
   -> { ref: { stand, ground, standHits, groundHits, standMiss, groundMiss }, added, confirmed, dropped } */
export const LAND_M = 0.3, LOOK_M = 1;
export function mergeCounted(old, add, { looked = true } = {}) {
  const has = old && old.stand.length + old.ground.length > 0;
  const nS = (a) => a.length / 3;
  const ones = (n) => new Uint8Array(n).fill(1);
  if (!has) {
    const stand = join(add.stand, new Float32Array(0), MAX_STAND), ground = join(add.ground, new Float32Array(0), MAX_GROUND);
    return { ref: { stand, ground, standHits: ones(nS(stand)), groundHits: ones(nS(ground)), standMiss: new Uint8Array(nS(stand)), groundMiss: new Uint8Array(nS(ground)), at: add.at }, added: nS(stand) + nS(ground), confirmed: 0, dropped: 0 };
  }
  const key3 = (x, y, z, c) => `${Math.floor(x / c)},${Math.floor(y / c)},${Math.floor(z / c)}`;
  const one = (oldA, oldH, oldM, addA, max) => {
    const n = nS(oldA), hits = Uint8Array.from(oldH || ones(n)), miss = Uint8Array.from(oldM || new Uint8Array(n));
    const grid = new Map();
    for (let i = 0; i < n; i++) { const k = key3(oldA[i * 3], oldA[i * 3 + 1], oldA[i * 3 + 2], LAND_M); let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(i); }
    const near = (x, y, z) => {
      const cx = Math.floor(x / LAND_M), cy = Math.floor(y / LAND_M), cz = Math.floor(z / LAND_M);
      let best = -1, bd = LAND_M * LAND_M;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const l = grid.get(`${cx + a},${cy + b},${cz + c}`); if (!l) continue;
        for (const i of l) { const d = (oldA[i * 3] - x) ** 2 + (oldA[i * 3 + 1] - y) ** 2 + (oldA[i * 3 + 2] - z) ** 2; if (d < bd) { bd = d; best = i; } }
      }
      return best;
    };
    const touched = new Uint8Array(n), fresh = [], look = new Set();
    for (let i = 0; i + 2 < addA.length; i += 3) {
      const x = addA[i], y = addA[i + 1], z = addA[i + 2];
      look.add(key3(x, y, z, LOOK_M));
      const j = near(x, y, z);
      if (j >= 0) touched[j] = 1; else fresh.push(x, y, z);
    }
    let confirmed = 0, dropped = 0;
    const keep = [];
    for (let i = 0; i < n; i++) {
      if (touched[i]) { hits[i] = Math.min(255, hits[i] + 1); confirmed++; }
      else if (looked && look.has(key3(oldA[i * 3], oldA[i * 3 + 1], oldA[i * 3 + 2], LOOK_M))) miss[i] = Math.min(255, miss[i] + 1);
      if (miss[i] >= 2 && miss[i] > hits[i]) { dropped++; continue; }
      keep.push(i);
    }
    // the new points, one to a VOX cell
    const nf = join(Float32Array.from(fresh), new Float32Array(0), Infinity);
    // over the limit: the old points most vouched for first, then the new, each list thinned evenly
    keep.sort((a, b) => hits[b] - hits[a]);
    let idx = keep.map((i) => ({ i, h: hits[i] }));
    const nn = nS(nf);
    const total = idx.length + nn;
    let newTake = nn;
    if (total > max) {
      const strong = idx.filter((o) => o.h >= 2), weak = idx.filter((o) => o.h < 2);
      const room = Math.max(0, max - strong.length);
      const share = weak.length + nn ? room / (weak.length + nn) : 0;
      const thin = (arr, k) => (arr.length <= k ? arr : arr.filter((_, q) => q % Math.ceil(arr.length / Math.max(1, k)) === 0));
      idx = [...strong.slice(0, max), ...thin(weak, Math.floor(weak.length * share))];
      newTake = Math.floor(nn * share);
    }
    const step = newTake < nn ? Math.ceil(nn / Math.max(1, newTake)) : 1;
    const outA = [], outH = [], outM = [];
    for (const o of idx) { outA.push(oldA[o.i * 3], oldA[o.i * 3 + 1], oldA[o.i * 3 + 2]); outH.push(hits[o.i]); outM.push(miss[o.i]); }
    let added = 0;
    for (let q = 0; q < nn; q += step) { outA.push(nf[q * 3], nf[q * 3 + 1], nf[q * 3 + 2]); outH.push(1); outM.push(0); added++; }
    return { a: Float32Array.from(outA), h: Uint8Array.from(outH), m: Uint8Array.from(outM), added, confirmed, dropped };
  };
  const S = one(old.stand, old.standHits, old.standMiss, add.stand, MAX_STAND), G = one(old.ground, old.groundHits, old.groundMiss, add.ground, MAX_GROUND);
  return { ref: { stand: S.a, ground: G.a, standHits: S.h, groundHits: G.h, standMiss: S.m, groundMiss: G.m, at: add.at }, added: S.added + G.added, confirmed: S.confirmed + G.confirmed, dropped: S.dropped + G.dropped };
}
/** How many of the reference's points each count of walks vouches for: -> { stand: [n1, n2, n3+], ground: [...] } */
export function countsOf(ref) {
  const tally = (h, n) => { const t = [0, 0, 0]; for (let i = 0; i < n; i++) { const v = h ? h[i] : 1; t[Math.min(2, Math.max(1, v) - 1)]++; } return t; };
  return { stand: tally(ref.standHits, ref.stand.length / 3), ground: tally(ref.groundHits, ref.ground.length / 3) };
}

/* ------------------------------------------------- the shape, and where it is (walkref.js, version 2) */
/* The owner, 2026-11-16: "The shape of a lawn (the mesh) and the literal position of the lawn in the world are 2
   different things. The uncertainty lies in the intersection of those 2. So we should treat them as separate things,
   so error in one doesn't poison the other."
   A reference is the yard's SHAPE (points in a frame of their own) and P, the turn and shift that puts the shape on
   the map. A walk gives up to two separate things:
     F  the walk on the shape, from matching its points to the shape (walkref.js shapeFix): adds to the SHAPE only;
     C  the walk on the map, from its agreeing roof corners (goodPart): with F, one more reading of P = C o F^-1,
        and P is the weighted middle of every reading so far. The shape is not touched by it.
   A walk with corners but no match to the shape can only be added through P (shape = P^-1 o C): it fills what the
   shape lacked and corrects nothing, because it reached the shape through the very thing that is uncertain. */
const rot = (th, [x, y]) => { const c = Math.cos(th), s = Math.sin(th); return [c * x - s * y, s * x + c * y]; };
/** A after B: the turn and shift that does B, then A. */
// with the scale carried (2026-11-22: a walk matched to the shape is stretched by the phone's shortfall, walkref.js
// shapeFix, so a fit may now hold s other than 1): T(p) = s R(theta) p + t
export function compose(A, B) { const sa = A.s ?? 1, sb = B.s ?? 1, t = rot(A.theta, [B.tx * sa, B.ty * sa]); return { theta: A.theta + B.theta, tx: t[0] + A.tx, ty: t[1] + A.ty, s: sa * sb }; }
export function invert(T) { const k = T.s ?? 1, t = rot(-T.theta, [T.tx / k, T.ty / k]); return { theta: -T.theta, tx: -t[0], ty: -t[1], s: 1 / k }; }

/** The middle of the readings of P ([{ theta, tx, ty, w }]) about the shape's pivot ([x, y]): the turn's weighted
 *  mean, and the shift that puts the pivot at the weighted mean of where the readings put it. */
export function placementOf(seen, pivot = [0, 0]) {
  let sw = 0, sc = 0, ss = 0, px = 0, py = 0;
  for (const o of seen) { const w = o.w > 0 ? o.w : 1; sw += w; sc += w * Math.cos(o.theta); ss += w * Math.sin(o.theta); const q = place(o, pivot[0], pivot[1]); px += w * q[0]; py += w * q[1]; }
  if (!sw) return { theta: 0, tx: 0, ty: 0, s: 1 };
  const theta = Math.atan2(ss, sc), r = rot(theta, pivot);
  return { theta, tx: px / sw - r[0], ty: py / sw - r[1], s: 1 };
}

const moved = (pts, T) => pts.map((p) => { const q = place(T, p[0], p[1]); return [q[0], q[1], p[2]]; });
const flat = (pts, max) => { const a = []; const step = Math.max(1, Math.ceil(pts.length / max)); for (let i = 0; i < pts.length; i += step) a.push(pts[i][0], pts[i][1], pts[i][2]); return Float32Array.from(a); };
const middle = (ref) => { let x = 0, y = 0, n = 0; for (const a of [ref.stand, ref.ground]) for (let i = 0; i + 2 < a.length; i += 3) { x += a[i]; y += a[i + 1]; n++; } return n ? [x / n, y / n] : [0, 0]; };

/**
 * A walk's part added to the map's reference. old: decodeRef's, or null. part: { stand, ground } [[u, v, y]] in the
 * walk's frame. C: the walk on the map by its agreeing corners (goodPart's T), or null. F: the walk on the shape
 * (the shape match's Ts), or null. w: the weight of this walk's reading of P (its corners).
 * -> { ref, how, added, replaced, kept, movedM } or { ref: null, why }
 */
export function updateRef(old, part, { C = null, F = null, w = 1, at = Date.now(), phone = null } = {}) {
  // phone: how much longer the map's metres are than this phone's here (the corners' fit's scale); kept with the
  // reference so the next walk can be stretched by it before it is matched (walkref.js shapeFix). The first one stays.
  const phoneOf = () => (Number.isFinite(old?.phone) ? old.phone : Number.isFinite(phone) && phone > 0.9 && phone < 1.1 ? phone : null);
  const has = old && (old.stand.length + old.ground.length) > 0;
  if (!has) {
    if (!C) return { ref: null, why: 'the map has no reference yet, and this walk has no two roof corners that agree to make one' };
    // the first: the shape is the walk as its corners put it, and P is "as it is"
    const m0 = mergeCounted(null, { stand: flat(moved(part.stand, C), Infinity), ground: flat(moved(part.ground, C), Infinity), at });
    const ref = { ...m0.ref, at, P: { theta: 0, tx: 0, ty: 0 }, seen: [{ theta: 0, tx: 0, ty: 0, w, at }], walks: 1 };
    ref.pivot = middle(ref);
    ref.phone = phoneOf();
    return { ref, how: 'made', added: (ref.stand.length + ref.ground.length) / 3, replaced: 0, kept: 0, movedM: 0 };
  }
  const pivot = old.pivot || middle(old);
  // onto the shape: by the match when there is one (it corrects the shape where the walk saw); else through P
  const toShape = F || (C ? compose(invert(old.P), C) : null);
  if (!toShape) return { ref: null, why: 'this walk has neither a match to the saved shape nor two roof corners that agree' };
  const add = { stand: flat(moved(part.stand, toShape), Infinity), ground: flat(moved(part.ground, toShape), Infinity), at };
  /* COUNTED (2026-11-25): a walk on the shape confirms, adds, and marks what it looked at and did not see; a walk that
     reached the shape only through P (its corners) confirms and adds, and is no witness of absence. */
  const m = mergeCounted(old, add, { looked: !!F });
  m.replaced = m.dropped; m.kept = (m.ref.stand.length + m.ref.ground.length) / 3 - m.added;
  // where the shape is: one more reading when the walk has both its corners and its match
  const seen = [...(old.seen || [])];
  if (!seen.length) seen.push({ ...old.P, w: 1, at: old.at || 0 });   // a version 1 reference: its place as it was, one reading
  let P = old.P, movedM = 0;
  if (F && C) {
    seen.push({ ...compose(C, invert(F)), w, at });
    P = placementOf(seen.slice(-40), pivot);
    const a = place(old.P, pivot[0], pivot[1]), b = place(P, pivot[0], pivot[1]);
    movedM = Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  const ref = { ...m.ref, P: { theta: P.theta, tx: P.tx, ty: P.ty }, seen: seen.slice(-40).map((o) => ({ theta: o.theta, tx: o.tx, ty: o.ty, w: o.w, at: o.at })), pivot, walks: (old.walks || 1) + 1, phone: phoneOf() };
  return { ref, how: F && C ? 'shape and place' : F ? 'shape only' : 'filled in through its place', added: m.added, replaced: m.replaced, kept: m.kept, confirmed: m.confirmed, dropped: m.dropped, movedM };
}

/* A WALK PUT ON THE SHAPE A STRETCH AT A TIME (2026-11-25). The page's match places a walk WHOLE, rigidly, so a walk that
   slid (the 21:48 walk of 2026-11-24: its corners 6 in to 3 ft 11 in from their places under one fit) or jumped (the
   22:04 walk: 7 ft at 848 ft walked) went into the reference by its corners, through the reference's own uncertain
   place, filling gaps and confirming nothing. Here each WIN_M of walking (every STEP_M) is matched to the shape by
   itself, held near where the walk's corners put it (or the stretch before it did) and moved by the shapes alone
   within that; each point placed by the stretch nearest it in its walk. A stretch after a jump with no corner of its
   own is matched with nothing to hold it but the lead rule.
   -> { stand, ground: [[x, y, z]] in the shape's frame, windows: [...], readings: P readings, left } */
export const WIN_M = 30, STEP_M = 15, HELD_GATE = 0.12, HELD_STAND_GATE = 0.05;
/* `T0` (2026-11-25, run 605): a walk whose corners cannot be trusted (two pairs agree, which is wrong cannot be told) is
   held by its whole-walk match to the shape instead, every stretch within 1.5 m and 2 degrees of it, and its corners
   give no readings of where the shape is. */
export function placeOnShape(ref, pts, marks, jumps, { log = () => {}, T0 = null } = {}) {
  const P = ref.P || AS_IS, toShape = invert({ ...P, s: 1 });
  const J = [...jumps].sort((a, b) => a - b), segOf = (o) => { let k = 0; while (k < J.length && J[k] <= o) k++; return k; };
  const corners = (marks || []).filter((m) => m?.ar && m?.map && m.kind === 'ref' && Number.isFinite(m.odo));
  const total = Math.max(0, ...pts.stand.map((p) => p[3] || 0), ...pts.ground.map((p) => p[3] || 0));
  const wins = [];
  for (let c = STEP_M; c < total + STEP_M; c += STEP_M) {
    const k = segOf(Math.min(c, total));
    const lo = Math.max(c - WIN_M, k ? J[k - 1] : -Infinity), hi = Math.min(c + WIN_M, k < J.length ? J[k] : Infinity);
    const inW = (p) => (p[3] || 0) >= lo && (p[3] || 0) < hi;
    wins.push({ c: Math.min(c, total), k, part: { stand: pts.stand.filter(inW), ground: pts.ground.filter(inW) }, T: null });
  }
  let last = null;
  for (const w of wins) {
    const own = corners.filter((m) => segOf(m.odo) === w.k);
    const Cw = T0 ? null : fitAt(own, w.c);
    let prior = null, how;
    if (T0) { prior = { T: T0, searchM: 1.5, searchDeg: 5 }; how = 'the whole walk\'s match'; }
    else if (Cw) { prior = { T: compose(toShape, Cw), searchM: 1.0, searchDeg: 5 }; how = 'its corners'; }
    else if (last && last.k === w.k) { prior = { T: last.T, searchM: 1.0, searchDeg: 5 }; how = 'the stretch before'; }
    else how = 'nothing (after a jump, no corner)';
    if (prior) prior.T = { theta: prior.T.theta, tx: prior.T.tx, ty: prior.T.ty };
    /* HELD, THE TESTS ARE THE BOUND'S (run 604: held within a metre of its corners, 14 stretches of 19 were refused by
       the whole-walk gates, "only 18% land", "another place fits nearly as well"). A stretch sees much the reference
       never saw, so less of it lands; and inside a 1 m, 2 degree bound the rival places the lead rule guards against
       are not there. So held: turns a degree apart, within 2 degrees; a lower landed share; no lead asked. */
    const held = prior ? { prior: { ...prior, searchDeg: 2 }, step: 1, lead: 0, gate: HELD_GATE, standGate: HELD_STAND_GATE } : {};
    const f = shapeFix(ref, w.part, held);
    w.how = how; w.f = f;
    if (f.ok) { w.T = f.T; last = w; }
    // a corner marked in this stretch, under its fit: how far from its place (judged in the map's frame)
    const nearC = corners.filter((m) => Math.abs(m.odo - w.c) <= STEP_M && segOf(m.odo) === w.k);
    w.err = f.T ? nearC.map((m) => { const q = place({ ...P, s: 1 }, ...place(f.T, ...m.ar)); return Math.hypot(q[0] - m.map[0], q[1] - m.map[1]) * 39.37; }) : [];
    w.reading = f.ok && Cw && nearC.length ? compose(Cw, invert(f.T)) : null;
  }
  const ok = wins.filter((w) => w.T);
  const put = (list) => {
    const out = []; let left = 0;
    for (const p of list) {
      const k = segOf(p[3] || 0); let best = null, bd = Infinity;
      for (const w of ok) if (w.k === k) { const d = Math.abs(w.c - (p[3] || 0)); if (d < bd) { bd = d; best = w; } }
      if (!best || bd > WIN_M) { left++; continue; }
      const q = place(best.T, p[0], p[1]); out.push([q[0], q[1], p[2] + (best.f.tz || 0)]);
    }
    return { out, left };
  };
  const S = put(pts.stand), G = put(pts.ground);
  log(`    stretches of ${Math.round(WIN_M * 2 * 3.281)} ft every ${Math.round(STEP_M * 3.281)} ft: ${wins.length}; matched ${ok.length} (held by its corners ${ok.filter((w) => w.how === 'its corners').length}, by the whole walk's match ${ok.filter((w) => /whole/.test(w.how)).length}, by the stretch before ${ok.filter((w) => w.how === 'the stretch before').length}, by nothing ${ok.filter((w) => /^nothing/.test(w.how)).length}); not matched ${wins.length - ok.length}${wins.length - ok.length ? ` (${[...new Set(wins.filter((w) => !w.T).map((w) => (w.f.why || 'too little').replace(/\(.*\)/, '').trim()))].slice(0, 3).join('; ')})` : ''}.`);
  const errs = ok.flatMap((w) => w.err);
  if (errs.length) log(`    the walk's corners under the stretch they were marked in: ${errs.map((e) => `${e.toFixed(0)} in`).join(', ')}.`);
  log(`    points placed: ${S.out.length} standing, ${G.out.length} ground; left out ${S.left + G.left} (no matched stretch in their part of the walk).`);
  return { stand: S.out, ground: G.out, windows: wins, readings: ok.map((w) => w.reading).filter(Boolean), left: S.left + G.left };
}

/** A walk placed on the shape (placeOnShape's answer) added to the reference, counted; its readings of where the shape
 *  is moved into P. -> { ref, confirmed, added, dropped, movedM } */
export function addPlaced(old, placed, at = Date.now()) {
  const m = mergeCounted(old, { stand: Float32Array.from(placed.stand.flat()), ground: Float32Array.from(placed.ground.flat()), at }, { looked: true });
  const seen = [...(old.seen || [])];
  if (!seen.length) seen.push({ ...(old.P || AS_IS), w: 1, at: old.at || 0 });
  for (const r of placed.readings || []) seen.push({ theta: r.theta, tx: r.tx, ty: r.ty, w: 1, at });
  const pivot = old.pivot || middle(old);
  const P = placementOf(seen.slice(-40), pivot), a = place({ ...(old.P || AS_IS), s: 1 }, ...pivot), b = place(P, ...pivot);
  const ref = { ...m.ref, P: { theta: P.theta, tx: P.tx, ty: P.ty }, seen: seen.slice(-40).map((o) => ({ theta: o.theta, tx: o.tx, ty: o.ty, w: o.w, at: o.at })), pivot, walks: (old.walks || 1) + 1, phone: Number.isFinite(old.phone) ? old.phone : null };
  return { ref, confirmed: m.confirmed, added: m.added, dropped: m.dropped, movedM: Math.hypot(a[0] - b[0], a[1] - b[1]) };
}
