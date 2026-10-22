/**
 * THE PIPE, LAID AS AN INSTALLER LAYS IT (water session; owner, 2026-10-21: "automatic line placement shouldn't
 * go through houses or under trees ... the automatic line placement needs some big improvements... Do some
 * research on how that is usually done").
 *
 * What installers and designers do (water/FINDINGS.md H30, with sources): the most direct route with the
 * fewest turns (Hunter, Residential System Design Guide); a trunk with short cut-ins to each head, at most two
 * pipes at a head (Stryker, Irrigation Tutorials); the main kept short and sharing trenches where it can (Rain
 * Bird, Landscape Irrigation Design Manual); never through a house; out from under trees (Stryker: "keep the
 * trenches out from under the canopy"); paving crossed in one straight sleeve.
 *
 * How it is done here (the research's recommendation, the costs its guesses, to tune):
 *   a grid of GRID_M cells turned to the lawn's long edge, so square runs lie along it
 *   each cell's cost to trench: a building can't be crossed; under a tree x CANOPY; lawn 1; a bed or other
 *   ground BED; a band just inside the lawn's edge CORRIDOR (installers run laterals there); paving PAVED a
 *   cell, crossed straight (no turning on it)
 *   a route is a search over (cell, heading), every turn costing TURN cells, so runs come out straight
 *   the main, backflow preventer to each valve box, first
 *   each zone a tree grown from its valve: first a spine to its farthest head, then each remaining head joined
 *   from the nearest point of the tree; a head is reached anywhere within STUB_M of it (its swing pipe)
 *   a cell another line already runs along costs SHARED of itself (one trench, two pipes); crossing one CROSS
 *   zones routed farthest first, then each routed again with the others in place
 * Pure: the ground comes in as a function.
 */

export const GRID_M = 0.5, TURN = 3, CANOPY = 6, BED = 0.9, CORRIDOR = 0.7, PAVED = 25, SHARED = 0.3, CROSS = 15, STUB_M = 0.9, OUTSIDE = 2, ZONE_REACH_M = 5, PAD_M = 8;
const R = 6371000;
const D = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // headings in grid cells: +u, +v, -u, -v

/** [lng, lat] <-> metres east, north of a reference. */
const toEN = (o, p) => [((p[0] - o[0]) * Math.PI / 180) * R * Math.cos((o[1] * Math.PI) / 180), ((p[1] - o[1]) * Math.PI / 180) * R];
const fromEN = (o, [e, n]) => [o[0] + (e / (R * Math.cos((o[1] * Math.PI) / 180))) * 180 / Math.PI, o[1] + (n / R) * 180 / Math.PI];

/**
 * The routing grid over the points to join, turned to `bearing` (degrees; the grid's u axis runs along it).
 * ground(at) -> { building, canopy, paved, lawn } (booleans; any may be missing) or null off the map.
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
    if (g.building) { cost[i] = Infinity; continue; }
    if (g.lawn) lawn[i] = 1;
    if (g.paved) { paved[i] = 1; cost[i] = PAVED; continue; }
    cost[i] = g.canopy ? CANOPY : g.lawn ? 1 : BED;
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
export function search(G, sources, targets, { occ = null, own = null, mult = null } = {}) {
  const S = G.N * 4, dist = new Float64Array(S).fill(Infinity), prev = new Int32Array(S).fill(-1), heap = new Heap();
  for (const [cell, hd] of sources) for (let h = 0; h < 4; h++) if (hd < 0 || hd === h) { const s = cell * 4 + h; dist[s] = 0; heap.push(0, s); }
  while (heap.size) {
    const s = heap.pop(), cell = s >> 2, h = s & 3, d0 = dist[s];
    if (d0 === Infinity) continue;
    if (targets.has(cell) && !sources.has(cell)) {
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
      const nd = d0 + step + (turning && !sources.has(cell) ? TURN : 0) + (turning && sources.has(cell) && sources.get(cell) >= 0 ? TURN : 0);
      const ns = j * 4 + nh;
      if (nd < dist[ns]) { dist[ns] = nd; prev[ns] = s; heap.push(nd, ns); }
    }
  }
  return null;
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

/** One zone's tree: grown from its valve. -> { parent: Map cell -> cell, headAt: Map headId -> cell, cells: Set } */
function zoneTree(G, valveCell, heads, occ, owner) {
  const parent = new Map([[valveCell, -1]]), headAt = new Map(), cells = new Set([valveCell]);
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
  const left = heads.slice();
  // the spine first: to the farthest head
  const vat = G.atOf(valveCell), d2 = (h) => { const [a, b] = G.toUV(h.at), [c, d] = G.toUV(vat); return (a - c) ** 2 + (b - d) ** 2; };
  left.sort((x, y) => d2(y) - d2(x));
  let first = true;
  while (left.length) {
    const targets = new Map();
    for (const h of first ? [left[0]] : left) for (const c of targetsOf.get(h.id)) if (!targets.has(c)) targets.set(c, h);
    // a head whose stub reaches the tree already: fed from there
    const touching = [...targets.entries()].find(([c]) => cells.has(c));
    let path;
    if (touching) path = [touching[0]];
    else {
      path = search(G, new Map([...cells].map((c) => [c, -1])), new Set(targets.keys()), { occ, own: owner, mult });
      if (!path) { // nothing reaches it (walled in): straight from the valve, as before
        const h = first ? left[0] : left[0], c = [...targetsOf.get(h.id)][0] ?? G.cellOf(h.at);
        path = [valveCell, c];
      }
    }
    const end = path[path.length - 1], h = targets.get(end) || left[0];
    for (let k = 1; k < path.length; k++) if (!parent.has(path[k])) { parent.set(path[k], path[k - 1]); cells.add(path[k]); }
    occupy(G, occ, path, owner);
    headAt.set(h.id, end);
    left.splice(left.indexOf(h), 1);
    first = false;
  }
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
  for (const z of order) out.set(z.n, nodesOf(G, 'valve', boxOf(z).at, trees.get(z.n), z.heads));
  return { main, zones: out, grid: { W: G.W, H: G.H, cellM: G.cellM } };
}
