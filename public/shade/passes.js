/**
 * ONE LEAF STATE PER LOT, WHERE THE LIDAR ALLOWS IT (owner, 2026-10-29:
 * "We need to be sure that fully in-leaf canopies are treated as such and
 * not given extra leaves. If the lidar was flown partially in leaf, that's a
 * bigger problem").
 *
 * A survey is flown over weeks or seasons, and USGS joins the passes into
 * one cloud: Ketchum's 2023-24 gap survey has a September 2023 pass and an
 * August 2024 one over the same lot; a work unit can just as well hold a
 * March pass and a July one. Every point carries the day its pulse was fired
 * (las.js leafOfMs), so the leaf state is read from the points over the lot,
 * not from the survey's span or one median time.
 *
 *   - All the lot's dated points in one state: that state.
 *   - Both: 'mixed', and EVERY POINT IS KEPT (owner, 2026-11-04: "We should
 *     never, under any circumstances, remove a lidar return"). seasonal.js
 *     then judges column by column: a column a third or more of whose crown
 *     returns were fired in leaf already shows its summer canopy and gets no
 *     leaves added; the rest are treated as bare branches. Until 2026-11-04
 *     the smaller pass's points were dropped when the larger covered the lot
 *     alone; no longer.
 */

import { LEAF_OFF, LEAF_ON } from './las.js';

export const COVER_CELL_M = 2;

/**
 * cols: the cloud's columns (with `leaf`); lot: [x0, y0, x1, y1] in the
 * columns' units (EPSG:3857); metersPer: meters per unit there (cos lat).
 * Returns { cols (always every point, unchanged), season: 'off'|'on'|'mixed'|null,
 * off, on, dropped (always 0), cover } -- season null when no point over
 * the lot keeps a date.
 */
export function onePass(cols, lot, metersPer = 1, { cellM = COVER_CELL_M } = {}) {
  const none = { cols, season: null, off: 0, on: 0, dropped: 0, cover: null };
  if (!cols?.leaf || !cols.n) return none;
  const [x0, y0, x1, y1] = lot;
  const cell = cellM / metersPer;
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell)), ny = Math.max(1, Math.ceil((y1 - y0) / cell));
  const any = new Uint8Array(nx * ny), has = [null, new Uint8Array(nx * ny), new Uint8Array(nx * ny)];
  let off = 0, on = 0;
  for (let i = 0; i < cols.n; i++) {
    const x = cols.x[i], y = cols.y[i];
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    const c = Math.min(ny - 1, Math.floor((y - y0) / cell)) * nx + Math.min(nx - 1, Math.floor((x - x0) / cell));
    any[c] = 1;
    const v = cols.leaf[i];
    if (v === LEAF_OFF) { off++; has[LEAF_OFF][c] = 1; } else if (v === LEAF_ON) { on++; has[LEAF_ON][c] = 1; }
  }
  if (!off && !on) return none;
  if (!on) return { ...none, season: 'off', off };
  if (!off) return { ...none, season: 'on', on };
  /* How much of the lot each pass reaches (2 m squares holding any point), for the report. */
  let squares = 0, onSq = 0, offSq = 0;
  for (let c = 0; c < any.length; c++) if (any[c]) { squares++; if (has[LEAF_ON][c]) onSq++; if (has[LEAF_OFF][c]) offSq++; }
  return { cols, season: 'mixed', off, on, dropped: 0, cover: squares ? { on: onSq / squares, off: offSq / squares } : null };
}
