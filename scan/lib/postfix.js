/**
 * RECORD FIRST, FIX AFTERWARDS (core session, 2026-11-05; the owner: "First walk is recording only... The walk is
 * processed and fixed based on a certain percentage of lidar fixes... The post walk fix places the sprinkler heads...
 * That base mesh can serve as the backbone for future walks").
 *
 * A walk's twin (scan/lib/twin.js: every depth point with the moment and the ground the page took under it, the
 * camera's track) placed on the map all at once, with no hurry, on a GitHub runner (scan/tools/post-fix.mjs):
 *
 *   1. classify   each point as the page does (ground, standing, high) by its height over the ground the page took,
 *                 its range from the camera then, and two sightings of its cell for a standing point
 *   2. global     one placement for the whole walk: every wall, trunk and roof edge the walk saw, at once, against the
 *                 model (scan/lib/lidar.js register), from the references (or GPS, or the whole box)
 *   3. windows    60 m of walk at a time, every 20 m, each searched round the global placement: ARCore drifts slowly,
 *                 and a window finds where this stretch of the walk sits
 *   4. smooth     a window that disagrees with its neighbours is dropped; the rest are blended along the walk, so the
 *                 placement at any moment is the nearest windows' mixed by distance walked
 *
 * Pure: points and grids in, placements out. The page's live match (locate.js) is not used.
 */
import { register, MIN_LANDED } from './lidar.js';
import { apply } from './align.js';
import { fitAt, fitRigid } from './align.js';
import { BANDS, STAND_RANGE, GROUND_RANGE } from './locate.js';

/* 60 m of walk a window, every 20 m (scan/test/postfix.test.js: on a walk round a house with a fence and trunks, 30 m
   windows came out a median 0.55 m off, 60 m windows 0.35 m, one placement for the whole walk 0.53 m). A stretch that
   sees only one wall of a house is free by up to 0.6 m along it: each wall may stand from a foot outside to three
   feet inside the roof's edge at no cost (the owner's rule, lidar.js WALL_USUAL); a trunk or a fence pins it. */
export const WINDOW_M = 60, WINDOW_STEP_M = 20;
export const WINDOW_SEARCH_M = 2.5, WINDOW_SEARCH_DEG = 6;
export const NEIGHBOUR_M = 1.0, NEIGHBOUR_DEG = 3; // a window this far from the median of its neighbours is dropped
export const VOX_M = 0.2; // a standing point's cell, for counting sightings
/* NEVER WORSE THAN THE REFERENCES (2026-11-05, the first real run, on the owner's walk of 2026-11-04 22:02: the whole
   walk found no single placement, two windows were kept, and stretched over 344 m of walk they put the six check
   points a median 15 ft off, where the references alone had 4.2 ft). So, when the references are given: a window is
   kept only within REF_GATE_M and REF_GATE_DEG of them at its own stretch; a kept window stands for its own stretch
   (KNOT_REACH_M either side of its middle), and everywhere else the walk keeps the references' placement. */
export const REF_GATE_M = 1.5, REF_GATE_DEG = 5, KNOT_REACH_M = 30;

/** The camera's position at a moment, from the track (sorted by t). */
export function cameraAt(track, t) {
  if (!track.length) return null;
  let lo = 0, hi = track.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (track[m].t < t) lo = m + 1; else hi = m; }
  return track[lo].pos || null;
}

/**
 * The twin's records -> { stand: [[u, v, odo]], ground: [[u, v, y, odo]], high: [[u, v, odo]] } in the session's level
 * frame (u = x, v = -z), as the page classes them (locate.js addDepth): height over the ground the page took, the
 * range caps, and a standing cell seen at least twice.
 */
