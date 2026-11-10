/**
 * STRAIGHT THINGS MADE STRAIGHT (core session, 2026-11-05; the owner: "let's do the shape/line cleaning for roofs and
 * objects that we think are actually straight. Let's not touch trees. But tree trunks i believe currently get averaged
 * to 1m, so let's just make those a thin line, otherwise they'll never match").
 *
 * The shade map's model knows a roof's edge only to its 1 m column, so a roofline is a staircase, right to within half
 * a column. Houses are straight: one line fitted through 15 m of staircase finds the edge to a few centimetres,
 * because the steps average out. This module is the AR's post-processing of the model's columns (docs/
 * SCAN-DIVERGENCES.md step 3b); it changes no kind, only the shape the match and the drawing are given.
 *
 *   ringsOfMask      a mask on a grid -> its outlines as rings of corner points (the staircase), in grid units
 *   straighten       a staircase ring -> straight lines through it, corners where they meet, near-square corners
 *                    squared to the building's own main direction
 *   offsetRing       a ring moved inward (or outward) by d, side by side
 *   fillRings        rings -> a mask on the fine grid (even-odd, so a courtyard stays open)
 *   lineOfPatch      a long thin patch (a wall, a fence) -> one segment through its middle
 *   postOf           a few columns of a trunk -> one point, weighted by where its returns are
 * All in plain numbers; the caller turns grid units into map metres.
 */

/** The outlines of a mask's patches: rings of [x, y] corner points in grid units (x right, y down), each closed, the
 *  inside on the right: an outer outline runs clockwise on the screen, and still clockwise once flipped to y-up metres
 *  (negative areaOf); a hole runs the other way. */
export function ringsOfMask(mask, w, h) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
  // boundary edges, each going round its cell with the inside on the right (clockwise on screen)
  const from = new Map(), key = (x, y) => `${x},${y}`;
  const add = (x0, y0, x1, y1) => { const k = key(x0, y0); if (!from.has(k)) from.set(k, []); from.get(k).push([x1, y1]); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (!at(x, y - 1)) add(x, y, x + 1, y);
    if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) add(x, y + 1, x, y);
  }
  const rings = [];
  for (const [k0, list] of from) {
    while (list.length) {
      const [sx, sy] = k0.split(',').map(Number);
      const ring = [[sx, sy]];
      let [px, py] = [sx, sy], [nx, ny] = list.pop();
      for (let guard = 0; guard < 1e6; guard++) {
        ring.push([nx, ny]);
        if (nx === sx && ny === sy) break;
        const outs = from.get(key(nx, ny));
        if (!outs || !outs.length) break;
        // at a pinch two edges leave one corner: take the right-hand turn, so diagonal neighbours stay apart
        let pick = 0;
        if (outs.length > 1) {
          const dx = nx - px, dy = ny - py;
          pick = outs.findIndex(([qx, qy]) => (dx * (qy - ny) - dy * (qx - nx)) > 0);
          if (pick < 0) pick = 0;
        }
        const [q] = outs.splice(pick, 1);
        px = nx; py = ny; [nx, ny] = q;
      }
      ring.pop(); // the closing corner repeats the first
      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

/** Signed area (positive when the ring runs anticlockwise in an x-right, y-up frame). */
export function areaOf(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]; a += x0 * y1 - x1 * y0; }
  return a / 2;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const segDist = (p, a, b) => {
  const [dx, dy] = sub(b, a), L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** Douglas-Peucker on a closed ring: the indices of the corners kept. */
function simplifyIdx(ring, tol) {
  const n = ring.length;
  // start from the two points farthest apart, so the split does not depend on where the trace began
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < n; i++) { const d = Math.hypot(...sub(ring[i], ring[0])); if (d > best) { best = d; b = i; } }
  best = -1; for (let i = 0; i < n; i++) { const d = Math.hypot(...sub(ring[i], ring[b])); if (d > best) { best = d; a = i; } }
  const keep = new Set([a, b]);
  const run = (i, j) => { // i -> j going forward round the ring
    let far = -1, fd = tol;
    for (let k = (i + 1) % n; k !== j; k = (k + 1) % n) { const d = segDist(ring[k], ring[i], ring[j]); if (d > fd) { fd = d; far = k; } }
    if (far >= 0) { keep.add(far); run(i, far); run(far, j); }
  };
  run(a, b); run(b, a);
  return [...keep].sort((x, y) => x - y);
}

/** Douglas-Peucker on a closed ring: the ring with only the corners that stray more than tol from a straight run. */
export function simplifyRing(ring, tol) { return ring.length < 4 ? ring.slice() : simplifyIdx(ring, tol).map((i) => ring[i]); }

/** The total-least-squares line through points: { c: centre, d: unit direction }. */
function fitLine(pts) {
  let mx = 0, my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of pts) { const u = x - mx, v = y - my; sxx += u * u; syy += v * v; sxy += u * v; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: [mx, my], d: [Math.cos(th), Math.sin(th)] };
}
const meet = (L1, L2) => {
  const den = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((L2.c[0] - L1.c[0]) * L2.d[1] - (L2.c[1] - L1.c[1]) * L2.d[0]) / den;
  return [L1.c[0] + t * L1.d[0], L1.c[1] + t * L1.d[1]];
};

