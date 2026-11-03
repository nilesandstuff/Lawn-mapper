/**
 * "YOU ARE HERE" FROM THE LIDAR: THE GRIDS AND THE SEARCH (core session, docs/SCAN-PLAN.md 3.2).
 *
 * CARRIED FROM THE WATER SESSION'S water/lib/ar-lidar.js (FINDINGS H68, built 2026-11-01 for its AR test page), with
 * their agreement, unchanged but for this header and the unproject helper (scan/lib/frames.js has it). The water
 * session's file is theirs; a change to the method is made here and noted in docs/SCAN-PLAN.md.
 *
 * Their description follows.
 *
 * "YOU ARE HERE" FROM THE LIDAR (owner, 2026-11-01: "arcore builds a 3d space using the camera right? And thanks to
 * 3dep, imagery, and lawn traces, we have a virtual 3d map of lawns... So can we compare features of the arcore space
 * with our own 3d map to place one on top of the other?"; FINDINGS H68).
 *
 * The phone's depth picture (Chrome gives it on the owner's phone: 52 of 53 frames, H68) turned into points round
 * the phone, in ARCore's own level frame; the lot's 3DEP lidar turned into two grids in the map's frame:
 *   dem   the bare ground's height (the lidar's ground points), 0.25 m cells
 *   occ   what stands at chest height: lidar points 0.25-2.5 m above the ground (fences, bushes, trunks, cars, low
 *         branches), and the house's walls (its roof's footprint pulled in by the eaves, its outline)
 *   dist  how far each cell is from the nearest such thing, metres (capped)
 * The phone's points that stand 0.3-2.5 m above its ground must land on occ; its ground points must follow the dem's
 * shape (a slope, a hollow) up to one height offset. The turn and shift that do both best is the fix.
 *
 * Search: round a prior (the reference fit, or GPS with any turn), a coarse grid of positions and turns, then a
 * pattern search down to centimetres and a tenth of a degree. Truncated costs, so what the lidar does not have (a
 * parked car, a person) does not drag the fix. A fix is taken only when most of the phone's standing points land on
 * something and no clearly different position does nearly as well (a rectangular house matches itself turned round).
 */
import { surfaceCost } from './surface.js';

/**
 * THE BUILDINGS FROM THE SHARED RULE (core session, 2026-11-03; CLAUDE.md "One way to read lidar"). The shade map's
 * public/shade/structures.js decides building / tree / nothing per 1 m column of its own grid (grid.js gridOver, in
 * EPSG:3857, the points moved by `shift`). This puts its BUILDING columns onto this file's fine grid in map metres:
 * each fine cell's centre, east/north of `origin3857` ([x, y], the map's point in 3857) at latitude scale k, is looked
 * up in the shade grid. sgrid: { x0, y1, cell, cellY?, w, h }. -> Uint8Array(W * H), 1 where a building stands.
 */
export function buildingsOnGrid(kind, sgrid, box, cell, origin3857, k, BUILDING = 1) {
  const W = Math.max(1, Math.ceil((box[2] - box[0]) / cell)), H = Math.max(1, Math.ceil((box[3] - box[1]) / cell));
  const out = new Uint8Array(W * H), cy = sgrid.cellY || sgrid.cell;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const e = box[0] + (c + 0.5) * cell, n = box[3] - (r + 0.5) * cell;
    const X = origin3857[0] + e / k, Y = origin3857[1] + n / k;
    const sc = Math.floor((X - sgrid.x0) / sgrid.cell), sr = Math.floor((sgrid.y1 - Y) / cy);
    if (sc < 0 || sr < 0 || sc >= sgrid.w || sr >= sgrid.h) continue;
    if (kind[sr * sgrid.w + sc] === BUILDING) out[r * W + c] = 1;
  }
  return out;
}

/**
 * The lot's lidar as grids. pts: { e, n, z, cls } typed columns in map metres (count = e.length); box [e0, n0, e1, n1].
 * opts.buildings: the shared rule's buildings on this grid (buildingsOnGrid); when given it replaces this file's own
 * roof rule (roofMask, the water map's, kept only as the fallback when the shared module cannot be loaded).
 * opts.footprint: the shared rule's inside-of-the-walls on this grid; when given it replaces the pull-in by `eave`.
 */
