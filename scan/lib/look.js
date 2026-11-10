/**
 * HOW THE LIDAR LOOKS IN THE CAMERA (core session, 2026-11-10; docs/SCAN-DIVERGENCES.md). The owner: "making the
 * lidar look more like the objects it represents... Right now, roofs just look terrible... the lidar blocks show
 * very faintly... I think roofs should be black, walls white, trees green, random objects orange. And displayed at
 * .5m, with smoothing of course."
 *
 * FOR THE EYE ONLY: nothing here is matched against, and nothing here judges what a column is. What stands where is
 * the shade map's answer as the match already has it (lidar.js buildGrids: bld, occ, occTop, dem on 0.25 m; the
 * shade map's columns for the crowns). This file puts it on 0.5 m cells by kind and makes each kind one smooth
 * surface: a corner shared by cells stands at the mean of their heights, so a gable slopes and a crown rounds, where
 * boxes made stairs.
 *
 *   roof     the cells under a BUILDING column, a thin sheet at the roof's height (black)
 *   wall     the building's walls as the match has them (the shade map's wallsOf outline), ground to roof (white)
 *   object   every other solid cell the shade map calls a low structure or unknown: sheds, walls, bins (orange)
 *   trunk    solid cells of a tree column: the posts the trunks were made into (green)
 *   canopy   a tree column's crown, from its lowest leaf to its top (green)
 */
export const SHOW_CELL = 0.5;
const ROOF_THICK = 0.25;

/* Colours, [r, g, b, a]: a top and two side tones each, so a shape reads as a shape with no lights in the shader. */
export const LOOK = {
  roof: { top: [0.04, 0.04, 0.05, 0.82], ns: [0.1, 0.1, 0.11, 0.82], ew: [0.07, 0.07, 0.08, 0.82], bottom: [0.02, 0.02, 0.02, 0.82] },
  wall: { top: [0.95, 0.95, 0.95, 0.78], ns: [1, 1, 1, 0.78], ew: [0.84, 0.84, 0.86, 0.78] },
  object: { top: [1, 0.6, 0.15, 0.78], ns: [1, 0.52, 0.08, 0.78], ew: [0.85, 0.42, 0.05, 0.78] },
  trunk: { top: [0.2, 0.62, 0.26, 0.78], ns: [0.16, 0.55, 0.22, 0.78], ew: [0.12, 0.46, 0.18, 0.78] },
  canopy: { top: [0.24, 0.78, 0.32, 0.6], ns: [0.18, 0.66, 0.26, 0.6], ew: [0.14, 0.56, 0.22, 0.6], bottom: [0.1, 0.42, 0.16, 0.6] },
};

/**
 * The five kinds on SHOW_CELL cells. G: lidar.js buildGrids' answer ({ box, cell, W, H, dem, occ, occTop, bld });
 * roofAt(k): the roof's absolute height over fine cell k, or NaN; cols: the shade map's columns in map metres
 * ({ w, h, e0, n1, cellE, cellN, tree: Uint8 (1 = a tree's column), lo, hi: the crown's absolute heights or NaN }).
 * Returns { cell, W, H, e0, n1, roof, wall, object, trunk, canopy } where each kind is { lo, hi } Float32 W*H, NaN
 * where the kind is not there. Rows run from the north.
 */
