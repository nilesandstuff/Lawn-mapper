/**
 * LAZ -> raw LAS point records, with laz-perf (Hobu's LASzip in WebAssembly,
 * Apache-2.0, vendored at public/shade/vendor/laz-perf.js + .wasm, v0.0.7).
 *
 * `create` is the laz-perf module factory: in the browser the global the
 * vendored script defines, in a test the npm package's own. One module is
 * made per page and reused; it only ever holds one file at a time.
 */

import { lasHeader } from './las.js';

let modulePromise = null;

/** The factory the vendored script put on the page, loading it if needed. */
export function browserFactory(src = '/shade/vendor/laz-perf.js') {
  if (globalThis.createLazPerf) return Promise.resolve(globalThis.createLazPerf);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (globalThis.createLazPerf ? res(globalThis.createLazPerf) : rej(new Error('laz-perf did not load')));
    s.onerror = () => rej(new Error('laz-perf did not load'));
    document.head.append(s);
  });
}

/** A decompress(ArrayBuffer) -> { header, points } bound to one laz-perf module. */
export function lazDecoder(getFactory, options = {}) {
  return async (buf) => {
    if (!modulePromise) modulePromise = Promise.resolve(getFactory()).then((f) => f(options));
    const M = await modulePromise;
    const header = lasHeader(buf);
    const filePtr = M._malloc(buf.byteLength);
    let dataPtr = 0;
    const zip = new M.LASZip();
    try {
      M.HEAPU8.set(new Uint8Array(buf), filePtr);
      zip.open(filePtr, buf.byteLength);
      const L = zip.getPointLength();
      const n = zip.getCount();
      dataPtr = M._malloc(L);
      const points = new Uint8Array(n * L);
      for (let i = 0; i < n; i++) {
        zip.getPoint(dataPtr);
        points.set(M.HEAPU8.subarray(dataPtr, dataPtr + L), i * L);
      }
      return { header: { ...header, recordLength: L, format: zip.getPointFormat() }, points };
    } finally {
      zip.delete();
      if (dataPtr) M._free(dataPtr);
      M._free(filePtr);
    }
  };
}
