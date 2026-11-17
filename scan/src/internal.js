/* THE PRIVATE ENTRYPOINT (2026-11-16; the owner said yes to scoring thermal walks with no page open): reached only by
   the main Worker's binding SCAN_INTERNAL (entrypoint "Internal"); it has no address on the internet, so it asks for
   no cookie. The main Worker hands what it reads on to the water site's own private entrypoint, for admin saves only
   (worker/src/internal.js). Kept out of index.js so the tests, which run index.js in Node, need no Workers runtime. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { thermalData, convertedWalks } from './thermal.js';
import { snapsList, snapOf, snapPng, placeSnap } from './thermal-snap.js';

export class Internal extends WorkerEntrypoint {
  /** A map's walks (walk null) or one walk: { status, body } as GET /api/scan/thermal answers. */
  async thermalOf(map, walk = null) { return thermalData(this.env, String(map || ''), walk == null ? null : String(walk)); }
  /** Every walk whose converted grid has landed: [{ map, walk, at }]. */
  async convertedWalks() { return convertedWalks(this.env); }
  /* DEV ONLY: single thermal photos (thermal-snap.js), for the water site's readings page through the main Worker */
  /** [{ id, at, map, placed, converted }], newest first: a map's (with those tied to no map yet), or all. */
  async thermalSnaps(map = null, opts = {}) { return snapsList(this.env, { map: map == null ? null : String(map), loose: opts.loose !== false, since: Number(opts.since) || 0, until: Number(opts.until) || 1e15 }); }
  /** One photo: its notes, the converter's answer and where it was placed; null when there is no such photo. */
  async thermalSnap(id) { return snapOf(this.env, String(id || '')); }
  /** Its preview picture: { bytes, type } or null. */
  async thermalSnapPng(id) { return snapPng(this.env, String(id || '')); }
  /** Where the owner stood: { lng, lat, heading?, map?, note? } -> { ok, place } or { error }. */
  async placeThermalSnap(id, place) { return placeSnap(this.env, String(id || ''), place || {}); }
}
