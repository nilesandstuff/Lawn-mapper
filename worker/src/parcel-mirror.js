/**
 * OUR OWN COPY OF EVERY COUNTY'S PARCELS (core session, 2026-11-09). The owner, after the owner's county's parcel
 * server began asking for a login: "How much storage space would it take for us to fetch every parcel in every county
 * that we have hooked up, so this can't happen again? Then we could provide a button ... 'parcel line out of date,
 * fetch a new one'." Then: "Yes build it".
 *
 * tools/parcel-mirror.mjs (workflow "P2. Parcel mirror") fetches every parcel of every county service in the registry
 * (counties.js ALL_COUNTIES) and keeps them in the CORPUS bucket in this module's format. The site asks the county
 * first, always; the copy is used only when the county cannot be asked (parcel.js unreachedCounties) and says how old
 * it is (properties.source = 'mirror', mirroredAt).
 *
 * THE FORMAT. The country is cut into cells of CELL degrees; one object per cell per service,
 *   parcels/<mirror key>/<cx>_<cy>.bin      (cx = floor(lng / CELL), cy = floor(lat / CELL))
 * holding every parcel whose box touches the cell (a farm across three cells is in all three), gzip'd:
 *   'PMC1', u32 n, f64 lng0, f64 lat0, f64 at  (the cell's south-west corner; when it was copied, ms since 1970)
 *   n x { u16 w, s, e, n; u32 offset }        each parcel's box within the cell, in 65535ths of it, rounded outward
 *   body: per parcel  varint pin length, pin (UTF-8), varint ring count, per ring varint point count and the points
 *         as zigzag varint steps in 1e-7 degrees (the first from 0, so a parcel is encoded once for every cell)
 * A lookup reads the box table and decodes only the parcels whose box holds the point, so a cell of ten thousand
 * parcels costs a few hundred microseconds. The rings are Esri's, as the county sent them (outer and holes by
 * winding); a point is inside by even-odd over all of them, and they become GeoJSON by parcel.js esriToGeoJSON.
 *
 * Services that publish the same layer under more than one registry key are copied once, under the first key
 * (mirrorKeyOf).
 */

export const CELL = 0.05;                // degrees: ~5.6 km by ~4.3 km at 40 N; a dense city cell holds ten thousand lots or so
export const Q = 1e7;                    // the points' quantum: 1e-7 degrees, about a centimetre
export const PREFIX = 'parcels/';
const MAGIC = 0x31434d50;                // 'PMC1' read as a little-endian u32
const HEAD = 32, ENTRY = 12;

export const cellOf = (lng, lat) => [Math.floor(lng / CELL), Math.floor(lat / CELL)];
export const cellKey = (mirrorKey, cx, cy) => `${PREFIX}${mirrorKey}/${cx}_${cy}.bin`;
/** The cells a box touches, as [cx, cy] pairs. */
export function cellsOfBox([w, s, e, n]) {
  const out = [];
  const [x0, y0] = cellOf(w, s), [x1, y1] = cellOf(e, n);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) out.push([cx, cy]);
  return out;
}

/** The key a service is copied under: the first registry key with the same layer and filter. */
export function mirrorKeys(counties) {
  const first = new Map(), out = {};
  for (const [key, cfg] of Object.entries(counties || {})) {
    if (!cfg?.service) continue;
    const id = `${cfg.service}|${cfg.layer}|${cfg.where || ''}`;
    if (!first.has(id)) first.set(id, key);
    out[key] = first.get(id);
  }
  return out;
}
let keysCache = null, keysOf = null;
export function mirrorKeyOf(counties, key) {
  if (keysOf !== counties) { keysCache = mirrorKeys(counties); keysOf = counties; }
  return keysCache[key] || null;
}

/* ------------------------------------------------------------------ varints */
class Writer {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.n = 0; }
  room(k) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.n)); this.buf = b;
  }
  uvar(v) {               // v a non-negative integer below 2^53
    this.room(8);
    while (v >= 128) { this.buf[this.n++] = (v % 128) + 128; v = Math.floor(v / 128); }
    this.buf[this.n++] = v;
  }
  svar(v) { this.uvar(v >= 0 ? v * 2 : -v * 2 - 1); }
  bytes(b) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length; }
  out() { return this.buf.subarray(0, this.n); }
}
function uvarAt(b, p) {
  let v = 0, mul = 1, c;
  do { c = b[p.i++]; v += (c & 127) * mul; mul *= 128; } while (c >= 128);
  return v;
}
const svarAt = (b, p) => { const u = uvarAt(b, p); return u % 2 ? -(u + 1) / 2 : u / 2; };

const enc = new TextEncoder(), dec = new TextDecoder();

/**
 * One parcel as a body record: { rings: [[[lng, lat], ...], ...], pin } -> bytes, with its box in degrees. Rings come from the county quantized to 1e-7; a ring with fewer than 3 points is dropped.
 */
