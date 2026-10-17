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
 * What has been erased: a mask per grid cell (whole columns, the "whole
 * tree" brush), a mask per cube (the "branches" brush: one block at a time,
 * the one nearest the camera), and the strokes behind both for undo.
 * `erase(cells)` adds columns to the open stroke and returns the cells
 * newly erased; `eraseCubes(idx)` does the same for cubes (index k * nz + l,
 * as canopy.js lays mu out); `end()` closes the stroke; `undo()` puts the
 * last stroke back; `clear()` everything.
 */
export class Erased {
  constructor(n, nz = 0) {
    this.mask = new Uint8Array(n);
    this.nz = nz;
    this.cubes = nz ? new Uint8Array(n * nz) : null;
    this.strokes = []; this.open = null; this.count = 0; this.cubeCount = 0;
  }
  stroke() { if (!this.open) { this.open = { cols: [], cubes: [] }; this.strokes.push(this.open); } return this.open; }
  erase(cells) {
    const fresh = [];
    for (const k of cells) {
      if (this.mask[k]) continue;
      this.mask[k] = 1; fresh.push(k);
    }
    if (fresh.length) { this.stroke().cols.push(...fresh); this.count += fresh.length; }
    return fresh;
  }
  eraseCubes(idx) {
    if (!this.cubes) return [];
    const fresh = [];
    for (const i of idx) {
      if (i < 0 || i >= this.cubes.length || this.cubes[i]) continue;
      this.cubes[i] = 1; fresh.push(i);
    }
    if (fresh.length) { this.stroke().cubes.push(...fresh); this.cubeCount += fresh.length; }
    return fresh;
  }
  end() { this.open = null; }
  undo() {
    this.open = null;
    const s = this.strokes.pop() || { cols: [], cubes: [] };
    for (const k of s.cols) this.mask[k] = 0;
    for (const i of s.cubes) this.cubes[i] = 0;
    this.count -= s.cols.length;
    this.cubeCount -= s.cubes.length;
    return s;
  }
  clear() {
    this.open = null;
    const all = { cols: this.strokes.flatMap((s) => s.cols), cubes: this.strokes.flatMap((s) => s.cubes) };
    this.strokes = [];
    this.mask.fill(0);
    if (this.cubes) this.cubes.fill(0);
    this.count = 0; this.cubeCount = 0;
    return all;
  }
  /** The erased cubes as a sorted list of indices (kept with the map). */
  cubeList() { const out = []; if (this.cubes) for (let i = 0; i < this.cubes.length; i++) if (this.cubes[i]) out.push(i); return out; }
  get any() { return this.count > 0 || this.cubeCount > 0; }
}

/**
 * THE BRANCHES BRUSH (owner, 2026-10-17: "another erasing mode for removing
 * specific branches, so just remove the tree blocks that are facing the
 * camera. 1 swipe removes the top layer of blocks (top as in closest to the
 * camera...), another swipe takes out the next layer, and so on").
 *
 * Of a column's drawn blocks (`runs`: [{ l0, l1, base, top }], cube layers
 * and meters over the ground), the one nearest the camera at `cam`
 * ([gx, gy, z]: grid cells and absolute meters), measured to the block's
 * center, `cm` meters per cell. Null when the column has none.
 */
export function nearestRun(runs, k, w, groundZ, cam, cm) {
  if (!runs?.length) return null;
  const cx = (k % w) + 0.5, cy = Math.floor(k / w) + 0.5;
  let best = null, bestD = Infinity;
  for (const r of runs) {
    const z = groundZ + (r.base + r.top) / 2;
    const d = Math.hypot((cam[0] - cx) * cm, (cam[1] - cy) * cm, cam[2] - z);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}
