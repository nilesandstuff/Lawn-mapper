/**
 * THE LIDAR DRAWN AT 0.5 M (owner, 2026-11-09, via the core session: "I'm
 * actually not sure if I've ever actually seen the .5m lidar grid because of
 * the way the shade map rounds it to 1m for the view (which I would like to
 * change to .5m)"; the owner suspects roofs read wider than the buildings).
 *
 * The light and every rule stay on the 1 m columns (canopy.js, structures.js,
 * all measured there). This is the picture only: each half-meter cell is
 * drawn where the laser itself hit it, in half-meter blocks, coloured by the
 * kind of the 1 m column it lies in. A building or low structure is drawn
 * solid from its ground to its highest return in that half meter, so a roof
 * ends where its returns end; everything else is drawn where the returns are.
 * Heights are over the 1 m column's ground (the one surface every map stands
 * on), so the half-meter blocks sit on the same ground as the 1 m ones.
 */
import { NOISE } from './structures.js';

export const FINE_M = 0.5, FINE_DZ = 0.5, FINE_LOW_M = 0.3, FINE_MAX_M = 80;

/**
 * Where the laser hit, per half-meter cell: { f, W, H, cellX, cellY, x0, y1,
 * cells: [{ fi, k, layers (sorted, each FINE_DZ over the ground) }] }. `grid`
 * the 1 m grid (grid.js gridOver), `ground` its ground per column.
 */
export function fineCells(cols, grid, shift, ground, { fine = FINE_M, dz = FINE_DZ, lowM = FINE_LOW_M, maxM = FINE_MAX_M } = {}) {
  const f = Math.max(1, Math.round(1 / fine));
  const W = grid.w * f, H = grid.h * f, cellX = grid.cell / f, cellY = (grid.cellY || grid.cell) / f;
  const sx = shift ? shift[0] : 0, sy = shift ? shift[1] : 0;
  const hit = new Map();
  for (let i = 0; i < cols.n; i++) {
    if (NOISE.has(cols.cls[i])) continue;
    const fx = Math.floor((cols.x[i] + sx - grid.x0) / cellX), fy = Math.floor((grid.y1 - (cols.y[i] + sy)) / cellY);
    if (fx < 0 || fy < 0 || fx >= W || fy >= H) continue;
    const k = Math.floor(fy / f) * grid.w + Math.floor(fx / f);
    const over = cols.z[i] - ground[k];
    if (!(over > lowM) || over > maxM) continue;
    const fi = fy * W + fx, l = Math.floor(over / dz);
    let s = hit.get(fi);
    if (!s) { s = new Set(); hit.set(fi, s); }
    s.add(l);
  }
  const cells = [];
  for (const [fi, s] of hit) {
    const fx = fi % W, fy = Math.floor(fi / W);
    cells.push({ fi, k: Math.floor(fy / f) * grid.w + Math.floor(fx / f), layers: [...s].sort((a, b) => a - b) });
  }
  return { f, W, H, cellX, cellY, x0: grid.x0, y1: grid.y1, dz, cells };
}

/**
 * The blocks to draw: [{ fi, k, base, top (m over the ground), kind }].
 * `kindAt(k)` the 1 m column's drawn kind ('roof', 'structure', a tree's ...);
 * `gone(k)` true for an erased column; `cubeGone(k, zOver)` true where the
 * person erased the 1 m block at that height; `roofs` false hides buildings
 * and low structures; `cut` hides what is below that height.
 */
export function fineRuns(fc, { kindAt, gone = () => false, cubeGone = () => false, roofs = true, cut = 0 } = {}) {
  const out = [], dz = fc.dz;
  for (const c of fc.cells) {
    if (gone(c.k)) continue;
    const kind = kindAt(c.k);
    if (!kind) continue;
    const solid = kind === 'roof' || kind === 'structure';
    if (solid && !roofs) continue;
    if (solid) {
      const top = (c.layers[c.layers.length - 1] + 1) * dz;
      if (top > cut) out.push({ fi: c.fi, k: c.k, base: cut, top, kind });
      continue;
    }
    let run = null;
    const close = () => { if (run) { out.push(run); run = null; } };
    for (const l of c.layers) {
      const b = l * dz, t = b + dz;
      if (t <= cut || cubeGone(c.k, b + dz / 2)) { close(); continue; }
      if (run && Math.abs(run.top - b) < 1e-9) { run.top = t; continue; }
      close();
      run = { fi: c.fi, k: c.k, base: Math.max(b, cut), top: t, kind };
    }
    close();
  }
  return out;
}

/** The corners of half-meter cell `fi` as a ring in EPSG:3857. */
export function fineRing(fc, fi) {
  const fx = fi % fc.W, fy = Math.floor(fi / fc.W);
  const X0 = fc.x0 + fx * fc.cellX, X1 = X0 + fc.cellX, Y1 = fc.y1 - fy * fc.cellY, Y0 = Y1 - fc.cellY;
  return [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], [X0, Y0]];
}
