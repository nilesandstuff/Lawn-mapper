/**
 * THE WATER BUILDER'S WORKER (owner, 2026-11-16; the shade builder's pattern, shade-builder/worker.js): a Durable
 * Object fronting the container (server.mjs). No public address (workers_dev = false, no routes): only the water
 * Worker reaches it, through its service binding WATER_BUILDER. The "basic" instance (1 GiB, a quarter CPU), internet
 * on (the lidar, the weather), stopped after five idle minutes. Before each request the running container's /health
 * build is compared with this deploy's, and an old one is restarted from the new image (the shade builder's lesson).
 */
import { DurableObject } from 'cloudflare:workers';
import { BUILD } from './app/builder/build.js';

const PORT = 8080;
const IDLE_MS = 5 * 60 * 1000;

export class WaterBuilder extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const c = ctx.container;
    if (c?.running) void ctx.blockConcurrencyWhile(() => c.setInactivityTimeout(IDLE_MS));
  }
  async fetch(request) {
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    await this.starting;
    const url = new URL(request.url);
    url.protocol = 'http:'; url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }
  async start() {
    const c = this.ctx.container;
    if (c.running && (await this.buildOf(c)) !== BUILD) {
      try { await c.destroy(); } catch { /* already stopping */ }
      for (let i = 0; i < 150 && c.running; i++) await new Promise((ok) => setTimeout(ok, 200));
    }
    this.exit = null;
    if (!c.running) c.start({ ...(c.images?.base ? { image: c.images.base } : {}), enableInternet: true });
    // why the container stopped, if it does: said in the error the water Worker keeps (its readings report shows it)
    this.ctx.waitUntil(c.monitor().then(() => { this.exit = 'the container exited'; }).catch((e) => { this.exit = `the container stopped: ${String(e?.message || e).slice(0, 200)}`; console.error('water builder container stopped:', e); }));
    await c.setInactivityTimeout(IDLE_MS);
    const port = c.getTcpPort(PORT);
    let last = '';
    for (let i = 0; i < 900; i++) { // up to three minutes: a first start pulls the image
      if (this.exit) break;
      try { const r = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1000) }); await r.body?.cancel(); if (r.ok) return; last = `health answered ${r.status}`; } catch (e) { last = String(e?.message || e).slice(0, 120); }
      await new Promise((ok) => setTimeout(ok, 200));
    }
    throw new Error(`the water builder did not come up on its port (${this.exit || last || 'no answer'}; running: ${c.running})`);
  }
  async buildOf(c) {
    try {
      const r = await c.getTcpPort(PORT).fetch('http://container/health', { signal: AbortSignal.timeout(2000) });
      return (await r.json().catch(() => null))?.build ?? null;
    } catch { return null; }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['/score', '/health'].includes(url.pathname)) return new Response('not found', { status: 404 });
    const stub = env.WATER_BUILDER_DO.get(env.WATER_BUILDER_DO.idFromName('builder')); // one container: one map at a time
    return stub.fetch(request);
  },
};
