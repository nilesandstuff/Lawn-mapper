/**
 * WHAT THE WATER MAP TAKES FROM THE SHADE MAP'S OWN PART AND RULES (owner, 2026-10-27: "you should follow the output
 * of the shade map... Re use the shade map's work, for uniformity"): the flight's leaf season by the shade map's own
 * rule (lib/shade/find.js, a link to public/shade/find.js), so the light worker is asked for the canopy the shade
 * map draws; and the trees erased on it.
 */
import { flightOf, leafSeason } from './shade/find.js';

export { leafSeason };

/** The season of the points themselves (ept.js flownOf), as the shade map reads it: 'off' | 'on' | 'mixed' | null. */
export const flightSeason = (flown) => (flown ? flightOf(null, flown)?.season ?? null : null);

/**
 * The cells and blocks erased on the shade map (its part: { grid: { w, h, x0, y1 }, erased, cubes }), on the
 * water map's grid ({ W, H, bbox }). The water grid is the shade map's own when it has worked on the map (site.js
 * uses its box): then they are the same cells and the same blocks. Otherwise each erased cell goes by its middle
 * to the water cell under it, and the blocks are left out (their layers belong to the other grid).
 * -> { erased: Uint8Array(W*H) | null, cubes: Int32Array | null, cells, blocks, blocksLost }
 */
export function erasedOn(edits, g) {
  if (!edits?.grid || !Array.isArray(edits.erased) || !g?.bbox) return { erased: null, cubes: null, cells: 0, blocks: 0, blocksLost: 0 };
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
  const asked = Array.isArray(edits.cubes) ? edits.cubes.length : 0;
  const cubes = same && asked ? Int32Array.from(edits.cubes) : null;
  // blocksLost: trimmed branches that could not come over (another grid), said on the page
  return { erased: cells ? out : null, cubes, cells, blocks: cubes ? cubes.length : 0, blocksLost: cubes ? 0 : asked };
}