/**
 * A staircase ring (corner points, in metres) -> a ring of straight sides. tol: how far a step may stray from a side
 * (about two thirds of a column); squareDeg: a side within this of the building's main direction, or square to it, is
 * turned onto it (houses are mostly square; a bay window at 45 degrees stays as it is). Falls back to the plain
 * simplified ring when the fit goes wrong (its area off by more than a quarter).
 */
export function straighten(ring, { tol = 1.0, squareDeg = 12, minSide = 1.5, mergeDeg = 10 } = {}) {
  const n = ring.length;
  if (n < 4) return ring.slice();
  const idx = simplifyIdx(ring, tol);
  if (idx.length < 3) return ring.slice();
  const simple = idx.map((i) => ring[i]);
  // each side's samples: the midpoints of the unit steps between its two corners (a step's midpoint lies on the true
  // edge on average; its corners do not)
  const sides = [];
  for (let s = 0; s < idx.length; s++) {
    const i = idx[s], j = idx[(s + 1) % idx.length], pts = [];
    for (let k = i; k !== j; k = (k + 1) % n) { const a = ring[k], b = ring[(k + 1) % n]; pts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
    const len = Math.hypot(...sub(ring[j], ring[i]));
    sides.push({ pts, i, line: pts.length >= 2 ? fitLine(pts) : { c: ring[i], d: [(ring[j][0] - ring[i][0]) / (len || 1), (ring[j][1] - ring[i][1]) / (len || 1)] }, len });
  }
  // neighbouring sides that run the same way are one side (a shallow staircase leaves several), refitted together
  const angle = (L) => Math.atan2(L.d[1], L.d[0]);
  const sameWay = (a, b) => { let d = Math.abs(angle(a.line) - angle(b.line)) % Math.PI; if (d > Math.PI / 2) d = Math.PI - d; return d < (mergeDeg * Math.PI) / 180; };
  for (let changed = true; changed && sides.length > 3;) {
    changed = false;
    for (let s = 0; s < sides.length && sides.length > 3; s++) {
      const a = sides[s], b = sides[(s + 1) % sides.length];
      if (!sameWay(a, b)) continue;
      const pts = [...a.pts, ...b.pts];
      const merged = { pts, i: a.i, line: fitLine(pts), len: a.len + b.len };
      sides.splice(s, 1, merged); sides.splice((s + 1) % (sides.length), 1);
      changed = true; break;
    }
  }
  if (sides.length < 3) return simple;
  // the main direction: length-weighted, angles folded to a quarter turn
  let cx = 0, cy = 0;
  for (const s of sides) { if (s.len < minSide) continue; const a = Math.atan2(s.line.d[1], s.line.d[0]) * 4; cx += s.len * Math.cos(a); cy += s.len * Math.sin(a); }
  const main = Math.atan2(cy, cx) / 4, lim = (squareDeg * Math.PI) / 180;
  for (const s of sides) {
    let a = Math.atan2(s.line.d[1], s.line.d[0]);
    const q = Math.PI / 2, off = ((((a - main) % q) + 1.5 * q) % q) - q / 2; // -45..45 deg from the grid of main
    if (Math.abs(off) <= lim) { a -= off; s.line.d = [Math.cos(a), Math.sin(a)]; }
  }
  const out = [];
  for (let s = 0; s < sides.length; s++) {
    const p = meet(sides[(s + sides.length - 1) % sides.length].line, sides[s].line);
    out.push(p || ring[sides[s].i]);
  }
  const a0 = Math.abs(areaOf(ring)), a1 = Math.abs(areaOf(out));
  const far = out.some((p, s) => Math.hypot(...sub(p, ring[sides[s].i])) > 2 * tol + 1);
  if (!(a1 > 0.75 * a0 && a1 < 1.25 * a0) || far) return simple;
  return out;
}

/** A ring moved side by side by d (positive: inward). */
export function offsetRing(ring, d) {
  const n = ring.length, sgn = areaOf(ring) > 0 ? 1 : -1; // anticlockwise: inward is to the left
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], L = Math.hypot(...sub(b, a)) || 1, dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const nrm = [-dir[1] * sgn, dir[0] * sgn];
    lines.push({ c: [a[0] + nrm[0] * d, a[1] + nrm[1] * d], d: dir });
  }
  return lines.map((L, i) => meet(lines[(i + n - 1) % n], L) || L.c);
}

