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
  // the sweep every six hours, and at once while the queue has never held a job (a backlog the pushes lost)
  const empty = !(await env.DB?.prepare('SELECT 1 AS x FROM kit_jobs LIMIT 1').first().catch(() => null));
  const log = async (what) => {
    console.log(what);
    try {
      await env.DB.prepare('INSERT INTO kit_log (at, what) VALUES (?, ?)').bind(Date.now(), String(what).slice(0, 500)).run();
      await env.DB.prepare('DELETE FROM kit_log WHERE at < (SELECT MIN(at) FROM (SELECT at FROM kit_log ORDER BY at DESC LIMIT 200))').run();
    } catch { /* the log is a convenience */ }
  };
  if ((at.getUTCHours() % 6 === 0 && at.getUTCMinutes() < 5) || empty) {
    const n = await sweep(env).catch((e) => ({ error: e?.message || String(e) }));
    await log(`sweep${env.MAIN ? '' : ' (no MAIN binding)'}: ${n.error ? `failed (${n.error})` : `${n.saves} admin saves, ${n.walks} walks (${n.converted} converted, ${n.waiting} waiting, ${n.failed} failed; ${n.scored} already scored), ${n.queued} queued`}`);
  }
  const done = await runQueue(env).catch((e) => [{ state: 'error', why: String(e?.message || e) }]);
  if (done.length) await log(done.map((d) => `${d.state}${d.why ? ` (${d.why})` : ''}`).join('; '));
}

export default { ...site, scheduled };
