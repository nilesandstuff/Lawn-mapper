/**
 * STRAIGHT EDGES AND CORNERS TO PLACE POINTS ON, FROM THE LASER'S OWN RETURNS (core session, 2026-11-10;
 * docs/SCAN-PLAN.md section 21). The owner, after the first lidar picture: "We do need that... The blurry edge is just
 * too imprecise for human eyes to decide where the edge is", and of raised things as marks: at home the brick patio
 * does not show, at work the drives are dirt, so the marks are a deck's corners, a hot tub, a ~6 ft stone wall's
 * corner, tree stumps.
 *
 * A raised thing with upright sides (a deck, a wall, a hot tub, a shed) is, from above, exactly as wide as its top:
 * the laser's outermost returns are its edge. The trouble with the picture was drawing each sparse return as a block.
 * So here, per object:
 *   1. its returns (0.3 m or more over the ground, not a tree's column) on 0.25 m cells, closed over the gaps between
 *      returns by about one return spacing and taken back by the same, holes filled;
 *   2. split where its height jumps by a metre or more (a deck's upper level is its own object);
 *   3. its outline straightened (outline.js straighten: lines fitted through the staircase, near-square corners
 *      squared to the object's main direction) and pushed out by half a return spacing less half a cell, where on
 *      average the true edge lies beyond the outermost return;
 *   4. its corners (turns of 30 degrees or more) as places a point snaps to; a small round thing (under 4 m2) by its
 *      middle instead.
 * In AR the corner is aimed at where it is, at any height: the fit uses where a mark is across the ground, not how
 * high.
 *
 * pts as for look.js lidarPicture ({ n, e(i), nn(i), hag(i), bright(i), kind(i): 1 building, 2 tree, 3 other }).
 * Returns { objects: [{ id, kind: 'building' | 'object', ring: [[e, n]], top, corners: [[e, n]], middle, area }],
 *           corners: [{ at: [e, n], of: id, kind: 'corner' | 'middle' }], spacing }
 */
import { ringsOfMask, patchesOf, areaOf } from './outline.js';

const CELL = 0.25;
/* A corner is "sure" when the edges through it were each set in a gap of returns no wider than twice this: the true
   corner is then within SURE_M of it (about 1 ft). A wall's end, where the laser's last hit on its top may be a metre
   or more short of the end, is often not. */
export const SURE_M = 0.3;


const turn = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  const d = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]));
  return (d * 180) / Math.PI;
};


/**
 * The turn (radians, 0..pi/2) of a thing's own grid, from its EDGE returns (those with an outside return near): turned
 * so, its edges pile up in few bins across and along. A stray appendage moves a bounding box; it barely moves this.
 */
function edgeTurn(inside, outside, reach) {
  const B = reach, hash = new Map(), key = (x, y) => `${x},${y}`;
  outside.forEach((p) => { const k = key(Math.floor(p.e / B), Math.floor(p.n / B)); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(p); });
  const r2 = (0.75 * reach) ** 2;
  const edge = inside.filter((p) => { const bx = Math.floor(p.e / B), by = Math.floor(p.n / B); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const q of hash.get(key(bx + dx, by + dy)) || []) if ((q.e - p.e) ** 2 + (q.n - p.n) ** 2 <= r2) return true; return false; });
  if (edge.length < 8) return mainTurn(inside);
  let best = 0, score = -1;
  for (let a = 0; a < 90; a += 0.5) {
    const t = (a * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t), hu = new Map(), hv = new Map();
    for (const p of edge) { const u = Math.round((c * p.e + sn * p.n) / 0.25), v = Math.round((-sn * p.e + c * p.n) / 0.25); hu.set(u, (hu.get(u) || 0) + 1); hv.set(v, (hv.get(v) || 0) + 1); }
    let sc = 0; for (const x of hu.values()) sc += x * x; for (const x of hv.values()) sc += x * x;
    if (sc > score) { score = sc; best = t; }
  }
  return best;
}

/** The turn (radians, 0..pi/2) that puts a cloud of points in its smallest box: a deck's or a wall's own grid. */
function mainTurn(ps) {
  let best = 0, area = Infinity;
  for (let a = 0; a < 90; a += 0.5) {
    const t = (a * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ps) { const u = c * p.e + s * p.n, v = -s * p.e + c * p.n; if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; }
    const A = (u1 - u0) * (v1 - v0);
    if (A < area) { area = A; best = t; }
  }
  return best;
}

