/* THE MAIN WORKER'S PRIVATE ENTRYPOINT (2026-11-16; water-push.js says why): reached only by the water Worker's
   binding MAIN (entrypoint "Internal"). It has no address on the internet, so it asks for no cookie; it answers for
   ADMIN SAVES ONLY (anything else is null). Kept apart from index.js, which the tests run in Node. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { findAdminSave, adminSavesList, modelOfSave, thermalOfSave } from './water-push.js';
import { makeWholeSave } from './admin-saves.js';

export class Internal extends WorkerEntrypoint {
  /** The admin save's record as GET /api/maps/one gives it, or null. */
  async saveOf(id) { return (await findAdminSave(this.env, id))?.map ?? null; }
  /** { bytes (gzipped, as GET /api/maps/model?tool=shade returns), modelAt }, or null. part 1..8: an overflow part. */
  async modelOf(id, part = 0) { return modelOfSave(this.env, id, part); }
  /** walk null: the save's walks, as GET /api/maps/thermal?id= returns; a walk: that walk, as with &walk=. */
  async thermalOf(id, walk = null) { return thermalOfSave(this.env, id, walk); }
  /** [{ id, modelAt, at }] for every admin save (the water side's daily sweep). */
  async adminSaves() { return adminSavesList(this.env); }
  /* DEV ONLY: SINGLE THERMAL PHOTOS (the owner, 2026-11-17; the yard AR site's src/thermal-snap.js), for the water
     site's readings page. A photo belongs to no map until the owner places it; saveId names an admin save. */
  /** [{ id, at, map, placed, converted }], newest first: the save's photos and those placed nowhere yet, or all. */
  async thermalSnaps(saveId = null, opts = {}) {
    if (!this.env.SCAN_INTERNAL) return [];
    const f = saveId == null ? null : await findAdminSave(this.env, saveId);
    if (saveId != null && !f) return [];
    return this.env.SCAN_INTERNAL.thermalSnaps(f ? f.map.id : null, opts);
  }
  async thermalSnap(id) { return this.env.SCAN_INTERNAL ? this.env.SCAN_INTERNAL.thermalSnap(id) : null; }
  async thermalSnapPng(id) { return this.env.SCAN_INTERNAL ? this.env.SCAN_INTERNAL.thermalSnapPng(id) : null; }
  /** { lng, lat, heading?, saveId?, note? } -> { ok, place } or { error }: saveId ties the photo to that save's map. */
  /** A whole-property admin save at a point, made with no press (admin-saves.js makeWholeSave): the admin save that
   *  already holds the point, or a new one of the parcel there. -> { id, created } or { error }. */
  async makeWholeSave(lng, lat) { return makeWholeSave(this.env, Number(lng), Number(lat)); }
  async placeThermalSnap(id, place = {}) {
    if (!this.env.SCAN_INTERNAL) return { error: 'no scan site' };
    let map = null;
    if (place.saveId != null) { const f = await findAdminSave(this.env, place.saveId); if (!f) return { error: 'which save?' }; map = f.map.id; }
    return this.env.SCAN_INTERNAL.placeThermalSnap(id, { lng: place.lng, lat: place.lat, heading: place.heading ?? null, map, note: place.note ?? null });
  }
}
