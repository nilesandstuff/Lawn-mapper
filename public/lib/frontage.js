/**
 * Property line out to the road, and the neighbouring parcels.
 *
 * THE OWNER'S IDEA (2026-09-27). A recorded parcel usually stops at the
 * right-of-way, several metres short of the kerb, while the lawn carries on
 * to it -- and dragging each front edge out by hand is the first chore of
 * every map. So: find the road, and move only the edges that are plainly the
 * frontage, the same way the edge slider does (each edge keeps its angle,
 * the side lines are extended along their own angles to meet it).
 *
 * WHAT COUNTS AS FRONTAGE. An edge moves only if all of these hold:
 *   - it is at least MIN_EDGE_M long (a lone corner near the road is not
 *     frontage: the shared-driveway case);
 *   - the nearest road lies OUTSIDE the lot, in front of the edge;
 *   - the road runs within MAX_ANGLE_DEG of parallel to it;
 *   - the gap from the edge to the road's estimated pavement edge is more
 *     than AT_ROAD_M (it is not already at the road) and at most MAX_GAP_M
 *     (so the house end of a flag lot, far back, stays where it is);
 *   - the strip it would add overlaps no neighbouring parcel (the lot behind
 *     another, a neighbour's front yard).
 * A run of consecutive frontage edges moves together, so a bent or curving
 * frontage and a corner lot's two roads are handled as one piece.
 *
 * WHERE IT LANDS. At the pavement edge as estimated from the road's class
 * (its centreline less a typical half-width), so "barely in the road" to
 * within a couple of metres; the width is not in the data.
 *
 * Pure: lng/lat in, lng/lat out. `clip` is polygon-clipping, passed in so
 * this runs in node. Tests in tools/frontage.test.js.
 */

import { makeFrame, openRing, signedArea } from './edges.js';

export const MAX_GAP_M = 6.1;       // 20 ft
export const AT_ROAD_M = 0.3;
export const MIN_EDGE_M = 3;
export const MAX_ANGLE_DEG = 30;

/** Typical half-width of the paved road by Mapbox Streets v8 road class, in metres. */
export const HALF_WIDTH_M = {
  motorway: 11, trunk: 9, primary: 7.5, secondary: 6.5, tertiary: 5, street: 4, street_limited: 3.5,
};
/** Road classes that can be a lot's frontage. Service roads, driveways, alleys, tracks and paths cannot. */
export const FRONTAGE_CLASSES = new Set(Object.keys(HALF_WIDTH_M));

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

function nearestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, mul(ab, t));
}

/** Where two lines (point + direction) cross, or null when near parallel. */
function intersect(p, u, q, v) {
  const d = cross(u, v);
  if (Math.abs(d) < 0.05) return null;
  const t = cross(sub(q, p), v) / d;
  return add(p, mul(u, t));
}

function polyAreaM2(ringLL, frame) {
  return Math.abs(signedArea(openRing(ringLL).map(frame.toXY)));
}

function geomAreaM2(multi, frame) {
  let a = 0;
  for (const poly of multi || []) {
    poly.forEach((ring, i) => { a += (i ? -1 : 1) * polyAreaM2(ring, frame); });
  }
  return a;
}

/**
 * roads: [{ coords: [[lng, lat], ...], cls }] -- centrelines, any number of
 * pieces (vector tiles cut them at tile edges; that is fine).
 * neighbours: [ring] -- other parcels' outer rings.
 *
 * Returns { ring, moved: [edge indices], chains, skipped: [{edges, reason}] }.
 * `ring` is the input unchanged when nothing qualifies.
 */
