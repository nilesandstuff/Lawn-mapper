/**
 * WHERE WATER GOES ON A GROUND SURFACE (water session).
 *
 * Three questions, on the grid lib/surface.js makes (row 0 north, real
 * meters, buildings as walls water cannot cross):
 *
 *   lowSpots      Every closed low spot: fill the surface until nothing is
 *                 left with no way down (Priority-Flood, Barnes, Lehman &
 *                 Mulla 2014, doi:10.1016/j.cageo.2013.04.024), and what the
 *                 filling added is where water stands. Each spot gets its
 *                 deepest point, area, volume, and the error bar on its depth
 *                 from surface.js's `se`. A spot is only REPORTED when it is
 *                 deeper than MIN_DEPTH and than `floor` (the deepest spot
 *                 pure noise makes on this flight's ground, lib/lowspots.js),
 *                 and at least MIN_AREA across. The error bar alone is not a
 *                 test: filling picks the LOWEST bottom and the HIGHEST rim
 *                 the noise offers, so on flat ground noise alone digs spots
 *                 three or four error bars deep (found 2026-10-16 on made-up
 *                 ground, FINDINGS H3).
 *
 *   flow          Where water runs once the low spots are full: steepest
 *                 descent (D8) over the filled surface, with a hair of slope
 *                 added across flats so they drain toward their outlet, and
 *                 how much ground drains through each cell (m^2).
 *
 *   foundation    The ground within 3 m of each building: does it fall away
 *                 from the wall or toward it? The slope is a least-squares
 *                 plane through the surface around each cell (5 x 5 m),
 *                 taken along the line to the nearest wall. The building
 *                 code's number (IRC R401.3) is a fall of 6 inches in the
 *                 first 10 feet away from a foundation: 5%.
 *
 * What none of this sees, said where it will be read: where downspouts
 * empty (roof water is a lawn's largest single source and its outlets are
 * not in the lidar), anything regraded since the flight, and how fast the
 * soil takes water in. A low spot here is where water WOULD collect if it
 * did not soak in first.
 */

export const MIN_DEPTH = 0.03;     // m
export const MIN_AREA = 4;         // m^2, cells at least 1 cm deep
export const WET_CM = 0.01;        // a cell counts toward a spot's area from 1 cm deep

/* -------------------------------------------------------- a binary heap */

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

const N8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/**
 * Priority-Flood. `wall[i]` cells are never entered (and so never drain
 * anything); the box's edge is the outlet. With eps > 0 every filled cell
 * ends a hair above the cell it was reached from, so flats drain.
 */
export function fill(g, z, wall, eps = 0) {
  const N = g.W * g.H;
  const out = Float64Array.from(z);
  const seen = new Uint8Array(N);
  const heap = new Heap();
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    if (r && c && r < g.H - 1 && c < g.W - 1) continue;
    const i = r * g.W + c;
    if (wall[i]) continue;
    seen[i] = 1; heap.push(out[i], i);
  }
  while (heap.size) {
    const i = heap.pop();
    const r = Math.floor(i / g.W), c = i % g.W;
    for (const [dr, dc] of N8) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
      const j = rr * g.W + cc;
      if (seen[j] || wall[j]) continue;
      seen[j] = 1;
      const floor = eps ? out[i] + eps : out[i];
      if (out[j] < floor) out[j] = floor;
      heap.push(out[j], j);
    }
  }
  // cells walled in completely (a courtyard) drain nowhere: leave them as they are
  for (let i = 0; i < N; i++) if (!seen[i] && !wall[i]) out[i] = z[i];
  return out;
}

