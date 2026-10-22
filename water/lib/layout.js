/**
 * THE PIPE, LAID AS AN INSTALLER LAYS IT (water session; owner, 2026-10-21: "automatic line placement shouldn't
 * go through houses or under trees ... the automatic line placement needs some big improvements... Do some
 * research on how that is usually done").
 *
 * What installers and designers do (water/FINDINGS.md H30, with sources): the most direct route with the
 * fewest turns (Hunter, Residential System Design Guide); a trunk with short cut-ins to each head, at most two
 * pipes at a head (Stryker, Irrigation Tutorials); the main kept short and sharing trenches where it can (Rain
 * Bird, Landscape Irrigation Design Manual); never through a house; paving crossed in one straight sleeve. Trees
 * are not counted (owner, 2026-10-22: "Scratch the tree rules completely").
 *
 * How it is done here (the research's recommendation, the costs its guesses, to tune):
 *   a grid of GRID_M cells turned to the lawn's long edge, so square runs lie along it
 *   each cell's cost to trench: a building can't be crossed; lawn 1; a bed or other
 *   ground BED; a band just inside the lawn's edge CORRIDOR (installers run laterals there); paving PAVED a
 *   cell, crossed straight (no turning on it)
 *   a route is a search over (cell, heading), every turn costing TURN cells, so runs come out straight
 *   the main, backflow preventer to each valve box, first
 *   each zone a tree of its heads, grown from the one nearest their middle, each head joined from the nearest
 *   point of the tree (reached anywhere within STUB_M of it: its swing pipe); then the valve's line brought
 *   to the point of it that balances the runs either way (fed from the middle: Rain Bird)
 *   a cell another line already runs along costs SHARED of itself (one trench, two pipes); crossing one CROSS
 *   zones routed farthest first, then each routed again with the others in place
 * Pure: the ground comes in as a function.
 */

export const GRID_M = 0.5, TURN = 3, BED = 0.9, CORRIDOR = 0.7, PAVED = 25, SHARED = 0.3, CROSS = 15, STUB_M = 0.9, OUTSIDE = 2, ZONE_REACH_M = 5, PAD_M = 8;
const R = 6371000;
const D = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // headings in grid cells: +u, +v, -u, -v

/** [lng, lat] <-> metres east, north of a reference. */
const toEN = (o, p) => [((p[0] - o[0]) * Math.PI / 180) * R * Math.cos((o[1] * Math.PI) / 180), ((p[1] - o[1]) * Math.PI / 180) * R];
const fromEN = (o, [e, n]) => [o[0] + (e / (R * Math.cos((o[1] * Math.PI) / 180))) * 180 / Math.PI, o[1] + (n / R) * 180 / Math.PI];

/**
 * The routing grid over the points to join, turned to `bearing` (degrees; the grid's u axis runs along it).
 * ground(at) -> { building, paved, lawn } (booleans; any may be missing) or null off the map.
 */
