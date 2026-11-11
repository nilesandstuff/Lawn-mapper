/**
 * THE GROUND ALONE, HARD-EDGED (core session, 2026-11-11; docs/SCAN-PLAN.md section 23). The owner, after the automatic
 * shapes: "The automatic shapes aren't working... So we need to improve the viewability of the lidar. Split it by
 * heights. So we'll have ground level (regardless of where the ground is, so we have to follow hills). For now, just
 * hide anything above ground level... the point here is to preserve the hard edges... We don't need detail, we need
 * precision." Their method, kept: a grid four times as fine as the lidar; where brightness goes light, middling, dark
 * across three returns, the edge is put through the middle one; then each unbroken light or dark area gets back some
 * of its own shade, well away from the middle, so blacktop still differs from concrete.
 *
 * How, per ground return (within 0.3 m of the shade map's ground under it, so hills are followed):
 *   1. its brightness is the median of its 7 nearest ground returns' (one return is noisy; a median keeps an edge);
 *   2. the lot's two levels, light (grass) and dark (paving), by 2-means; the cut between them;
 *   3. HOW DARK IT IS, 0 to 1, against the light and dark levels found within 4 m of it: 0 at the light level, 1 at
 *      the dark, a half in between. Where everything within 4 m is on one side of the lot's cut it is 0 or 1 outright
 *      (a road's middle; a lawn's middle). Local levels, so a concrete drive's edge sits halfway between concrete and
 *      grass and a blacktop road's halfway between blacktop and grass.
 * Then on the fine grid each cell takes the distance-weighted mean of that number from its nearest returns, and is
 * dark where it passes a half: between a light return and a dark one the edge falls halfway, and through a middling
 * one. Specks under a square metre and a half are given to what surrounds them. Each cell is then shaded by the
 * brightness of the returns round it on its own side of the edge: dark areas within 0-35% white, light ones within
 * 65-100%, so the edge stays hard and concrete still differs from blacktop. No ground return near (under
 * a roof, a dense crown): a flat mid grey.
 *
 * pts as lidar-marks.js returnsFrom gives. Returns { e0, n1, cell, W, H, rgba, dark: Float32Array (how dark, NaN where
 * no ground), spacing, levels: { light, dark, cut, noise } }.
 */

const hashOf = (ps, B) => {
  const h = new Map();
  ps.forEach((p, i) => { const k = `${Math.floor(p.e / B)},${Math.floor(p.n / B)}`; const a = h.get(k); if (a) a.push(i); else h.set(k, [i]); });
  return h;
};
const medianOf = (a) => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : NaN; };

