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
  return {
    version: `1.${minor}`,
    pointOffset: v.getUint32(96, true),
    format: v.getUint8(104) & 0x3f, // the top two bits flag compression
    recordLength: v.getUint16(105, true),
    count,
    scale: [v.getFloat64(131, true), v.getFloat64(139, true), v.getFloat64(147, true)],
    offset: [v.getFloat64(155, true), v.getFloat64(163, true), v.getFloat64(171, true)],
  };
}

/** Empty columns for n points. */
export function makeColumns(n) {
  return {
    n,
    x: new Float64Array(n), y: new Float64Array(n), z: new Float32Array(n),
    intensity: new Uint16Array(n), ret: new Uint8Array(n), nret: new Uint8Array(n),
    cls: new Uint8Array(n),
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
    for (const key of ['x', 'y', 'z', 'intensity', 'ret', 'nret', 'cls']) out[key].set(p[key].subarray(0, p.n), k);
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
  for (const key of ['x', 'y', 'z', 'intensity', 'ret', 'nret', 'cls']) {
    for (let j = 0; j < n; j++) out[key][j] = cols[key][idx[j]];
  }
  return out;
}