export function extendToRoads(ringLL, roads, {
  neighbours = [], clip = null, maxGapM = MAX_GAP_M, minEdgeM = MIN_EDGE_M, maxAngleDeg = MAX_ANGLE_DEG,
} = {}) {
  const open = openRing(ringLL);
  const n = open.length;
  const none = { ring: ringLL, moved: [], chains: 0, skipped: [] };
  if (n < 3) return none;

  const frame = makeFrame(open[0]);
  const P = open.map(frame.toXY);
  const ccw = signedArea(P) > 0;

  const segs = [];
  for (const r of roads || []) {
    if (r.cls && !FRONTAGE_CLASSES.has(r.cls)) continue;
    const hw = HALF_WIDTH_M[r.cls] ?? HALF_WIDTH_M.street;
    const pts = (r.coords || []).map(frame.toXY);
    for (let i = 1; i < pts.length; i++) segs.push({ a: pts[i - 1], b: pts[i], hw });
  }
  if (!segs.length) return none;

  const cosAngle = Math.cos((maxAngleDeg * Math.PI) / 180);
  const cosFront = Math.cos((40 * Math.PI) / 180);

  // Per edge: how far to move it outward, or null if it is not frontage.
  const shift = new Array(n).fill(null);
  const normals = [];
  for (let i = 0; i < n; i++) {
    const a = P[i];
    const b = P[(i + 1) % n];
    const d = sub(b, a);
    const L = len(d);
    const u = unit(d);
    // Outward: right of travel on a counter-clockwise ring, left on a clockwise one.
    const out = ccw ? [u[1], -u[0]] : [-u[1], u[0]];
    normals.push(out);
    if (L < minEdgeM) continue;

    const gaps = [];
    for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const s = add(a, mul(d, t));
      let best = null;
      for (const g of segs) {
        const q = nearestOnSegment(s, g.a, g.b);
        const dist = len(sub(q, s));
        if (!best || dist < best.dist) best = { q, dist, g };
      }
      if (!best || best.dist < 1e-6) continue;
      const toward = unit(sub(best.q, s));
      const segDir = unit(sub(best.g.b, best.g.a));
      if (dot(toward, out) < cosFront) continue;           // not in front of this edge
      if (Math.abs(dot(segDir, u)) < cosAngle) continue;   // not running alongside it
      gaps.push(dot(sub(best.q, s), out) - best.g.hw);
    }
    if (gaps.length < 3) continue;
    gaps.sort((x, y) => x - y);
    const gap = gaps[Math.floor(gaps.length / 2)];
    if (gap > AT_ROAD_M && gap <= maxGapM) shift[i] = gap;
  }

  // Runs of consecutive frontage edges.
  const chains = [];
  if (shift.every((s) => s !== null)) return { ...none, skipped: [{ edges: [...shift.keys()], reason: 'every edge' }] };
  let startAt = shift.findIndex((s) => s === null);
  for (let k = 1; k <= n; k++) {
    const i = (startAt + k) % n;
    if (shift[i] === null) continue;
    const prev = (i - 1 + n) % n;
    if (shift[prev] !== null && chains.length) chains[chains.length - 1].push(i);
    else chains.push([i]);
  }

  const lineOf = (i, moved) => {
    const a = P[i];
    const u = unit(sub(P[(i + 1) % n], a));
    return { p: moved ? add(a, mul(normals[i], shift[i])) : a, u };
  };

  // New position of each vertex a chain moves; null means the chain is unsafe.
  const chainVerts = (chain) => {
    const out = new Map();
    const first = chain[0];
    const last = chain[chain.length - 1];
    // The vertex at the start of the chain: moved front line meets the unmoved side line before it.
    const sideBefore = lineOf((first - 1 + n) % n, false);
    const L0 = lineOf(first, true);
    out.set(first, intersect(sideBefore.p, sideBefore.u, L0.p, L0.u) || add(P[first], mul(normals[first], shift[first])));
    // Between two moved edges.
    for (let k = 0; k < chain.length - 1; k++) {
      const i = chain[k];
      const j = chain[k + 1];
      const Li = lineOf(i, true);
      const Lj = lineOf(j, true);
      out.set(j, intersect(Li.p, Li.u, Lj.p, Lj.u)
        || add(P[j], mul(add(mul(normals[i], shift[i]), mul(normals[j], shift[j])), 0.5)));
    }
    // The vertex at the end of the chain: moved front line meets the unmoved side line after it.
    const endV = (last + 1) % n;
    const sideAfter = lineOf(endV, false);
    const Ln = lineOf(last, true);
    out.set(endV, intersect(Ln.p, Ln.u, sideAfter.p, sideAfter.u) || add(P[endV], mul(normals[last], shift[last])));
    // No corner may travel absurdly far (a side line nearly parallel to the road).
    const cap = Math.max(...chain.map((i) => shift[i])) * 3 + 3;
    for (const [v, q] of out) if (len(sub(q, P[v])) > cap) return null;
    return out;
  };

  const toRing = (verts) => {
    const pts = P.map((p, i) => verts.get(i) || p).map(frame.toLngLat);
    return [...pts, pts[0]];
  };

  const baseArea = polyAreaM2(ringLL, frame);
  const accepted = new Map();
  const moved = [];
  const skipped = [];
  for (const chain of chains) {
    const verts = chainVerts(chain);
    if (!verts) { skipped.push({ edges: chain, reason: 'a side line runs almost along the road' }); continue; }
    const trial = toRing(verts);
    if (clip) {
      let addedGeom;
      try {
        // Still one simple polygon, and bigger (it only ever adds ground).
        const self = clip.union([trial]);
        const trialArea = geomAreaM2(self, frame);
        if (self.length !== 1 || trialArea < baseArea) {
          skipped.push({ edges: chain, reason: 'the outline would fold' });
          continue;
        }
        addedGeom = clip.difference([trial], [ringLL]);
      } catch {
        skipped.push({ edges: chain, reason: 'geometry' });
        continue;
      }
      const addedArea = geomAreaM2(addedGeom, frame);
      const clash = neighbours.some((nb) => {
        try {
          const over = geomAreaM2(clip.intersection(addedGeom, [nb]), frame);
          return over > Math.max(1, 0.05 * addedArea);
        } catch { return false; }
      });
      if (clash) { skipped.push({ edges: chain, reason: 'another parcel is in the way' }); continue; }
    }
    for (const [v, q] of verts) accepted.set(v, q);
    moved.push(...chain);
  }
  if (!moved.length) return { ...none, skipped };
  return { ring: toRing(accepted), moved, chains: chains.length - skipped.length, skipped };
}

