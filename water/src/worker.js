/**
 * THE WATER WORKER'S ENTRY (wrangler's main since 2026-11-16): the site (src/index.js, unchanged) and the named
 * entrypoint Internal, which only the main site's Worker reaches, over its service binding WATER (no public address:
 * not a URL route the internet could call). src/index.js stays importable in Node for the tests; this file needs the
 * Workers runtime ('cloudflare:workers').
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import site from './index.js';
import { enqueue } from './jobs.js';
import { runQueue, sweep } from './autoscore.js';

export class Internal extends WorkerEntrypoint {
  /** An admin save's shade model landed or was rebuilt: its scoring kit is to be (re)built. */
  async modelChanged(id, modelAt) { return enqueue(this.env, 'model', id, { modelAt }); }
  /** A thermal walk's converted grid landed: it is to be scored. */
  async walkReady(id, walk) { return enqueue(this.env, 'walk', id, { walk }); }
}

/* THE TIMER (every five minutes, tools/prepare.mjs [triggers]): one queued walk scored a run; every six hours, the
   sweep for walks a push missed (src/autoscore.js). Logs say counts and states only. */
async function scheduled(controller, env, ctx) {
  const at = new Date(controller.scheduledTime || Date.now());
  if (at.getUTCHours() % 6 === 0 && at.getUTCMinutes() < 5) console.log(`sweep: ${await sweep(env).catch(() => 0)} walks queued`);
  const done = await runQueue(env).catch((e) => [{ state: 'error', why: String(e?.message || e) }]);
  if (done.length) console.log(done.map((d) => `${d.state}${d.why ? ` (${d.why})` : ''}`).join('; '));
}

export default { ...site, scheduled };
