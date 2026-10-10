/**
 * READ A PROPERTY'S POINTS OUT OF A PUBLIC ENTWINE (EPT) OCTREE.
 *
 * The same octrees tools/lidar_frame.py reads (USGS 3DEP on AWS, EPSG:3857),
 * read here in JavaScript so the shade page can run in a phone's browser:
 * USGS's bucket answers any origin (Access-Control-Allow-Origin: *).
 *
 * A NOTE ON METRES. EPSG:3857 x and y are WEB-MERCATOR metres, which are
 * real metres divided by cos(latitude): at 42 deg N one of them is 0.74 m on
 * the ground. z is real metres. Anything that mixes them -- a shadow's
 * length, a cell size, a slope -- has to scale x and y by cos(lat) first.
 * mercScale() is the one place that factor is computed.
 *
 * Everything that touches the network takes its fetch as an argument, so the
 * walk and the cropping are tested without one.
 */

import { lasHeader, makeColumns, readRecord, concatColumns } from './las.js';

const R = 6378137;

/** lng/lat (degrees) -> EPSG:3857 metres. */
export const toMerc = ([lng, lat]) => [
  (lng * Math.PI / 180) * R,
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R,
];
/** EPSG:3857 metres -> lng/lat. */
export const fromMerc = ([x, y]) => [
  (x / R) * 180 / Math.PI,
  (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI,
];
/** Real metres per web-mercator metre at a latitude. */
export const mercScale = (lat) => Math.cos(lat * Math.PI / 180);

/** The [minx, miny, maxx, maxy] of one node, from its D-X-Y-Z key and the cube's bounds. */
export function nodeBox(bounds, key) {
  const [d, xi, yi] = key.split('-').map(Number);
  const size = (bounds[3] - bounds[0]) / 2 ** d;
  return [bounds[0] + xi * size, bounds[1] + yi * size, bounds[0] + (xi + 1) * size, bounds[1] + (yi + 1) * size];
}

const touches = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

/**
 * Every node with points whose box touches bbox, root down. Points sit at
 * every depth, coarse to fine, so all of them are wanted, not only leaves.
 * `count(key)` answers a node's point count (async), or null when the node
 * does not exist.
 */
export async function walk(bounds, bbox, count, { maxNodes = 600 } = {}) {
  const wanted = [];
  const stack = ['0-0-0-0'];
  while (stack.length) {
    const key = stack.pop();
    if (!touches(nodeBox(bounds, key), bbox)) continue;
    const c = await count(key);
    if (!c || c <= 0) continue;
    wanted.push({ key, count: c });
    if (wanted.length > maxNodes) throw new Error(`more than ${maxNodes} octree nodes over this box`);
    const [d, x, y, z] = key.split('-').map(Number);
    for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) {
      stack.push(`${d + 1}-${2 * x + dx}-${2 * y + dy}-${2 * z + dz}`);
    }
  }
  return wanted;
}

/**
 * The hierarchy as a count(key) function. Entwine keeps a subtree's counts
 * in its own file, marked by -1 in the parent's; a key missing from every
 * loaded file is a node that does not exist, not a file to go looking for.
 */
export function hierarchyReader(base, getJson) {
  const counts = new Map();
  const loaded = new Set();
  const load = async (key) => {
    if (loaded.has(key)) return;
    loaded.add(key);
    const h = await getJson(`${base}/ept-hierarchy/${key}.json`);
    for (const [k, v] of Object.entries(h || {})) if (!(counts.has(k) && v < 0)) counts.set(k, v);
  };
  return async (key) => {
    if (!loaded.size) await load('0-0-0-0');
    let v = counts.get(key);
    if (v === -1) { await load(key); v = counts.get(key); }
    return v ?? null;
  };
}

/** Points of one decompressed LAS buffer (records in `points`) inside bbox. */
export function cropRecords(header, points, bbox) {
  const dv = new DataView(points.buffer, points.byteOffset, points.byteLength);
  const L = header.recordLength;
  const n = Math.floor(points.byteLength / L);
  const all = makeColumns(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    readRecord(dv, i * L, header.format, header, all, k);
    const x = all.x[k], y = all.y[k];
    if (x >= bbox[0] && x < bbox[2] && y >= bbox[1] && y < bbox[3]) k++;
  }
  all.n = k;
  return all;
}

/**
 * Every point of one octree inside bbox (EPSG:3857), as columns.
 *
 *   io = { getJson(url), getBytes(url) -> ArrayBuffer,
 *          decompress(ArrayBuffer) -> { header, points: Uint8Array } }
 *
 * `progress(done, total)` is told as nodes arrive.
 */
export async function pointsIn(eptJsonUrl, bbox, io, { progress = () => {}, parallel = 6 } = {}) {
  const base = eptJsonUrl.replace(/\/ept\.json$/, '');
  const ept = await io.getJson(`${base}/ept.json`);
  if (String(ept?.srs?.horizontal) !== '3857') throw new Error(`point cloud is EPSG:${ept?.srs?.horizontal}, not 3857`);
  const nodes = await walk(ept.bounds, bbox, hierarchyReader(base, io.getJson));
  const parts = [];
  let done = 0;
  progress(0, nodes.length);
  const queue = nodes.slice();
  const worker = async () => {
    while (queue.length) {
      const { key } = queue.shift();
      const raw = await io.getBytes(`${base}/ept-data/${key}.laz`);
      const { header, points } = await io.decompress(raw);
      const cols = cropRecords(header, points, bbox);
      if (cols.n) parts.push(cols);
      progress(++done, nodes.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, nodes.length) }, worker));
  return { ept, nodes: nodes.length, cols: parts.length ? concatColumns(parts) : makeColumns(0) };
}

export { lasHeader };