/**
 * Where to put a neighbour's "merge this parcel" button: inside the
 * neighbour, about `insetM` from the shared boundary, opposite the middle of
 * the stretch they share. Null when the two do not touch (within touchM).
 */
export function mergeButtonPoint(parcelLL, neighbourLL, { insetM = 6.1, touchM = 2 } = {}) {
  const A = openRing(parcelLL);
  const B = openRing(neighbourLL);
  if (A.length < 3 || B.length < 3) return null;
  const frame = makeFrame(A[0]);
  const pa = A.map(frame.toXY);
  const pb = B.map(frame.toXY);
  const nearParcel = (p) => {
    let best = Infinity;
    for (let i = 0; i < pa.length; i++) {
      best = Math.min(best, len(sub(nearestOnSegment(p, pa[i], pa[(i + 1) % pa.length]), p)));
    }
    return best;
  };
  // The neighbour's boundary, sampled every metre; keep the samples on the shared stretch.
  const shared = [];
  for (let i = 0; i < pb.length; i++) {
    const a = pb[i];
    const b = pb[(i + 1) % pb.length];
    const steps = Math.max(1, Math.ceil(len(sub(b, a))));
    for (let k = 0; k < steps; k++) {
      const s = add(a, mul(sub(b, a), k / steps));
      if (nearParcel(s) <= touchM) shared.push({ s, edge: i });
    }
  }
  if (!shared.length) return null;
  const mid = shared[Math.floor(shared.length / 2)];
  const a = pb[mid.edge];
  const u = unit(sub(pb[(mid.edge + 1) % pb.length], a));
  // Into the neighbour: its inward normal.
  const inward = signedArea(pb) > 0 ? [-u[1], u[0]] : [u[1], -u[0]];
  const inside = (p) => {
    let c = false;
    for (let i = 0, j = pb.length - 1; i < pb.length; j = i++) {
      const [xi, yi] = pb[i];
      const [xj, yj] = pb[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (const d of [insetM, insetM * 0.6, insetM * 0.3, 1]) {
    const p = add(mid.s, mul(inward, d));
    if (inside(p)) return frame.toLngLat(p);
  }
  return null;
}

/** Put the corners of ring `r` that lie within snapM of ring `onto`'s line exactly on that line. */
function snapOnto(r, onto, frame, snapM) {
  const po = openRing(onto).map(frame.toXY);
  const out = openRing(r).map((ll) => {
    const p = frame.toXY(ll);
    let best = null;
    for (let i = 0; i < po.length; i++) {
      const q = nearestOnSegment(p, po[i], po[(i + 1) % po.length]);
      const d = len(sub(q, p));
      if (!best || d < best.d) best = { q, d };
    }
    return best && best.d <= snapM ? frame.toLngLat(best.q) : ll;
  });
  return [...out, out[0]];
}

/**
 * The two parcels as one outline, or null if they do not join into one piece.
 *
 * Two county parcels share a line, but not always to the last digit, and a
 * gap between them comes out of a union as two pieces. The button is offered
 * to any parcel within 2 m (mergeButtonPoint's touchM), so the merge must
 * close any gap that size or the button does nothing -- which is what the
 * owner found (2026-09-27). So each parcel's corners within snapM of the
 * other's line are put ON it, both ways, before the union.
 */
export function mergeRings(clip, aLL, bLL, { snapM = 2.5 } = {}) {
  const frame = makeFrame(openRing(aLL)[0]);
  const b = snapOnto(bLL, aLL, frame, snapM);
  const a = snapOnto(aLL, b, frame, snapM);
  try {
    const out = clip.union([a], [b]);
    if (out.length !== 1) return null;
    return out[0][0];
  } catch {
    return null;
  }
}

/**
 * Where a w x h button (screen pixels) can sit ENTIRELY inside a polygon
 * (screen pixels), as near `pref` as possible. The owner's rule: the button
 * shows whole inside the parcel it merges, never overhanging, or not at all.
 *
 * A rectangle is inside a simple polygon when its four corners are inside and
 * no corner of the polygon is inside it (an edge cannot cross it otherwise
 * without cutting off a corner). Candidates: `pref`, then rings around it out
 * to `reach` pixels. Returns the centre, or null.
 */
export function placeInside(polyPx, pref, w, h, { pad = 3, reach = 600, step = 6 } = {}) {
  const P = openRing(polyPx);
  if (P.length < 3) return null;
  const inside = ([x, y]) => {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, yi] = P[i];
      const [xj, yj] = P[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const hw = w / 2 + pad;
  const hh = h / 2 + pad;
  const fits = ([cx, cy]) => {
    const x0 = cx - hw; const x1 = cx + hw; const y0 = cy - hh; const y1 = cy + hh;
    if (![[x0, y0], [x1, y0], [x1, y1], [x0, y1]].every(inside)) return false;
    return !P.some(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1);
  };
  if (fits(pref)) return pref;
  for (let r = step; r <= reach; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / step));
    for (let k = 0; k < n; k++) {
      const t = (2 * Math.PI * k) / n;
      const c = [pref[0] + r * Math.cos(t), pref[1] + r * Math.sin(t)];
      if (fits(c)) return c;
    }
  }
  return null;
}