/** Closed low spots, deepest first. See the header for which are reported. */
export function lowSpots(g, z, se, wall, opts = {}) {
  const { minDepth = MIN_DEPTH, floor = 0, minArea = MIN_AREA, wet = WET_CM } = opts;
  const N = g.W * g.H;
  const filled = fill(g, z, wall);
  const depth = new Float32Array(N);
  for (let i = 0; i < N; i++) depth[i] = wall[i] ? 0 : Math.max(0, filled[i] - z[i]);
  // a spot is a connected patch of the filled surface standing over the ground
  const label = new Int32Array(N);
  const spots = [];
  for (let s = 0; s < N; s++) {
    if (label[s] || depth[s] <= 1e-4) continue;
    const id = spots.length + 1;
    const cells = [s];
    label[s] = id;
    for (let q = 0; q < cells.length; q++) {
      const i = cells[q], r = Math.floor(i / g.W), c = i % g.W;
      for (const [dr, dc] of N8) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const j = rr * g.W + cc;
        if (!label[j] && depth[j] > 1e-4) { label[j] = id; cells.push(j); }
      }
    }
    let deepest = cells[0], vol = 0, wetCells = 0, edge = false, house = false;
    let rimSe = [];
    for (const i of cells) {
      if (depth[i] > depth[deepest]) deepest = i;
      vol += depth[i] * g.cell * g.cell;
      if (depth[i] >= wet) wetCells++;
      const r = Math.floor(i / g.W), c = i % g.W;
      if (r < 3 || c < 3 || r >= g.H - 3 || c >= g.W - 3) edge = true;
      for (const [dr, dc] of N8) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const j = rr * g.W + cc;
        if (wall[j]) house = true;
        else if (depth[j] <= 1e-4 && Number.isFinite(se[j])) rimSe.push(se[j]);
      }
    }
    rimSe.sort((a, b) => a - b);
    const seRim = rimSe.length ? rimSe[rimSe.length >> 1] : 0.02;
    const seBottom = Number.isFinite(se[deepest]) ? se[deepest] : 0.02;
    const sigma = Math.hypot(seRim, seBottom);
    const d = depth[deepest];
    const area = wetCells * g.cell * g.cell;
    spots.push({
      id, cells, deepest, depth: d, sigma, area, volume: vol, againstBuilding: house, atEdge: edge,
      row: Math.floor(deepest / g.W), col: deepest % g.W,
      reported: d >= minDepth && d > floor && area >= minArea,
    });
  }
  spots.sort((a, b) => b.depth - a.depth);
  return { filled, depth, label, spots };
}

/** D8 over the filled surface: { down (next cell or -1), area (m^2 draining through each cell) }. */
export function flow(g, z, wall) {
  const N = g.W * g.H;
  const f = fill(g, z, wall, 1e-5);
  const down = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (wall[i]) continue;
    const r = Math.floor(i / g.W), c = i % g.W;
    let best = -1, bestDrop = 0;
    for (const [dr, dc] of N8) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
      const j = rr * g.W + cc;
      if (wall[j]) continue;
      const drop = (f[i] - f[j]) / Math.hypot(dr, dc);
      if (drop > bestDrop) { bestDrop = drop; best = j; }
    }
    down[i] = best;
  }
  const order = Array.from({ length: N }, (_, i) => i).filter((i) => !wall[i]).sort((a, b) => f[b] - f[a]);
  const area = new Float32Array(N);
  for (const i of order) area[i] += g.cell * g.cell;
  for (const i of order) if (down[i] >= 0) area[down[i]] += area[i];
  return { down, area, filled: f };
}

/**
 * Distance (m) to the nearest wall cell within `reach` m, and which cell
 * that is (-1 and Infinity beyond it). A plain window search: only the strip
 * beside the walls is ever asked about.
 */
export function wallDistance(g, wall, reach = 4) {
  const N = g.W * g.H;
  const dist = new Float32Array(N).fill(Infinity);
  const near = new Int32Array(N).fill(-1);
  const R = Math.ceil(reach / g.cell);
  for (let i = 0; i < N; i++) {
    if (wall[i]) { dist[i] = 0; near[i] = i; continue; }
    const r = Math.floor(i / g.W), c = i % g.W;
    for (let rr = Math.max(0, r - R); rr <= Math.min(g.H - 1, r + R); rr++) {
      for (let cc = Math.max(0, c - R); cc <= Math.min(g.W - 1, c + R); cc++) {
        const j = rr * g.W + cc;
        if (!wall[j]) continue;
        const d = Math.hypot(rr - r, cc - c) * g.cell;
        if (d < dist[i]) { dist[i] = d; near[i] = j; }
      }
    }
  }
  return { dist, near };
}

