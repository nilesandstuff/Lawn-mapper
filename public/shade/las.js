/**
 * LAS POINT RECORDS -> TYPED ARRAYS (shade map, features session).
 *
 * The decompression is laz-perf's (public/shade/laz.js); this is only the
 * reading of what it hands back, so it is pure and runs in the tests.
 *
 * Kept per point, and nothing else, because these are what the shade model
 * needs: where (x, y, z), how strongly it came back (intensity, for lining the
 * cloud up with the photo), which return of how many (the pulse went on
 * through something: a crown, not a roof), and the class (2 = ground).
 */

/** The fields of a LAS header this reader uses. `buf` is an ArrayBuffer. */
export function lasHeader(buf) {
  const v = new DataView(buf);
  const sig = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (sig !== 'LASF') throw new Error('not a LAS/LAZ file');
  const minor = v.getUint8(25);
  const legacyCount = v.getUint32(107, true);
  const count = minor >= 4 && legacyCount === 0 ? Number(v.getBigUint64(247, true)) : legacyCount;
  const format = v.getUint8(104) & 0x3f; // the top two bits flag compression
  return {
    version: `1.${minor}`,
    pointOffset: v.getUint32(96, true),
    format,
    recordLength: v.getUint16(105, true),
    count,
    /* Where the GPS time sits in a record (formats 1, 3-5 at 20; 6+ at 22; none in 0 and 2),
       and whether the header calls it "adjusted standard" time (global encoding bit 0) rather
       than time-of-week. The bit is NOT trusted by gpsTimes: Entwine's node files say week time
       and hold adjusted standard time (USGS 3DEP on AWS, checked 2026-10-15). */
    gpsAt: [1, 3, 4, 5].includes(format) ? 20 : format >= 6 ? 22 : -1,
    gpsAdjusted: (v.getUint16(6, true) & 1) === 1,
    scale: [v.getFloat64(131, true), v.getFloat64(139, true), v.getFloat64(147, true)],
    offset: [v.getFloat64(155, true), v.getFloat64(163, true), v.getFloat64(171, true)],
  };
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const WEEK_S = 604800, RAW_GPS_2001_S = 6.6e8; // GPS seconds at 2001: raw standard time (rare) from here up
/**
 * A record's GPS time as ms since 1970, or NaN when it is time-of-week (the
 * seconds since Sunday, which says nothing of the date). By the value, not
 * the header's bit: under a week is week time; from there to 2001's raw
 * count is adjusted standard time (seconds since 1980-01-06 less 1e9, which
 * is negative for flights before 2011-09); above that, raw standard time.
 */
export function gpsMs(g) {
  if (!Number.isFinite(g) || Math.abs(g) < WEEK_S) return NaN;
  const s = g >= RAW_GPS_2001_S ? g : g + 1e9;
  const ms = GPS_EPOCH_MS + s * 1000;
  return ms > Date.UTC(1995, 0, 1) && ms < Date.now() + 366 * 864e5 ? ms : NaN;
}

/**
 * EACH POINT'S LEAF STATE (owner, 2026-10-29: "If the lidar was flown
 * partially in leaf, that's a bigger problem"): by the day its own pulse was
 * fired, as find.js leafSeason judges a day -- 1 November to 10 May leaf-off,
 * the rest in leaf. 0 when the record keeps no usable date.
 */
export const LEAF_UNKNOWN = 0, LEAF_OFF = 1, LEAF_ON = 2;
export function leafOfMs(ms) {
  if (!Number.isFinite(ms)) return LEAF_UNKNOWN;
  const d = new Date(ms), m = d.getUTCMonth() + 1;
  return m >= 11 || m <= 4 || (m === 5 && d.getUTCDate() <= 10) ? LEAF_OFF : LEAF_ON;
}

/**
 * WHEN THE LASER PASSED: the GPS times of a node's records, sampled (about
 * `want` of them), as sorted ms since 1970 -- or null when the file keeps no
 * usable time. The points' own clock: the catalogue's flight dates were
 * right for 144 of 145 flights checked (SHADE-FINDINGS 18), and the one
 * wrong one said August for a flight made in March.
 */
export function gpsTimes(h, points, want = 400) {
  if (h.gpsAt < 0) return null;
  const L = h.recordLength, n = Math.floor(points.byteLength / L);
  if (!n) return null;
  const dv = new DataView(points.buffer, points.byteOffset, points.byteLength);
  const step = Math.max(1, Math.floor(n / want)), out = [];
  for (let i = 0; i < n; i += step) {
    const ms = gpsMs(dv.getFloat64(i * L + h.gpsAt, true));
    if (Number.isFinite(ms)) out.push(ms);
  }
  return out.length ? out.sort((a, b) => a - b) : null;
}

/** The per-point arrays of a set of columns. */
export const COLUMN_KEYS = ['x', 'y', 'z', 'intensity', 'ret', 'nret', 'cls', 'leaf'];

/** Empty columns for n points. */
export function makeColumns(n) {
  return {
    n,
    x: new Float64Array(n), y: new Float64Array(n), z: new Float32Array(n),
    intensity: new Uint16Array(n), ret: new Uint8Array(n), nret: new Uint8Array(n),
    cls: new Uint8Array(n),
    leaf: new Uint8Array(n), // LEAF_OFF / LEAF_ON by the point's own GPS day, 0 unknown
  };
}

/**
 * Read one point record (a DataView over at least `recordLength` bytes at
 * `at`) into row i of `cols`. Formats 0-5 pack return and class into one byte
 * each way; 6-10 (LAS 1.4) widen them.
 */
export function readRecord(dv, at, format, h, cols, i) {
  cols.x[i] = dv.getInt32(at, true) * h.scale[0] + h.offset[0];
  cols.y[i] = dv.getInt32(at + 4, true) * h.scale[1] + h.offset[1];
  cols.z[i] = dv.getInt32(at + 8, true) * h.scale[2] + h.offset[2];
  cols.intensity[i] = dv.getUint16(at + 12, true);
  const b = dv.getUint8(at + 14);
  if (format >= 6) {
    cols.ret[i] = b & 0x0f;
    cols.nret[i] = b >> 4;
    cols.cls[i] = dv.getUint8(at + 16);
  } else {
    cols.ret[i] = b & 0x07;
    cols.nret[i] = (b >> 3) & 0x07;
    cols.cls[i] = dv.getUint8(at + 15) & 0x1f;
  }
}

/** Join several column sets into one. */
export function concatColumns(parts) {
  const n = parts.reduce((s, p) => s + p.n, 0);
  const out = makeColumns(n);
  let k = 0;
  for (const p of parts) {
    for (const key of COLUMN_KEYS) if (p[key]) out[key].set(p[key].subarray(0, p.n), k);
    k += p.n;
  }
  return out;
}

/** Only the rows where keep(i) is true. */
export function filterColumns(cols, keep) {
  let n = 0;
  const idx = new Uint32Array(cols.n);
  for (let i = 0; i < cols.n; i++) if (keep(i)) idx[n++] = i;
  const out = makeColumns(n);
  for (const key of COLUMN_KEYS) {
    if (!cols[key]) continue;
    for (let j = 0; j < n; j++) out[key][j] = cols[key][idx[j]];
  }
  return out;
}
