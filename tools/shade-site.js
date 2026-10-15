/**
 * The shade map's model of one place, built in node exactly as the page
 * builds it in the browser (public/shade/light-worker.js): the USGS 3DEP
 * lidar through the same reader, datum correction, voxel canopy and
 * seasonal classification. For the checks that measure the shade map
 * against outside evidence (tools/shade-check-naip.js and the like).
 *
 *   const site = await shadeSite(lng, lat, { halfM: 80 });
 *   site.model, site.season, site.grid, site.cloud, site.flight ({ start, end, season, source }), site.cellOf(lng, lat)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pointsIn, toMerc, mercScale } from '../public/shade/ept.js';
import { lazDecoder } from '../public/shade/laz.js';
import { nad83Correction } from '../public/shade/datum.js';
import { buildCanopy } from '../public/shade/canopy.js';
import { gridOver } from '../public/shade/grid.js';
import { seasonalCanopy } from '../public/shade/seasonal.js';
import { transmittance, groundAt } from '../public/shade/rays.js';
import { sunAt } from '../public/shade/sun.js';
import { lidarAt } from '../worker/src/shade.js';
import { flightOf } from '../public/shade/find.js';

const vendor = (f) => fileURLToPath(new URL(`../public/shade/vendor/${f}`, import.meta.url));
let factory = null;
/**
 * The vendored laz-perf (the browser's copy), loaded into node: it is a
 * web-only build, so node's own globals are hidden from it and it gets a
 * stand-in window and the wasm bytes directly.
 */
function lazFactory() {
  if (!factory) {
    // eslint-disable-next-line no-new-func
    const create = new Function('window', 'process', 'require', `${readFileSync(vendor('laz-perf.js'), 'utf8')}; return createLazPerf;`)({ location: { href: '' } }, undefined, undefined);
    const wasmBinary = readFileSync(vendor('laz-perf.wasm'));
    factory = (opts) => create({ ...opts, wasmBinary });
  }
  return factory;
}

async function fetchRetry(u, as, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(u);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${u}`);
      return as === 'json' ? r.json() : r.arrayBuffer();
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await new Promise((ok) => setTimeout(ok, 1500 * 2 ** i));
    }
  }
}

/**
 * The model over a square `halfM` meters each way of (lng, lat), from the
 * lidar the page would pick there (`cloudIndex` 0 = its first choice).
 * Null when there is no lidar.
 */
export async function shadeSite(lng, lat, { halfM = 80, cloudIndex = 0 } = {}) {
  const found = await lidarAt(lng, lat);
  const cloud = found?.clouds?.[cloudIndex];
  if (!cloud) return null;
  const k = mercScale(lat), m = halfM / k, [cx, cy] = toMerc([lng, lat]);
  const box = [cx - m, cy - m, cx + m, cy + m];
  const io = { getJson: (u) => fetchRetry(u, 'json'), getBytes: (u) => fetchRetry(u, 'bytes'), decompress: lazDecoder(lazFactory) };
  const { cols, flown } = await pointsIn(cloud.url, box, io);
  /* When it was flown, by the points' own clock (the catalogue when they keep none): find.js flightOf. */
  const flight = flightOf(cloud.unit, flown);
  const d = nad83Correction(lat, lng, cloud.epoch), shift = [d.east / k, d.north / k];
  const grid = gridOver(box, 1, lat);
  const model = buildCanopy(cols, grid, { shift });
  /* SHADE_FILL='{"closeR":0,"topR":0}' tries a leaf fill (seasonal.js) in the checks; none: as shipped. */
  let fill = {};
  try { fill = process.env.SHADE_FILL ? JSON.parse(process.env.SHADE_FILL) : {}; } catch { fill = {}; }
  const season = seasonalCanopy(cols, model, { shift, fill });
  const cellOf = (plng, plat) => {
    const [x, y] = toMerc([plng, plat]);
    return [(x - grid.x0) / grid.cell, (grid.y1 - y) / grid.cell];
  };
  return { cloud, flight, box, grid, cols, model, season, shift, cellOf, points: cols.n };
}

/** The sun's direction (east, north, up) at a time and place, with its angles. */
export function sunDir(lat, lng, ms) {
  const s = sunAt(lat, lng, ms), R = Math.PI / 180, ce = Math.cos(s.elevation * R);
  return { ...s, dir: [Math.sin(s.azimuth * R) * ce, Math.cos(s.azimuth * R) * ce, Math.sin(s.elevation * R)] };
}

/** Share of the direct beam reaching `heightM` above the ground at grid cell centers `cells`. */
export function beamAt(model, mu, cells, dir, heightM = 0.1) {
  const m = { ...model, mu };
  return Float32Array.from(cells, (kk) => {
    const x = (kk % model.w) + 0.5, y = Math.floor(kk / model.w) + 0.5;
    return transmittance(m, x, y, groundAt(model, x, y) + heightM, dir);
  });
}