/** A staircase ring squared off: steps shorter than minJog removed, the two sides they joined set at their
 *  length-weighted mean. ring: [[u, v]] with only right angles. Returns sides [{ axis: 'u' | 'v', at, from, to }]. */
function squareOff(ring, minJog) {
  // the ring as sides: each a run along u (constant v) or along v (constant u)
  let sides = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const alongU = Math.abs(a[1] - b[1]) < 1e-9;
    const s = alongU ? { axis: 'v', at: a[1], from: a[0], to: b[0] } : { axis: 'u', at: a[0], from: a[1], to: b[1] };
    const last = sides[sides.length - 1];
    if (last && last.axis === s.axis) last.to = s.to; else sides.push(s);
  }
  if (sides.length > 1 && sides[0].axis === sides[sides.length - 1].axis) { sides[0].from = sides[sides.length - 1].from; sides.pop(); }
  const len = (s) => Math.abs(s.to - s.from);
  for (let guard = 0; guard < 400 && sides.length > 4; guard++) {
    // a STEP is a short side between two that run on the same way; between two that run back (a wall's end, a U-turn)
    // a short side is the thing's own end and stays
    let k = -1, m = minJog;
    const n0 = sides.length, dir = (x) => Math.sign(x.to - x.from);
    sides.forEach((s, i) => { if (len(s) < m && dir(sides[(i + n0 - 1) % n0]) === dir(sides[(i + 1) % n0])) { m = len(s); k = i; } });
    if (k < 0) break;
    const n = sides.length, A = sides[(k + n - 1) % n], B = sides[(k + 1) % n];
    const w = len(A) + len(B) || 1, at = (A.at * len(A) + B.at * len(B)) / w;
    const merged = { axis: A.axis, at, from: A.from, to: B.to };
    const keep = sides.filter((_, i) => i !== k && i !== (k + n - 1) % n && i !== (k + 1) % n);
    const pos = Math.min((k + n - 1) % n, k, (k + 1) % n === 0 ? n : (k + 1) % n);
    // put the merged side where the three were, in order
    const out = [];
    for (let i = 0; i < n; i++) { if (i === (k + n - 1) % n) out.push(merged); else if (i !== k && i !== (k + 1) % n) out.push(sides[i]); }
    sides = out.length >= 4 ? out : sides;
    if (out.length < 4) break;
    void keep; void pos;
  }
  return sides;
}

/**
 * Each side set where the returns say: among the returns along it (not near its ends) and within reach of it, the
 * place that best parts this thing's returns from the others, halfway across the gap.
 */
function refineSide(s, inside, outside, reach, noise = 0.05) {
  // the returns along the side, kept clear of its two ends; a short side (a wall's end) keeps its whole length and a
  // little either side, or it would have none
  const L = Math.abs(s.to - s.from), trim = L >= 1.5 ? 0.25 : 0;
  const lo = Math.min(s.from, s.to) + trim, hi = Math.max(s.from, s.to) - trim;
  // a narrow end sees few returns beyond it: look twice as far, and take even one
  const short = L < 1.5, minOut = short ? 1 : 3;
  if (short) reach *= 2;
  const along = s.axis === 'v' ? 0 : 1, across = 1 - along;
  const near = [];
  for (const p of inside) if (p[along] > lo && p[along] < hi && Math.abs(p[across] - s.at) < reach) near.push([p[across], 1]);
  for (const p of outside) if (p[along] > lo && p[along] < hi && Math.abs(p[across] - s.at) < reach) near.push([p[across], 0]);
  // which way is out, from the outline's own winding (its inside on the right as it runs: outline.js ringsOfMask): a
  // side along u running +u has its outside at +v; along v running +v, at -u. Only the ground on that side counts, so
  // a thin wall's far side does not pull its near side across.
  const fwd = s.to > s.from, outUp = s.axis === 'v' ? fwd : !fwd;
  const ins = near.filter((x) => x[1]);
  if (ins.length < 3) return { at: s.at, gap: Infinity };
  const mIn = ins.reduce((t, x) => t + x[0], 0) / ins.length;
  for (let j = near.length - 1; j >= 0; j--) if (!near[j][1] && (outUp ? near[j][0] < mIn : near[j][0] > mIn)) near.splice(j, 1);
  // no ground beyond it in reach: the side stands just past this thing's outermost return there, and is not sure
  if (near.filter((x) => !x[1]).length < minOut) {
    const xs = ins.map((x) => x[0]);
    return { at: outUp ? Math.max(...xs) + 0.1 : Math.min(...xs) - 0.1, gap: Infinity };
  }
  near.sort((a, b) => a[0] - b[0]);
  let bestErr = Infinity, bestAt = s.at, bestGap = Infinity;
  for (let i = 0; i <= near.length; i++) {
    // a cut between near[i-1] and near[i]: inside below it when the outside lies above
    let err = 0;
    for (let j = 0; j < near.length; j++) { const below = j < i; err += (outUp ? below !== !!near[j][1] : below === !!near[j][1]) ? 1 : 0; }
    const at = i === 0 ? near[0][0] - 0.1 : i === near.length ? near[near.length - 1][0] + 0.1 : (near[i - 1][0] + near[i][0]) / 2;
    const gap = i === 0 || i === near.length ? Infinity : near[i][0] - near[i - 1][0];
    if (err < bestErr || (err === bestErr && Math.abs(at - s.at) < Math.abs(bestAt - s.at))) { bestErr = err; bestAt = at; bestGap = gap; }
  }
  // the gap the side was set in: the true edge is somewhere in it, so half of it is how sure the side is; a side with
  // returns on the wrong side of it (brightness that does not part cleanly) is not sure however small the gap
  return { at: bestAt, gap: bestErr > noise * near.length ? Infinity : bestGap, err: bestErr / Math.max(1, near.length) };
}