export function makeGrid(points, bearing, ground, { cellM = GRID_M, padM = PAD_M } = {}) {
  const o = points[0], t = ((bearing || 0) * Math.PI) / 180;
  const toUV = (p) => { const [e, n] = toEN(o, p); return [e * Math.sin(t) + n * Math.cos(t), e * Math.cos(t) - n * Math.sin(t)]; };
  const fromUV = ([u, v]) => fromEN(o, [u * Math.sin(t) + v * Math.cos(t), u * Math.cos(t) - v * Math.sin(t)]);
  const uv = points.map(toUV);
  const u0 = Math.min(...uv.map((q) => q[0])) - padM, v0 = Math.min(...uv.map((q) => q[1])) - padM;
  const W = Math.ceil((Math.max(...uv.map((q) => q[0])) + padM - u0) / cellM), H = Math.ceil((Math.max(...uv.map((q) => q[1])) + padM - v0) / cellM);
  const N = W * H, cost = new Float32Array(N), paved = new Uint8Array(N), lawn = new Uint8Array(N);
  const atOf = (i) => fromUV([u0 + ((i % W) + 0.5) * cellM, v0 + (Math.floor(i / W) + 0.5) * cellM]);
  for (let i = 0; i < N; i++) {
    const g = ground(atOf(i));
    if (!g) { cost[i] = BED; continue; }
    if (g.building) { cost[i] = Infinity; continue; } // a house: never trenched
    if (g.lawn) lawn[i] = 1;
    if (g.paved) { paved[i] = 1; cost[i] = PAVED; continue; }
    cost[i] = g.lawn ? 1 : BED;
  }
  // the band just inside the lawn's edge (0.5-1 m in), where laterals are run
  const edgeDist = new Uint8Array(N).fill(255), q = [];
  for (let i = 0; i < N; i++) if (lawn[i]) {
    const c = i % W, r = Math.floor(i / W);
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => { const cc = c + dc, rr = r + dr; return cc < 0 || rr < 0 || cc >= W || rr >= H || !lawn[rr * W + cc]; })) { edgeDist[i] = 0; q.push(i); }
  }
  for (let k = 0; k < q.length; k++) {
    const i = q[k], c = i % W, r = Math.floor(i / W);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cc = c + dc, rr = r + dr, j = rr * W + cc;
      if (cc < 0 || rr < 0 || cc >= W || rr >= H || !lawn[j] || edgeDist[j] !== 255) continue;
      edgeDist[j] = edgeDist[i] + 1; if (edgeDist[j] < 3) q.push(j);
    }
  }
  const inBand = (d) => d * cellM >= 0.5 - 1e-9 && d * cellM <= 1.0 + 1e-9;
  for (let i = 0; i < N; i++) if (lawn[i] && cost[i] === 1 && inBand(edgeDist[i])) cost[i] = CORRIDOR;
  const cellOf = (p) => { const [u, v] = toUV(p); const c = Math.floor((u - u0) / cellM), r = Math.floor((v - v0) / cellM); return c < 0 || r < 0 || c >= W || r >= H ? -1 : r * W + c; };
  return { W, H, N, cellM, cost, paved, lawn, atOf, cellOf, toUV, fromUV, u0, v0 };
}

/** A small binary heap of [key, value]. */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * The cheapest route from any source cell to any target cell, over (cell, heading). sources: Map cell -> heading
 * or -1 (any); targets: Set of cells; occ: Map cell -> { axes: bitmask (1 along u, 2 along v), owners: Set };
 * own: this line's owner id (its own cells are free to reuse); outside(cell) -> extra multiplier.
 * -> [cells, from source to target] or null
 */
export function search(G, sources, targets, { occ = null, own = null, mult = null, add = null } = {}) {
  const S = G.N * 4, dist = new Float64Array(S).fill(Infinity), prev = new Int32Array(S).fill(-1), heap = new Heap();
  for (const [cell, hd] of sources) for (let h = 0; h < 4; h++) if (hd < 0 || hd === h) { const s = cell * 4 + h; dist[s] = 0; heap.push(0, s); }
  while (heap.size) {
    const s = heap.pop(), cell = s >> 2, h = s & 3, d0 = dist[s];
    if (d0 === Infinity) continue;
    if (targets && targets.has(cell) && !sources.has(cell)) {
      const path = [];
      for (let x = s; x >= 0; x = prev[x]) { const c = x >> 2; if (path[path.length - 1] !== c) path.push(c); }
      return path.reverse();
    }
    const c = cell % G.W, r = (cell - c) / G.W;
    for (let nh = 0; nh < 4; nh++) {
      if (nh === ((h + 2) & 3)) continue; // no doubling back
      const turning = nh !== h;
      if (turning && G.paved[cell] && !sources.has(cell)) continue; // paving is crossed straight
      const cc = c + D[nh][0], rr = r + D[nh][1];
      if (cc < 0 || rr < 0 || cc >= G.W || rr >= G.H) continue;
      const j = rr * G.W + cc;
      let step = G.cost[j];
      if (step === Infinity) continue;
      if (G.paved[j] && turning && !sources.has(cell)) continue;
      const o = occ?.get(j);
      if (o && !(own !== null && o.owners.size === 1 && o.owners.has(own))) {
        const axis = nh & 1 ? 2 : 1;
        if (o.axes & axis) step *= SHARED; else step += CROSS;
      } else if (o && own !== null && o.owners.has(own)) step = 0;
      if (mult) step *= mult(j);
      if (add) step += add(j);
      const nd = d0 + step + (turning && !sources.has(cell) ? TURN : 0) + (turning && sources.has(cell) && sources.get(cell) >= 0 ? TURN : 0);
      const ns = j * 4 + nh;
      if (nd < dist[ns]) { dist[ns] = nd; prev[ns] = s; heap.push(nd, ns); }
    }
  }
  // with no targets: the whole field, { dist, prev } over (cell, heading), for pathTo
  return targets ? null : { dist, prev };
}