export function groundPicture(box, pts, { fine = 4, nearM = 4, maxCells = 1500 } = {}) {
  const G = [];
  for (let i = 0; i < pts.n; i++) {
    const e = pts.e(i), n = pts.nn(i);
    if (e < box[0] - 5 || e >= box[2] + 5 || n <= box[1] - 5 || n > box[3] + 5) continue;
    const h = pts.hag(i), b = pts.bright(i);
    if (Number.isNaN(h) || !Number.isFinite(b) || h >= 0.3 || h < -0.5) continue;
    G.push({ e, n, b, s: b, d: 0 });
  }
  // the returns' spacing where there is ground: over the 2 m squares that hold any
  const sq = new Set(); for (const p of G) sq.add(`${Math.floor(p.e / 2)},${Math.floor(p.n / 2)}`);
  const spacing = 1 / Math.sqrt(Math.max(0.05, G.length / Math.max(1, sq.size * 4)));
  let cell = spacing / fine;
  const span = Math.max(box[2] - box[0], box[3] - box[1]);
  if (span / cell > maxCells) cell = span / maxCells;
  const W = Math.max(1, Math.ceil((box[2] - box[0]) / cell)), H = Math.max(1, Math.ceil((box[3] - box[1]) / cell)), N = W * H;
  const out = { e0: box[0], n1: box[3], cell, W, H, rgba: new Uint8ClampedArray(N * 4), dark: new Float32Array(N).fill(NaN), spacing: +spacing.toFixed(2), levels: null };
  if (G.length < 50) { for (let k = 0; k < N; k++) { out.rgba[k * 4] = out.rgba[k * 4 + 1] = out.rgba[k * 4 + 2] = 128; out.rgba[k * 4 + 3] = 255; } return out; }

  // 1. each return's brightness: the median of its 7 nearest
  const B1 = Math.max(1, 2.2 * spacing), h1 = hashOf(G, B1);
  const near = (p, B, hash, reach) => {
    const bx = Math.floor(p.e / B), by = Math.floor(p.n / B), d = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of hash.get(`${bx + dx},${by + dy}`) || []) { const q = G[j], dd = (q.e - p.e) ** 2 + (q.n - p.n) ** 2; if (dd <= reach * reach) d.push([dd, j]); }
    return d;
  };
  for (const p of G) { const d = near(p, B1, h1, B1).sort((a, b) => a[0] - b[0]).slice(0, 7); p.s = medianOf(d.map(([, j]) => G[j].b)); }
  // the noise left in it: a return against the median of its neighbours' smoothed values
  const dev = [];
  for (let i = 0; i < G.length; i += Math.max(1, Math.floor(G.length / 3000))) { const d = near(G[i], B1, h1, B1).sort((a, b) => a[0] - b[0]).slice(1, 8); if (d.length >= 3) dev.push(Math.abs(G[i].s - medianOf(d.map(([, j]) => G[j].s)))); }
  const noise = Math.max(1e-9, 1.4826 * medianOf(dev));

  // 2. the lot's two levels
  const sv = Float64Array.from(G, (p) => p.s).sort();
  let lo = sv[Math.floor(sv.length * 0.1)], hi = sv[Math.floor(sv.length * 0.7)], cut = (lo + hi) / 2;
  for (let it = 0; it < 30; it++) {
    let a = 0, na = 0, b = 0, nb = 0;
    for (const v of sv) if (v <= cut) { a += v; na++; } else { b += v; nb++; }
    if (!na || !nb) break;
    lo = a / na; hi = b / nb;
    const c2 = (lo + hi) / 2; if (Math.abs(c2 - cut) < 1e-6) break; cut = c2;
  }
  out.levels = { light: Math.round(hi), dark: Math.round(lo), cut: Math.round(cut), noise: Math.round(noise) };

  // 3. how dark each return is, against the light and dark levels within nearM of it
  const h4 = hashOf(G, nearM);
  for (const p of G) {
    const vs = near(p, nearM, h4, nearM).map(([, j]) => G[j].s).sort((a, b) => a - b);
    const dk = vs[Math.floor(vs.length * 0.12)], lt = vs[Math.min(vs.length - 1, Math.floor(vs.length * 0.88))];
    if (lt <= cut) p.d = 1;                       // all paving round here
    else if (dk > cut || lt - dk < 3 * noise) p.d = p.s <= cut ? 1 : 0; // all one surface: the lot's cut decides
    else p.d = Math.min(1, Math.max(0, (lt - p.s) / (lt - dk)));
  }

  // the fine grid: each cell from its nearest returns, weighted by distance^-3 (halfway between two, a half)
  const reach = Math.max(1.2, 2 * spacing), B2 = reach, h2 = hashOf(G, B2), dark = out.dark, own = new Float32Array(N).fill(NaN);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const e = box[0] + (c + 0.5) * cell, n = box[3] - (r + 0.5) * cell;
    const d = near({ e, n }, B2, h2, reach);
    if (!d.length) continue;
    d.sort((a, b) => a[0] - b[0]);
    if (d[0][0] > (1.5 * spacing) ** 2) continue;
    let sw = 0, sd = 0;
    for (let i = 0; i < Math.min(6, d.length); i++) { const w = 1 / (d[i][0] ** 1.5 + 1e-6); sw += w; sd += w * G[d[i][1]].d; }
    const k = r * W + c; dark[k] = sd / sw;
    // its own shade: the brightness of the returns round it that are on its side of the edge (a drive and the road
    // it runs into are one dark area, and concrete must still differ from blacktop)
    const dk = dark[k] >= 0.5; let s2 = 0, w2 = 0;
    for (let i = 0; i < Math.min(12, d.length); i++) { const q = G[d[i][1]]; if ((q.d >= 0.5) !== dk) continue; const w = 1 / (d[i][0] + 0.25); w2 += w; s2 += w * q.s; }
    own[k] = w2 ? s2 / w2 : NaN;
  }

  // areas: unbroken dark (>= a half) or light; specks go to what surrounds them
  const lab = new Int32Array(N).fill(-1), isDark = (k) => dark[k] >= 0.5;
  const regions = [];
  const stack = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (lab[k0] >= 0 || Number.isNaN(dark[k0])) continue;
    const id = regions.length, dk = isDark(k0); let n = 0;
    lab[k0] = id; stack.push(k0);
    while (stack.length) {
      const k = stack.pop(), r = (k / W) | 0, c = k % W; n++;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const k2 = rr * W + cc; if (lab[k2] >= 0 || Number.isNaN(dark[k2]) || isDark(k2) !== dk) continue;
        lab[k2] = id; stack.push(k2);
      }
    }
    regions.push({ dark: dk, n, vals: [] });
  }
  const speck = 1.5 / (cell * cell);
  for (let k = 0; k < N; k++) { const id = lab[k]; if (id >= 0 && regions[id].n < speck) dark[k] = regions[id].dark ? 0.49 : 0.51; }
  // relabel after the specks are gone, and gather each area's returns
  lab.fill(-1); regions.length = 0;
  for (let k0 = 0; k0 < N; k0++) {
    if (lab[k0] >= 0 || Number.isNaN(dark[k0])) continue;
    const id = regions.length, dk = isDark(k0);
    lab[k0] = id; stack.push(k0);
    while (stack.length) {
      const k = stack.pop(), r = (k / W) | 0, c = k % W;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const k2 = rr * W + cc; if (lab[k2] >= 0 || Number.isNaN(dark[k2]) || isDark(k2) !== dk) continue;
        lab[k2] = id; stack.push(k2);
      }
    }
    regions.push({ dark: dk, vals: [] });
  }
  for (const p of G) {
    const c = Math.floor((p.e - box[0]) / cell), r = Math.floor((box[3] - p.n) / cell);
    if (c < 0 || r < 0 || c >= W || r >= H) continue;
    const id = lab[r * W + c]; if (id >= 0) regions[id].vals.push(p.s);
  }
  const dMin = sv[Math.floor(sv.length * 0.01)], lMax = sv[Math.floor(sv.length * 0.99)];
  for (const R of regions) R.med = R.vals.length ? medianOf(R.vals) : (R.dark ? lo : hi);
  for (let k = 0; k < N; k++) {
    let v = 128;
    if (lab[k] >= 0) {
      const R = regions[lab[k]], m = Number.isNaN(own[k]) ? R.med : own[k];
      const t = R.dark ? 0.35 * Math.min(1, Math.max(0, (m - dMin) / Math.max(1e-9, cut - dMin))) : 0.65 + 0.35 * Math.min(1, Math.max(0, (m - cut) / Math.max(1e-9, lMax - cut)));
      v = Math.round(255 * t); if (v === 128) v = 127;
    }
    out.rgba[k * 4] = out.rgba[k * 4 + 1] = out.rgba[k * 4 + 2] = v; out.rgba[k * 4 + 3] = 255;
  }
  return out;
}