/** One thing's outline, square to its own grid, each side set by the returns, and its corners. */
function squareOutline(mask, box, W, H, cell, inside, outside, { minJog, reach, loose = false, edgeIn = null, edgeOut = null }) {
  if (inside.length < 6) return null;
  const t = loose ? edgeTurn(inside, outside, reach) : mainTurn(inside), c = Math.cos(t), sn = Math.sin(t);
  const rot = (p) => [c * p.e + sn * p.n, -sn * p.e + c * p.n], back = ([u, v]) => [c * u - sn * v, sn * u + c * v];
  // the thing's cells, turned onto its own grid
  const cellsUV = [];
  for (let k = 0; k < W * H; k++) if (mask[k]) cellsUV.push(rot({ e: box[0] + ((k % W) + 0.5) * cell, n: box[3] - (((k / W) | 0) + 0.5) * cell }));
  let u0 = Infinity, v1 = -Infinity, u1 = -Infinity, v0 = Infinity;
  for (const [u, v] of cellsUV) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  u0 -= cell; v1 += cell; u1 += cell; v0 -= cell;
  const w = Math.ceil((u1 - u0) / cell) + 1, h = Math.ceil((v1 - v0) / cell) + 1, m = new Uint8Array(w * h);
  for (const [u, v] of cellsUV) { const x = Math.floor((u - u0) / cell), y = Math.floor((v1 - v) / cell); if (x >= 0 && y >= 0 && x < w && y < h) m[y * w + x] = 1; }
  const rings = ringsOfMask(m, w, h).map((r) => r.map(([x, y]) => [u0 + x * cell, v1 - y * cell])).filter((r) => areaOf(r) < 0);
  if (!rings.length) return null;
  rings.sort((a, b) => areaOf(a) - areaOf(b));
  const sides = squareOff(rings[0], minJog);
  if (sides.length < 4) return null;
  // the sides are set by edgeIn/edgeOut when given (paving: the returns' own brightness, not the smoothed vote that
  // found the slab, which leans outward at a noisy edge)
  const inUV = (edgeIn || inside).map((p) => rot(p)), outUV = (edgeOut || outside).map((p) => rot(p));
  // twice: the second time each side runs between its neighbours as the first pass set them, so a wall's end is looked
  // for across the wall's real width, not the rough outline's
  for (let pass = 0; pass < 2; pass++) {
    if (pass) sides.forEach((s, i) => { s.from = sides[(i + sides.length - 1) % sides.length].at; s.to = sides[(i + 1) % sides.length].at; });
    for (const s of sides) { const r = refineSide(s, inUV, outUV, reach, loose ? 0.2 : 0.05); s.at = r.at; s.gap = r.gap; s.err = r.err ?? 0; }
  }
  // corners: where each side meets the next
  const ring = sides.map((s, i) => { const nx = sides[(i + 1) % sides.length]; return s.axis === 'v' ? back([nx.at, s.at]) : back([s.at, nx.at]); });
  // square enough to mark by its corners when the outline holds the thing's returns and keeps the ground's out
  const inPoly = (x, y) => { let c2 = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c2 = !c2; } return c2; };
  const held = inside.filter((p) => inPoly(p.e, p.n)).length / inside.length;
  const strays = outside.filter((p) => inPoly(p.e, p.n)).length / inside.length;
  // a corner is as sure as the less sure of its two sides: half the gap it was set in (Infinity when not set)
  // a paving corner is never "sure": brightness parts paving from grass with returns on the wrong side of every edge
  // (2026-11-10, a synthetic drive: edges 0.2-0.6 m off), so it is offered as less sure, for the eye to judge
  const sure = sides.map((s, i) => (loose ? Infinity : Math.max(s.gap, sides[(i + 1) % sides.length].gap) / 2));
  // a slab of paving is believed only when most of its sides were set by returns on both sides of them
  const pinned = sides.filter((s) => Number.isFinite(s.gap)).length / sides.length;
  return { ring, sure, square: loose ? held >= 0.85 && strays <= 0.15 && pinned >= 0.6 && sides.length <= 12 : held >= 0.9 && strays <= 0.1 };
}

