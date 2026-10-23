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

/** The maps to offer: [{ id, label }]. */
export function openable(maps) {
  return (Array.isArray(maps) ? maps : [])
    .filter((m) => m?.id && lawnDone(m) && shadeDone(m) && Number.isFinite(m.lng) && Number.isFinite(m.lat))
    .map((m) => ({ id: String(m.id), label: `${m.address || 'A map'} · ${Math.round(Number(m.squareFeet)).toLocaleString('en-US')} sq ft` }));
}