/** The cheapest path from search()'s field to a cell, or null. */
export function pathTo(field, cell) {
  let best = -1;
  for (let h = 0; h < 4; h++) { const s = cell * 4 + h; if (field.dist[s] < Infinity && (best < 0 || field.dist[s] < field.dist[best])) best = s; }
  if (best < 0) return null;
  const path = [];
  for (let x = best; x >= 0; x = field.prev[x]) { const c = x >> 2; if (path[path.length - 1] !== c) path.push(c); }
  return { path: path.reverse(), cost: field.dist[best] };
}

/** Mark a route's cells as occupied by `owner`, along their axes. */
function occupy(G, occ, path, owner) {
  for (let k = 0; k < path.length; k++) {
    const a = path[Math.max(0, k - 1)], b = path[Math.min(path.length - 1, k + 1)];
    const axes = (Math.abs(b - a) === 1 || Math.abs(b - a) === 2 ? 1 : 0) | (Math.abs(b - a) >= G.W ? 2 : 0) || 1;
    const o = occ.get(path[k]) || { axes: 0, owners: new Set() };
    o.axes |= axes; o.owners.add(owner); occ.set(path[k], o);
  }
}

/** The cells within STUB_M of a point: where a lateral may pass to feed it by its swing pipe. */
function stubCells(G, at) {
  const out = new Set(), c0 = G.cellOf(at);
  if (c0 < 0) return out;
  const k = Math.ceil(STUB_M / G.cellM), [u, v] = G.toUV(at);
  const c = c0 % G.W, r = Math.floor(c0 / G.W);
  for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) {
    const cc = c + dc, rr = r + dr;
    if (cc < 0 || rr < 0 || cc >= G.W || rr >= G.H) continue;
    const cu = G.u0 + (cc + 0.5) * G.cellM, cv = G.v0 + (rr + 0.5) * G.cellM;
    if (Math.hypot(cu - u, cv - v) <= STUB_M && G.cost[rr * G.W + cc] !== Infinity) out.add(rr * G.W + cc);
  }
  if (!out.size && G.cost[c0] !== Infinity) out.add(c0);
  return out;
}

/*
 * One zone's tree, FED FROM ITS MIDDLE (owner, 2026-10-22, on Rain Bird's advice: "Where possible, the valve
 * serving a group of sprinklers should be at the center of the group to balance the flow and size of lateral
 * pipe"; a line fed from one end "is the least optimum of all lateral designs", Landscape Irrigation Design
 * Manual pp. 57-60). The valve box is where it is, so the zone's heads are joined first, as one tree grown from
 * the head nearest their middle; then the valve's line is brought to the point of that tree where the cost of
 * getting there, plus FEED_LAMBDA x the farthest head's run from it, is least -- the split that balances the
 * runs either way, as the split-length layout does.
 * -> { parent: Map cell -> cell (rooted at the valve), headAt: Map headId -> cell, cells: Set }
 */