/** Grown (v = 1) or taken back (v = 0) by a disc of rad cells. */
function morph(m, W, H, rad, v) {
  const o = new Uint8Array(W * H), offs = [];
  for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) if (dr * dr + dc * dc <= rad * rad) offs.push([dr, dc]);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let hit = v ? 0 : 1;
    for (const [dr, dc] of offs) {
      const rr = r + dr, cc = c + dc, x = rr < 0 || cc < 0 || rr >= H || cc >= W ? 0 : m[rr * W + cc];
      if (v ? x : !x) { hit = v; break; }
    }
    o[r * W + c] = hit;
  }
  return o;
}

/** Holes (patches of empty cells not reaching the edge) under maxCells filled. */
function fillHoles(m, W, H, maxCells) {
  const empty = Uint8Array.from(m, (x) => (x ? 0 : 1));
  for (const p of patchesOf(empty, W, H)) {
    if (p.length > maxCells) continue;
    if (p.some((k) => { const r = (k / W) | 0, c = k % W; return r === 0 || c === 0 || r === H - 1 || c === W - 1; })) continue;
    for (const k of p) m[k] = 1;
  }
  return m;
}

/** Groups of returns joined when within link of each other (and, given dh, within dh in height), or within 1.7 link
 *  at the same height (0.3 m): a wall's top is sparse along its length but keeps its height. Union-find. */
function linked(ps, link, dh = Infinity) {
  const parent = ps.map((_, i) => i), find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const far = 1.7 * link, B = far, hash = new Map(), key = (x, y) => `${x},${y}`;
  ps.forEach((p, i) => { const k = key(Math.floor(p.e / B), Math.floor(p.n / B)); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(i); });
  ps.forEach((p, i) => {
    const bx = Math.floor(p.e / B), by = Math.floor(p.n / B);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of hash.get(key(bx + dx, by + dy)) || []) {
      if (j <= i) continue;
      const q = ps[j];
      const d2 = (p.e - q.e) ** 2 + (p.n - q.n) ** 2, dz = Math.abs(p.h - q.h);
      if ((d2 <= link * link && dz <= dh) || (d2 <= far * far && dz <= Math.min(0.3, dh))) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
  });
  const groups = new Map();
  ps.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  return [...groups.values()];
}