export function classify(recs, track = [], { standRange = STAND_RANGE } = {}) {
  const stand = [], ground = [], high = [], seen = new Map(), standAt = [];
  for (const r of recs) {
    if (!Number.isFinite(r.ground)) continue;
    const h = r.y - r.ground, cam = cameraAt(track, r.t);
    const range = cam ? Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z) : 0;
    if (Math.abs(h) < BANDS.groundTol) { if (range <= GROUND_RANGE) ground.push([r.x, -r.z, r.y, r.odo]); continue; }
    if (h > BANDS.standLow && h < BANDS.standHigh) {
      if (range > standRange) continue;
      const k = `${Math.floor(r.x / VOX_M)},${Math.floor(r.z / VOX_M)}`;
      seen.set(k, (seen.get(k) || 0) + 1);
      standAt.push([r.x, -r.z, r.odo, k]);
      continue;
    }
    if (h >= BANDS.standHigh && h < BANDS.highTop) high.push([r.x, -r.z, r.odo]);
  }
  for (const [u, v, odo, k] of standAt) if (seen.get(k) >= 2) stand.push([u, v, odo]);
  return { stand, ground, high };
}

const thin = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));
const inWindow = (pts, i, a, b) => pts.filter((p) => p[i] >= a && p[i] < b);
const angDiff = (a, b) => ((((a - b) * 180) / Math.PI + 540) % 360) - 180;

/**
 * Where the walk sat on the map. pts: classify's answer; G: the match's grids (lidar-load.js gridsFromModel);
 * prior: { T } (the references), { at, phone, radiusM } (GPS) or { at, phone, radiusM: big } (the whole box).
 * -> { global, windows: [{ odo0, odo1, centre, ok, T, hits, landed, why, kept }], placeAt(odo) -> T, knots }
 */