export const FEED_LAMBDA = 1, TREE_WALL = 20;
function zoneTree(G, valveCell, heads, occ, owner) {
  const headAt = new Map(), cells = new Set(), adj = new Map();
  const link = (a, b) => { if (a === b) return; if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set()); adj.get(a).add(b); adj.get(b).add(a); };
  const targetsOf = new Map(heads.map((h) => [h.id, stubCells(G, h.at)]));
  // the zone's own ground: within ZONE_REACH_M of one of its heads (a line out of it costs OUTSIDE)
  const near = new Uint8Array(G.N), reach = Math.ceil(ZONE_REACH_M / G.cellM);
  for (const h of heads) {
    const c0 = G.cellOf(h.at); if (c0 < 0) continue;
    const c = c0 % G.W, r = Math.floor(c0 / G.W);
    for (let dr = -reach; dr <= reach; dr++) for (let dc = -reach; dc <= reach; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && rr >= 0 && cc < G.W && rr < G.H && dc * dc + dr * dr <= reach * reach) near[rr * G.W + cc] = 1;
    }
  }
  const mult = (j) => (near[j] ? 1 : OUTSIDE);
  // the heads first: a tree grown from the head nearest the zone's middle
  const mid = heads.reduce((m, h) => { const [u, v] = G.toUV(h.at); return [m[0] + u / heads.length, m[1] + v / heads.length]; }, [0, 0]);
  const dMid = (h) => { const [u, v] = G.toUV(h.at); return (u - mid[0]) ** 2 + (v - mid[1]) ** 2; };
  const left = heads.slice().sort((a, b) => dMid(a) - dMid(b));
  const seed = left.shift(), seedCell = [...targetsOf.get(seed.id)][0] ?? G.cellOf(seed.at);
  cells.add(seedCell); headAt.set(seed.id, seedCell);
  while (left.length) {
    const targets = new Map();
    for (const h of left) for (const c of targetsOf.get(h.id)) if (!targets.has(c)) targets.set(c, h);
    const touching = [...targets.entries()].find(([c]) => cells.has(c));
    let path = touching ? [touching[0]] : search(G, new Map([...cells].map((c) => [c, -1])), new Set(targets.keys()), { occ, own: owner, mult });
    if (!path) { const h = left[0]; path = [seedCell, [...targetsOf.get(h.id)][0] ?? G.cellOf(h.at)]; }
    const end = path[path.length - 1], h = targets.get(end) || left[0];
    for (let k = 1; k < path.length; k++) { link(path[k - 1], path[k]); cells.add(path[k]); }
    occupy(G, occ, path, owner);
    headAt.set(h.id, end);
    left.splice(left.indexOf(h), 1);
  }
  // where the valve's line joins: cheapest to reach, plus the farthest head's run from there
  // the valve's line is a run of its own up to the join: through the heads' tree it would just meet it at the
  // first point it touched, so their cells cost TREE_WALL to cross (the same for every join: it enters one)
  const field = search(G, new Map([[valveCell, -1]]), null, { occ, own: null, mult, add: (j) => (cells.has(j) && j !== valveCell ? TREE_WALL : 0) });
  const fed = new Set(headAt.values());
  const ecc = (c0) => {
    const seen = new Map([[c0, 0]]), q = [c0];
    let far = 0;
    for (let k = 0; k < q.length; k++) { const c = q[k], d = seen.get(c); if (fed.has(c) && d > far) far = d; for (const n of adj.get(c) || []) if (!seen.has(n)) { seen.set(n, d + 1); q.push(n); } }
    return far;
  };
  let best = null;
  for (const c of cells) {
    const p = pathTo(field, c);
    if (!p) continue;
    const score = p.cost + FEED_LAMBDA * ecc(c);
    if (!best || score < best.score) best = { c, p, score };
  }
  const join = best ? best.c : seedCell, valvePath = best ? best.p.path : [valveCell, join];
  // rooted at the valve: down its line to the join, then out through the head tree
  occupy(G, occ, valvePath, owner);
  // the valve's line down to the join, then out through the heads' tree from there
  const parent = new Map([[valveCell, -1]]);
  for (let k = 1; k < valvePath.length; k++) if (!parent.has(valvePath[k])) parent.set(valvePath[k], valvePath[k - 1]);
  if (!parent.has(join)) parent.set(join, valvePath[valvePath.length - 1] ?? valveCell);
  const q = [join];
  for (let k = 0; k < q.length; k++) for (const n of adj.get(q[k]) || []) if (!parent.has(n)) { parent.set(n, q[k]); q.push(n); }
  // anything the walk did not reach (a head walled off): straight to the valve, as before
  for (const c of cells) if (!parent.has(c)) parent.set(c, valveCell);
  for (const c of valvePath) cells.add(c);
  cells.add(valveCell);
  return { parent, headAt, cells };
}