export function buildGrids(pts, box, { cell = 0.25, band = [0.25, 2.5], cap = 5, eave = 0.5, buildings = null, footprint = null, under = null } = {}) {
  const W = Math.max(1, Math.ceil((box[2] - box[0]) / cell)), H = Math.max(1, Math.ceil((box[3] - box[1]) / cell));
  const idx = (e, n) => { const c = Math.floor((e - box[0]) / cell), r = Math.floor((box[3] - n) / cell); return c >= 0 && c < W && r >= 0 && r < H ? r * W + c : -1; };
  const dem = new Float32Array(W * H).fill(NaN);
  const N = pts.e.length;
  for (let i = 0; i < N; i++) {
    if (pts.cls[i] !== 2) continue;
    const k = idx(pts.e[i], pts.n[i]); if (k < 0) continue;
    if (!(dem[k] <= pts.z[i])) dem[k] = pts.z[i];
  }
  fill(dem, W, H);
  const occ = new Uint8Array(W * H), occTop = new Float32Array(W * H);
  for (let i = 0; i < N; i++) {
    const c = pts.cls[i];
    if (c === 2 || c === 7 || c === 18 || c === 9 || c === 6) continue;
    const k = idx(pts.e[i], pts.n[i]); if (k < 0) continue;
    // opts.under: cells under a tree's crown (the shared rule's TREE / SOLID_TREE), whose low points are not used: on
    // the owner's walk of 2026-11-03 the phone saw nothing at 84% of the low-point cells near it (SCAN-H3), and under a
    // crown they are drawn as blue walls the owner saw and could not account for
    if (under && under[k]) continue;
    const h = pts.z[i] - dem[k];
    if (h > band[0] && h < band[1]) { occ[k] = 1; if (h > occTop[k]) occTop[k] = h; }
  }
  const bld = buildings && buildings.length === W * H ? buildings : roofMask(pts, box, cell, W, H, dem);
  /* A building is its walls, not its inside (the phone cannot see in, and points landing inside a solid footprint
     would cost nothing wherever they went): the roof's footprint pulled in by the eaves (0.5 m), then its
     outline. */
  // the roof's points are sparser than the cells: grow the roof by 0.5 m to close it, then shrink it back by that and the eaves
  /* opts.footprint: the inside of the walls by the shared rule (structures.js wallsOf: 2 ft in from the roof's edge,
     the owner's number, 2026-11-03), put on this grid; else this file's own pull-in by `eave`. */
  const grow = Math.max(1, Math.round(0.5 / cell));
  const walls = footprint && footprint.length === W * H ? footprint : erode(dilate(bld, W, H, grow), W, H, grow + eave / cell);
  const occNoWalls = occ.slice();
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c; if (!walls[k]) continue;
    if (r === 0 || c === 0 || r === H - 1 || c === W - 1 || !walls[k - 1] || !walls[k + 1] || !walls[k - W] || !walls[k + W]) occ[k] = 1;
  }
  let solid = 0; for (let k = 0; k < occ.length; k++) solid += occ[k];
  // (core session, 2026-11-03) occTop: how tall each solid cell's points reach, and bld, the roof mask, so the AR
  // page can draw what the match is matching against (docs/SCAN-PLAN.md SCAN-H2); walls are drawn to the roof.
  const g = { box, cell, W, H, dem, occ, occTop, bld, dist: distanceField(occ, W, H, cell, cap), solid };
  /* WALLS JUDGED ONE BY ONE, AND THE ROOF'S EDGE (owner, 2026-11-03: walls are "USUALLY within 2 feet of the
     overhang... But sometimes they're just 1 foot or less, and other times they could be 10 feet (like an
     all-seasons room or large front porch...). So each wall needs to be judge independently and the trust needs to
     weighed"). Three more grids, when there are buildings:
       inset     how far inside the roof's edge each cell is (m; negative outside), for placementCost's wall term,
                 which charges a wall point by how far it is from 2 ft in, up to a small cap, so an ordinary wall
                 pulls the fix and a porch's or a sunroom's costs a little and pulls nothing;
       distNW    the distance to the solid cells WITHOUT the drawn 2 ft walls (fences, trunks, low structures);
       distRoof  the distance to the roof's edge itself, which the lidar sees exactly and the phone sees when it
                 looks up (the gutter line): no inset to guess. */
  let any = 0; for (let k = 0; k < bld.length; k++) any += bld[k];
  if (any) {
    // the roof closed first (gaps under 1 m filled), since a roof found from its points can be holed at 0.25 m
    const roof = erode(dilate(bld, W, H, grow), W, H, grow);
    const notBld = new Uint8Array(W * H), edge = new Uint8Array(W * H);
    for (let k = 0; k < roof.length; k++) notBld[k] = roof[k] ? 0 : 1;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const k = r * W + c; if (!roof[k]) continue;
      if (r === 0 || c === 0 || r === H - 1 || c === W - 1 || !roof[k - 1] || !roof[k + 1] || !roof[k - W] || !roof[k + W]) edge[k] = 1;
    }
    const inside = distanceField(notBld, W, H, cell, cap), outside = distanceField(roof, W, H, cell, cap);
    const inset = new Float32Array(W * H);
    for (let k = 0; k < inset.length; k++) inset[k] = roof[k] ? inside[k] - cell / 2 : -outside[k] + cell / 2;
    g.inset = inset; g.distNW = distanceField(occNoWalls, W, H, cell, cap); g.distRoof = distanceField(edge, W, H, cell, cap);
    /* how far in, measured straight across a wall: for each of 8 headings, from each roof cell to the roof's edge along
       that heading and against it, the nearer. A porch wall 10 ft in reads 10 ft along its whole length, where the
       distance to the nearest edge would read less near the house's corners. Outside the roof, as inset. */
    const reach = WALL_BAND[1] + 0.5, stepM = cell / 2;
    g.rays = [];
    for (let h = 0; h < RAY_HEADINGS; h++) {
      const a = (h * Math.PI) / RAY_HEADINGS, de = Math.cos(a), dn = Math.sin(a), ray = new Float32Array(W * H);
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const k = r * W + c;
        if (!roof[k]) { ray[k] = inset[k]; continue; }
        const e0 = box[0] + (c + 0.5) * cell, n0 = box[3] - (r + 0.5) * cell;
        let best = reach;
        for (const sg of [1, -1]) for (let d = stepM; d < best; d += stepM) {
          const cc = Math.floor((e0 + sg * de * d - box[0]) / cell), rr = Math.floor((box[3] - (n0 + sg * dn * d)) / cell);
          if (cc < 0 || rr < 0 || cc >= W || rr >= H || !roof[rr * W + cc]) { best = d; break; }
        }
        ray[k] = best;
      }
      g.rays.push(ray);
    }
  }
  return g;
}