export function lidarMarks(box, pts, { cell = CELL } = {}) {
  const W = Math.max(1, Math.ceil((box[2] - box[0]) / cell)), H = Math.max(1, Math.ceil((box[3] - box[1]) / cell)), N = W * H;
  // every return in the box, raised (not a tree's) or not; a tree's own returns are left out altogether
  const P = [];
  for (let i = 0; i < pts.n; i++) {
    const e = pts.e(i), n = pts.nn(i);
    if (e < box[0] || e >= box[2] || n <= box[1] || n > box[3]) continue;
    const h = pts.hag(i), kind = pts.kind(i);
    if (Number.isNaN(h)) continue;
    if (h >= 0.3 && kind === 2) continue; // trees are not marks (SCAN-DIVERGENCES step 9)
    P.push({ e, n, h, raised: h >= 0.3, bld: kind === 1, b: pts.bright(i) });
  }
  const areaM2 = (box[2] - box[0]) * (box[3] - box[1]);
  const spacing = 1 / Math.sqrt(Math.max(0.3, P.length / Math.max(1, areaM2)));
  const reach = Math.max(1.5, 3 * spacing), minJog = Math.max(0.75, 1.6 * spacing), link = Math.max(1.2, 3 * spacing);
  const grow = Math.max(0.35, 0.75 * spacing);
  const objects = [], corners = [];
  // a thing's rough cells: every cell within `grow` of one of its returns (only its topology is used; each side is then
  // set by the returns themselves)
  // each thing on a grid of its own few metres, not the whole lot's (a lot is 150,000 cells; a deck a few thousand)
  const maskOf = (ps) => {
    let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
    for (const p of ps) { e0 = Math.min(e0, p.e); e1 = Math.max(e1, p.e); n0 = Math.min(n0, p.n); n1 = Math.max(n1, p.n); }
    const pad = grow + 1.2 * spacing + 4 * cell, rad = Math.max(1, Math.ceil((1.2 * spacing) / cell));
    const box = [e0 - pad, n0 - pad, e1 + pad, n1 + pad];
    const W = Math.ceil((box[2] - box[0]) / cell), H = Math.ceil((box[3] - box[1]) / cell), N = W * H;
    const m = new Uint8Array(N), g = Math.ceil(grow / cell);
    for (const p of ps) {
      const c0 = Math.floor((p.e - box[0]) / cell), r0 = Math.floor((box[3] - p.n) / cell);
      for (let dr = -g; dr <= g; dr++) for (let dc = -g; dc <= g; dc++) {
        const r = r0 + dr, c = c0 + dc; if (r < 0 || c < 0 || r >= H || c >= W) continue;
        const e = box[0] + (c + 0.5) * cell, n = box[3] - (r + 0.5) * cell;
        if ((e - p.e) ** 2 + (n - p.n) ** 2 <= grow * grow) m[r * W + c] = 1;
      }
    }
    // closed over the random gaps between returns, and its holes filled: only its outline's topology is wanted
    return { mask: fillHoles(morph(morph(m, W, H, rad, 1), W, H, rad, 0), W, H, N), box, W, H };
  };
  const add = (inside, outside, kind, { minArea = 4, minSpan = 3, edgeIn = null, edgeOut = null } = {}) => {
    if (inside.length < 3) return;
    const hs = inside.map((p) => p.h).sort((a, b) => a - b);
    const mid = inside.reduce((s, p) => [s[0] + p.e / inside.length, s[1] + p.n / inside.length], [0, 0]);
    // its size by its returns (one per spacing^2), and its length: a long thin thing (a wall) is outlined too
    const area = inside.length * spacing * spacing;
    let span = 0; for (let a = 0; a < 180; a += 15) { const t = (a * Math.PI) / 180, v = inside.map((p) => Math.cos(t) * p.e + Math.sin(t) * p.n); span = Math.max(span, Math.max(...v) - Math.min(...v)); }
    const local = area >= minArea || span >= minSpan ? maskOf(inside) : null;
    const fit = local ? squareOutline(local.mask, local.box, local.W, local.H, cell, inside, outside, { minJog, reach, loose: kind === 'paving', edgeIn, edgeOut }) : null;
    if (kind === 'paving' && !fit?.square) return; // a patch of ground that is not a straight-edged slab is not a mark
    const id = objects.length;
    const cs = fit?.square ? fit.ring : [];
    objects.push({ id, kind, ring: fit?.ring || null, top: +hs[hs.length >> 1].toFixed(1), corners: cs, middle: mid, area: +area.toFixed(1), square: !!fit?.square });
    cs.forEach((c, j) => corners.push({ at: c, of: id, kind: 'corner', within: Number.isFinite(fit.sure[j]) ? +fit.sure[j].toFixed(2) : null, sure: fit.sure[j] <= SURE_M }));
    // a small thing (a hot tub, a stump, a post) is also marked by its middle: round, it has no corners
    if (!cs.length || area < 6) corners.push({ at: mid, of: id, kind: 'middle' });
  };
  const raised = P.filter((p) => p.raised), ground = P.filter((p) => !p.raised);
  // 1. things: raised returns that touch; 2. within a thing, its levels: returns that touch at much the same height
  for (const group of linked(raised, link)) {
    if (group.length < 3) continue;
    const inG = new Set(group), others = P.filter((p) => !inG.has(p));
    const kind = group.filter((p) => p.bld).length > group.length * 0.3 ? 'building' : 'object';
    add(group, others, kind);
    if (kind !== 'object') continue;
    const levels = linked(group, link, 0.8).filter((l) => l.length >= 20);
    if (levels.length < 2) continue;
    const medOf = (l) => { const h = l.map((p) => p.h).sort((a, b) => a - b); return h[h.length >> 1]; };
    const low = Math.min(...levels.map(medOf));
    for (const l of levels) {
      if (medOf(l) - low < 0.8) continue; // the lowest level is the whole thing's own outline
      const inL = new Set(l);
      add(l, P.filter((p) => !inL.has(p)), 'object');
    }
  }
  // 3. PAVING: the ground's returns parted by brightness (Otsu's threshold), each part's slabs (a drive, a walk, a patio)
  // outlined the same way, the other ground as their outside; only straight-edged ones are kept
  const gb = ground.map((p) => p.b).filter(Number.isFinite);
  const thr = otsu(gb);
  if (thr != null) {
    // each return's side by the vote of its nearest ground returns: a bright speck in grass is grass
    const lit = smoothVote(ground, ground.map((p) => p.b > thr), 15, Math.max(1.2, 3 * spacing));
    for (const bright of [true, false]) {
      const part = ground.filter((p, i) => lit[i] === bright), rest = ground.filter((p, i) => lit[i] !== bright);
      for (const group of linked(part, Math.max(0.8, 1.6 * spacing), 0.25)) {
        if (group.length * spacing * spacing < 8) continue;
        const inG = new Set(group);
        add(group, [...rest, ...part.filter((p) => !inG.has(p))], 'paving', { minArea: 8, minSpan: 6,
          edgeIn: ground.filter((p) => (p.b > thr) === bright), edgeOut: ground.filter((p) => (p.b > thr) !== bright) });
      }
    }
  }
  return { objects, corners, spacing: +spacing.toFixed(2) };
}

