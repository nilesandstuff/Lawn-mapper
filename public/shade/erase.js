/**
 * THE ERASER FOR TREE BLOCKS (owner, 2026-10-15: "The user can erase (and
 * undo) tree blocks in this step. The eraser should use a square cursor,
 * like a brush tool, with multiple sizes available"). A tree that has been
 * felled since the laser flew, or a neighbor's that the visitor does not
 * want counted, is brushed out of the model; the shade is then worked out
 * without it (light-worker.js takes the erased mask).
 *
 * The brush is a square `sizeM` meters wide on the ground, centered on the
 * pointer; it takes every 1 m column whose center it covers. Strokes are
 * kept for undo, one stroke at a time. The pure parts are exported for
 * tools/shade.test.js; the map part is in trees-ui.js.
 */

import { fromMerc } from './ept.js';

export const SIZES_M = [1, 3, 6]; // the brush widths offered

/** The cells of `grid` (grid.js, 1 m cells) whose centers a square `sizeM` wide at the 3857 point (x, y) covers. */
export function cellsUnder(grid, x, y, sizeM) {
  const half = (sizeM / 2) * grid.cell; // grid.cell is one meter in 3857 units at this latitude
  const cellY = grid.cellY || grid.cell;
  const c0 = Math.ceil((x - half - grid.x0) / grid.cell - 0.5), c1 = Math.floor((x + half - grid.x0) / grid.cell - 0.5);
  const r0 = Math.ceil((grid.y1 - (y + half)) / cellY - 0.5), r1 = Math.floor((grid.y1 - (y - half)) / cellY - 0.5);
  const out = [];
  for (let r = Math.max(0, r0); r <= Math.min(grid.h - 1, r1); r++) {
    for (let c = Math.max(0, c0); c <= Math.min(grid.w - 1, c1); c++) out.push(r * grid.w + c);
  }
  return out;
}

/** The brush's outline on the map (a closed ring of [lng, lat]) for the cursor. */
export function squareRing(grid, x, y, sizeM) {
  const half = (sizeM / 2) * grid.cell;
  return [[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half], [x - half, y - half]].map((p) => fromMerc(p));
}

/**
 * What has been erased: a mask per grid cell, and the strokes behind it
 * for undo. `erase(cells)` adds to the open stroke and returns the cells
 * newly erased; `end()` closes the stroke; `undo()` returns the cells of
 * the last stroke, back in the model; `clear()` returns everything.
 */
export class Erased {
  constructor(n) { this.mask = new Uint8Array(n); this.strokes = []; this.open = null; this.count = 0; }
  erase(cells) {
    const fresh = [];
    for (const k of cells) {
      if (this.mask[k]) continue;
      this.mask[k] = 1; fresh.push(k);
    }
    if (fresh.length) {
      if (!this.open) { this.open = []; this.strokes.push(this.open); }
      this.open.push(...fresh);
      this.count += fresh.length;
    }
    return fresh;
  }
  end() { this.open = null; }
  undo() {
    this.open = null;
    const s = this.strokes.pop() || [];
    for (const k of s) this.mask[k] = 0;
    this.count -= s.length;
    return s;
  }
  clear() {
    this.open = null;
    const all = this.strokes.flat();
    this.strokes = [];
    this.mask.fill(0);
    this.count = 0;
    return all;
  }
  get any() { return this.count > 0; }
}
