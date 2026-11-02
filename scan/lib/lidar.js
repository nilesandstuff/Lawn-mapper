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

/** The lot's lidar as grids. pts: { e, n, z, cls } typed columns in map metres (count = e.length); box [e0, n0, e1, n1]. */
export function buildGrids(pts, box, { cell = 0.25, band = [0.25, 2.5], cap = 5, eave = 0.5 } = {}) {
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
  const occ = new Uint8Array(W * H);
  for (let i = 0; i < N; i++) {
    const c = pts.cls[i];
    if (c === 2 || c === 7 || c === 18 || c === 9 || c === 6) continue;
    const k = idx(pts.e[i], pts.n[i]); if (k < 0) continue;
    const h = pts.z[i] - dem[k];
    if (h > band[0] && h < band[1]) occ[k] = 1;
  }
  const bld = roofMask(pts, box, cell, W, H, dem);
  /* A building is its walls, not its inside (the phone cannot see in, and points landing inside a solid footprint
     would cost nothing wherever they went): the roof's footprint pulled in by the eaves (0.5 m), then its
     outline. */
  // the roof's points are sparser than the cells: grow the roof by 0.5 m to close it, then shrink it back by that and the eaves
  const grow = Math.max(1, Math.round(0.5 / cell));
  const walls = erode(dilate(bld, W, H, grow), W, H, grow + eave / cell);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c; if (!walls[k]) continue;
    if (r === 0 || c === 0 || r === H - 1 || c === W - 1 || !walls[k - 1] || !walls[k + 1] || !walls[k - W] || !walls[k + W]) occ[k] = 1;
  }
  let solid = 0; for (let k = 0; k < occ.length; k++) solid += occ[k];
  return { box, cell, W, H, dem, occ, dist: distanceField(occ, W, H, cell, cap), solid };
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
export function placementCost(g, stand, ground, T, { trunc = 1, groundW = 0.5, groundTrunc = 0.3 } = {}) {
  const c = Math.cos(T.theta) * T.s, s = Math.sin(T.theta) * T.s;
  let sum = 0, n = 0, hits = 0;
  for (const [u, v] of stand) {
    const d = sample(g, g.dist, c * u - s * v + T.tx, s * u + c * v + T.ty);
    const dd = Number.isFinite(d) ? Math.min(d, trunc) : trunc;
    sum += dd * dd; n++; if (dd < 0.3) hits++;
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
  const cost = (n ? sum / n : 0) + (gn ? groundW * gsum / gn : 0);
  return { cost, hits: n ? hits / n : 0, tz };
}

/**
 * Where the phone is: the turn and shift that land its points on the lidar.
 * prior: { T } (a fit to start from: searched +-searchM and +-searchDeg round it) or { at: [e, n] (the map point the
 * phone stands on, e.g. GPS), phone: [u, v] (where it stands in AR), radiusM } (any turn). -> { T, cost, hits,
 * runnerUp: { cost, apartM, apartDeg }, ok, why }
 */
export function register(g, stand, ground, prior, { s = 1, searchM = 4, searchDeg = 15, stepM = 0.5, stepDeg = 3, minStand = 30, minHits = 0.5 } = {}) {
  if (stand.length < minStand) return { ok: false, why: `${stand.length} standing points; ${minStand} wanted` };
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
  // the coarse pass on a thinned set of points
  const thin = (a, m) => (a.length <= m ? a : a.filter((_, i) => i % Math.ceil(a.length / m) === 0));
  const st = thin(stand, 150), gr = thin(ground, 80);
  const scored = cands.map((T) => ({ T, cost: placementCost(g, st, gr, T).cost })).sort((a, b) => a.cost - b.cost);
  // refine the best few apart from each other
  const seeds = [];
  for (const x of scored) {
    if (seeds.length >= 4) break;
    if (seeds.every((y) => Math.hypot(x.T.tx - y.T.tx, x.T.ty - y.T.ty) > 2 || Math.abs(angDiff(x.T.theta, y.T.theta)) > (10 * Math.PI) / 180)) seeds.push(x);
  }
  const refined = seeds.map((x) => refine(g, stand, ground, x.T)).sort((a, b) => a.cost - b.cost);
  const best = refined[0];
  const other = refined.find((r) => Math.hypot(r.T.tx - best.T.tx, r.T.ty - best.T.ty) > 1 || Math.abs(angDiff(r.T.theta, best.T.theta)) > (5 * Math.PI) / 180);
  const m = placementCost(g, stand, ground, best.T);
  const out = { T: best.T, cost: m.cost, hits: m.hits, tz: m.tz, runnerUp: other ? { cost: other.cost, apartM: Math.hypot(other.T.tx - best.T.tx, other.T.ty - best.T.ty), apartDeg: Math.abs(angDiff(other.T.theta, best.T.theta)) * 180 / Math.PI } : null };
  if (m.hits < minHits) return { ...out, ok: false, why: `only ${Math.round(m.hits * 100)}% of what the phone sees lands on the lidar` };
  if (other && other.cost < best.cost * 1.25) return { ...out, ok: false, why: 'two places fit about as well' };
  return { ...out, ok: true };
}

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Pattern search on (turn, east, north) from T, down to 1 cm and 0.05 degrees. */
function refine(g, stand, ground, T0) {
  let T = { ...T0 }, cost = placementCost(g, stand, ground, T).cost;
  let sm = 0.5, sd = (2 * Math.PI) / 180;
  while (sm > 0.01) {
    let moved = false;
    for (const [k, d] of [['tx', sm], ['tx', -sm], ['ty', sm], ['ty', -sm], ['theta', sd], ['theta', -sd]]) {
      const C = { ...T, [k]: T[k] + d };
      // a turn about the phone's points' middle, not the AR origin, so turning does not also throw them sideways
      if (k === 'theta') { const [mu, mv] = middle(stand); const c0 = Math.cos(T.theta) * T.s, s0 = Math.sin(T.theta) * T.s, c1 = Math.cos(C.theta) * T.s, s1 = Math.sin(C.theta) * T.s; C.tx = T.tx + (c0 * mu - s0 * mv) - (c1 * mu - s1 * mv); C.ty = T.ty + (s0 * mu + c0 * mv) - (s1 * mu + c1 * mv); }
      const v = placementCost(g, stand, ground, C).cost;
      if (v < cost - 1e-9) { T = C; cost = v; moved = true; }
    }
    if (!moved) { sm /= 2; sd /= 2; }
  }
  return { T, cost };
}
const middle = (pts) => { let u = 0, v = 0; for (const p of pts) { u += p[0]; v += p[1]; } return pts.length ? [u / pts.length, v / pts.length] : [0, 0]; };