/**
 * THE WIDTH OF A LONG STRAIGHT DARK STRIP (a drive), measured on the picture: the owner's test of it ("My drive has a
 * long straight section with a uniform width. I measured it with a tape measure").
 *
 * Within `ring` (the lot), over cells not under `skip`: the dark area's middle line (cells furthest from the light on
 * both sides), the width most of it has, the longest straight run of that width, and across that run every half
 * metre the distance between the two places where "how dark" crosses a half (read between cells, not counted in
 * cells). Returns { widthM (median), meanM, q25, q75, lengthM, sections, rejected } or null.
 */
export function stripWidth(pic, ring, { skip = null, minW = 1.5, maxW = 12 } = {}) {
  const { W, H, cell, dark, e0, n1 } = pic, N = W * H;
  const inRing = (x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  // distance (cells) from each dark cell to the nearest cell that is not dark (two-pass chamfer)
  const D = new Float32Array(N), BIG = 1e6;
  for (let k = 0; k < N; k++) D[k] = dark[k] >= 0.5 ? BIG : 0;
  const a = 1, b = Math.SQRT2;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const k = r * W + c; if (!D[k]) continue; let v = D[k]; if (c) v = Math.min(v, D[k - 1] + a); if (r) { v = Math.min(v, D[k - W] + a); if (c) v = Math.min(v, D[k - W - 1] + b); if (c < W - 1) v = Math.min(v, D[k - W + 1] + b); } D[k] = v; }
  for (let r = H - 1; r >= 0; r--) for (let c = W - 1; c >= 0; c--) { const k = r * W + c; if (!D[k]) continue; let v = D[k]; if (c < W - 1) v = Math.min(v, D[k + 1] + a); if (r < H - 1) { v = Math.min(v, D[k + W] + a); if (c) v = Math.min(v, D[k + W - 1] + b); if (c < W - 1) v = Math.min(v, D[k + W + 1] + b); } D[k] = v; }
  // the middle line: local maxima of that distance, inside the lot
  const mid = [];
  for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) {
    const k = r * W + c, v = D[k]; if (v < 2 || v >= BIG / 2) continue;
    const w = 2 * v * cell; if (w < minW || w > maxW) continue;
    let top = true; for (const o of [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1]) if (D[k + o] > v + 0.01) { top = false; break; }
    if (!top) continue;
    const e = e0 + (c + 0.5) * cell, n = n1 - (r + 0.5) * cell;
    if (!inRing(e, n)) continue;
    mid.push({ e, n, w });
  }
  if (mid.length < 20) return null;
  // the best straight line through the middle line: most cells within 0.4 m of it, of much the same width
  let sd = 7; const rnd = () => { sd = (sd + 0x6d2b79f5) | 0; let t = Math.imul(sd ^ (sd >>> 15), 1 | sd); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let best = null;
  for (let it = 0; it < 600; it++) {
    const p = mid[Math.floor(rnd() * mid.length)], q = mid[Math.floor(rnd() * mid.length)];
    const L = Math.hypot(q.e - p.e, q.n - p.n); if (L < 6 || Math.abs(p.w - q.w) > 0.8) continue;
    const ux = (q.e - p.e) / L, uy = (q.n - p.n) / L, wm = (p.w + q.w) / 2;
    const ts = [];
    for (const m of mid) { const dx = m.e - p.e, dy = m.n - p.n; if (Math.abs(dx * uy - dy * ux) <= 0.4 && Math.abs(m.w - wm) <= 0.8) ts.push(dx * ux + dy * uy); }
    if (ts.length < 15) continue;
    ts.sort((x, y) => x - y);
    // its longest run without a gap of 2 m
    let s0 = 0, bs = 0, be = 0;
    for (let i = 1; i <= ts.length; i++) if (i === ts.length || ts[i] - ts[i - 1] > 2) { if (ts[i - 1] - ts[s0] > ts[be] - ts[bs]) { bs = s0; be = i - 1; } s0 = i; }
    const len = ts[be] - ts[bs];
    if (!best || len > best.len) best = { p, ux, uy, t0: ts[bs], t1: ts[be], len };
  }
  if (!best || best.len < 6) return null;
  // across it every half metre: where "how dark" crosses a half on each side, read between cells
  const at = (e, n) => {
    const x = (e - e0) / cell - 0.5, y = (n1 - n) / cell - 0.5, c = Math.floor(x), r = Math.floor(y);
    if (c < 0 || r < 0 || c >= W - 1 || r >= H - 1) return NaN;
    const fx = x - c, fy = y - r, k = r * W + c;
    return dark[k] * (1 - fx) * (1 - fy) + dark[k + 1] * fx * (1 - fy) + dark[k + W] * (1 - fx) * fy + dark[k + W + 1] * fx * fy;
  };
  const widths = []; let rejected = 0;
  const step = 0.02, nx = -best.uy, ny = best.ux;
  for (let t = best.t0 + 1; t <= best.t1 - 1; t += 0.5) {
    const ce = best.p.e + best.ux * t, cn = best.p.n + best.uy * t;
    if (!(at(ce, cn) >= 0.5)) { rejected++; continue; }
    const side = (sg) => {
      let prev = at(ce, cn);
      for (let s = step; s <= maxW; s += step) {
        const e = ce + sg * nx * s, n = cn + sg * ny * s, v = at(e, n);
        if (Number.isNaN(v) || (skip && skip(e, n))) return NaN;
        if (v < 0.5) return s - step + step * (prev - 0.5) / Math.max(1e-9, prev - v);
        prev = v;
      }
      return NaN;
    };
    const l = side(1), r2 = side(-1);
    if (Number.isNaN(l) || Number.isNaN(r2)) { rejected++; continue; }
    widths.push(l + r2);
  }
  if (widths.length < 5) return null;
  widths.sort((x, y) => x - y);
  const q = (f) => widths[Math.min(widths.length - 1, Math.floor(widths.length * f))];
  return { widthM: q(0.5), meanM: widths.reduce((s, v) => s + v, 0) / widths.length, q25: q(0.25), q75: q(0.75), lengthM: best.len, sections: widths.length, rejected };
}
