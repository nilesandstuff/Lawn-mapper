/**
 * THE SHADE BUILDER'S WORKER (owner, 2026-11-11): a Durable Object that runs
 * the shade build's Node server (server.mjs) in a Cloudflare Container and
 * passes requests to it. It has no public address (workers_dev = false, no
 * routes): only the main Worker reaches it, through its service binding
 * SHADE_BUILDER, with POST /build { map, base } (worker/src/shade-server-build.js).
 * The container: the "basic" instance (1 GiB, a quarter of a CPU), internet
 * on (the lidar, the photos), stopped after five idle minutes.
 *
 * ONE IMAGE, ONE BUILD (2026-11-16): a container already running when a new
 * builder is deployed keeps its old image until it stops, and answered a
 * rebuild at the old SHADE_BUILD minutes after the deploy (the owner's house,
 * build 4). So before each build the running container's /health build is
 * compared with the one this Worker was deployed with (app/, laid out by
 * prepare.mjs from the same commit), and a container on another build is
 * destroyed and started again from the new image.
 */
import { DurableObject } from 'cloudflare:workers';
import { SHADE_BUILD } from './app/public/shade/build.js';

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
    if (c.running && (await this.buildOf(c)) !== SHADE_BUILD) {
      try { await c.destroy(); } catch { /* already stopping */ }
      for (let i = 0; i < 150 && c.running; i++) await new Promise((ok) => setTimeout(ok, 200));
    }
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

  /** The running container's SHADE_BUILD (its /health), or null when it does not say. */
  async buildOf(c) {
    try {
      const r = await c.getTcpPort(PORT).fetch('http://container/health', { signal: AbortSignal.timeout(2000) });
      const j = await r.json().catch(() => null);
      return Number.isFinite(j?.build) ? j.build : null;
    } catch { return null; }
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
