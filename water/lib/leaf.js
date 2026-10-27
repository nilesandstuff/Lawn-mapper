/**
 * WAS THE LIDAR FLOWN IN LEAF? Copied from the shade map's public/shade/find.js (leafSeason, laserSeason; features
 * session), unchanged in what it decides, so the water map asks its light worker for the same canopy the shade map
 * draws: a leaf-off flight's crowns get their summer leaves back (light-worker.js 'seasonal').
 */

/** 'off' when nine tenths of the days from startMs to endMs fall in November-April or before 11 May; 'on' when a tenth or fewer do; else 'mixed'. */
export function leafSeason(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  let off = 0, n = 0;
  for (let t = startMs; t <= endMs && n < 3660; t += 86400000, n++) {
    const d = new Date(t), m = d.getUTCMonth() + 1;
    if (m >= 11 || m <= 4 || (m === 5 && d.getUTCDate() <= 10)) off++;
  }
  const share = off / Math.max(1, n);
  return share >= 0.9 ? 'off' : share <= 0.1 ? 'on' : 'mixed';
}

/** The season of the points themselves (ept.js flownOf): by each piece's own day, the span when there are none. */
export function flightSeason(flown) {
  if (!flown) return null;
  if (!flown.mids?.length) return leafSeason(flown.start, flown.end);
  let off = 0;
  for (const m of flown.mids) if (leafSeason(m, m) === 'off') off++;
  const share = off / flown.mids.length;
  return share >= 0.9 ? 'off' : share <= 0.1 ? 'on' : 'mixed';
}

/**
 * The cells and blocks erased on the shade map (its part: { grid: { w, h, x0, y1 }, erased, cubes }), on the
 * water map's grid ({ W, H, bbox }). The water grid is the shade map's own when it has worked on the map (site.js
 * uses its box): then they are the same cells and the same blocks. Otherwise each erased cell goes by its middle
 * to the water cell under it, and the blocks are left out (their layers belong to the other grid).
 * -> { erased: Uint8Array(W*H) | null, cubes: Int32Array | null, cells: number }
 */
export function erasedOn(edits, g) {
  if (!edits?.grid || !Array.isArray(edits.erased) || !g?.bbox) return { erased: null, cubes: null, cells: 0 };
  const { w, h, x0, y1 } = edits.grid;
  const N = g.W * g.H, out = new Uint8Array(N);
  const cellW = (g.bbox[2] - g.bbox[0]) / g.W;
  const same = w === g.W && h === g.H && Math.abs(x0 - g.bbox[0]) < 0.05 && Math.abs(y1 - g.bbox[3]) < 0.05;
  let cells = 0;
  if (same) for (const k of edits.erased) { if (k >= 0 && k < N && !out[k]) { out[k] = 1; cells++; } }
  else {
    const sc = (edits.grid.cell ?? cellW);
    for (const k of edits.erased) {
      const c = k % w, r = Math.floor(k / w);
      const x = x0 + (c + 0.5) * sc, y = y1 - (r + 0.5) * sc;
      const cc = Math.floor((x - g.bbox[0]) / cellW), rr = Math.floor((g.bbox[3] - y) / cellW);
      if (cc >= 0 && rr >= 0 && cc < g.W && rr < g.H && !out[rr * g.W + cc]) { out[rr * g.W + cc] = 1; cells++; }
    }
  }
  const cubes = same && Array.isArray(edits.cubes) && edits.cubes.length ? Int32Array.from(edits.cubes) : null;
  return { erased: cells ? out : null, cubes, cells };
}