export function lookGrids(G, roofAt, cols) {
  const f = Math.max(1, Math.round(SHOW_CELL / G.cell));
  const W = Math.ceil(G.W / f), H = Math.ceil(G.H / f), N = W * H;
  const e0 = G.box[0], n1 = G.box[3], cell = G.cell * f;
  const make = () => ({ lo: new Float32Array(N).fill(NaN), hi: new Float32Array(N).fill(NaN) });
  const out = { cell, W, H, e0, n1, roof: make(), wall: make(), object: make(), trunk: make(), canopy: make() };
  const colAt = (e, n) => {
    if (!cols) return -1;
    const c = Math.floor((e - cols.e0) / cols.cellE), r = Math.floor((cols.n1 - n) / cols.cellN);
    return c < 0 || r < 0 || c >= cols.w || r >= cols.h ? -1 : r * cols.w + c;
  };
  const add = (g, j, lo, hi) => { g.lo[j] = Number.isNaN(g.lo[j]) ? lo : Math.min(g.lo[j], lo); g.hi[j] = Number.isNaN(g.hi[j]) ? hi : Math.max(g.hi[j], hi); };
  for (let R = 0; R < H; R++) for (let C = 0; C < W; C++) {
    const j = R * W + C;
    let roofSum = 0, roofN = 0;
    for (let r = R * f; r < Math.min(G.H, (R + 1) * f); r++) for (let c = C * f; c < Math.min(G.W, (C + 1) * f); c++) {
      const k = r * G.W + c, g = G.dem[k];
      if (G.bld[k]) { const h = roofAt(k); if (Number.isFinite(h)) { roofSum += h; roofN++; } }
      if (!G.occ[k] || !Number.isFinite(g)) continue;
      const top = g + Math.min(15, Math.max(0.5, G.occTop[k] || 0.5));
      if (G.bld[k]) { const h = roofAt(k); add(out.wall, j, g, Number.isFinite(h) ? h : top); continue; }
      const cj = colAt(G.box[0] + (c + 0.5) * G.cell, G.box[3] - (r + 0.5) * G.cell);
      add(cj >= 0 && cols.tree[cj] ? out.trunk : out.object, j, g, top);
    }
    if (roofN) { out.roof.hi[j] = roofSum / roofN; out.roof.lo[j] = out.roof.hi[j] - ROOF_THICK; }
    // the crown over this cell: its shade-map column's, where that column is a tree's
    const cj = colAt(e0 + (C + 0.5) * cell, n1 - (R + 0.5) * cell);
    if (cj >= 0 && cols.tree[cj] && Number.isFinite(cols.lo[cj]) && cols.hi[cj] > cols.lo[cj] && !roofN) { out.canopy.lo[j] = cols.lo[cj]; out.canopy.hi[j] = cols.hi[cj]; }
  }
  // a wall stops under its roof, never above the sheet drawn over it
  for (let j = 0; j < N; j++) if (!Number.isNaN(out.wall.hi[j]) && !Number.isNaN(out.roof.lo[j])) out.wall.hi[j] = Math.max(out.wall.lo[j] + 0.3, Math.min(out.wall.hi[j], out.roof.lo[j]));
  return out;
}

/**
 * One kind as a smooth surface, in map coordinates (east, height, north). A corner stands at the mean of the cells
 * round it that have the kind. Returns triangles' vertices: { top, bottom, ns, ew } (the sides facing north or south,
 * and east or west, apart, for their two tones); `bottom` only when asked (a crown seen from under it).
 */
