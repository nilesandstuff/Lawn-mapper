/**
 * SIZE LABELS (owner, 2026-10-27; docs/TODO.md item 1): every lawn area in
 * the editor, and every section in the sections tool, shows its size inside
 * itself. One copy of the wording and the placement, used by both.
 *
 *   under 1,000      as it is         "850 sqft"
 *   1,000 to 9,999   one decimal, k   "1.1 k sqft"
 *   10,000 and up    whole k          "12 k sqft"
 */

import { placeInside } from './frontage.js';

export function sizeLabel(sqft) {
  const n = Math.max(0, Number(sqft) || 0);
  if (n < 999.5) return `${Math.round(n)} sqft`;
  const k = n / 1000;
  if (Math.round(k * 10) / 10 < 10) return `${(Math.round(k * 10) / 10).toFixed(1)} k sqft`;
  return `${Math.round(k)} k sqft`;
}

/** The centre of a ring's bounding box (screen pixels). */
function middle(ring) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/**
 * Where a w x h label sits wholly inside a shape, in screen pixels, or null
 * when the shape is too small to hold it (then the label is hidden, never
 * hanging over the edge). `rings` is the shape's outer ring then its holes;
 * a label never sits over a hole. `reach` keeps it near the middle: a label
 * pushed far from it reads as belonging to the next shape.
 */
export function labelSpot(rings, w, h, { avoid = [], pad = 2 } = {}) {
  const outer = rings?.[0];
  if (!outer || outer.length < 3) return null;
  const holes = (rings.slice(1) || []).map((r) => {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return [x0, y0, x1, y1];
  });
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const [x, y] of outer) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 - x0 < w || y1 - y0 < h) return null;
  const reach = Math.max(x1 - x0, y1 - y0) / 2;
  return placeInside(outer, middle(outer), w, h, { pad, reach, step: Math.max(3, Math.min(8, reach / 20)), avoid: [...avoid, ...holes] });
}
