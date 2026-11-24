/**
 * THE WATER MAP WITH NO PAGE OPEN (owner, 2026-11-16: walks scored the way the shade map builds, no page open; the
 * core session's plan, agreed the same day). The page's own analysis worker (public/analyse.js) and the shade light
 * worker run here in Node, unchanged, so a walk is scored exactly as opening its map scores it: the same plan, the
 * same canopy, the same walkCheck. What a browser gives them is stood in for:
 *   self            a message port: postMessage out is collected, onmessage in is called
 *   Worker          a worker_threads thread running boot-worker.mjs
 *   '/lib/...'      the water library on disk (loader.mjs); the browser's data reader the Node one
 *   fetch('/...')   the live water site (base), whose public routes reach the lidar, the climate, the streams and
 *                   the property lookups exactly as the page's do
 * Stage 1 (2026-11-16): the canopy is built from the lidar as the page builds it today; stage 2 (to-do 27) moves the
 * page and this together to the shade map's finished model.
 *
 *   const run = await openMap({ site, inputs, base });   // the plan, as the page works it out
 *   const res = await run.walkCheck({ records, series, notes });
 *   run.close();
 */
import { Worker as NodeWorker } from 'node:worker_threads';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = process.env.WATER_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
let ready = null;

function setUp(base) {
  if (ready) return ready;
  register('./loader.mjs', import.meta.url, { data: { root: ROOT } });
  const listeners = new Set();
  globalThis.self = globalThis;
  self.postMessage = (m) => { for (const f of [...listeners]) f(m); };
  self.__listen = (f) => { listeners.add(f); return () => listeners.delete(f); };
  // the page's relative requests go to the live site
  const realFetch = globalThis.fetch;
  /* THE FUSED MODEL (2026-11-24): the page reads it from the account routes with the person's sign-in; here there is
     none, so the water Worker hands the file over first (server.mjs /fused, from the main site's private fusedOf) and
     this answers the same address from it: the bytes, or 404 when the map has none. */
  globalThis.fetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/api/maps/model')) {
      const u = new URL(input, 'http://x'), bytes = u.searchParams.get('file') === 'fused' ? globalThis.WATER_FUSED?.get(`${u.searchParams.get('id')}|${u.searchParams.get('part') || 0}`) : null;
      return Promise.resolve(bytes ? new Response(bytes, { status: 200 }) : new Response('{"error":"no-model"}', { status: 404 }));
    }
    return realFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init);
  };
  globalThis.location = { href: `${base}/`, origin: base };
  globalThis.WATER_SHADE_MS = 45 * 6e4; // the shade step's limit: a browser's 4 minutes is too short on a container's shared CPU
  // a module Web Worker over worker_threads
  globalThis.Worker = class {
    constructor(url) {
      const path = String(url).startsWith('/lib/') ? join(ROOT, 'lib', String(url).slice(5)) : join(ROOT, 'public', String(url).replace(/^\//, ''));
      this.t = new NodeWorker(new URL('./boot-worker.mjs', import.meta.url), { workerData: { file: path, root: ROOT }, resourceLimits: { maxOldGenerationSizeMb: 1280 } });
      const debug = process.env.WATER_BUILDER_DEBUG === '1';
      this.t.on('message', (d) => { if (debug) console.log('light worker ->', d?.type); this.onmessage?.({ data: d }); });
      this.t.on('error', (e) => { if (debug) console.log('light worker error', e?.message); this.onerror?.({ message: e?.message || String(e) }); });
      this.t.on('exit', (c) => { if (debug) console.log('light worker exit', c); });
      this.debug = debug;
    }
    postMessage(m) { if (this.debug) console.log('light worker <-', m?.type); this.t.postMessage(m); }
    terminate() { this.t.terminate(); }
  };
  ready = import(pathToFileURL(join(ROOT, 'public/analyse.js')).href);
  return ready;
}

/** Wait for the first message that `pick` accepts (or an error), within ms. */
function waitFor(pick, ms) {
  return new Promise((resolve, reject) => {
    const stop = self.__listen((m) => {
      if (m?.error && !m.walkCheck && !m.surfCheck) { stop(); clearTimeout(timer); reject(new Error(m.error)); return; }
      if (m?.planError) { stop(); clearTimeout(timer); reject(new Error(`the plan: ${m.planError}`)); return; }
      const got = pick(m);
      if (got !== undefined) { stop(); clearTimeout(timer); resolve(got); }
    });
    const timer = setTimeout(() => { stop(); reject(new Error(`no answer in ${Math.round(ms / 1000)} s`)); }, ms);
  });
}

/** The map worked out as the page works it out. -> { plan (the worker's plan message), walkCheck(...), close() } */
export async function openMap({ site, inputs, base, minutes = 60 }) {
  await setUp(base);
  const planP = waitFor((m) => (m?.plan ? m.plan : undefined), minutes * 6e4);
  self.onmessage({ data: { site, inputs } });
  const plan = await planP;
  let n = 0;
  return {
    plan,
    async walkCheck({ records, series, notes }) {
      const id = `builder${++n}`;
      const p = waitFor((m) => (m?.walkCheck?.id === id ? m.walkCheck : undefined), 6 * 6e4);
      self.onmessage({ data: { walkCheck: { id, records, series, notes } } });
      return p;
    },
    /** any other question the page asks its worker (moment, explain, moistureAt: public/explore.js), by its key */
    async ask(key, body, ms = 10 * 6e4) {
      const id = `builder${++n}`;
      const p = waitFor((m) => (m?.[key]?.id === id ? m[key] : undefined), ms);
      self.onmessage({ data: { [key]: { id, ...body } } });
      return p;
    },
    close() { /* the light worker threads end with each check; the process ends with the job */ },
  };
}
