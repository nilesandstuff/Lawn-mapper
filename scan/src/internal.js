/* THE PRIVATE ENTRYPOINT (2026-11-16; the owner said yes to scoring thermal walks with no page open): reached only by
   the main Worker's binding SCAN_INTERNAL (entrypoint "Internal"); it has no address on the internet, so it asks for
   no cookie. The main Worker hands what it reads on to the water site's own private entrypoint, for admin saves only
   (worker/src/internal.js). Kept out of index.js so the tests, which run index.js in Node, need no Workers runtime. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { thermalData, convertedWalks } from './thermal.js';

export class Internal extends WorkerEntrypoint {
  /** A map's walks (walk null) or one walk: { status, body } as GET /api/scan/thermal answers. */
  async thermalOf(map, walk = null) { return thermalData(this.env, String(map || ''), walk == null ? null : String(walk)); }
  /** Every walk whose converted grid has landed: [{ map, walk, at }]. */
  async convertedWalks() { return convertedWalks(this.env); }
}
