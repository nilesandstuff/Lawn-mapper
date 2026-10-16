/**
 * THE LIDAR READERS' I/O, FOR NODE (water session). The browser loads the
 * vendored laz-perf as a <script>; here the same file is run in a vm context
 * and handed its .wasm directly, so the offline tools and the tests decode
 * exactly what a phone would.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { lazDecoder } from './laz.js';

const here = dirname(fileURLToPath(import.meta.url));

export function nodeLazFactory() {
  const ctx = { console, WebAssembly, URL, TextDecoder, TextEncoder, setTimeout, clearTimeout, performance };
  ctx.window = ctx; // the build is web-only: it checks for a window before it will start
  vm.createContext(ctx);
  vm.runInContext(`${readFileSync(join(here, 'vendor/laz-perf.js'), 'utf8')}\nthis.createLazPerf = createLazPerf;`, ctx);
  return ctx.createLazPerf;
}

export async function fetchRetry(url, as, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return as === 'json' ? r.json() : r.arrayBuffer();
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** i));
    }
  }
  throw last;
}

/** The io object ept.js's pointsIn wants. */
export function nodeIo() {
  const wasmBinary = readFileSync(join(here, 'vendor/laz-perf.wasm'));
  return {
    getJson: (u) => fetchRetry(u, 'json'),
    getBytes: (u) => fetchRetry(u, 'bytes'),
    decompress: lazDecoder(nodeLazFactory, { wasmBinary }),
  };
}
