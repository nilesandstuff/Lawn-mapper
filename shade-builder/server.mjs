/**
 * THE SHADE BUILD AS A SERVICE (owner, 2026-11-11: admin saves' shade build
 * "runs on cloudflare so I don't need to leave the page open"). A small Node
 * server, run in a Cloudflare Container (shade-builder/worker.js): the build
 * needs about 180 MB on a medium lot, more than a Worker's 128 MB.
 *
 *   GET  /health                 -> ok
 *   POST /build { map, base }    -> { ok, why?, result, part: { data, basedOn } | null, model: base64 gzip }
 *
 * `map` is the saved map's record as the main Worker's getMap gives it (with
 * `tools`); `base` the site's origin (https://lawnmap.<home>), for the public
 * routes the build reads (/api/shade/lidar, /api/imagery, /api/lidar/tiles).
 * It runs public/shade/rebuild.js rebuildModel exactly as the page's modules
 * do, with firstBuild (a map never opened in the shade map gets the page's
 * survey choice and photo line-up), and hands the model and the shade part
 * back instead of saving them: the main Worker stores them as the map's
 * owner. One build at a time.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { rebuildModel } = await import('./public/shade/rebuild.js');
const { lazDecoder } = await import('./public/shade/laz.js');

/* laz-perf (the browser's copy) in Node, as tools/shade-site.js loads it: its own globals hidden, the wasm handed in. */
// eslint-disable-next-line no-new-func
const createLazPerf = new Function('window', 'process', 'require', `${readFileSync(here('./public/shade/vendor/laz-perf.js'), 'utf8')}; return createLazPerf;`)({ location: { href: '' } }, undefined, undefined);
const wasmBinary = readFileSync(here('./public/shade/vendor/laz-perf.wasm'));
const decompress = lazDecoder(() => (opts) => createLazPerf({ ...opts, wasmBinary }));

/** A photo's bytes (PNG or JPEG) -> { data (RGBA), width, height }. */
export async function decodeImage(buf) {
  const b = Buffer.from(buf);
  if (b[0] === 0x89 && b[1] === 0x50) { const p = PNG.sync.read(b); return { data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.length), width: p.width, height: p.height }; }
  if (b[0] === 0xff && b[1] === 0xd8) { const j = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 }); return { data: new Uint8ClampedArray(j.data.buffer, j.data.byteOffset, j.data.length), width: j.width, height: j.height }; }
  throw new Error(`not a PNG or JPEG (${b.subarray(0, 4).toString('hex')})`);
}

/** Build one map: { ok, why?, result, part, model (base64) }. `fetchImpl` for tests. */
export async function buildMap({ map, base }, { fetchImpl = globalThis.fetch, onProgress = () => {} } = {}) {
  if (!map || typeof map !== 'object' || !Number.isFinite(map.lng) || !Number.isFinite(map.lat)) return { ok: false, why: 'no map record' };
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(String(base || ''))) return { ok: false, why: 'no site origin' };
  let model = null, part = null;
  const fetchFn = async (u, init = {}) => {
    const url = String(u);
    if (url.startsWith(`${base}/api/maps/one`)) return new Response(JSON.stringify({ map }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith(`${base}/api/maps/model`) && init.method === 'PUT') { model = Buffer.from(new Uint8Array(init.body)); return new Response('{"ok":true}', { status: 200 }); }
    if (url.startsWith(`${base}/api/maps/tool`) && init.method === 'POST') { part = JSON.parse(init.body); return new Response('{"ok":true}', { status: 200 }); }
    return fetchImpl(url, init);
  };
  const result = await rebuildModel(map.id || map.key || 'map', { base, fetchFn, firstBuild: true, decompress, decodeImage, decodePng: decodeImage, onProgress });
  if (!result.ok) return { ok: false, why: result.why, result };
  return { ok: true, result, part, model: model ? model.toString('base64') : null };
}

let busy = Promise.resolve();
const server = http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method === 'POST' && req.url === '/build') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const run = busy.then(() => buildMap(body)); // one at a time: the memory is the limit
      busy = run.catch(() => {});
      const t0 = Date.now();
      const out = await run;
      return send(200, { ...out, seconds: Math.round((Date.now() - t0) / 1000) });
    }
    send(404, { ok: false, why: 'not found' });
  } catch (e) {
    send(500, { ok: false, why: String(e?.message || e) });
  }
});
if (process.env.SHADE_BUILDER_LISTEN !== '0') server.listen(Number(process.env.PORT || 8080), () => console.log('shade builder listening'));
export { server };
