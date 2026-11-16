/**
 * THE MAPS THE WATER MAP CAN OPEN (owner, 2026-10-23: "get rid of the address entry and the 'use where I am'
 * and replace it with a drop down menu to load other saved maps that have completed lawn and shade maps").
 *
 * From GET /api/maps (docs/MAPS.md): the lawn is done when the map has its measured square feet, and the shade
 * map when the shade tool has kept its part -- the dashboard's own rules (home/public/dashboard.js doneAt).
 * Newest first, as the list comes. Pure.
 */

export const lawnDone = (m) => Number(m?.squareFeet) > 0;
export const shadeDone = (m) => !!m?.tools?.shade?.updatedAt;
/* ADMIN SAVES (docs/MAPS.md, 2026-11-11; owner, 2026-11-16: "the water map isn't recognizing that the shade maps done
   through the admin save route are actually finished"): the administrator's test maps, made in one press, every tool
   run from it by itself. GET /api/maps leaves them out for the administrator; GET /api/maps?admin=1 lists only them.
   One is ready for the water map once its lawn is traced: the water map reads the lidar itself, and the shade map's
   part, when there, is used as on any map. */
export const isAdminSave = (m) => m?.adminSave === true || String(m?.id || '').startsWith('admin|');
export const ready = (m) => lawnDone(m) && (shadeDone(m) || isAdminSave(m));

/** The maps to offer: [{ id, label, test }], the test maps (admin saves) first. */
export function openable(maps, adminSaves = []) {
  const ok = (m) => m?.id && ready(m) && Number.isFinite(m.lng) && Number.isFinite(m.lat);
  const one = (m, test) => ({ id: String(m.id), test, label: `${test ? 'Test map: ' : ''}${m.address || 'A map'} · ${Math.round(Number(m.squareFeet)).toLocaleString('en-US')} sq ft` });
  const seen = new Set();
  const tests = (Array.isArray(adminSaves) ? adminSaves : []).filter(ok).map((m) => (seen.add(String(m.id)), one(m, true)));
  return [...tests, ...(Array.isArray(maps) ? maps : []).filter((m) => ok(m) && !seen.has(String(m.id))).map((m) => one(m, isAdminSave(m)))];
}