/** The tree's cells as nodes for lib/hydraulics.js solveZone: the valve, a node at each corner and branch,
    each head off the cell its swing pipe leaves from. */
function nodesOf(G, valveId, valveAt, t, heads) {
  const kids = new Map();
  for (const [c, p] of t.parent) if (p >= 0) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(c); }
  const fed = new Map();
  for (const [id, c] of t.headAt) { if (!fed.has(c)) fed.set(c, []); fed.get(c).push(id); }
  const root = [...t.parent.entries()].find(([, p]) => p < 0)[0];
  const nodes = [{ id: valveId, at: valveAt, kind: 'valve', parent: null, lenFt: 0, path: 0 }];
  const FT = 3.28084;
  let n = 0;
  // walk down: keep a cell as a node when it branches, turns, feeds a head, or ends
  const stack = [[root, valveId, 0, -1]];
  while (stack.length) {
    const [cell, up, run, dirIn] = stack.pop();
    const ch = kids.get(cell) || [];
    const isRoot = cell === root;
    const dirOf = (a, b) => (b - a === 1 ? 0 : b - a === G.W ? 1 : b - a === -1 ? 2 : 3);
    const keep = !isRoot && (ch.length !== 1 || fed.has(cell) || dirOf(cell, ch[0]) !== dirIn);
    let here = up, len = run;
    if (keep) {
      here = `p${++n}`;
      nodes.push({ id: here, at: G.atOf(cell), kind: ch.length > 1 || (fed.has(cell) && ch.length) ? 'tee' : 'bend', parent: up, lenFt: run * G.cellM * FT, path: 0 });
      len = 0;
    }
    for (const id of fed.get(cell) || []) {
      const h = heads.find((x) => x.id === id), at = h.at, ca = G.atOf(cell);
      const stub = Math.hypot(...toEN(ca, at));
      nodes.push({ id, at, kind: 'head', parent: here, lenFt: Math.max(0.5, stub * FT), path: 0 });
    }
    for (const c of ch) stack.push([c, here, len + 1, dirOf(cell, c)]);
  }
  // a bend or tee with nothing below it (a stub that ended at a head's own cell) stays: harmless
  const order = [], byParent = new Map();
  for (const x of nodes) { if (!byParent.has(x.parent)) byParent.set(x.parent, []); byParent.get(x.parent).push(x); }
  const walk = (id) => { for (const c of byParent.get(id) || []) { order.push(c); walk(c.id); } };
  order.push(nodes[0]); walk(valveId);
  return { nodes, order };
}

/*
 * STRAIGHT RUNS, NOT A GRID (owner, 2026-10-22: "let's not do that unless the grid is genuinely the best practice
 * way"). It is not: the practice is "the most direct route with the fewest turns" (Hunter), a straight pull of
 * pipe from point to point, along an edge where that is where the run belongs, across open lawn where it is not.
 * The search above can only step square, so its corners are taken out wherever the straight line between the
 * points either side costs no more to trench than the square steps did (it never crosses a house, and crosses
 * paving no more than they did). Tees and heads stay where they are.
 */
