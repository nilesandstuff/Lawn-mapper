/**
 * GRASS OR PAVING, AND THE LAWN'S EDGE (core session, 2026-11-03; the owner: "Yes do that", to matching what a thin
 * lidar flight still sees well, the drive, walk and lawn edges among it; SCAN-H3). Pure.
 *
 * The phone side: a ground point's colour in the camera's picture says grass or paving. The map side: the lawn the
 * owner traced (the map's shapes) is grass, and its edge is where grass meets drive, walk or bed. A placement that
 * puts paving inside the lawn, or grass well outside it, is wrong by about that much: lidar.js placementCost's
 * surface term. A colour that is neither (soil, mulch, leaves, shade) says nothing.
 */

/** 'grass', 'pave' or null, from 0-255 RGB. Grass: green to yellow-green and coloured enough (a dormant lawn in
 *  November is olive, not emerald); paving: grey (little colour), neither very dark nor in deep shade. */
export function surfaceOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, s = mx ? (mx - mn) / mx : 0;
  if (v < 0.18) return null; // too dark to say
  if (s < 0.12 && v > 0.3) return 'pave';
  if (s < 0.16) return null;
  let h = 0;
  const d = mx - mn;
  if (mx === r) h = 60 * (((g - b) / d) % 6); else if (mx === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return h >= 45 && h <= 170 ? 'grass' : null; // 45: straw-coloured dormant grass; mulch and soil sit near 20-35
}

/** The share of points of each kind in a list of labels, for the log. */
export function tally(labels) {
  const t = { grass: 0, pave: 0, none: 0 };
  for (const l of labels) t[l || 'none']++;
  return t;
}

/**
 * The lawn as a signed distance on the match's grid: metres inside the lawn (positive) or outside it (negative), out
 * to `cap`. rings: [[ [e, n], ... ], ...] in map metres; even-odd, so a hole (a bed in the lawn) is outside.
 */
export function lawnField(rings, box, cell = 0.25, cap = 5) {
  const W = Math.max(1, Math.ceil((box[2] - box[0]) / cell)), H = Math.max(1, Math.ceil((box[3] - box[1]) / cell));
  const inside = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    const n = box[3] - (r + 0.5) * cell, xs = [];
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ei, ni] = ring[i], [ej, nj] = ring[j];
      if ((ni > n) !== (nj > n)) xs.push(ei + ((n - ni) * (ej - ei)) / (nj - ni));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - box[0]) / cell - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[k + 1] - box[0]) / cell - 0.5));
      for (let c = c0; c <= c1; c++) inside[r * W + c] = 1;
    }
  }
  const out = new Uint8Array(W * H); for (let k = 0; k < out.length; k++) out[k] = inside[k] ? 0 : 1;
  const din = chamfer(out, W, H, cell, cap), dout = chamfer(inside, W, H, cell, cap);
  const sd = new Float32Array(W * H);
  for (let k = 0; k < sd.length; k++) sd[k] = inside[k] ? din[k] - cell / 2 : -(dout[k] - cell / 2);
  let any = 0; for (const v of inside) any += v;
  return { sd, W, H, cell, box, cells: any };
}

function chamfer(occ, W, H, cell, cap) {
  const d = new Float32Array(W * H);
  for (let k = 0; k < d.length; k++) d[k] = occ[k] ? 0 : 1e9;
  const a = 1, b = Math.SQRT2;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const k = r * W + c; let v = d[k];
    if (c > 0) v = Math.min(v, d[k - 1] + a);
    if (r > 0) { v = Math.min(v, d[k - W] + a); if (c > 0) v = Math.min(v, d[k - W - 1] + b); if (c < W - 1) v = Math.min(v, d[k - W + 1] + b); }
    d[k] = v;
  }
  for (let r = H - 1; r >= 0; r--) for (let c = W - 1; c >= 0; c--) {
    const k = r * W + c; let v = d[k];
    if (c < W - 1) v = Math.min(v, d[k + 1] + a);
    if (r < H - 1) { v = Math.min(v, d[k + W] + a); if (c < W - 1) v = Math.min(v, d[k + W + 1] + b); if (c > 0) v = Math.min(v, d[k + W - 1] + b); }
    d[k] = v;
  }
  for (let k = 0; k < d.length; k++) d[k] = Math.min(cap, d[k] * cell);
  return d;
}

/** What a surface point costs at signed distance sd (m, + inside the lawn): paving inside, grass outside. */
export const SURF_TOL = 0.15, PAVE_CAP = 1, GRASS_CAP = 0.5;
export function surfaceCost(kind, sd) {
  if (!Number.isFinite(sd)) return 0;
  if (kind === 'pave') { const x = Math.min(PAVE_CAP, Math.max(0, sd - SURF_TOL)); return x * x; }
  if (kind === 'grass') { const x = Math.min(GRASS_CAP, Math.max(0, -sd - SURF_TOL)); return x * x; }
  return 0;
}