/**
 * Least-squares plane through the surface in a (2h+1)^2 window, skipping
 * walls and cells with no ground of their own: { gx, gy } in m per m, east
 * and NORTH positive, and the slope's standard error.
 */
export function planeSlope(g, z, ok, r0, c0, h = 2) {
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  const pts = [];
  for (let r = r0 - h; r <= r0 + h; r++) for (let c = c0 - h; c <= c0 + h; c++) {
    if (r < 0 || c < 0 || r >= g.H || c >= g.W) continue;
    const i = r * g.W + c;
    if (!ok[i]) continue;
    const x = (c - c0) * g.cell, y = (r0 - r) * g.cell, v = z[i];
    pts.push([x, y, v]);
    n++; sx += x; sy += y; sz += v; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * v; syz += y * v;
  }
  if (n < 6) return null;
  const mx = sx / n, my = sy / n, mz = sz / n;
  const a = sxx / n - mx * mx, b = sxy / n - mx * my, d = syy / n - my * my;
  const ex = sxz / n - mx * mz, ey = syz / n - my * mz;
  const det = a * d - b * b;
  if (det < 1e-6) return null;
  const gx = (d * ex - b * ey) / det, gy = (a * ey - b * ex) / det;
  let rss = 0;
  for (const [x, y, v] of pts) rss += (v - (mz + gx * (x - mx) + gy * (y - my))) ** 2;
  const s2 = rss / Math.max(1, n - 3);
  return { gx, gy, se: Math.sqrt(s2 / (n * Math.min(a, d))) };
}

/**
 * The ground beside each building. For every cell 0.5-3 m from a wall, the
 * fall AWAY from the wall along the line to its nearest wall cell (positive:
 * water runs off, away from the house). Then, per wall cell on a building's
 * outline, the median of the cells that lean on it; and stretches of outline
 * where the ground falls toward the house by more than `toward`.
 *
 * The cells next to the wall are judged on the ground AROUND them, which is
 * the point -- the 1 m strip at the foundation is often a planting bed whose
 * mulch is not in a 2017 survey anyway.
 */
export function foundation(g, z, groundOk, wall, { inner = 0.5, outer = 3, toward = -0.01, code = 0.05 } = {}) {
  const N = g.W * g.H;
  const { dist, near } = wallDistance(g, wall);
  const perWall = new Map();
  const ring = [];
  for (let i = 0; i < N; i++) {
    if (wall[i] || dist[i] < inner || dist[i] > outer) continue;
    const r = Math.floor(i / g.W), c = i % g.W;
    const s = planeSlope(g, z, groundOk, r, c);
    if (!s) continue;
    const w = near[i], wr = Math.floor(w / g.W), wc = w % g.W;
    const ux = (wc - c), uy = (r - wr), len = Math.hypot(ux, uy) || 1;
    const fallAway = (s.gx * ux + s.gy * uy) / len; // rise toward the wall = fall away from it
    ring.push({ i, fallAway, se: s.se });
    if (!perWall.has(w)) perWall.set(w, []);
    perWall.get(w).push(fallAway);
  }
  const walls = [];
  for (const [w, v] of perWall) {
    v.sort((a, b) => a - b);
    walls.push({ i: w, row: Math.floor(w / g.W), col: w % g.W, fallAway: v[v.length >> 1], n: v.length });
  }
  const towardCells = walls.filter((w) => w.fallAway < toward);
  const flatCells = walls.filter((w) => w.fallAway >= toward && w.fallAway < code);
  const share = (a) => (walls.length ? a.length / walls.length : 0);
  return {
    ring, walls,
    summary: {
      outlineCells: walls.length,
      towardShare: share(towardCells),
      underCodeShare: share(flatCells),
      meetsCodeShare: share(walls.filter((w) => w.fallAway >= code)),
      medianFallAway: walls.length ? walls.map((w) => w.fallAway).sort((a, b) => a - b)[walls.length >> 1] : null,
    },
  };
}
