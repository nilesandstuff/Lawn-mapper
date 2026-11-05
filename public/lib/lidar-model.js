/**
 * THE FINISHED LIDAR MODEL OF A LOT, AS A FILE (core session, 2026-11-04; the owner: "there should be one base set
 * of files for making 3d maps from lidar... When a map goes into the shade map, the lidar gets built, aligned, points
 * get sorted/classified, then the finished output is saved. The AR shouldn't be rebuilding lidar maps from scratch").
 *
 * The shade map builds it (public/shade.js, with the person's erasures applied) and PUTs it to
 * /api/maps/model?id=&tool=shade (worker/src/routes-maps.js, kept in R2); every other tool GETs the same bytes and
 * reads them here. Nothing downstream re-reads the points or re-runs the rule: a fix in the shade map is a fix
 * everywhere the next time the map is opened there. A tool may post-process what it reads (the AR tool does, and
 * lists every such step in docs/SCAN-DIVERGENCES.md); it may not re-derive it.
 *
 * The file: "LMDL", a uint32 (little-endian) header length, the header as JSON, then the arrays back to back, each
 * starting on a 4-byte boundary. The header names every array: { name, type, length, offset }.
 *
 *   meta  { v: 1, tool: 'shade', at: ISO, basedOn: the map's `at` built from,
 *           grid:  { w, h, x0, y1, cell, cellY, lat }   EPSG:3857 metres; column (c, r) spans x0 + c*cell .. +cell,
 *                                                     y1 - r*cellY .. -cellY (public/shade/grid.js gridOver), with
 *                                                     the cloud's shift ALREADY applied: nothing moves it again
 *           layers: { z0, dz, nz }                    the canopy's cubes: layer l spans z0 + l*dz .. +dz (absolute m)
 *           lidar: { url, name, epoch, flown: { start, mid, end } | null, shift: [east, north] (3857 units), fit }
 *           photo: { id, date, source } | null         the summer photo the rule read (structures.js structuresFor)
 *           rule:  { kinds: { NOTHING, BUILDING, ... } } the kind codes as public/shade/structures.js numbers them
 *           erased: n                                   how many columns the person erased (applied already) }
 *   arrays (per column, row-major r*w + c, unless said):
 *     ground  Float32 w*h   the ground's height, absolute m (ground.js, the one surface every map stands on)
 *     kind    Uint8   w*h   structures.js kind (NOTHING 0, BUILDING 1, TREE 2, SOLID_TREE 3, STRUCTURE 4, UNKNOWN 5),
 *                           after the person's erasures (an erased column is NOTHING)
 *     why     Uint8   w*h   structures.js WHY key
 *     top     Float32 w*h   the highest return over the ground, m (columnStats top; -Infinity -> NaN where none)
 *     mu      Float32 w*h*nz  the canopy's extinction per metre per cube (canopy.js), column k's cubes at k*nz + l,
 *                           after erasures: the 3D map itself
 *
 * Any array may be absent when a writer does not have it; a reader checks. Extra arrays are allowed and kept.
 *
 * KEPT AND SENT GZIPPED (2026-11-05; the owner's lot is 23.1 MB raw, and a lot is mostly empty air, which gzip
 * all but erases: about 15 to 1 on a file shaped like it). packModel gives the gzipped bytes to PUT; unpackModel
 * reads either kind (a raw file written before this, or gzip). The Worker gzips a raw upload itself, so every
 * stored file is gzip; a reader that fetches one calls unpackModel, never decodeModel on the bytes directly.
 */
export const MAGIC = 'LMDL';
export const MODEL_V = 1;

const TYPES = { Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, Int32Array };

/** { meta, arrays: { name: TypedArray } } -> ArrayBuffer. */
export function encodeModel(meta, arrays) {
  const table = [];
  let offset = 0;
  const parts = [];
  for (const [name, arr] of Object.entries(arrays)) {
    if (!arr) continue;
    const type = arr.constructor.name;
    if (!TYPES[type]) throw new Error(`lidar-model: ${name} is a ${type}, not a typed array`);
    table.push({ name, type, length: arr.length, offset });
    parts.push(arr);
    offset += Math.ceil((arr.length * arr.BYTES_PER_ELEMENT) / 4) * 4;
  }
  const header = new TextEncoder().encode(JSON.stringify({ ...meta, v: meta.v ?? MODEL_V, arrays: table }));
  const headerLen = Math.ceil(header.length / 4) * 4;
  const out = new ArrayBuffer(8 + headerLen + offset);
  const bytes = new Uint8Array(out), dv = new DataView(out);
  bytes.set(new TextEncoder().encode(MAGIC), 0);
  dv.setUint32(4, header.length, true);
  bytes.set(header, 8);
  for (let i = 0; i < table.length; i++) {
    const a = parts[i];
    bytes.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), 8 + headerLen + table[i].offset);
  }
  return out;
}

/** Are these the gzip magic bytes (1f 8b)? */
export function isGzip(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
}

const through = (bytes, stream) => new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();

/** { meta, arrays } -> the gzipped file, what a writer PUTs (browser, Worker and Node 18+ alike). */
export async function packModel(meta, arrays) {
  return through(new Uint8Array(encodeModel(meta, arrays)), new CompressionStream('gzip'));
}

/** A stored or fetched file, gzipped or raw -> { meta, arrays }. */
export async function unpackModel(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return decodeModel(isGzip(b) ? await through(b, new DecompressionStream('gzip')) : b);
}

/** ArrayBuffer (raw, not gzip) -> { meta, arrays }. Each array is a view on `buf` where it sits aligned (no second
 *  copy of a 20 MB file on a phone), else a copy; transferring one to another thread detaches them all. */
export function decodeModel(buf) {
  const bytes = new Uint8Array(buf), dv = new DataView(buf instanceof ArrayBuffer ? buf : bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('not a lidar model file');
  const hl = dv.getUint32(4, true), headerLen = Math.ceil(hl / 4) * 4;
  const { arrays: table = [], ...meta } = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + hl)));
  const arrays = {};
  for (const t of table) {
    const T = TYPES[t.type];
    if (!T) continue;
    const start = bytes.byteOffset + 8 + headerLen + t.offset;
    arrays[t.name] = start % T.BYTES_PER_ELEMENT === 0 ? new T(bytes.buffer, start, t.length) : new T(bytes.buffer.slice(start, start + t.length * T.BYTES_PER_ELEMENT));
  }
  return { meta, arrays };
}

/** The column under an EPSG:3857 point, or -1 (the same arithmetic as grid.js cellOf, without the shift: it is applied). */
export function columnAt(grid, x, y) {
  const c = Math.floor((x - grid.x0) / grid.cell), r = Math.floor((grid.y1 - y) / (grid.cellY || grid.cell));
  return c >= 0 && r >= 0 && c < grid.w && r < grid.h ? r * grid.w + c : -1;
}

/** Is this a model a tool can stand on: the grid, the ground and the kinds, sized to match. */
export function modelUsable(m) {
  const g = m?.meta?.grid, n = g ? g.w * g.h : 0;
  return Boolean(n && m.arrays.ground?.length === n && m.arrays.kind?.length === n);
}
