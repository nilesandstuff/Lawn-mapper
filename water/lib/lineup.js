/**
 * FIELD READINGS LINED UP WITH THE TEST MAP THEY WERE TAKEN ON, BY PLACE (owner, 2026-11-17: "Line the readings up by
 * the location... Do this automatically so I don't have to do it", and "the /moisture page has the ability to take
 * measurements on pages that don't yet have an admin save map. So those need to be pinned to an address, and then
 * cued up to have an admin map made for them later"). Pure: the hourly sweep (src/autoscore.js lineUpVisits) gives it
 * the visits and the admin saves, and moves what it says.
 *
 * A visit's place is the middle of its readings (else where the phone stood). Its home is the admin save whose
 * property line holds that place (within TOL_M, the phone's GPS at the lot's edge), else whose parcel number is the
 * visit's, else, for a save with no property line, whose lawn holds it; of several, the newest. A visit with a home is
 * put on it; one with none stays pinned to its parcel number and waits for a test map of that lot (waiting()), and if
 * it sits on a test map of another lot it is taken off it. Readings on an ordinary map are left there until a test
 * map of their lot exists.
 */
import { offLawnM } from './walkrecords.js';

export const TOL_M = 10;

/** The middle of a visit's readings, else its own place, else null. readings: [{ lng, lat }] */
export function placeOf(visit, readings = []) {
  const ok = readings.filter((r) => Number.isFinite(r?.lng) && Number.isFinite(r?.lat));
  if (ok.length) return [ok.reduce((a, r) => a + r.lng, 0) / ok.length, ok.reduce((a, r) => a + r.lat, 0) / ok.length];
  return Number.isFinite(visit?.lng) && Number.isFinite(visit?.lat) ? [visit.lng, visit.lat] : null;
}

const asGeom = (p) => (p?.type === 'Feature' ? p.geometry : p?.type ? p : null);

/**
 * The admin save a place belongs to, or null. saves: [{ id, at, parcel (Feature or geometry), pin, shapes }]
 */
export function homeFor(pt, pin, saves) {
  if (!pt) return null;
  const hits = [];
  for (const s of saves || []) {
    const g = asGeom(s.parcel);
    if (g) { const d = offLawnM(pt, [g]); if (d !== null && d <= TOL_M) { hits.push(s); continue; } }
    if (pin && s.pin && String(pin) === String(s.pin)) { hits.push(s); continue; }
    if (!g && s.shapes?.length) { const d = offLawnM(pt, s.shapes); if (d !== null && d <= TOL_M) hits.push(s); }
  }
  hits.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return hits[0]?.id ?? null;
}

/**
 * What to move. visits: [{ id, map_id, parcel_pin, lng, lat, readings: [{ lng, lat }] }]; saves as homeFor's.
 * -> { moves: [{ id, from, to (a save id, or null: off a test map of another lot) }], waiting: [visit ids] }
 */
export function lineUp(visits, saves) {
  const isSave = new Set((saves || []).map((s) => s.id));
  const moves = [], waiting = [];
  for (const v of visits || []) {
    const pt = placeOf(v, v.readings);
    if (!pt) continue;
    const home = homeFor(pt, v.parcel_pin, saves);
    if (home) { if (v.map_id !== home) moves.push({ id: v.id, from: v.map_id ?? null, to: home }); continue; }
    waiting.push(v.id);
    if (v.map_id && isSave.has(v.map_id)) moves.push({ id: v.id, from: v.map_id, to: null });
  }
  return { moves, waiting };
}

/** A save record (GET /api/maps/one's map) as homeFor reads it. */
export function saveShape(id, s) {
  const parcel = s?.parcel || null;
  return { id, at: s?.at || null, parcel, pin: parcel?.properties?.pin || s?.parcelPin || null, shapes: Array.isArray(s?.shapes) ? s.shapes : [] };
}
