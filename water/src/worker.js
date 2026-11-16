/**
 * THE WATER WORKER'S ENTRY (wrangler's main since 2026-11-16): the site (src/index.js, unchanged) and the named
 * entrypoint Internal, which only the main site's Worker reaches, over its service binding WATER (no public address:
 * not a URL route the internet could call). src/index.js stays importable in Node for the tests; this file needs the
 * Workers runtime ('cloudflare:workers').
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import site from './index.js';
import { enqueue } from './jobs.js';

export class Internal extends WorkerEntrypoint {
  /** An admin save's shade model landed or was rebuilt: its scoring kit is to be (re)built. */
  async modelChanged(id, modelAt) { return enqueue(this.env, 'model', id, { modelAt }); }
  /** A thermal walk's converted grid landed: it is to be scored. */
  async walkReady(id, walk) { return enqueue(this.env, 'walk', id, { walk }); }
}

export default site;