export function encodeParcel(p, minPoints = 3) {
  const w = new Writer(256);
  const pin = enc.encode(p.pin == null ? '' : String(p.pin));
  w.uvar(pin.length); w.bytes(pin);
  // a water layer's points and lines too (water-copy.js): one corner is a point, two a line
  const rings = (p.rings || []).filter((r) => Array.isArray(r) && r.length >= minPoints);
  w.uvar(rings.length);
  let px = 0, py = 0;
  let bw = Infinity, bs = Infinity, be = -Infinity, bn = -Infinity;
  for (const r of rings) {
    w.uvar(r.length);
    for (const [x, y] of r) {
      const qx = Math.round(x * Q), qy = Math.round(y * Q);
      w.svar(qx - px); w.svar(qy - py); px = qx; py = qy;
      if (x < bw) bw = x; if (x > be) be = x; if (y < bs) bs = y; if (y > bn) bn = y;
    }
  }
  return { bytes: w.out().slice(), box: [bw, bs, be, bn], rings: rings.length };
}

/** A whole cell: parcels [{ rings, pin }] (or pre-encoded { bytes, box }) -> the file's bytes, before gzip. */
export function encodeCell(cx, cy, parcels, at = Date.now()) {
  const lng0 = cx * CELL, lat0 = cy * CELL;
  const recs = parcels.map((p) => (p.bytes && p.box ? p : encodeParcel(p))).filter((r) => r.rings !== 0);
  const bodyLen = recs.reduce((s, r) => s + r.bytes.length, 0);
  const out = new Uint8Array(HEAD + recs.length * ENTRY + bodyLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, recs.length, true);
  dv.setFloat64(8, lng0, true); dv.setFloat64(16, lat0, true); dv.setFloat64(24, at, true);
  const q = (v, o, up) => {
    const t = ((v - o) / CELL) * 65535;
    return Math.max(0, Math.min(65535, up ? Math.ceil(t) : Math.floor(t)));
  };
  let off = 0, body = HEAD + recs.length * ENTRY;
  recs.forEach((r, i) => {
    const e = HEAD + i * ENTRY, [w, s, ea, n] = r.box;
    dv.setUint16(e, q(w, lng0, false), true); dv.setUint16(e + 2, q(s, lat0, false), true);
    dv.setUint16(e + 4, q(ea, lng0, true), true); dv.setUint16(e + 6, q(n, lat0, true), true);
    dv.setUint32(e + 8, off, true);
    out.set(r.bytes, body + off); off += r.bytes.length;
  });
  return out;
}

/** The cell's header: { n, lng0, lat0, at, dv } or null when the bytes are not a cell. */
function head(b) {
  if (!b || b.length < HEAD) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) return null;
  const n = dv.getUint32(4, true);
  if (b.length < HEAD + n * ENTRY) return null;
  return { n, lng0: dv.getFloat64(8, true), lat0: dv.getFloat64(16, true), at: dv.getFloat64(24, true), dv };
}

/** Parcel i of a cell: { pin, rings } in degrees. */
function record(b, h, i) {
  const p = { i: HEAD + h.n * ENTRY + h.dv.getUint32(HEAD + i * ENTRY + 8, true) };
  const pl = uvarAt(b, p);
  const pin = pl ? dec.decode(b.subarray(p.i, p.i + pl)) : null;
  p.i += pl;
  const nr = uvarAt(b, p), rings = [];
  let x = 0, y = 0;
  for (let r = 0; r < nr; r++) {
    const np = uvarAt(b, p), ring = new Array(np);
    for (let k = 0; k < np; k++) { x += svarAt(b, p); y += svarAt(b, p); ring[k] = [x / Q, y / Q]; }
    rings.push(ring);
  }
  return { pin, rings };
}

/** Box i of a cell in degrees (rounded outward). */
function boxOf(h, i) {
  const e = HEAD + i * ENTRY, k = CELL / 65535;
  return [h.lng0 + h.dv.getUint16(e, true) * k, h.lat0 + h.dv.getUint16(e + 2, true) * k,
    h.lng0 + h.dv.getUint16(e + 4, true) * k, h.lat0 + h.dv.getUint16(e + 6, true) * k];
}

/** Even-odd over every ring: inside the outer rings and outside their holes. */
export function insideRings(rings, lng, lat) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

const ringsArea = (rings) => Math.abs(rings.reduce((s, r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return s + a / 2;
}, 0));

/** When a cell was copied: an ISO date, or null. */
export function cellAt(b) {
  const h = head(b);
  return h && h.at > 0 ? new Date(h.at).toISOString() : null;
}

/** Every parcel in a cell: [{ pin, rings }]. */
export function decodeCell(b) {
  const h = head(b);
  if (!h) return [];
  return Array.from({ length: h.n }, (_, i) => record(b, h, i));
}