export function solveWalk(pts, G, prior, { s = 1, windowM = WINDOW_M, stepM = WINDOW_STEP_M, maxPts = 4000, refPlace = null } = {}) {
  const two = (a) => a.map((p) => [p[0], p[1]]), withY = (a) => a.map((p) => [p[0], p[1], p[2]]);
  const all = { stand: thin(pts.stand, maxPts), ground: thin(pts.ground, 1500), high: thin(pts.high, 1500) };
  const gOpts = prior?.T ? { searchM: prior.searchM ?? 6, searchDeg: prior.searchDeg ?? 25 } : {};
  const global = register(G, two(all.stand), withY(all.ground), prior, { s, high: two(all.high), minLanded: MIN_LANDED, ...gOpts });
  const base = global.ok ? global.T : prior?.T || null;
  const odos = [...pts.stand, ...pts.high].map((p) => p[p.length - 1]);
  const end = odos.length ? Math.max(...odos) : 0;
  const windows = [];
  if (base) {
    for (let a = 0; a < Math.max(end, 1); a += stepM) {
      const b = a + windowM;
      const st = inWindow(pts.stand, 2, a, b), hi = inWindow(pts.high, 2, a, b), gr = inWindow(pts.ground, 3, a, b);
      const w = { odo0: a, odo1: b, centre: a + windowM / 2, ok: false, kept: false, stand: st.length, high: hi.length };
      if (st.length + hi.length >= 30) {
        const f = register(G, two(thin(st, 1500)), withY(thin(gr, 600)), { T: base }, { s, high: two(thin(hi, 600)), searchM: WINDOW_SEARCH_M, searchDeg: WINDOW_SEARCH_DEG, minLanded: MIN_LANDED });
        Object.assign(w, { ok: !!f.ok, T: f.T || null, hits: f.hits ?? null, landed: f.landed ?? null, why: f.ok ? null : f.why });
        // where the window's stretch of the walk is, for comparing windows: the mean of its points in the session
        const mid = st.length ? st.reduce((m, p) => [m[0] + p[0] / st.length, m[1] + p[1] / st.length], [0, 0]) : null;
        w.mid = mid;
      } else w.why = `${st.length + hi.length} points`;
      windows.push(w);
    }
    // drop a window that disagrees with the median of its kept neighbours (two each side), where its stretch is
    const okW = windows.filter((w) => w.ok && w.mid);
    for (const w of okW) {
      const nb = okW.filter((x) => x !== w && Math.abs(x.centre - w.centre) <= 2 * stepM + 1e-9);
      if (!nb.length) { w.kept = okW.length === 1; continue; }
      const here = apply(w.T, w.mid), there = nb.map((x) => apply(x.T, w.mid));
      const med = (arr) => { const s2 = [...arr].sort((p, q) => p - q); return s2[s2.length >> 1]; };
      const me = [med(there.map((p) => p[0])), med(there.map((p) => p[1]))], mth = med(nb.map((x) => angDiff(x.T.theta, w.T.theta)));
      w.kept = Math.hypot(here[0] - me[0], here[1] - me[1]) <= NEIGHBOUR_M && Math.abs(mth) <= NEIGHBOUR_DEG;
      if (!w.kept) w.why = 'disagreed with its neighbours';
    }
    // the references as the bound, where they are given
    if (refPlace) for (const w of okW) {
      if (!w.kept) continue;
      const R = refPlace(w.centre); if (!R) continue;
      const a = apply(w.T, w.mid), b = apply(R, w.mid);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > REF_GATE_M || Math.abs(angDiff(w.T.theta, R.theta)) > REF_GATE_DEG) { w.kept = false; w.why = 'too far from the references'; }
    }
  }
  const knots = windows.filter((w) => w.kept).map((w) => ({ odo: w.centre, T: w.T }));
  const fallback = (odo) => (refPlace ? refPlace(odo) : null) || base;
  const near = (odo) => knots.some((k) => Math.abs(k.odo - odo) <= KNOT_REACH_M);
  const placeAt = (odo) => {
    if (!knots.length || (refPlace && !near(odo))) return fallback(odo);
    if (odo <= knots[0].odo) return knots[0].T;
    if (odo >= knots.at(-1).odo) return knots.at(-1).T;
    let i = 0; while (knots[i + 1].odo < odo) i++;
    // two kept windows far apart with the references between: the references there, not a blend across the gap
    if (refPlace && knots[i + 1].odo - knots[i].odo > 2 * KNOT_REACH_M && !near(odo)) return fallback(odo);
    const a = knots[i], b = knots[i + 1], t = (odo - a.odo) / (b.odo - a.odo || 1);
    const dth = (angDiff(b.T.theta, a.T.theta) * Math.PI) / 180;
    return { theta: a.T.theta + t * dth, tx: a.T.tx + t * (b.T.tx - a.T.tx), ty: a.T.ty + t * (b.T.ty - a.T.ty), s: a.T.s ?? 1 };
  };
  return { global: { ok: !!global.ok, T: global.T || null, hits: global.hits ?? null, landed: global.landed ?? null, tz: global.tz ?? null, why: global.ok ? null : global.why }, windows, knots, placeAt, base };
}

/** The references' prior for a walk: their fit over all their marks, searched as wide as the references are trusted. */
export function refsPrior(marks, odo = 0) {
  const refs = (marks || []).filter((m) => m.kind === 'ref');
  const T = fitAt(refs, odo, 1e9);
  return T ? { T, searchM: 6, searchDeg: 25, from: 'the references' } : null;
}

/**
 * A WALK WITHOUT REFERENCES, placed by its GPS trail (2026-11-05): each reading's place on the map against where the
 * session had the phone then, fitted as one turn and shift, each weighed by 1/accuracy^2. GPS is metres off, but its
 * errors are not all one way, and over a long walk the fit's heading comes out within a few degrees. Searched as
 * wide as the trail's own scatter allows. -> a prior for solveWalk, or null with too short or too straight a trail.
 */
