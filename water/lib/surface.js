/**
 * THE GROUND, AS A 1 m SURFACE WITH ITS OWN ERROR BAR (water session).
 *
 * Input: a point cloud's columns (lib/ept.js, EPSG:3857) and the box they
 * were read over. Output: a grid in REAL meters (web-mercator x and y scaled
 * by cos(lat), see ept.js's note), row 0 at the NORTH edge, holding
 *
 *   z      the ground's height, a Gaussian-weighted mean of the class-2
 *          points around the cell's centre (sigma 0.8 m, out to 2 m)
 *   se     the standard error of that height: the points' local scatter over
 *          the square root of their effective count. The core session
 *          measured 1.2-3.5 cm of scatter inside 1 m cells on 11 corpus lots
 *          (water/FINDINGS.md H1); a low spot is only reported when it is
 *          deeper than its own error bar, and this is that bar.
 *   n      ground points within 2 m (for the reader: "how much is this made of")
 *   building  1 where a roof stands (below)
 *
 * WHY SMOOTH AT ALL. Kent County's 2016 flight has about 1.2 ground points
 * per square meter on the first lot read, so most 1 m cells hold 0-2 points
 * and a 1 m cell's own mean is mostly noise. The kernel spends resolution
 * (a 2 m spot survives, a 1 m one does not) to buy a height good to about a
 * centimetre -- the same trade the core session's ~2 m minimum already makes.
 *
 * BUILDINGS. Not every 3DEP flight classes buildings (Kent 2016 holds only
 * classes 1, 2 and 7), so a roof is found from the points: a cell with no
 * ground under it, where the points stand 2 m or more over the ground around
 * and nearly all of them are single returns (a roof stops the pulse; a tree,
 * even a bare one, lets later returns through). Pieces under 15 m^2 are
 * dropped (a car, a hedge) and small holes in a roof filled. Class 6 is used
 * as is when the flight has it.
 */

import { mercScale } from './ept.js';
import { gridOver } from './shade/grid.js';
import { groundSurface as sharedGround, inpaint as sharedInpaint, KERNEL_SIGMA, KERNEL_RADIUS } from './shade/ground.js';

export { KERNEL_SIGMA, KERNEL_RADIUS };



/** Where the grid sits: real-meter cells over a web-mercator box. */
export function gridFor(bbox, lat, cell = 1) {
  const k = mercScale(lat);
  const W = Math.round(((bbox[2] - bbox[0]) * k) / cell);
  const H = Math.round(((bbox[3] - bbox[1]) * k) / cell);
  return {
    W, H, cell, k, bbox, lat,
    /** EPSG:3857 -> fractional column/row (row 0 north). */
    toCell: (x, y) => [((x - bbox[0]) * k) / cell, ((bbox[3] - y) * k) / cell],
    /** A cell's centre back to EPSG:3857. */
    toMerc: (c, r) => [bbox[0] + ((c + 0.5) * cell) / k, bbox[3] - ((r + 0.5) * cell) / k],
  };
}

/**
 * The ground surface -- ONE PIECE OF CODE WITH THE SHADE MAP (owner, 2026-10-17): lib/shade/ground.js,
 * copied unchanged from public/shade/, is the water map's former groundSurface moved onto the shade
 * map's grid. These two keep the water map's (grid, ...) call shape and hand over to it.
 * Returns { z, se, sd, n, sigma } (NaN where no ground point lies within KERNEL_RADIUS).
 */
export function groundSurface(g, cols, opts = {}) {
  return sharedGround(cols, shadeGrid(g), opts);
}

/** Fill NaN cells from their neighbours, outward, so every cell has a height. */
export function inpaint(g, z) {
  return sharedInpaint(shadeGrid(g), z);
}

/** The shade map's grid (grid.js gridOver) for the same box: identical cells (1 real m, row 0 north). */
export function shadeGrid(g) {
  return gridOver(g.bbox, g.cell, g.lat);
}