export function heightMesh({ cell, W, H, e0, n1 }, lo, hi, { bottom = false } = {}) {
  const VW = W + 1, vh = new Float32Array(VW * (H + 1)), vl = new Float32Array(VW * (H + 1)), vn = new Uint8Array(VW * (H + 1));
  const has = (r, c) => r >= 0 && c >= 0 && r < H && c < W && !Number.isNaN(hi[r * W + c]);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const j = r * W + c; if (Number.isNaN(hi[j])) continue;
    for (const v of [r * VW + c, r * VW + c + 1, (r + 1) * VW + c, (r + 1) * VW + c + 1]) { vh[v] += hi[j]; vl[v] += lo[j]; vn[v]++; }
  }
  for (let v = 0; v < vn.length; v++) if (vn[v]) { vh[v] /= vn[v]; vl[v] /= vn[v]; }
  const out = { top: [], bottom: [], ns: [], ew: [] };
  const P = (r, c, y) => [e0 + c * cell, y, n1 - r * cell];
  const quad = (to, a, b, c2, d) => { to.push(...a, ...b, ...c2, ...a, ...c2, ...d); };
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!has(r, c)) continue;
    const nw = r * VW + c, ne = nw + 1, sw = nw + VW, se = sw + 1;
    quad(out.top, P(r, c, vh[nw]), P(r, c + 1, vh[ne]), P(r + 1, c + 1, vh[se]), P(r + 1, c, vh[sw]));
    if (bottom) quad(out.bottom, P(r, c, vl[nw]), P(r, c + 1, vl[ne]), P(r + 1, c + 1, vl[se]), P(r + 1, c, vl[sw]));
    if (!has(r - 1, c)) quad(out.ns, P(r, c, vh[nw]), P(r, c + 1, vh[ne]), P(r, c + 1, vl[ne]), P(r, c, vl[nw]));
    if (!has(r + 1, c)) quad(out.ns, P(r + 1, c, vh[sw]), P(r + 1, c + 1, vh[se]), P(r + 1, c + 1, vl[se]), P(r + 1, c, vl[sw]));
    if (!has(r, c - 1)) quad(out.ew, P(r, c, vh[nw]), P(r + 1, c, vh[sw]), P(r + 1, c, vl[sw]), P(r, c, vl[nw]));
    if (!has(r, c + 1)) quad(out.ew, P(r, c + 1, vh[ne]), P(r + 1, c + 1, vh[se]), P(r + 1, c + 1, vl[se]), P(r, c + 1, vl[ne]));
  }
  return out;
}

/** Every kind's surfaces with their colours, in drawing order: [{ kind, part, verts, color }]. */
export function lookMeshes(show) {
  const out = [];
  for (const kind of ['wall', 'object', 'trunk', 'canopy', 'roof']) {
    const g = show[kind]; if (!g) continue;
    const m = heightMesh(show, g.lo, g.hi, { bottom: kind === 'canopy' || kind === 'roof' });
    for (const part of ['top', 'ns', 'ew', 'bottom']) if (m[part].length && LOOK[kind][part]) out.push({ kind, part, verts: m[part], color: LOOK[kind][part] });
  }
  return out;
}

/**
 * THE LIDAR AS A PICTURE TO PLACE POINTS ON (core session, 2026-11-10; docs/SCAN-PLAN.md sections 17 and 20). The
 * owner: "we can try placing points to lidar... currently we guess at walls, but I don't think we should if we're
 * going this path", and, the night before, what would make it hard: blocks nobody can place a point on, canopies that
 * hide the ground, roofs drawn wider than the buildings, few places to mark.
 *
 * So this is drawn from the laser's own returns on 0.25 m cells, and nothing is guessed:
 *   the ground   its returns' brightness, smoothed between returns: paving against grass shows as it does in a photo
 *   a roof       dark, only where returns of a building's column stand over the ground (closed over the gaps between
 *                returns, then taken back in by the same amount, so it is no wider than its outermost returns);
 *                NO WALLS: where a wall stands under the eaves is not something the laser saw
 *   a tree       a thin green line round its crown; the ground under it stays in view
 *   other things (a shed, a wall, bins) orange, the same way as a roof
 *
 * pts: { n, e(i), nn(i), hag(i) height over the ground, bright(i), kind(i): 1 building, 2 tree, 3 other, 0 none }.
 * Returns { e0, n1, cell, W, H, rgba } with rows from the north.
 */