function lineCost(G, a, b) {
  const [ua, va] = G.toUV(a), [ub, vb] = G.toUV(b), L = Math.hypot(ub - ua, vb - va), n = Math.max(1, Math.ceil(L / (G.cellM / 2)));
  let t = 0, paved = 0;
  for (let k = 0; k < n; k++) {
    const f = (k + 0.5) / n, c = G.cellOf(G.fromUV([ua + (ub - ua) * f, va + (vb - va) * f]));
    const v = c < 0 ? BED : G.cost[c];
    if (v === Infinity) return { cost: Infinity, paved: Infinity };
    t += v * (L / n); if (c >= 0 && G.paved[c]) paved += L / n;
  }
  return { cost: t, paved };
}
function straighten(G, tree) {
  const nodes = tree.nodes, byId = new Map(nodes.map((n) => [n.id, n])), FT = 3.28084;
  const kids = () => { const m = new Map(); for (const n of nodes) if (n.parent) { if (!m.has(n.parent)) m.set(n.parent, []); m.get(n.parent).push(n); } return m; };
  let changed = true;
  while (changed) {
    changed = false;
    const ch = kids();
    for (const n of nodes) {
      if (n.kind !== 'bend' || !n.parent || (ch.get(n.id) || []).length !== 1) continue;
      const c = ch.get(n.id)[0], p = byId.get(n.parent);
      const via = [lineCost(G, p.at, n.at), lineCost(G, n.at, c.at)], direct = lineCost(G, p.at, c.at);
      const viaCost = via[0].cost + via[1].cost, viaPaved = via[0].paved + via[1].paved;
      if (direct.cost <= viaCost + 1e-9 && direct.paved <= viaPaved + G.cellM) {
        c.parent = n.parent; c.lenFt = Math.hypot(...G.toUV(c.at).map((v, k) => v - G.toUV(p.at)[k])) * FT;
        nodes.splice(nodes.indexOf(n), 1); byId.delete(n.id); changed = true;
        break;
      }
    }
  }
  const order = [], byParent = new Map();
  for (const x of nodes) { if (!byParent.has(x.parent)) byParent.set(x.parent, []); byParent.get(x.parent).push(x); }
  const walk = (id) => { for (const c of byParent.get(id) || []) { order.push(c); walk(c.id); } };
  order.push(nodes[0]); walk(nodes[0].id);
  return { nodes, order };
}

/**
 * The whole system laid out. pvb [lng, lat]; boxes [{ id, at }]; zones [{ n, box (id), heads [{ id, at }] }];
 * bearing: the grid's (the lawn's long edge); ground(at) as makeGrid.
 * -> { main: [{ box, cells: [[lng, lat]...] (corners), lenM }], zones: Map n -> { nodes, order } (solveZone's tree) }
 */
export function layout({ pvb, boxes, zones, bearing = 0, ground, passes = 2 }) {
  const pts = [pvb, ...boxes.map((b) => b.at), ...zones.flatMap((z) => z.heads.map((h) => h.at))].filter(Array.isArray);
  const G = makeGrid(pts, bearing, ground);
  const corners = (path) => {
    const out = [];
    for (let k = 0; k < path.length; k++) {
      const a = path[k - 1], b = path[k], c = path[k + 1];
      if (k === 0 || k === path.length - 1 || b - a !== c - b) out.push(G.atOf(b));
    }
    return out;
  };
  const occ = new Map();
  // the main: backflow preventer to each valve box, sharing its trench
  const main = [];
  const pvbCell = G.cellOf(pvb), mainCells = new Set([pvbCell]);
  for (const b of boxes) {
    const bc = G.cellOf(b.at);
    const path = search(G, new Map([...mainCells].map((c) => [c, -1])), new Set([bc]), { occ, own: 'main' }) || [pvbCell, bc];
    occupy(G, occ, path, 'main');
    for (const c of path) mainCells.add(c);
    main.push({ box: b.id, cells: corners(path), lenM: (path.length - 1) * G.cellM });
  }
  // the zones, farthest from their valve first, then each again with the others in place
  const boxOf = (z) => boxes.find((b) => b.id === z.box) || boxes[0];
  const far = (z) => Math.max(...z.heads.map((h) => Math.hypot(...toEN(boxOf(z).at, h.at))));
  const order = zones.filter((z) => z.heads.length).slice().sort((a, b) => far(b) - far(a));
  const trees = new Map();
  for (let pass = 0; pass < passes; pass++) {
    for (const z of order) {
      if (trees.has(z.n)) for (const [c, o] of occ) { o.owners.delete(`z${z.n}`); if (!o.owners.size) occ.delete(c); }
      const vc = G.cellOf(boxOf(z).at);
      trees.set(z.n, zoneTree(G, vc, z.heads, occ, `z${z.n}`));
    }
  }
  const out = new Map();
  for (const z of order) out.set(z.n, straighten(G, nodesOf(G, 'valve', boxOf(z).at, trees.get(z.n), z.heads)));
  return { main, zones: out, grid: { W: G.W, H: G.H, cellM: G.cellM } };
}
