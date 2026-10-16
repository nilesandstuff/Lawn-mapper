/**
 * THE LIDAR READERS' I/O IN A WEB WORKER (water session). The shade page
 * loads laz-perf with a <script> tag (lib/laz.js browserFactory); a module
 * worker has no document, so here the same vendored file is fetched, run,
 * and handed its .wasm -- the same trick lib/node-io.js plays in Node.
 */

import { lazDecoder } from './laz.js';

let factory = null;
async function workerFactory(base) {
  if (!factory) {
    const src = await (await fetch(`${base}/vendor/laz-perf.js`)).text();
    factory = (0, eval)(`${src}\n;createLazPerf`); // eslint-disable-line no-eval
  }
  return factory;
}

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url, location.href).host}`);
  return res.json();
}

async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url, location.href).host}`);
  return res.arrayBuffer();
}

export async function workerIo(base = '/lib') {
  const wasmBinary = await (await fetch(`${base}/vendor/laz-perf.wasm`)).arrayBuffer();
  const f = await workerFactory(base);
  return { getJson, getBytes, decompress: lazDecoder(() => f, { wasmBinary }) };
}
