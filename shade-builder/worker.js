/**
 * THE SHADE BUILDER'S WORKER (owner, 2026-11-11): a Durable Object that runs
 * the shade build's Node server (server.mjs) in a Cloudflare Container and
 * passes requests to it. It has no public address (workers_dev = false, no
 * routes): only the main Worker reaches it, through its service binding
 * SHADE_BUILDER, with POST /build { map, base } (worker/src/shade-server-build.js).
 * The container: the "basic" instance (1 GiB, a quarter of a CPU), internet
 * on (the lidar, the photos), stopped after five idle minutes.
 */
import { DurableObject } from 'cloudflare:workers';

const PORT = 8080;
const IDLE_MS = 5 * 60 * 1000;

export class ShadeBuilder extends DurableObject {
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
    if (!c.running) c.start({ ...(c.images?.base ? { image: c.images.base } : {}), enableInternet: true });
    this.ctx.waitUntil(c.monitor().catch((e) => console.error('shade builder container stopped:', e)));
    await c.setInactivityTimeout(IDLE_MS);
    const port = c.getTcpPort(PORT);
    for (let i = 0; i < 300; i++) { // up to a minute for the server to come up
      try { const r = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1000) }); await r.body?.cancel(); if (r.ok) return; } catch { /* not listening yet */ }
      await new Promise((ok) => setTimeout(ok, 200));
    }
    throw new Error('the shade builder did not come up on its port');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['/build', '/health'].includes(url.pathname)) return new Response('not found', { status: 404 });
    const stub = env.SHADE_BUILDER_DO.get(env.SHADE_BUILDER_DO.idFromName('builder')); // one container: one build at a time
    return stub.fetch(request);
  },
};