/**
 * The roofs, on the fine grid. A cloud with building points (class 6): those. Otherwise (the owner's 2016 Kent County
 * cloud has only ground, unclassified and noise) the water map's own rule (lib/surface.js buildingMask): a 1 m cell
 * with returns over 2 m above the ground, no ground return, and at least 80% of them single echoes (a tree's crown
 * echoes more than once); pinholes closed; pieces under 15 m2 dropped.
 */
function roofMask(pts, box, cell, W, H, dem) {
  const N = pts.e.length, out = new Uint8Array(W * H);
  let class6 = false;
  for (let i = 0; i < N && !class6; i++) if (pts.cls[i] === 6) class6 = true;
  const fineIdx = (e, n) => { const c = Math.floor((e - box[0]) / cell), r = Math.floor((box[3] - n) / cell); return c >= 0 && c < W && r >= 0 && r < H ? r * W + c : -1; };
  if (class6) { for (let i = 0; i < N; i++) if (pts.cls[i] === 6) { const k = fineIdx(pts.e[i], pts.n[i]); if (k >= 0) out[k] = 1; } return out; }
  if (!pts.nret) return out;
  const C = 1, CW = Math.ceil((box[2] - box[0]) / C), CH = Math.ceil((box[3] - box[1]) / C);
  const tall = new Uint16Array(CW * CH), single = new Uint16Array(CW * CH), grd = new Uint16Array(CW * CH);
  for (let i = 0; i < N; i++) {
    const c = Math.floor((pts.e[i] - box[0]) / C), r = Math.floor((box[3] - pts.n[i]) / C);
    if (c < 0 || r < 0 || c >= CW || r >= CH) continue;
    const j = r * CW + c, cl = pts.cls[i];
    if (cl === 2) { grd[j]++; continue; }
    if (cl === 7 || cl === 18 || cl === 9) continue;
    const k = fineIdx(pts.e[i], pts.n[i]);
    if (k < 0 || pts.z[i] - dem[k] < 2) continue;
    tall[j]++; if (pts.nret[i] <= 1) single[j]++;
  }
  let m = new Uint8Array(CW * CH);
  for (let j = 0; j < m.length; j++) m[j] = tall[j] > 0 && grd[j] === 0 && single[j] >= 0.8 * tall[j] ? 1 : 0;
  // close one cell, then drop pieces under 15 m2
  const closed = m.slice();
  for (let r = 1; r < CH - 1; r++) for (let c = 1; c < CW - 1; c++) { const j = r * CW + c; if (!m[j] && ((m[j - 1] && m[j + 1]) || (m[j - CW] && m[j + CW]))) closed[j] = 1; }
  m = closed;
  const seen = new Int32Array(CW * CH).fill(-1);
  for (let j0 = 0; j0 < m.length; j0++) {
    if (!m[j0] || seen[j0] >= 0) continue;
    const stack = [j0], part = []; seen[j0] = j0;
    while (stack.length) { const j = stack.pop(); part.push(j); const r = Math.floor(j / CW), c = j % CW; for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= CH || cc >= CW) continue; const q = rr * CW + cc; if (m[q] && seen[q] < 0) { seen[q] = j0; stack.push(q); } } }
    if (part.length * C * C < 15) for (const j of part) m[j] = 0;
  }
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const cc = Math.floor(((c + 0.5) * cell) / C), rr = Math.floor(((r + 0.5) * cell) / C);
    if (cc < CW && rr < CH && m[rr * CW + cc]) out[r * W + c] = 1;
  }
  return out;
}