export function gpsPrior(trail, { minSpanM = 25, minReadings = 10 } = {}) {
  const t = (trail || []).filter((g) => g?.at && g?.phone && Number.isFinite(g.acc));
  if (t.length < minReadings) return null;
  let span = 0;
  for (const a of t) for (const b of t) span = Math.max(span, Math.hypot(a.phone[0] - b.phone[0], a.phone[1] - b.phone[1]));
  if (span < minSpanM) return null;
  const T = fitRigid(t.map((g) => ({ ar: g.phone, map: g.at, w: 1 / Math.max(1, g.acc) ** 2 })));
  if (!T) return null;
  const res = t.map((g) => { const p = apply(T, g.phone); return Math.hypot(p[0] - g.at[0], p[1] - g.at[1]); }).sort((a, b) => a - b);
  const spread = res[res.length >> 1];
  const degFromSpan = Math.min(30, Math.max(6, (Math.atan2(2 * spread, span) * 180) / Math.PI * 2));
  return { T, searchM: Math.min(12, Math.max(4, 2 * spread)), searchDeg: degFromSpan, from: `the GPS trail (${t.length} readings over ${Math.round(span)} m, median ${spread.toFixed(1)} m off)` };
}

/**
 * THE CHECK MARKS OF A WALK, ONE PER POINT: a point marked twice counts by its LAST mark (the owner, 2026-11-08: "I
 * did hit one checkpoint wrong, then I selected the right ones and did it again"; that walk's wrong tap sat 60 ft off,
 * SCAN-H30). Every study reads the marks through this.
 */
export function checkMarks(marks) {
  const byId = new Map();
  for (const m of marks || []) if (m.kind === 'check' && m.ar && m.map) { byId.delete(m.id); byId.set(m.id, m); }
  return [...byId.values()];
}

/** How far a placement puts each check mark from its place on the map: [{ id, m }]. */
export function checkErrors(marks, placeAt) {
  return checkMarks(marks).map((m) => {
    const T = placeAt(m.odo); if (!T) return { id: m.id, m: null };
    const p = apply(T, m.ar);
    return { id: m.id, m: Math.hypot(p[0] - m.map[0], p[1] - m.map[1]) };
  });
}

/**
 * THE BASE MESH: every point of the walk on the map, one per VOXEL-m cell, with its class and how many times it was
 * seen. heightOffset: the lidar's ground minus the phone's (the match's tz), so heights are the map's. -> typed arrays
 * for lidar-model.js's container: { e, n, z (Float32, map metres; z absolute), cls (Uint8: 0 ground, 1 standing,
 * 2 high, 3 other), seen (Uint8) }.
 */
export function baseMesh(recs, placeAt, heightOffset = 0, { voxel = 0.1 } = {}) {
  const cells = new Map();
  for (const r of recs) {
    const T = placeAt(r.odo); if (!T) continue;
    const [e, n] = apply(T, [r.x, -r.z]), z = r.y + heightOffset;
    const h = Number.isFinite(r.ground) ? r.y - r.ground : NaN;
    const cls = Math.abs(h) < BANDS.groundTol ? 0 : h > BANDS.standLow && h < BANDS.standHigh ? 1 : h >= BANDS.standHigh && h < BANDS.highTop ? 2 : 3;
    const k = `${Math.floor(e / voxel)},${Math.floor(n / voxel)},${Math.floor(z / voxel)}`;
    const c = cells.get(k);
    if (c) { c.n++; c.e += e; c.nn += n; c.z += z; } else cells.set(k, { n: 1, e, nn: n, z, cls });
  }
  const N = cells.size, E = new Float32Array(N), Nn = new Float32Array(N), Z = new Float32Array(N), C = new Uint8Array(N), S = new Uint8Array(N);
  let i = 0;
  for (const c of cells.values()) { E[i] = c.e / c.n; Nn[i] = c.nn / c.n; Z[i] = c.z / c.n; C[i] = c.cls; S[i] = Math.min(255, c.n); i++; }
  return { e: E, n: Nn, z: Z, cls: C, seen: S };
}
