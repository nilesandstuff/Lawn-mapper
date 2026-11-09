/**
 * THE EARLIER WALK'S SHAPE, MATCHED OFF THE PAGE'S THREAD (core session, 2026-11-09; scan/lib/walkref.js, SCAN-H32).
 * A module worker, so a match (a second or two, more on a phone) never stalls the camera.
 *
 * In:  { ref: ArrayBuffer }                         the map's reference (GET /api/scan/reference?map=)
 *      { fix: { id, stand: [[u, v, y]], ground } }  this walk's points so far, in its session
 * Out: { ready: { stand, ground, at } } or { error }; { fix, id } (walkref.js shapeFix's answer)
 */
import { decodeRef, shapeFix } from '/lib/walkref.js';

let REF = null;

self.onmessage = ({ data }) => {
  if (data.ref) {
    REF = decodeRef(new Uint8Array(data.ref));
    self.postMessage(REF ? { ready: { stand: REF.stand.length / 3, ground: REF.ground.length / 3, at: REF.at } } : { error: 'the reference could not be read' });
  }
  if (data.fix) {
    let fix;
    try { fix = shapeFix(REF, data.fix); } catch (err) { fix = { ok: false, why: `the match failed: ${err.message}` }; }
    self.postMessage({ fix, id: data.fix.id });
  }
};
