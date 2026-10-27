/**
 * WHAT STANDS IN THE WIND'S WAY, over a wide box (owner, 2026-10-27: "looking into wind so that we get true localized
 * effects rather than broad area averages. If you have to pull a wider area for lidar than you currently do, do what
 * you need to do"; FINDINGS H50).
 *
 * The lidar's coarse levels over a box a few hundred metres round the lot (ept.js pointsIn with spacingM), on a coarse
 * grid: per cell the ground (its lowest ground return, holes filled from around), the top of whatever stands there,
 * and whether that is a building or vegetation: buildings by Overture's outlines (overture.js, which the water map
 * already reads for roofs and paving) or the survey's class 6 where it has one; anything else standing 1.5 m or more
 * is vegetation (many surveys class only ground and the rest: the owner's, 1, 2 and 7). Not a tree model: the wind
 * takes from it only what stands where, how tall. Inside the shade map's grid the shade map's own kinds and heights are used instead
 * (wind.js shelter, which takes both).
 */
const NOISE = new Set([7, 18]);

/**
 * cols (ept columns), bbox (3857), lat, cellM -> { W, H, cell (m), x0, y1, k (3857 units per m), ground, height
 * (top above ground, m), kind (0 open, 1 building, 2 vegetation) }
 */
import { overtureMasks } from './overture.js';

export function obstacleGrid(cols, bbox, lat, cellM = 4, { buildings = null, standShare = 0.4 } = {}) {
  const k = 1 / Math.cos((lat * Math.PI) / 180), cs = cellM * k;
  const W = Math.max(1, Math.round((bbox[2] - bbox[0]) / cs)), H = Math.max(1, Math.round((bbox[3] - bbox[1]) / cs)), N = W * H;
  const ground = new Float32Array(N).fill(NaN), top = new Float32Array(N).fill(-Infinity);
  const nB = new Uint16Array(N), nV = new Uint16Array(N), nAll = new Uint16Array(N), zs = Array.from({ length: N }, () => null);
  for (let i = 0; i < cols.n; i++) {
    const cl = cols.cls[i];
    if (NOISE.has(cl)) continue;
    const c = Math.floor((cols.x[i] - bbox[0]) / cs), r = Math.floor((bbox[3] - cols.y[i]) / cs);
    if (c < 0 || r < 0 || c >= W || r >= H) continue;
    const j = r * W + c, z = cols.z[i];
    if (cl === 2 && !(ground[j] <= z)) ground[j] = z;
    if (z > top[j]) top[j] = z;
    if (nAll[j] < 65535) nAll[j]++;
    (zs[j] ||= []).push(z);
    if (cl === 6 && nB[j] < 65535) nB[j]++;
    if (cl >= 3 && cl <= 5 && nV[j] < 65535) nV[j]++;
  }
  // ground holes (under roofs, dense crowns): the mean of the ground around, widening until found
  for (let pass = 0; pass < 12; pass++) {
    let left = 0;
    const g2 = Float32Array.from(ground);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const j = r * W + c;
      if (!Number.isNaN(ground[j])) continue;
      let s = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const v = ground[rr * W + cc];
        if (!Number.isNaN(v)) { s += v; n++; }
      }
      if (n) g2[j] = s / n; else left++;
    }
    ground.set(g2);
    if (!left) break;
  }
  // Overture's building outlines on this grid, by cell centre
  const ovB = buildings?.length ? overtureMasks({ W, H, cell: cellM, toCell: (x, y) => [(x - bbox[0]) / cs, (bbox[3] - y) / cs] }, { roads: [], buildings }).building : null;
  /* Each cell: its standing share (returns 1.5 m or more above its ground: how much of it is crown or roof, from
     above) and the height most of its standing returns reach (their 90th percentile; one stray return does not make
     a tree). A cell under a building outline is building; otherwise vegetation when at least standShare of its
     returns stand: 0.4, calibrated on the shade map's own crowns over the owner's grid (40% cover against its 39%,
     the same call on 85% of the cells; FINDINGS H50). */
  const height = new Float32Array(N), kind = new Uint8Array(N), stand = new Float32Array(N), base = new Float32Array(N);
  let zMin = Infinity; for (const v of ground) if (v < zMin) zMin = v;
  for (let j = 0; j < N; j++) {
    if (Number.isNaN(ground[j])) ground[j] = zMin;
    const hs = (zs[j] || []).map((z) => z - ground[j]).filter((h) => h >= 1.5).sort((a, b) => a - b);
    stand[j] = nAll[j] ? hs.length / nAll[j] : 0;
    height[j] = hs.length ? hs[Math.floor(0.9 * (hs.length - 1))] : 0;
    base[j] = hs.length ? hs[Math.floor(0.1 * (hs.length - 1))] : 0; // the crown's underside, roughly: its lowest standing returns
    kind[j] = (ovB && ovB[j]) || (nB[j] > 0 && nB[j] >= nV[j]) ? (height[j] >= 1.5 ? 1 : 0) : stand[j] >= standShare ? 2 : 0;
  }
  return { W, H, cell: cellM, x0: bbox[0], y1: bbox[3], k, ground, height, kind, stand, base };
}

