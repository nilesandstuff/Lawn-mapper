/**
 * THE LOW-SPOT MAP AS A PICTURE (water session): RGBA pixels, `scale`
 * pixels to a grid cell, north up. Pure, so a page's canvas and the offline
 * tool's PNG draw the same thing.
 *
 *   grey shading      the ground, lit from the north-west, slopes exaggerated
 *   dark slate        roofs (found from the points, lib/surface.js)
 *   blue              reported low spots, darker = deeper (full at 10 cm)
 *   pale blue         filled hollows too shallow to tell from noise
 *   cyan line         where runoff gathers (>= `flowArea` m^2 upslope)
 *   outline of roofs  red: ground falls toward the wall (> 1%)
 *                     amber: falls away, but less than the code's 5%
 *                     green: 5% or more away
 *   white box         the lot, if one is given (in cells)
 */

export function renderMap(result, { scale = 4, flowArea = 250, lot = null } = {}) {
  const g = result.grid, W = g.W * scale, H = g.H * scale;
  const px = new Uint8ClampedArray(W * H * 4);
  const z = result.z, wall = result.wall;
  const depth = result.spots.depth, label = result.spots.label;
  const reported = new Set(result.spots.spots.filter((s) => s.reported).map((s) => s.id));
  // ids in `label` follow discovery order, before the sort; map them back
  const byId = new Map(result.spots.spots.map((s) => [s.id, s]));
  const at = (r, c) => z[Math.min(g.H - 1, Math.max(0, r)) * g.W + Math.min(g.W - 1, Math.max(0, c))];
  const wallColour = new Map(result.beside.walls.map((w) => [w.i, w.fallAway < -0.01 ? [220, 40, 40] : w.fallAway < 0.05 ? [240, 170, 30] : [60, 170, 70]]));
  const cell = new Array(g.W * g.H);
  for (let r = 0; r < g.H; r++) for (let c = 0; c < g.W; c++) {
    const i = r * g.W + c;
    let rgb;
    if (wall[i]) rgb = wallColour.get(i) || [70, 80, 95];
    else {
      const dzdx = (at(r, c + 1) - at(r, c - 1)) / (2 * g.cell), dzdy = (at(r - 1, c) - at(r + 1, c)) / (2 * g.cell);
      const ex = 8; // vertical exaggeration: a yard's relief is centimetres
      const nx = -dzdx * ex, ny = -dzdy * ex, nz = 1, nl = Math.hypot(nx, ny, nz);
      const light = Math.max(0, (nx * -0.5 + ny * 0.5 + nz * 0.7071) / nl);
      const v = 70 + 170 * light;
      rgb = [v, v, v];
      const d = depth[i];
      if (d > 0.002) {
        const s = byId.get(label[i]);
        if (s && reported.has(s.id)) {
          const t = Math.min(1, d / 0.10);
          rgb = [rgb[0] * (0.5 - 0.4 * t), rgb[1] * (0.6 - 0.3 * t) + 40, 200 + 55 * t];
        } else rgb = [rgb[0] * 0.8, rgb[1] * 0.85, Math.min(255, rgb[2] * 0.95 + 40)];
      }
      if (result.runoff.area[i] >= flowArea) rgb = [40, 210, 230];
    }
    cell[i] = rgb;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const rgb = cell[Math.floor(y / scale) * g.W + Math.floor(x / scale)];
    const o = (y * W + x) * 4;
    px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
  }
  if (lot) {
    const [c0, r0, c1, r1] = lot.map((v) => Math.round(v * scale));
    for (let x = c0; x <= c1; x++) for (const y of [r0, r1]) dot(px, W, H, x, y);
    for (let y = r0; y <= r1; y++) for (const x of [c0, c1]) dot(px, W, H, x, y);
  }
  return { width: W, height: H, data: px };
}

function dot(px, W, H, x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4;
  px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = 255;
}
