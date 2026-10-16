/**
 * WHAT THE LOW-SPOT MAP CAN FIND, ON MADE-UP GROUND (water session).
 *
 * Smooth dishes of known width and depth, alone in a 50 m lot (plus 20 m
 * round it), on flat ground and on ground falling 1%, at the ground
 * densities and point scatter West Michigan's flights have (FINDINGS H1,
 * H2). For each: how often the map reports it (a spot within 3 m of its
 * middle, or within its own radius), and how many it reports that are not
 * there. Results are binned by the water each dish REALLY holds (the noise-
 * free surface, filled), since a dish on a slope spills on its low side. The noise
 * floor is computed per density and scatter exactly as for a real lot
 * (lib/lowspots.js noiseFloor), then held fixed across the dishes.
 *
 *   SEEDS=10 node water/tools/limits.mjs
 */

import { cloud, dish, LAT } from '../lib/synthetic.js';
import { analyse, noiseFloor } from '../lib/lowspots.js';
import { gridFor } from '../lib/surface.js';
import { fill } from '../lib/hydro.js';

const SEEDS = Number(process.env.SEEDS || 10);
const SIZE = 90, PAD = 20, LOT = [PAD, PAD, SIZE - PAD, SIZE - PAD];
const DENSITIES = [1.2, 3];
const SCATTERS = [0.025, 0.035];
const WIDTHS = [3, 5, 8, 12];
const DEPTHS = [0.03, 0.05, 0.08, 0.12];
const SLOPES = [0, 0.005, 0.01];

/** The water a dish really holds: the deepest filled depth on the exact surface, no noise. */
function heldDepth(height) {
  const { bbox } = cloud({ size: SIZE, density: 0.01, height: () => 0 });
  const g = gridFor(bbox, LAT, 0.25);
  const z = new Float64Array(g.W * g.H);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) z[r * g.W + c] = height((c + 0.5) * g.cell, SIZE - (r + 0.5) * g.cell);
  const f = fill(g, z, new Uint8Array(g.W * g.H));
  let d = 0;
  for (let i = 0; i < z.length; i++) d = Math.max(d, f[i] - z[i]);
  return d;
}

const HELD = [[0.02, 0.03], [0.03, 0.045], [0.045, 0.065], [0.065, 0.09], [0.09, 0.2]];
const binOf = (d) => HELD.findIndex(([a, b]) => d >= a && d < b);

const rows = [];
for (const density of DENSITIES) for (const scatter of SCATTERS) {
  const { bbox } = cloud({ size: SIZE, density: 0.01, height: () => 0 });
  const nf = noiseFloor(bbox, LAT, density, scatter, { within: LOT });
  let fp = 0, runs = 0;
  const hits = {}, tries = {};
  for (const slope of SLOPES) for (const w of WIDTHS) for (const d of DEPTHS) {
    const bowl = dish(SIZE / 2, SIZE / 2, w / 2, d);
    const height = (x, y) => slope * x + bowl(x, y);
    const bin = binOf(heldDepth(height));
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = cloud({ size: SIZE, density, noise: scatter, seed: 1000 * seed + w * 10 + Math.round(d * 100) + slope * 1e4, height });
      const res = analyse(c.cols, c.bbox, LAT, { within: LOT, floor: nf.floor });
      const mid = SIZE / 2;
      let found = false;
      for (const s of res.spots.spots) {
        if (!s.reported || s.col < LOT[0] || s.col >= LOT[2] || s.row < LOT[1] || s.row >= LOT[3]) continue;
        if (Math.hypot(s.col + 0.5 - mid, s.row + 0.5 - mid) <= Math.max(3, w / 2)) found = true;
        else fp++;
      }
      runs++;
      if (bin < 0) continue;
      const key = `${w}|${bin}`;
      tries[key] = (tries[key] || 0) + 1;
      hits[key] = (hits[key] || 0) + (found ? 1 : 0);
    }
  }
  rows.push({ density, scatter, floor: nf.floor, fpPerLot: fp / runs, hits, tries });
}

for (const r of rows) {
  console.log(`\n${r.density} ground pts/m^2, ${(r.scatter * 100).toFixed(1)} cm scatter: noise floor ${(r.floor * 100).toFixed(1)} cm, ${r.fpPerLot.toFixed(3)} false spots per 50 m lot`);
  console.log(`  water held        across ->  ${WIDTHS.map((w) => `${w} m`.padStart(9)).join('')}`);
  HELD.forEach(([a, b], bin) => {
    const cells = WIDTHS.map((w) => {
      const t = r.tries[`${w}|${bin}`];
      return (t ? `${Math.round((100 * r.hits[`${w}|${bin}`]) / t)}% (${t})` : '-').padStart(9);
    });
    console.log(`    ${(a * 100).toFixed(1)}-${(b * 100).toFixed(1)} cm`.padEnd(29) + cells.join(''));
  });
}
