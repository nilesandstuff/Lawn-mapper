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
 *   - Both, but the larger share alone covers the lot (a point in 95% or more
 *     of the 2 m squares that hold any point): that state, and the other
 *     pass's points are left out, so a canopy is never part summer leaves
 *     and part winter branches with leaves added on top.
 *   - Both, and neither covers the lot alone (a seam between a spring pass
 *     and a summer one crosses it): 'mixed', and every point is kept;
 *     seasonal.js then judges column by column, and a column whose crown
 *     returns are mostly in leaf gets no leaves added.
 */

import { LEAF_OFF, LEAF_ON, filterColumns } from './las.js';

export const COVER_SHARE = 0.95; // the larger pass alone must reach this share of the lot's 2 m squares
export const COVER_CELL_M = 2;

/**
 * cols: the cloud's columns (with `leaf`); lot: [x0, y0, x1, y1] in the
 * columns' units (EPSG:3857); metersPer: meters per unit there (cos lat).
 * Returns { cols, season: 'off'|'on'|'mixed'|null, off, on, dropped,
 * cover } -- season null when no point over the lot keeps a date.
 */
export function onePass(cols, lot, metersPer = 1, { coverShare = COVER_SHARE, cellM = COVER_CELL_M } = {}) {
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
  const big = on >= off ? LEAF_ON : LEAF_OFF, small = big === LEAF_ON ? LEAF_OFF : LEAF_ON;
  let squares = 0, covered = 0;
  for (let c = 0; c < any.length; c++) if (any[c]) { squares++; if (has[big][c]) covered++; }
  const cover = squares ? covered / squares : 0;
  if (cover < coverShare) return { cols, season: 'mixed', off, on, dropped: 0, cover };
  const kept = filterColumns(cols, (i) => cols.leaf[i] !== small);
  return { cols: kept, season: big === LEAF_ON ? 'on' : 'off', off, on, dropped: cols.n - kept.n, cover };
}
