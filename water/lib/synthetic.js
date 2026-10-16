/**
 * MADE-UP GROUND WHOSE ANSWER IS KNOWN (water session): the tests and the
 * detection-limit sweep (tools/limits.mjs) build their point clouds here.
 */

import { makeColumns } from './las.js';
import { toMerc, mercScale } from './ept.js';

export const LAT = 43, LNG = -85; // round numbers: only the latitude matters (meters per degree)

/** A random number stream that is the same every run. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
export const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** A smooth dish: `depth` m at the middle, nothing from `radius` m out. */
export const dish = (cx, cy, radius, depth) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  return d >= radius ? 0 : -depth * 0.5 * (1 + Math.cos(Math.PI * d / radius));
};

/**
 * A cloud over a `size` m square: ground at `density` points/m^2 following
 * height(x, y) (meters east and north of the south-west corner) with `noise`
 * m of scatter, and roofs (class 1, single returns, 6 m up) inside `roofs`
 * ([west, south, east, north] in the same meters, at roof density).
 */
export function cloud({ size = 80, density = 1.2, noise = 0.02, height, roofs = [], seed = 1 }) {
  const r = rng(seed), k = mercScale(LAT);
  const [x0, y0] = toMerc([LNG, LAT]);
  const n = Math.round(size * size * density);
  const cols = makeColumns(n);
  const inRoof = (x, y) => roofs.some(([a, b, c, d]) => x >= a && x < c && y >= b && y < d);
  for (let m = 0; m < n; m++) {
    const x = r() * size, y = r() * size;
    const roof = inRoof(x, y);
    cols.x[m] = x0 + x / k; cols.y[m] = y0 + y / k;
    cols.z[m] = roof ? height(x, y) + 6 : height(x, y) + noise * gauss(r);
    cols.cls[m] = roof ? 1 : 2; cols.ret[m] = 1; cols.nret[m] = 1;
  }
  return { cols, bbox: [x0, y0, x0 + size / k, y0 + size / k] };
}
