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

/*
 * THE BRANCHES BRUSH (owner, 2026-10-17: "just remove the tree blocks that
 * are facing the camera. 1 swipe removes the top layer of blocks (top as in
 * closest to the camera...), another swipe takes out the next layer").
 *
 * WHAT THE FINGER IS ON (owner, 2026-10-21: branch mode "is still deleting
 * whole columns"). The map's own event gives the point on the GROUND under
 * the finger; with the map tilted, a finger on a crown 10 m up is over
 * ground some 17 m behind the tree, so the brush worked on columns nobody
 * was touching. The block under the finger is the first one a ray from the
 * camera through that ground point meets.
 *
 * rayHit(cam, target, opts): cam and target are [x, y, z] in the grid's
 * cells (x east, y south; one cell is one real metre) and metres up; the ray
 * runs from cam through target and on. opts: { w, h, cubeAt(k, z) -> layer
 * or -1, visible(k, l) -> bool, taken: Set of cube indices (k * nz + l) the
 * ray must stop at, nz, zTop, zBottom, stepM }. Returns { k, l, at: [x, y,
 * z], s } for the first visible block, or null (nothing, or a taken one
 * first: one layer per stroke).
 */
export function rayHit(cam, target, { w, h, nz, cubeAt, visible, taken = null, zTop = 90, zBottom = -40, stepM = 0.2 }) {
  const d = [target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 0)) return null;
  const u = d.map((v) => v / len);
  /* Only the stretch inside the grid and between the heights can hit anything (slabs). */
  let s0 = 0, s1 = Infinity;
  for (const [i, lo, hi] of [[0, 0, w], [1, 0, h], [2, zBottom, zTop]]) {
    if (Math.abs(u[i]) < 1e-12) { if (cam[i] < lo || cam[i] > hi) return null; continue; }
    let a = (lo - cam[i]) / u[i], b = (hi - cam[i]) / u[i];
    if (a > b) [a, b] = [b, a];
    s0 = Math.max(s0, a); s1 = Math.min(s1, b);
  }
  if (!(s1 > s0)) return null;
  for (let s = s0; s <= s1; s += stepM) {
    const x = cam[0] + u[0] * s, y = cam[1] + u[1] * s, z = cam[2] + u[2] * s;
    const cx = Math.floor(x), cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    const k = cy * w + cx, l = cubeAt(k, z);
    if (l < 0) continue;
    if (taken && taken.has(k * nz + l)) return null;
    if (visible(k, l)) return { k, l, at: [x, y, z], s };
  }
  return null;
}

/**
 * The brush's rays: targets spread over a square `sizeM` wide, square to the
 * line of sight, centred on the point `at` the finger's ray hit; about two
 * per metre each way. The blocks they meet first are the surface facing the
 * camera, whatever the camera's angle.
 */
export function brushTargets(cam, at, sizeM) {
  const d = [at[0] - cam[0], at[1] - cam[1], at[2] - cam[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const u = d.map((v) => v / len);
  let a = [u[1], -u[0], 0]; // across the view, level
  const al = Math.hypot(a[0], a[1]);
  a = al > 1e-6 ? [a[0] / al, a[1] / al, 0] : [1, 0, 0];
  const b = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]; // up the view
  const n = Math.max(1, Math.round(sizeM / 0.5));
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = ((i + 0.5) / n - 0.5) * sizeM, q = ((j + 0.5) / n - 0.5) * sizeM;
    out.push([at[0] + a[0] * p + b[0] * q, at[1] + a[1] * p + b[1] * q, at[2] + a[2] * p + b[2] * q]);
  }
  return out;
}
