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
import { fitRigid, place, VOX } from './walkref.js';

export const AGREE_M = 0.45;       // 1.5 ft: how well the marks of a kept part agree with the map
export const MIN_APART_M = 3;      // the part's marks at least this far apart: nearer, they cannot turn the walk
export const FOOT_M = 1;           // the squares a new part's ground is counted in, for what it replaces
export const MAX_STAND = 60000, MAX_GROUND = 30000;   // walkref.js's own limits

const lastOfEach = (marks) => { const by = new Map(); for (const m of marks || []) if (m?.ar && m?.map && Number.isFinite(m.odo)) by.set(m.id, m); return [...by.values()]; };

/** How a group of marks agrees: the worst distance from its place after their own best fit (two: the difference of
 *  the distance between them as walked and on the map), and the fit. */
export function agreement(group) {
  const T = fitRigid(group.map((m) => m.ar), group.map((m) => m.map));
  let worst = 0;
  if (group.length === 2) worst = Math.abs(Math.hypot(group[0].ar[0] - group[1].ar[0], group[0].ar[1] - group[1].ar[1]) - Math.hypot(group[0].map[0] - group[1].map[0], group[0].map[1] - group[1].map[1]));
  else for (const m of group) { const p = place(T, m.ar[0], m.ar[1]); worst = Math.max(worst, Math.hypot(p[0] - m.map[0], p[1] - m.map[1])); }
  const apart = Math.max(...group.flatMap((a) => group.map((b) => Math.hypot(a.map[0] - b.map[0], a.map[1] - b.map[1]))));
  return { T, worst, apart };
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
    const a = agreement(g);
    if (a.worst > agree || a.apart < MIN_APART_M) continue;
    const last = g[g.length - 1].odo;
    if (!best || g.length > best.g.length || (g.length === best.g.length && (last > best.last + 1e-9 || (Math.abs(last - best.last) <= 1e-9 && a.worst < best.a.worst)))) best = { g, a, last };
  }
  if (!best) return { ok: false, n: use.length, roof, why: `no two of the ${use.length} marks agree with the map to ${(agree * 3.281).toFixed(1)} ft` };
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