/**
 * The parcel of a cell at a point: { pin, rings } or null. With a pin, the parcel of that number in the cell nearest
 * the point wins first (a queued job's own lot, parcel.js queryByPin). Of several holding the point (a lot inside a
 * subdivision's outline, stacked condominiums), the smallest.
 */
export function findInCell(b, lng, lat, { pin = null } = {}) {
  const h = head(b);
  if (!h) return null;
  if (pin != null && pin !== '') {
    let best = null, bestD = Infinity;
    for (let i = 0; i < h.n; i++) {
      const r = record(b, h, i);
      if (r.pin !== String(pin)) continue;
      const [w, s, e, n] = boxOf(h, i);
      const d = Math.hypot(lng < w ? w - lng : lng > e ? lng - e : 0, lat < s ? s - lat : lat > n ? lat - n : 0);
      if (d < bestD) { best = r; bestD = d; }
    }
    if (best && bestD <= 0.01) return best;
  }
  let best = null, bestA = Infinity;
  for (let i = 0; i < h.n; i++) {
    const [w, s, e, n] = boxOf(h, i);
    if (lng < w || lng > e || lat < s || lat > n) continue;
    const r = record(b, h, i);
    if (!insideRings(r.rings, lng, lat)) continue;
    const a = ringsArea(r.rings);
    if (a < bestA) { best = r; bestA = a; }
  }
  return best;
}

/** The parcels of a cell whose box meets a box: [{ pin, rings }]. */
export function parcelsInBox(b, [qw, qs, qe, qn]) {
  const h = head(b);
  if (!h) return [];
  const out = [];
  for (let i = 0; i < h.n; i++) {
    const [w, s, e, n] = boxOf(h, i);
    if (e < qw || w > qe || n < qs || s > qn) continue;
    out.push(record(b, h, i));
  }
  return out;
}

/* ------------------------------------------------------------------- gzip */
async function streamAll(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gunzip = (bytes) => streamAll(bytes, new DecompressionStream('gzip'));
export const gzip = (bytes) => streamAll(bytes, new CompressionStream('gzip'));

/* ------------------------------------------------------------ the site's reads */
/** One cell of a service from the bucket: { bytes, at } or null. */
async function readCell(env, mirrorKey, cx, cy) {
  const obj = await env.CORPUS.get(cellKey(mirrorKey, cx, cy)).catch(() => null);
  if (!obj) return null;
  try {
    const bytes = await gunzip(new Uint8Array(await obj.arrayBuffer()));
    return { bytes, at: cellAt(bytes) };
  } catch { return null; }
}

/**
 * The copy's parcel at a point for the first of `keys` (registry keys) that has one, as the app's parcel feature, or
 * null. `toGeoJSON` is parcel.js esriToGeoJSON (passed in, so this module needs nothing of parcel.js).
 */
export async function mirrorLookup(env, counties, keys, lng, lat, { pin = null, toGeoJSON } = {}) {
  if (!env?.CORPUS) return null;
  const [cx, cy] = cellOf(lng, lat);
  const seen = new Set();
  for (const key of keys) {
    const mk = mirrorKeyOf(counties, key);
    if (!mk || seen.has(mk)) continue;
    seen.add(mk);
    const cell = await readCell(env, mk, cx, cy);
    if (!cell) continue;
    const hit = findInCell(cell.bytes, lng, lat, { pin });
    if (!hit) continue;
    const geometry = toGeoJSON({ rings: hit.rings });
    if (!geometry) continue;
    const cfg = counties[key];
    return {
      type: 'Feature', geometry,
      properties: {
        county: cfg?.name || key, countyKey: key, pin: hit.pin, address: null, source: 'mirror', mirroredAt: cell.at,
        ...(pin != null && pin !== '' && hit.pin === String(pin) ? { matched: 'pin' } : {}),
      },
    };
  }
  return null;
}

/** The copy's parcels in a box for one registry key, as features (parcel.js lookupNeighbours's shape), [] if none. */
export async function mirrorParcelsIn(env, counties, key, bbox, { toGeoJSON } = {}) {
  if (!env?.CORPUS) return [];
  const mk = mirrorKeyOf(counties, key);
  if (!mk) return [];
  const cells = cellsOfBox(bbox);
  if (cells.length > 16) return [];
  const out = [], pins = new Set();
  for (const [cx, cy] of cells) {
    const cell = await readCell(env, mk, cx, cy);
    if (!cell) continue;
    for (const r of parcelsInBox(cell.bytes, bbox)) {
      // a parcel across two cells is in both: once is enough (by its number and first corner)
      const id = `${r.pin}|${r.rings[0]?.[0]?.join(',')}`;
      if (pins.has(id)) continue;
      pins.add(id);
      const geometry = toGeoJSON({ rings: r.rings });
      if (geometry) out.push({ type: 'Feature', geometry, properties: { pin: r.pin, county: counties[key]?.name || key, countyKey: key, source: 'mirror', mirroredAt: cell.at } });
    }
  }
  return out;
}
