/**
 * HOW MUCH OF THE LIDAR'S CROWN SITS IN AIR A WALK SAW EMPTY IN ANY SEASON (core session, 2026-11-24;
 * docs/SCAN-PLAN.md 62; the owner, on the three reasons to take lidar crown away: branches trimmed since the flight,
 * whole trees gone, and lidar shapes drifted off the real canopy). The walk's side is `plants.clearHigh`, read onto
 * the fused grid by the fusing's own band reader (fuse.js openHighFromSeen: { lo, hi } metres over the ground per
 * half-metre cell, NaN where no claim). This counts, without changing anything:
 *   - the lidar's crown cubes (half-metre cells of a tree column's layers with density) inside that air, by height,
 *     and how many are a deciduous crown's (the summer copy denser), which the fusing leaves alone after a leaf-off walk;
 *   - the lidar's ROOF cubes inside it (a roof in air the walk saw empty says the walk or the lidar is misplaced);
 *   - each lidar tree clump (tree columns, 8-neighbour): how much of its crown from 8 to 30 ft is in that air. A clump
 *     nearly all of whose lower crown the walk saw empty is a tree that may be gone (the owner: "Zero branches... seen
 *     within a certain distance of the ground where lidar says there should be tree, means that tree is gone").
 * Pure: (lidar { meta, arrays }, clear { lo, hi } on the fused grid, sub) -> stats.
 */
const FT = 3.28084;
const TREE = (k) => k === 2 || k === 3;
const ROOF = (k) => k === 1 || k === 4;

export function lidarInClear(lidar, clear, sub = 2) {
  const { meta, arrays } = lidar;
  const G = meta.grid, { z0, dz, nz } = meta.layers;
  const W = G.w, H = G.h, w = W * sub, h = H * sub;
  const { mu, muOn, kind, ground } = arrays;
  const bands = [[8, 16], [16, 30], [30, 50], [50, 200]];
  const out = { cells: 0, crown: 0, crownDecid: 0, roof: 0, byHeight: bands.map(([a, b]) => ({ from: a, to: b, cubes: 0 })), clumps: null };
  // the lidar's tree clumps on its own grid
  const id = new Int32Array(W * H).fill(-1);
  let n = 0;
  for (let s = 0; s < W * H; s++) {
    if (!TREE(kind[s]) || id[s] >= 0) continue;
    const q = [s]; id[s] = n;
    for (let i = 0; i < q.length; i++) {
      const k = q[i], x = k % W, y = (k / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (TREE(kind[j]) && id[j] < 0) { id[j] = n; q.push(j); }
      }
    }
    n++;
  }
  const lower = new Float64Array(n), lowerClear = new Float64Array(n), upper = new Float64Array(n), cols = new Int32Array(n);
  for (let s = 0; s < W * H; s++) if (id[s] >= 0) cols[id[s]]++;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const f = r * w + c, p = ((r / sub) | 0) * W + ((c / sub) | 0);
    const lo = clear.lo[f], hi = clear.hi[f], has = hi > lo;
    if (has) out.cells++;
    const g = ground[p];
    for (let l = 0; l < nz; l++) {
      const m = mu[p * nz + l];
      if (!(m > 0)) continue;
      const zb = z0 + l * dz - g, zt = zb + dz, mid = (zb + zt) / 2;
      const inside = has && Math.max(0, Math.min(zt, hi) - Math.max(zb, lo)) >= dz / 2;
      if (TREE(kind[p])) {
        const k = id[p];
        if (mid * FT >= 8 && mid * FT < 30) { lower[k]++; if (inside) lowerClear[k]++; } else if (mid * FT >= 30) upper[k]++;
        if (inside) {
          out.crown++;
          if (muOn && muOn[p * nz + l] > m + 1e-6) out.crownDecid++;
          for (const b of out.byHeight) if (mid * FT >= b.from && mid * FT < b.to) b.cubes++;
        }
      } else if (ROOF(kind[p]) && inside) out.roof++;
    }
  }
  const hist = { none: 0, under25: 0, to50: 0, to90: 0, over90: 0, notJudged: 0 };
  const gone = [];
  for (let k = 0; k < n; k++) {
    if (lower[k] < 8) { hist.notJudged++; continue; }
    const fr = lowerClear[k] / lower[k];
    if (fr === 0) hist.none++; else if (fr < 0.25) hist.under25++; else if (fr < 0.5) hist.to50++; else if (fr < 0.9) hist.to90++; else { hist.over90++; gone.push({ cols: cols[k], lower: lower[k], upper: upper[k] }); }
  }
  out.clumps = { n, hist, mostlyClear: gone };
  return out;
}