/** Each point's label by the vote of its K nearest (itself among them) within reach. */
function smoothVote(ps, lab, K, reach) {
  const B = reach, hash = new Map(), key = (x, y) => `${x},${y}`;
  ps.forEach((p, i) => { const k = key(Math.floor(p.e / B), Math.floor(p.n / B)); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(i); });
  return ps.map((p) => {
    const bx = Math.floor(p.e / B), by = Math.floor(p.n / B), d = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of hash.get(key(bx + dx, by + dy)) || []) { const q = ps[j], dd = (q.e - p.e) ** 2 + (q.n - p.n) ** 2; if (dd <= reach * reach) d.push([dd, j]); }
    d.sort((a, b) => a[0] - b[0]);
    const k = d.slice(0, K); let yes = 0; for (const [, j] of k) if (lab[j]) yes++;
    return yes * 2 > k.length;
  });
}

/** Otsu's threshold: the brightness that best parts a list into two groups (null when it does not part at all). */
function otsu(vals) {
  if (vals.length < 50) return null;
  const s = [...vals].sort((a, b) => a - b), lo = s[Math.floor(s.length * 0.01)], hi = s[Math.floor(s.length * 0.99)];
  if (!(hi > lo)) return null;
  const B = 64, hist = new Float64Array(B);
  for (const v of s) hist[Math.min(B - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * B)))]++;
  let total = 0, sum = 0; for (let i = 0; i < B; i++) { total += hist[i]; sum += i * hist[i]; }
  let w0 = 0, s0 = 0, best = -1, at = -1;
  for (let i = 0; i < B - 1; i++) {
    w0 += hist[i]; s0 += i * hist[i]; const w1 = total - w0; if (!w0 || !w1) continue;
    const m0 = s0 / w0, m1 = (sum - s0) / w1, v = w0 * w1 * (m0 - m1) ** 2;
    if (v > best) { best = v; at = i; }
  }
  return at < 0 ? null : lo + ((at + 1) / B) * (hi - lo);
}

/** The corner nearest a map point within reach (metres), or null. */
export function snapTo(marks, at, reach) {
  let best = null, bd = reach;
  for (const c of marks?.corners || []) { const d = Math.hypot(c.at[0] - at[0], c.at[1] - at[1]); if (d <= bd) { bd = d; best = c; } }
  return best;
}