/**
 * The near field at full density: on the water map's own 1 m grid ({ W, H, bbox }), the height most standing returns
 * reach above its ground (z) and the crown's underside, as obstacleGrid does over the wide box.
 */
export function nearHeights(cols, grid, z) {
  const { W, H, bbox } = grid, N = W * H, cs = (bbox[2] - bbox[0]) / W;
  const zs = Array.from({ length: N }, () => null);
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const c = Math.floor((cols.x[i] - bbox[0]) / cs), r = Math.floor((bbox[3] - cols.y[i]) / cs);
    if (c < 0 || r < 0 || c >= W || r >= H) continue;
    const j = r * W + c, h = cols.z[i] - z[j];
    if (h >= 1.5) (zs[j] ||= []).push(h);
  }
  const height = new Float32Array(N), base = new Float32Array(N);
  for (let j = 0; j < N; j++) { const a = zs[j]; if (!a) continue; a.sort((x, y) => x - y); height[j] = a[Math.floor(0.9 * (a.length - 1))]; base[j] = a[Math.floor(0.1 * (a.length - 1))]; }
  return { height, base };
}

/**
 * One 1 m grid for the wind: the water map's grid padded `pad` cells all round. Beyond the water grid, the wide box's
 * coarse cells (og); on it, the shade map's own reading of each cell (kinds: 1 roof, 2 evergreen, 3 deciduous) with
 * the full-density heights (near), or og's where the shade map gave none.
 * -> { W, H, kind, height, base, pad }
 */
export function windGrid(grid, og, near, shadeKinds, pad = 150) {
  const W = grid.W + 2 * pad, H = grid.H + 2 * pad, N = W * H;
  const kind = new Uint8Array(N), height = new Float32Array(N), base = new Float32Array(N);
  const cs = (grid.bbox[2] - grid.bbox[0]) / grid.W, ocs = og ? og.cell * og.k : 1;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const j = r * W + c, gc = c - pad, gr = r - pad;
    const inside = gc >= 0 && gr >= 0 && gc < grid.W && gr < grid.H;
    if (inside && shadeKinds) {
      const i = gr * grid.W + gc, k = shadeKinds[i];
      kind[j] = k >= 1 && k <= 3 ? k : 0; height[j] = near.height[i]; base[j] = near.base[i];
      continue;
    }
    if (!og) continue;
    const x = grid.bbox[0] + (gc + 0.5) * cs, y = grid.bbox[3] - (gr + 0.5) * cs;
    const oc = Math.floor((x - og.x0) / ocs), orr = Math.floor((og.y1 - y) / ocs);
    if (oc < 0 || orr < 0 || oc >= og.W || orr >= og.H) continue;
    const o = orr * og.W + oc;
    kind[j] = og.kind[o] === 1 ? 1 : og.kind[o] === 2 ? 3 : 0; // the wide box's vegetation taken as deciduous (most yard trees here)
    height[j] = og.height[o]; base[j] = og.base[o];
  }
  return { W, H, kind, height, base, pad };
}

/** The share of the ground within radiusM (m) of a cell of the wind grid under buildings and crowns. */
export function coverWithin(wg, cx, cy, radiusM = 90) {
  let n = 0, hit = 0;
  for (let r = Math.max(0, Math.floor(cy - radiusM)); r <= Math.min(wg.H - 1, Math.ceil(cy + radiusM)); r += 2) {
    for (let c = Math.max(0, Math.floor(cx - radiusM)); c <= Math.min(wg.W - 1, Math.ceil(cx + radiusM)); c += 2) {
      if ((c - cx) ** 2 + (r - cy) ** 2 > radiusM * radiusM) continue;
      n++; if (wg.kind[r * wg.W + c] && wg.height[r * wg.W + c] >= 1.5) hit++;
    }
  }
  return n ? hit / n : 0;
}