/** 8-connected components of mask==1: { label (Int32Array, 0 = none), sizes [index = label] }. */
export function components(g, mask) {
  const label = new Int32Array(mask.length);
  const sizes = [0];
  let next = 1;
  const stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    label[s] = next; stack.push(s);
    let size = 0;
    while (stack.length) {
      const i = stack.pop(); size++;
      const r = Math.floor(i / g.W), c = i % g.W;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if ((!dr && !dc) || rr < 0 || cc < 0 || rr >= g.H || cc >= g.W) continue;
        const j = rr * g.W + cc;
        if (mask[j] && !label[j]) { label[j] = next; stack.push(j); }
      }
    }
    sizes.push(size); next++;
  }
  return { label, sizes };
}

/**
 * Where roofs are: Uint8Array W*H. `ground` is the inpainted ground height.
 * See the header for the rule.
 */
export function buildingMask(g, cols, groundRaw, ground, { minHeight = 2, singleShare = 0.8, minArea = 15 } = {}) {
  const N = g.W * g.H;
  const hasClass6 = (() => { for (let i = 0; i < cols.n; i++) if (cols.cls[i] === 6) return true; return false; })();
  const tall = new Uint16Array(N), single = new Uint16Array(N), ground1 = new Uint16Array(N), roof6 = new Uint16Array(N);
  for (let i = 0; i < cols.n; i++) {
    const [fc, fr] = g.toCell(cols.x[i], cols.y[i]);
    const c = Math.floor(fc), r = Math.floor(fr);
    if (c < 0 || r < 0 || c >= g.W || r >= g.H) continue;
    const j = r * g.W + c;
    const cls = cols.cls[i];
    if (cls === 2) { ground1[j]++; continue; }
    if (cls === 6) roof6[j]++;
    if (cls === 7 || cls === 18 || cls === 9) continue; // noise, water
    if (cols.z[i] - ground[j] < minHeight) continue;
    tall[j]++;
    if (cols.nret[i] <= 1) single[j]++;
  }
  let mask = new Uint8Array(N);
  for (let j = 0; j < N; j++) {
    if (hasClass6) mask[j] = roof6[j] > 0 ? 1 : 0;
    else mask[j] = tall[j] > 0 && ground1[j] === 0 && single[j] >= singleShare * tall[j] ? 1 : 0;
  }
  // close one cell (sparse returns leave pinholes in a roof), then drop small pieces
  mask = close1(g, mask);
  const { label, sizes } = components(g, mask);
  for (let j = 0; j < N; j++) if (mask[j] && sizes[label[j]] * g.cell * g.cell < minArea) mask[j] = 0;
  // holes in a roof (no points at all, e.g. a dark skylight) belong to it
  const empty = new Uint8Array(N);
  for (let j = 0; j < N; j++) empty[j] = mask[j] ? 0 : 1;
  const holes = components(g, empty);
  const touchesEdge = new Set();
  for (let c = 0; c < g.W; c++) { touchesEdge.add(holes.label[c]); touchesEdge.add(holes.label[(g.H - 1) * g.W + c]); }
  for (let r = 0; r < g.H; r++) { touchesEdge.add(holes.label[r * g.W]); touchesEdge.add(holes.label[r * g.W + g.W - 1]); }
  for (let j = 0; j < N; j++) {
    const l = holes.label[j];
    if (l && !touchesEdge.has(l) && holes.sizes[l] <= 6 && Number.isNaN(groundRaw[j])) mask[j] = 1;
  }
  return { mask, fromClass6: hasClass6 };
}

function close1(g, m) {
  const grow = morph(g, m, true), shrink = morph(g, grow, false);
  return shrink;
}

function morph(g, m, dilate) {
  const out = new Uint8Array(m.length);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    let v = dilate ? 0 : 1;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      const x = rr < 0 || cc < 0 || rr >= g.H || cc >= g.W ? (dilate ? 0 : 1) : m[rr * g.W + cc];
      if (dilate && x) v = 1;
      if (!dilate && !x) v = 0;
    }
    out[r * g.W + c] = v;
  }
  return out;
}