/** A mask grown by n cells (4-neighbour steps). */
function dilate(m, W, H, n) {
  let cur = m;
  for (let step = 0; step < n; step++) {
    const next = cur.slice();
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const k = r * W + c; if (!cur[k] && ((c > 0 && cur[k - 1]) || (c < W - 1 && cur[k + 1]) || (r > 0 && cur[k - W]) || (r < H - 1 && cur[k + W]))) next[k] = 1; }
    cur = next;
  }
  return cur;
}
/** A mask shrunk by n cells (4-neighbour steps, n rounded). */
function erode(m, W, H, n) {
  let cur = m;
  for (let step = 0; step < Math.round(n); step++) {
    const next = new Uint8Array(W * H);
    for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) { const k = r * W + c; next[k] = cur[k] && cur[k - 1] && cur[k + 1] && cur[k - W] && cur[k + W] ? 1 : 0; }
    cur = next;
  }
  return cur;
}

/** Holes in the ground filled from their neighbours, ring by ring. */
function fill(z, W, H) {
  for (let pass = 0; pass < 400; pass++) {
    let holes = 0;
    const next = z.slice();
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const k = r * W + c; if (Number.isFinite(z[k])) continue;
      let s = 0, m = 0;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < H && cc >= 0 && cc < W && Number.isFinite(z[rr * W + cc])) { s += z[rr * W + cc]; m++; } }
      if (m) next[k] = s / m; else holes++;
    }
    z.set(next);
    if (!holes) return;
  }
  for (let k = 0; k < z.length; k++) if (!Number.isFinite(z[k])) z[k] = 0;
}

/** Distance (m) from each cell to the nearest set one: two passes, 3-4 chamfer, capped. */
export function distanceField(occ, W, H, cell, cap = 5) {
  const BIG = 1e9, d = new Float32Array(W * H);
  for (let k = 0; k < d.length; k++) d[k] = occ[k] ? 0 : BIG;
  const a = 1, b = Math.SQRT2;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c; let v = d[k];
    if (c > 0) v = Math.min(v, d[k - 1] + a);
    if (r > 0) { v = Math.min(v, d[k - W] + a); if (c > 0) v = Math.min(v, d[k - W - 1] + b); if (c < W - 1) v = Math.min(v, d[k - W + 1] + b); }
    d[k] = v;
  }
  for (let r = H - 1; r >= 0; r--) for (let c = W - 1; c >= 0; c--) {
    const k = r * W + c; let v = d[k];
    if (c < W - 1) v = Math.min(v, d[k + 1] + a);
    if (r < H - 1) { v = Math.min(v, d[k + W] + a); if (c < W - 1) v = Math.min(v, d[k + W + 1] + b); if (c > 0) v = Math.min(v, d[k + W - 1] + b); }
    d[k] = v;
  }
  for (let k = 0; k < d.length; k++) d[k] = Math.min(cap, d[k] * cell);
  return d;
}

/** A grid's value at a map point, bilinear (NaN off the grid). */
export function sample(g, arr, e, n) {
  const fx = (e - g.box[0]) / g.cell - 0.5, fy = (g.box[3] - n) / g.cell - 0.5;
  const c0 = Math.floor(fx), r0 = Math.floor(fy);
  if (c0 < 0 || r0 < 0 || c0 >= g.W - 1 || r0 >= g.H - 1) return NaN;
  const tx = fx - c0, ty = fy - r0, k = r0 * g.W + c0;
  return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - ty) + (arr[k + g.W] * (1 - tx) + arr[k + g.W + 1] * tx) * ty;
}

/**
 * The cost of one placement. stand: [[u, v]] (the phone's points at chest height, AR level); ground: [[u, v, y]];
 * T: { theta, tx, ty, s }. -> { cost, hits (share of stand within 0.3 m of something), tz }
 */
/* EACH WALL JUDGED ON ITS OWN (owner, 2026-11-03: walls are "USUALLY within 2 feet of the overhang... But sometimes
   they're just 1 foot or less, and other times they could be 10 feet (like an all-seasons room or large front porch.
   And, rarely, a pavilion type structure). So each wall needs to be judge independently").
   What the phone sees standing is cut into pieces in its own frame (points within 0.3 m of each other: one wall, one
   fence run, one bush). Under a placement, a piece that lands just inside a roof is a wall, and it finds its OWN
   inset: the trimmed mean of how far in its points stand. Its points then cost how far each is from that inset (so
   the wall must run along the roof's edge, straight and square), plus a small charge for an unusual inset: nothing
   from a foot outside to 3 ft in, growing to WALL_CAP by 12 ft, and for a long wall no more in all than a short
   one's. A porch wall 10 ft in therefore fits as a wall and costs a little; it never drags the fix to put it 2 ft in. The 2 ft walls drawn into g.dist are only for the
   drawing and the agreement dots now. */
