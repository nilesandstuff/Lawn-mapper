/**
 * THE EARLIER WALK'S SHAPE, MATCHED OFF THE PAGE'S THREAD (core session, 2026-11-09; scan/lib/walkref.js, SCAN-H32).
 * A module worker, so a match (a second or two, more on a phone) never stalls the camera.
 *
 * In:  { ref: ArrayBuffer }                         the map's reference (GET /api/scan/reference?map=)
 *      { fix: { id, stand: [[u, v, y]], ground, prior? } }  this walk's points so far, in its session; prior: where
 *                                                   GPS has it ({ T, searchM, searchDeg }), a bound on the search
 * Out: { ready: { stand, ground, at } } or { error }; { fix, id } (walkref.js shapeFix's answer)
 */
import { decodeRef, shapeFix } from '/lib/walkref.js';
import { compose } from '/lib/refkeep.js';

let REF = null;

self.onmessage = ({ data }) => {
  if (data.ref) {
    REF = decodeRef(new Uint8Array(data.ref));
    self.postMessage(REF ? { ready: { stand: REF.stand.length / 3, ground: REF.ground.length / 3, at: REF.at } } : { error: 'the reference could not be read' });
  }
  if (data.fix) {
    let fix;
    // the walk is stretched by the reference's own `phone` inside shapeFix; a prior, when the page has one, bounds the search
    try { fix = shapeFix(REF, data.fix, data.fix.prior ? { prior: data.fix.prior } : {}); } catch (err) { fix = { ok: false, why: `the match failed: ${err.message}` }; }
    // the match is to the yard's SHAPE; where that shape is on the map is the reference's own P (walkref.js, version 2).
    // T stays what the page has always been given, the walk on the MAP; Ts is the walk on the shape.
    if (fix?.T) { fix.Ts = fix.T; fix.T = compose(REF.P, fix.T); }
    self.postMessage({ fix, id: data.fix.id });
  }
};