/** Rings in map metres -> a mask on the fine grid over box [e0, n0, e1, n1] (rows north to south), even-odd. */
export function fillRings(rings, box, cell) {
  const W = Math.max(1, Math.ceil((box[2] - box[0]) / cell)), H = Math.max(1, Math.ceil((box[3] - box[1]) / cell));
  const out = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    const n = box[3] - (r + 0.5) * cell, xs = [];
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const [e0, n0] = ring[i], [e1, n1] = ring[(i + 1) % ring.length];
      if ((n0 <= n && n1 > n) || (n1 <= n && n0 > n)) xs.push(e0 + ((n - n0) * (e1 - e0)) / (n1 - n0));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((xs[i] - box[0]) / cell - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[i + 1] - box[0]) / cell - 0.5));
      for (let c = c0; c <= c1; c++) out[r * W + c] = 1;
    }
  }
  return out;
}

/** Cells of the fine grid within `half` of a segment (a wall's middle line), set to 1 in `mask`. */
export function drawSegment(mask, box, cell, a, b, half = cell / 2) {
  const W = Math.max(1, Math.ceil((box[2] - box[0]) / cell)), H = Math.max(1, Math.ceil((box[3] - box[1]) / cell));
  const e0 = Math.min(a[0], b[0]) - half, e1 = Math.max(a[0], b[0]) + half, n0 = Math.min(a[1], b[1]) - half, n1 = Math.max(a[1], b[1]) + half;
  const c0 = Math.max(0, Math.floor((e0 - box[0]) / cell)), c1 = Math.min(W - 1, Math.floor((e1 - box[0]) / cell));
  const r0 = Math.max(0, Math.floor((box[3] - n1) / cell)), r1 = Math.min(H - 1, Math.floor((box[3] - n0) / cell));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const p = [box[0] + (c + 0.5) * cell, box[3] - (r + 0.5) * cell];
    if (segDist(p, a, b) <= half + 1e-9) mask[r * W + c] = 1;
  }
  // and always the cells the line passes through, so a thin post between cell centres is not lost
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cell / 2)));
  for (let i = 0; i <= steps; i++) {
    const e = a[0] + ((b[0] - a[0]) * i) / steps, n = a[1] + ((b[1] - a[1]) * i) / steps;
    const c = Math.floor((e - box[0]) / cell), r = Math.floor((box[3] - n) / cell);
    if (c >= 0 && r >= 0 && c < W && r < H) mask[r * W + c] = 1;
  }
  return mask;
}

/** A patch's column centres (metres) -> one segment through its middle when it is long and thin, else null. */
export function lineOfPatch(pts, { minLong = 3, colM = 1 } = {}) {
  if (pts.length < 3) return null;
  const L = fitLine(pts);
  let lo = Infinity, hi = -Infinity, wide = 0;
  for (const p of pts) {
    const u = (p[0] - L.c[0]) * L.d[0] + (p[1] - L.c[1]) * L.d[1], v = Math.abs(-(p[0] - L.c[0]) * L.d[1] + (p[1] - L.c[1]) * L.d[0]);
    lo = Math.min(lo, u); hi = Math.max(hi, u); wide = Math.max(wide, v);
  }
  const length = hi - lo + colM, width = 2 * wide + colM;
  if (length < minLong * width) return null;
  return [[L.c[0] + (lo - colM / 2) * L.d[0], L.c[1] + (lo - colM / 2) * L.d[1]], [L.c[0] + (hi + colM / 2) * L.d[0], L.c[1] + (hi + colM / 2) * L.d[1]]];
}

/** A trunk's columns -> one point: their centres weighted by their own returns at standing height (1 each without). */
export function postOf(pts, weights = null) {
  let x = 0, y = 0, s = 0;
  pts.forEach((p, i) => { const w = weights ? Math.max(weights[i], 0) || 0 : 1; x += w * p[0]; y += w * p[1]; s += w; });
  if (!s) { s = pts.length; x = pts.reduce((a, p) => a + p[0], 0); y = pts.reduce((a, p) => a + p[1], 0); }
  return [x / s, y / s];
}

/** Connected patches (8 neighbours) of a mask on a grid: arrays of indices. */
export function patchesOf(mask, w, h) {
  const seen = new Uint8Array(w * h), out = [];
  for (let k0 = 0; k0 < w * h; k0++) {
    if (!mask[k0] || seen[k0]) continue;
    const q = [k0]; seen[k0] = 1;
    for (let i = 0; i < q.length; i++) {
      const k = q[i], x = k % w, y = (k / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy, j = yy * w + xx;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[j] && !seen[j]) { seen[j] = 1; q.push(j); }
      }
    }
    out.push(q);
  }
  return out;
}
