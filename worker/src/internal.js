/* THE MAIN WORKER'S PRIVATE ENTRYPOINT (2026-11-16; water-push.js says why): reached only by the water Worker's
   binding MAIN (entrypoint "Internal"). It has no address on the internet, so it asks for no cookie; it answers for
   ADMIN SAVES ONLY (anything else is null). Kept apart from index.js, which the tests run in Node. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { findAdminSave, adminSavesList, modelOfSave, thermalOfSave } from './water-push.js';

export class Internal extends WorkerEntrypoint {
  /** The admin save's record as GET /api/maps/one gives it, or null. */
  async saveOf(id) { return (await findAdminSave(this.env, id))?.map ?? null; }
  /** { bytes (gzipped, as GET /api/maps/model?tool=shade returns), modelAt }, or null. */
  async modelOf(id) { return modelOfSave(this.env, id); }
  /** walk null: the save's walks, as GET /api/maps/thermal?id= returns; a walk: that walk, as with &walk=. */
  async thermalOf(id, walk = null) { return thermalOfSave(this.env, id, walk); }
  /** [{ id, modelAt, at }] for every admin save (the water side's daily sweep). */
  async adminSaves() { return adminSavesList(this.env); }
}
