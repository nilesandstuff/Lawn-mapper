/**
 * THE CHESAPEAKE BAY PROGRAM'S 1 m LAND USE, AS AN ANSWER KEY (water session,
 * 2026-10-17). The same public service the core reads for lawns
 * (worker/src/landcover.js LANDCOVER_SERVICE): Chesapeake Conservancy with
 * the University of Vermont and USGS, over the Bay watershed (VA, MD, PA,
 * DE, WV, NY parts). Used ONLY to score the water map's own measures (roofs,
 * imperviousness) -- never shown as an answer, and it has its own errors.
 *
 * Read as the service's own colours (exportImage png32, nearest neighbour:
 * plain png paints no-data black, the same as a road), which
 * name class GROUPS -- enough here: structures, roads, other impervious,
 * turf, and the rest.
 */

import { PNG } from 'pngjs';

export const SERVICE = 'https://cicgis.org/arcgis/rest/services/LULC/bay_lu_tif/ImageServer';

const GROUPS = [
  ['road', [0, 0, 0]], ['structure', [235, 6, 2]], ['impervious', [89, 89, 89]], ['canopyOverImpervious', [138, 138, 136]],
  ['turf', [233, 255, 190]], ['canopyOverTurf', [115, 115, 0]], ['pervious', [255, 255, 115]], ['forest', [38, 115, 0]],
  ['trees', [56, 168, 0]], ['water', [0, 92, 230]],
];
export const GROUP_NAMES = ['none', ...GROUPS.map(([n]) => n), 'other'];
const code = (n) => GROUP_NAMES.indexOf(n);

/** The class group of one pixel's colour (0 = no data, last = some other class). */
export function groupOf(r, g, b, a = 255) {
  if (a === 0) return 0;
  for (const [n, [R, G, B]] of GROUPS) if (Math.abs(r - R) + Math.abs(g - G) + Math.abs(b - B) <= 6) return code(n);
  return GROUP_NAMES.length - 1;
}

/**
 * Uint8Array W*H of group codes over a grid (lib/surface.js gridFor), with
 * the cloud's datum shift (lib/datum.js; the land use is on the web map's
 * ground, the cloud is not), or null when the service has nothing there.
 */
export async function truthFor(g, shift = { east: 0, north: 0 }, fetchImpl = fetch) {
  const dx = shift.east / g.k, dy = shift.north / g.k;
  const bbox = [g.bbox[0] + dx, g.bbox[1] + dy, g.bbox[2] + dx, g.bbox[3] + dy].join(',');
  const q = new URLSearchParams({ bbox, bboxSR: '3857', imageSR: '3857', size: `${g.W},${g.H}`, format: 'png32', interpolation: 'RSP_NearestNeighbor', f: 'image' });
  const res = await fetchImpl(`${SERVICE}/exportImage?${q}`);
  if (!res.ok) return null;
  const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  if (png.width !== g.W || png.height !== g.H) return null;
  const out = new Uint8Array(g.W * g.H);
  let any = 0;
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = groupOf(png.data[o], png.data[o + 1], png.data[o + 2], png.data[o + 3]);
    if (out[i]) any++;
  }
  return any > out.length / 2 ? out : null;
}