export const WALL_USUAL = [-0.3, 0.9]; // m in from the roof's edge: no charge (a foot or less, to 2 ft and a bit)
export const WALL_BAND = [-0.4, 3.6];  // m: anywhere in here a piece may be a wall (a 10 ft porch is the far end)
export const WALL_CAP = 0.15;          // the charge per point for a wall at the far end (a missed point costs 1)...
export const WALL_WORTH = 20;          // ...for a wall of up to this many points; a longer wall pays this many points'
                                       // worth in all, so a long porch wall seen well cannot outvote the trees
export const PIECE_GAP = 0.3;          // m: points closer than this, in the phone's frame, are one piece
export const EDGE_NEAR = 1.5;          // m from the lawn's edge: a surface point near enough to say where it is
export const SURF_W = 1;              // the lawn-edge term's weight against the standing points'
export const HIGH_W = 0.5;             // what a high point counts for, against a standing one
export const RAY_HEADINGS = 8;         // headings (over half a turn) at which buildGrids measures inset across a wall
const insetCharge = (m) => { const o = m < WALL_USUAL[0] ? WALL_USUAL[0] - m : m > WALL_USUAL[1] ? m - WALL_USUAL[1] : 0; return WALL_CAP * Math.min(1, (o / 2.7) ** 2); };
const pieceCache = new WeakMap();
/** Cut points [[u, v]] into pieces: points within PIECE_GAP of each other that run the same way share one, so a
 *  house's corner splits its two walls (each finds its own inset) and a bush, which runs no way, stays whole.
 *  Returns { of: Int32Array, n }. */