export const PICTURE_CELL = 0.25;
export function lidarPicture(box, pts, cell = PICTURE_CELL) {
  const W = Math.max(1, Math.ceil((box[2] - box[0]) / cell)), H = Math.max(1, Math.ceil((box[3] - box[1]) / cell)), N = W * H;
  const sum = new Float32Array(N), cnt = new Float32Array(N), roof = new Uint8Array(N), tree = new Uint8Array(N), other = new Uint8Array(N);
  for (let i = 0; i < pts.n; i++) {
    const c = Math.floor((pts.e(i) - box[0]) / cell), r = Math.floor((box[3] - pts.nn(i)) / cell);
    if (c < 0 || r < 0 || c >= W || r >= H) continue;
    const k = r * W + c, h = pts.hag(i);
    if (!(h > 0.3)) { if (h > -0.5 || Number.isNaN(h)) { sum[k] += pts.bright(i); cnt[k]++; } continue; }
    const kind = pts.kind(i);
    if (kind === 1 && h > 1.8) roof[k] = 1; else if (kind === 2) tree[k] = 1; else if (kind === 3) other[k] = 1;
  }
  // the ground's brightness between returns: a small blur where returns are near, a wide one across the gaps
  const blur = (a, rad) => {
    const t = new Float32Array(N), o = new Float32Array(N), w = 2 * rad + 1;
    for (let r = 0; r < H; r++) { let s = 0; for (let c = -rad; c < W; c++) { if (c + rad < W) s += a[r * W + c + rad]; if (c - rad - 1 >= 0) s -= a[r * W + c - rad - 1]; if (c >= 0) t[r * W + c] = s / w; } }
    for (let c = 0; c < W; c++) { let s = 0; for (let r = -rad; r < H; r++) { if (r + rad < H) s += t[(r + rad) * W + c]; if (r - rad - 1 >= 0) s -= t[(r - rad - 1) * W + c]; if (r >= 0) o[r * W + c] = s / w; } }
    return o;
  };
  const twice = (a, rad) => blur(blur(a, rad), rad);
  const s1 = twice(sum, 2), n1b = twice(cnt, 2), s2 = twice(sum, 8), n2 = twice(cnt, 8);
  const g = new Float32Array(N), vals = [];
  for (let k = 0; k < N; k++) { g[k] = n1b[k] > 0.02 ? s1[k] / n1b[k] : n2[k] > 1e-4 ? s2[k] / n2[k] : NaN; if (!Number.isNaN(g[k]) && k % 7 === 0) vals.push(g[k]); }
  vals.sort((a, b) => a - b);
  const lo = vals.length ? vals[Math.floor(vals.length * 0.02)] : 0, hi = vals.length ? vals[Math.floor(vals.length * 0.98)] : 1;
  // closing: grown by rad cells, then taken back by rad, so gaps between returns fill and the edge stays where it was
  const grow = (m, rad, v) => { const o = new Uint8Array(N); for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { let hit = v ? 0 : 1; for (let dr = -rad; dr <= rad && hit !== v; dr++) for (let dc = -rad; dc <= rad; dc++) { if (dr * dr + dc * dc > rad * rad) continue; const rr = r + dr, cc = c + dc; const x = rr < 0 || cc < 0 || rr >= H || cc >= W ? 0 : m[rr * W + cc]; if (v ? x : !x) { hit = v; break; } } o[r * W + c] = hit; } return o; };
  const close = (m, rad) => grow(grow(m, rad, 1), rad, 0);
  const R = close(roof, 3), T = close(tree, 4), O = close(other, 2);
  const edge = (m, k, r, c) => m[k] && (r === 0 || c === 0 || r === H - 1 || c === W - 1 || !m[k - 1] || !m[k + 1] || !m[k - W] || !m[k + W]);
  const rgba = new Uint8ClampedArray(N * 4);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c, v = Number.isNaN(g[k]) ? 70 : 40 + 190 * Math.min(1, Math.max(0, (g[k] - lo) / Math.max(1e-6, hi - lo)));
    let px = [v, v, v];
    if (O[k]) px = edge(O, k, r, c) ? [200, 90, 0] : [255, 150, 40];
    if (R[k]) px = edge(R, k, r, c) ? [255, 255, 255] : [20, 20, 22];   // a white line round a dark roof: its edge is what is aimed at
    if (T[k] && !R[k] && edge(T, k, r, c)) px = [40, 220, 80];
    rgba[k * 4] = px[0]; rgba[k * 4 + 1] = px[1]; rgba[k * 4 + 2] = px[2]; rgba[k * 4 + 3] = 255;
  }
  return { e0: box[0], n1: box[3], cell, W, H, rgba };
}