export function piecesOf(pts, gap = PIECE_GAP) {
  if (pieceCache.has(pts)) return pieceCache.get(pts);
  const N = pts.length, parent = Int32Array.from({ length: N }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const R = 0.6, cells = new Map(), key = (a, b) => a * 100003 + b;
  for (let i = 0; i < N; i++) { const k = key(Math.floor(pts[i][0] / R), Math.floor(pts[i][1] / R)); (cells.get(k) || cells.set(k, []).get(k)).push(i); }
  const near = (i, r, f) => {
    const a = Math.floor(pts[i][0] / R), b = Math.floor(pts[i][1] / R);
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (const j of cells.get(key(a + da, b + db)) || []) if (j !== i && Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < r) f(j);
  };
  // each point's way: the long axis of its neighbours within 0.6 m (an angle mod 180), or none when they spread evenly
  const way = new Float64Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, k = 1; const [x0, y0] = pts[i];
    near(i, R, (j) => { const x = pts[j][0] - x0, y = pts[j][1] - y0; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; k++; });
    if (k < 4) continue;
    const mx = sx / k, my = sy / k, a = sxx / k - mx * mx, b = syy / k - my * my, cxy = sxy / k - mx * my;
    const tr = a + b, det = a * b - cxy * cxy, l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det)), l2 = tr - l1;
    if (l1 > 0 && l2 / l1 < 0.15) way[i] = 0.5 * Math.atan2(2 * cxy, a - b);
  }
  const sameWay = (i, j) => { const x = way[i], y = way[j]; if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y); let d = Math.abs(x - y) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d < (25 * Math.PI) / 180; };
  for (let i = 0; i < N; i++) near(i, gap, (j) => { if (j > i && sameWay(i, j)) { const x = find(i), y = find(j); if (x !== y) parent[x] = y; } });
  const ids = new Map(), of = new Int32Array(N);
  for (let i = 0; i < N; i++) { const r = find(i); if (!ids.has(r)) ids.set(r, ids.size); of[i] = ids.get(r); }
  // each piece's way: the mean of its points' (as doubled angles), when most of them run one way
  const n = ids.size, cs = new Float64Array(n), sn = new Float64Array(n), cnt = new Float64Array(n), tot = new Float64Array(n);
  for (let i = 0; i < N; i++) { tot[of[i]]++; if (!Number.isNaN(way[i])) { cs[of[i]] += Math.cos(2 * way[i]); sn[of[i]] += Math.sin(2 * way[i]); cnt[of[i]]++; } }
  const ways = Float64Array.from({ length: n }, (_, p) => (cnt[p] >= 3 && cnt[p] >= tot[p] / 2 ? 0.5 * Math.atan2(sn[p], cs[p]) : NaN));
  const out = { of, n, way: ways }; pieceCache.set(pts, out); return out;
}
export function placementCost(g, stand, ground, T, { trunc = 1, groundW = 0.5, groundTrunc = 0.3, high = [], surface = [], surfW = g.surfW ?? SURF_W, detail = false } = {}) {
  const c = Math.cos(T.theta) * T.s, s = Math.sin(T.theta) * T.s;
  let sum = 0, n = 0, hits = 0, hHits = 0;
  const walls = detail ? [] : null;
  if (g.inset) {
    const N = stand.length, P = piecesOf(stand), dd2 = new Float64Array(N), si = new Float64Array(N);
    const ps = new Float64Array(P.n), pc = new Float64Array(P.n);
    // each piece that runs one way is measured across itself: its normal's heading under this placement
    const across = g.rays ? Array.from(P.way, (w) => (Number.isNaN(w) ? g.inset : g.rays[((Math.round((((w + T.theta + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI / (Math.PI / RAY_HEADINGS)) % RAY_HEADINGS) + RAY_HEADINGS) % RAY_HEADINGS])) : null;
    for (let i = 0; i < N; i++) {
      const [u, v] = stand[i], e = c * u - s * v + T.tx, nn = s * u + c * v + T.ty;
      const d = sample(g, g.distNW, e, nn), dd = Number.isFinite(d) ? Math.min(d, trunc) : trunc;
      dd2[i] = dd * dd; si[i] = sample(g, across ? across[P.of[i]] : g.inset, e, nn);
      if (si[i] >= WALL_BAND[0] && si[i] <= WALL_BAND[1]) { ps[P.of[i]] += si[i]; pc[P.of[i]]++; }
    }
    // each piece's own inset: the mean of its points in the band, then again of those within 0.5 m of it
    const m = new Float64Array(P.n).fill(NaN);
    for (let p = 0; p < P.n; p++) if (pc[p] >= 3) m[p] = ps[p] / pc[p];
    ps.fill(0); pc.fill(0);
    for (let i = 0; i < N; i++) { const p = P.of[i]; if (Math.abs(si[i] - m[p]) < 0.5) { ps[p] += si[i]; pc[p]++; } }
    for (let p = 0; p < P.n; p++) m[p] = pc[p] >= 3 ? ps[p] / pc[p] : NaN;
    const charge = Float64Array.from(m, (x, p) => (Number.isFinite(x) ? (insetCharge(x) * WALL_WORTH) / Math.max(WALL_WORTH, pc[p]) : 0));
    const used = detail ? new Uint32Array(P.n) : null;
    for (let i = 0; i < N; i++) {
      const p = P.of[i]; let cost = dd2[i], hit = dd2[i] < 0.09;
      if (Number.isFinite(m[p]) && Number.isFinite(si[i])) {
        const r = Math.min(trunc, Math.abs(si[i] - m[p])), wc = r * r + charge[p];
        if (wc < cost) { cost = wc; hit = r < 0.3; if (used && hit) used[p]++; }
      }
      sum += cost; n++; if (hit) hits++;
    }
    if (detail) for (let p = 0; p < P.n; p++) if (used[p] >= 3) walls.push({ points: used[p], insetM: Math.round(m[p] * 100) / 100 });
  } else {
    for (const [u, v] of stand) {
      const d = sample(g, g.dist, c * u - s * v + T.tx, s * u + c * v + T.ty);
      const dd = Number.isFinite(d) ? Math.min(d, trunc) : trunc;
      sum += dd * dd; n++; if (dd < 0.3) hits++;
    }
  }
  /* the roof's edge, from what the phone saw high up (2.4 m or more over its ground): gutters and fascia, which the
     lidar has exactly. Each counts half a point, and costs at most 0.6 m off: a high point far from any edge is most
     likely a tree's crown, which costs the same wherever the placement puts it. It counts towards the share that
     landed only when it lands, so a yard full of crowns does not read as a bad match. */
  if (g.distRoof) for (const [u, v] of high) {
    const d = sample(g, g.distRoof, c * u - s * v + T.tx, s * u + c * v + T.ty), dd = Number.isFinite(d) ? Math.min(d, 0.6) : 0.6;
    sum += HIGH_W * dd * dd; n += HIGH_W; if (dd < 0.3) { hits += HIGH_W; hHits++; }
  }
  let tz = 0, gsum = 0, gn = 0;
  if (ground.length) {
    const diffs = [];
    for (const [u, v, y] of ground) { const z = sample(g, g.dem, c * u - s * v + T.tx, s * u + c * v + T.ty); if (Number.isFinite(z)) diffs.push(z - y); }
    if (diffs.length) {
      diffs.sort((x, y) => x - y); tz = diffs[diffs.length >> 1];
      for (const d of diffs) { const r = Math.min(Math.abs(d - tz), groundTrunc); gsum += r * r; gn++; }
    }
  }
  /* THE LAWN'S EDGE (scan/lib/surface.js, SCAN-H3's follow-up): ground points the camera saw as grass or paving,
     against the lawn the owner traced (g.lawnSd, set by the page from the map's shapes) */
  // near the edge (within EDGE_NEAR) a point says where the edge is, and one that agrees counts as landed with the
  // standing points' (half each); deep in the lawn or out on the drive it only says "not here"
  let ssum = 0, sn = 0, sBad = 0, sEdge = 0, sLanded = 0;
  if (g.lawnSd && surface.length) for (const [u, v, kind] of surface) {
    const sd = sample(g, g.lawnSd, c * u - s * v + T.tx, s * u + c * v + T.ty);
    if (!Number.isFinite(sd)) continue;
    const x = surfaceCost(kind, sd); ssum += x; sn++; if (x > 0.04) sBad++;
    if (Math.abs(sd) < EDGE_NEAR) { sEdge++; if (x < 0.01) sLanded++; }
  }
  const cost = (n ? sum / n : 0) + (gn ? groundW * gsum / gn : 0) + (sn ? surfW * ssum / sn : 0);
  const landedOf = n - (g.distRoof ? HIGH_W * (high.length - hHits) : 0);
  const out = { cost, hits: landedOf > 0 ? hits / landedOf : 0, landed: Math.round(hits + 0.5 * sLanded), tz };
  if (detail) { out.walls = walls; out.high = { n: g.distRoof ? high.length : 0, hits: hHits }; out.surface = { n: sn, off: sBad, edge: sEdge, landed: sLanded }; }
  return out;
}

/**
 * Where the phone is: the turn and shift that land its points on the lidar.
 * prior: { T } (a fit to start from: searched +-searchM and +-searchDeg round it) or { at: [e, n] (the map point the
 * phone stands on, e.g. GPS), phone: [u, v] (where it stands in AR), radiusM } (any turn). -> { T, cost, hits,
 * runnerUp: { cost, apartM, apartDeg }, ok, why }
 */
/* MIN_LANDED (2026-11-03, the owner's walk on a new lawn, SCAN-H3): on a thin flight (2.3 points a m2) most of what the
   phone sees standing -- shrubs, trunks, low branches -- is not in the lidar at all, and only 6% of its points landed
   even where the references placed them well; no ask passed the 50% share. With the references marked (they judge the
   fix, locate.js REF_TOL_M), enough points landing in number is enough: opts.minLanded. */
export const MIN_LANDED = 40;
// the coarse pass scores every candidate on this many standing points; 150 was too few once most of them land nowhere
export const COARSE_STAND = 400;
export function register(g, stand, ground, prior, { s = 1, searchM = 4, searchDeg = 15, stepM = 0.5, stepDeg = 3, minStand = 30, minHits = 0.5, minLanded = Infinity, high = [], surface = [] } = {}) {
  if (stand.length + (g.distRoof ? high.length : 0) < minStand) return { ok: false, why: `${stand.length + (g.distRoof ? high.length : 0)} standing points; ${minStand} wanted` };
  // coarse candidates: positions of the phone on the map, and turns
  const cands = [];
  if (prior?.T) {
    const T0 = prior.T;
    for (let dt = -searchDeg; dt <= searchDeg + 1e-9; dt += stepDeg) for (let dx = -searchM; dx <= searchM + 1e-9; dx += stepM) for (let dy = -searchM; dy <= searchM + 1e-9; dy += stepM) {
      cands.push({ theta: T0.theta + (dt * Math.PI) / 180, tx: T0.tx + dx, ty: T0.ty + dy, s });
    }
  } else if (prior?.at && prior?.phone) {
    const R = prior.radiusM ?? 15, step = Math.max(stepM, 1), dstep = Math.max(stepDeg, 4);
    for (let deg = 0; deg < 360; deg += dstep) {
      const th = (deg * Math.PI) / 180, c = Math.cos(th) * s, sn = Math.sin(th) * s;
      const pu = c * prior.phone[0] - sn * prior.phone[1], pv = sn * prior.phone[0] + c * prior.phone[1];
      for (let dx = -R; dx <= R + 1e-9; dx += step) for (let dy = -R; dy <= R + 1e-9; dy += step) {
        const e = prior.at[0] + dx, n = prior.at[1] + dy;
        if (!Number.isFinite(sample(g, g.dem, e, n))) continue;
        cands.push({ theta: th, tx: e - pu, ty: n - pv, s });
      }
    }
  } else return { ok: false, why: 'no starting guess' };
  // (2026-11-03, the owner's walk: "Cannot read properties of undefined (reading 'T')") GPS can put the phone off the
  // lidar this page read, and then there is nowhere to try
  if (!cands.length) return { ok: false, why: 'GPS puts you off the edge of the lidar read for this map' };
  // the coarse pass on a thinned set of points
  const thin = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));
  const st = thin(stand, COARSE_STAND), gr = thin(ground, 80), hi = thin(high, 80), su = thin(surface, 120);
  const scored = cands.map((T) => ({ T, cost: placementCost(g, st, gr, T, { high: hi, surface: su }).cost })).sort((a, b) => a.cost - b.cost);
  // refine the best few apart from each other
  const seeds = [];
  for (const x of scored) {
    if (seeds.length >= 4) break;
    if (seeds.every((y) => Math.hypot(x.T.tx - y.T.tx, x.T.ty - y.T.ty) > 2 || Math.abs(angDiff(x.T.theta, y.T.theta)) > (10 * Math.PI) / 180)) seeds.push(x);
  }
  const refined = seeds.map((x) => hop(g, stand, ground, refine(g, stand, ground, x.T, high, 0.5, surface), high, surface)).sort((a, b) => a.cost - b.cost);
  const best = refined[0];
  const other = refined.find((r) => Math.hypot(r.T.tx - best.T.tx, r.T.ty - best.T.ty) > 1 || Math.abs(angDiff(r.T.theta, best.T.theta)) > (5 * Math.PI) / 180);
  const m = placementCost(g, stand, ground, best.T, { high, surface, detail: true });
  const out = { T: best.T, cost: m.cost, hits: m.hits, tz: m.tz, walls: m.walls, high: m.high, surface: m.surface, runnerUp: other ? { cost: other.cost, apartM: Math.hypot(other.T.tx - best.T.tx, other.T.ty - best.T.ty), apartDeg: Math.abs(angDiff(other.T.theta, best.T.theta)) * 180 / Math.PI } : null };
  out.landed = m.landed;
  if (m.hits < minHits && m.landed < minLanded) return { ...out, ok: false, why: `only ${Math.round(m.hits * 100)}% of what the phone sees lands on the lidar (${m.landed} points)` };
  // two places fit about as well: by cost, and by how many points land (what lands nowhere at either costs the same at
  // both, and on a thin flight that is most of it, which pulls the costs together without making them alike)
  if (other && other.cost < best.cost * 1.25) {
    const mo = placementCost(g, stand, ground, other.T, { high, surface });
    out.runnerUp.landed = mo.landed;
    if (mo.landed * 1.25 > m.landed) return { ...out, ok: false, why: 'two places fit about as well' };
  }
  return { ...out, ok: true };
}

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Since each wall finds its own inset, the cost has shallow side hollows a pattern search can stop in (a degree or
 *  two off, a few tenths of a metre). So from where it stopped, start again a little turned and shifted each way and
 *  keep the lowest. */
function hop(g, stand, ground, best, high = [], surface = []) {
  const [mu, mv] = middle(stand);
  for (const [dd, dx, dy] of [[1.5, 0, 0], [-1.5, 0, 0], [3, 0, 0], [-3, 0, 0], [0, 0.3, 0], [0, -0.3, 0], [0, 0, 0.3], [0, 0, -0.3]]) {
    const T = best.T, th = T.theta + (dd * Math.PI) / 180;
    const c0 = Math.cos(T.theta) * T.s, s0 = Math.sin(T.theta) * T.s, c1 = Math.cos(th) * T.s, s1 = Math.sin(th) * T.s;
    const C = { ...T, theta: th, tx: T.tx + (c0 * mu - s0 * mv) - (c1 * mu - s1 * mv) + dx, ty: T.ty + (s0 * mu + c0 * mv) - (s1 * mu + c1 * mv) + dy };
    const r = refine(g, stand, ground, C, high, 0.25, surface);
    if (r.cost < best.cost - 1e-9) best = r;
  }
  return best;
}

/** Pattern search on (turn, east, north) from T, down to 1 cm and 0.05 degrees. */
function refine(g, stand, ground, T0, high = [], sm = 0.5, surface = []) {
  let T = { ...T0 }, cost = placementCost(g, stand, ground, T, { high, surface }).cost;
  let sd = ((4 * sm) * Math.PI) / 180;
  while (sm > 0.01) {
    let moved = false;
    for (const [k, d] of [['tx', sm], ['tx', -sm], ['ty', sm], ['ty', -sm], ['theta', sd], ['theta', -sd]]) {
      const C = { ...T, [k]: T[k] + d };
      // a turn about the phone's points' middle, not the AR origin, so turning does not also throw them sideways
      if (k === 'theta') { const [mu, mv] = middle(stand); const c0 = Math.cos(T.theta) * T.s, s0 = Math.sin(T.theta) * T.s, c1 = Math.cos(C.theta) * T.s, s1 = Math.sin(C.theta) * T.s; C.tx = T.tx + (c0 * mu - s0 * mv) - (c1 * mu - s1 * mv); C.ty = T.ty + (s0 * mu + c0 * mv) - (s1 * mu + c1 * mv); }
      const v = placementCost(g, stand, ground, C, { high, surface }).cost;
      if (v < cost - 1e-9) { T = C; cost = v; moved = true; }
    }
    if (!moved) { sm /= 2; sd /= 2; }
  }
  return { T, cost };
}
const middle = (pts) => { let u = 0, v = 0; for (const p of pts) { u += p[0]; v += p[1]; } return pts.length ? [u / pts.length, v / pts.length] : [0, 0]; };
