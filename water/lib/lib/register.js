/**
 * WHERE ONE AERIAL PHOTO'S GROUND IS IN ANOTHER, MEASURED ON THE GROUND.
 *
 * WHY (owner, 2026-10-01): "be sure that property lines map correctly on all
 * of the different image sources... done perfectly... automatically... every
 * time." The county photos lined up with Mapbox by tools/county-imagery.js
 * were "consistently off, both positionally and perspective".
 *
 * What align.js does is one shift and one scale for the whole frame, scored on
 * every edge in it. Two things defeat that on a real lot:
 *
 *   LEAN. Neither photo is a true orthophoto. A roof is displaced from its
 *   footprint by its height times the tangent of the view angle -- a metre or
 *   two on a satellite pass, less but not nothing on a county flight -- and
 *   in a different direction in each photo. Roof edges are the strongest
 *   edges in a suburban frame, so a whole-frame score is pulled toward
 *   lining up ROOFS, which is lining up the wrong thing: the lawn and the
 *   property line are on the ground.
 *
 *   SHAPE. Two photos of one frame can differ by more than a shift: a little
 *   scale, a little shear, a little rotation, from how each was rectified.
 *
 * So this measures the offset in many small patches across the frame, each on
 * its own, and fits ONE smooth map (an affine: shift, scale, rotation, shear)
 * to the patches that agree with each other. A roof patch disagrees with the
 * ground around it -- its lean is not the ground's offset -- and is outvoted;
 * so are a shadow that moved with the sun and a tree that was cut down. What
 * the fit agrees on is the ground.
 *
 * The features are edge ORIENTATIONS, not brightness or edge strength: a kerb
 * is the same line in June and in March, in a satellite pass and in a county
 * flight, whichever side of it is darker. Each pixel's gradient becomes the
 * doubled-angle pair (cos 2t, sin 2t) weighted by how sure the edge is, which
 * matches a line to the same line regardless of polarity.
 *
 * AND IT SAYS WHEN IT DOES NOT KNOW. `confident` needs enough agreeing patches,
 * spread across the frame, with a small spread among them. A frame of solid
 * tree canopy has nothing to measure, and the honest answer there is "not
 * measured", never a guess.
 *
 * Pure arithmetic on pixel arrays: the same code runs in the browser and in
 * the tools, and the tests drive it with warps whose answer is known.
 */

/* ------------------------------------------------------------ pictures */

/** RGBA (any size) -> luminance on a w x h grid, by area averaging. */
export function greyOn(rgba, W, H, w, h) {
  const out = new Float32Array(w * h);
  const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < H; yy++) {
        for (let xx = x0; xx < x1 && xx < W; xx++) {
          const i = (yy * W + xx) * 4;
          if (rgba[i + 3] === 0) continue; // no data
          s += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; n++;
        }
      }
      out[y * w + x] = n ? s / n : NaN;
    }
  }
  return out;
}

/** Separable Gaussian blur; NaN (no data) stays NaN and is not spread. */
export function gauss(a, w, h, sigma) {
  if (sigma <= 0) return Float32Array.from(a);
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const pass = (src, horiz) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Number.isNaN(src[y * w + x])) { out[y * w + x] = NaN; continue; }
        let s = 0, n = 0;
        for (let i = -r; i <= r; i++) {
          const xx = horiz ? x + i : x, yy = horiz ? y : y + i;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = src[yy * w + xx];
          if (Number.isNaN(v)) continue;
          s += v * k[i + r]; n += k[i + r];
        }
        out[y * w + x] = n ? s / n : NaN;
      }
    }
    return out;
  };
  return pass(pass(a, true), false);
}

/**
 * Edge orientation features: two channels, the doubled-angle unit vector of
 * the gradient times a confidence that saturates (so a roof edge does not
 * outweigh a kerb by its contrast), then softened by `spread` cells so the
 * search has a slope to climb. NaN becomes 0 with weight 0.
 */
export function orientationFeatures(grey, w, h, { sigma = 1, spread = 1 } = {}) {
  const g = gauss(grey, w, h, sigma);
  const n = w * h;
  const m2 = new Float32Array(n);
  const gx = new Float32Array(n), gy = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1];
      const d = g[i - 1], f = g[i + 1];
      const p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
      const vx = (c + 2 * f + r) - (a + 2 * d + p);
      const vy = (p + 2 * q + r) - (a + 2 * b + c);
      if (Number.isNaN(vx) || Number.isNaN(vy)) continue;
      gx[i] = vx; gy[i] = vy; m2[i] = vx * vx + vy * vy; valid[i] = 1;
    }
  }
  /* The knee of the confidence: the median edge strength among valid pixels. */
  const vals = [];
  for (let i = 0; i < n; i += 7) if (valid[i]) vals.push(m2[i]);
  vals.sort((p, q) => p - q);
  const knee = Math.max(1e-6, vals[Math.floor(vals.length * 0.5)] || 1);
  const c1 = new Float32Array(n), c2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!valid[i] || m2[i] === 0) continue;
    const conf = m2[i] / (m2[i] + knee);
    c1[i] = ((gx[i] * gx[i] - gy[i] * gy[i]) / m2[i]) * conf;
    c2[i] = ((2 * gx[i] * gy[i]) / m2[i]) * conf;
  }
  return { w, h, c1: gauss(c1, w, h, spread), c2: gauss(c2, w, h, spread), valid };
}

/* ------------------------------------------------------------- scoring */

/**
 * Normalised correlation of ref's window [x0,x0+pw) x [y0,y0+ph) with mov's
 * window displaced by (dx, dy) (integers). Both channels together.
 */
function ncc(ref, mov, x0, y0, pw, ph, dx, dy) {
  const { w } = ref;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y0 + ph; y++) {
    const my = y + dy;
    if (my < 0 || my >= mov.h) continue;
    for (let x = x0; x < x0 + pw; x++) {
      const mx = x + dx;
      if (mx < 0 || mx >= mov.w) continue;
      const i = y * w + x, j = my * mov.w + mx;
      if (!ref.valid[i] || !mov.valid[j]) continue;
      const a1 = ref.c1[i], a2 = ref.c2[i], b1 = mov.c1[j], b2 = mov.c2[j];
      n += 2; sa += a1 + a2; sb += b1 + b2;
      saa += a1 * a1 + a2 * a2; sbb += b1 * b1 + b2 * b2; sab += a1 * b1 + a2 * b2;
    }
  }
  if (n < (pw * ph) / 2) return -1;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  if (va <= 1e-9 || vb <= 1e-9) return -1;
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

/** Energy of the features in a window: is there anything here to match? */
function energy(f, x0, y0, pw, ph) {
  let s = 0, n = 0;
  for (let y = y0; y < y0 + ph; y++) {
    for (let x = x0; x < x0 + pw; x++) {
      const i = y * f.w + x;
      if (!f.valid[i]) continue;
      s += f.c1[i] * f.c1[i] + f.c2[i] * f.c2[i]; n++;
    }
  }
  return n ? s / n : 0;
}

/** Peak of a parabola through three scores, as an offset in (-0.5, 0.5). */
function sub(m, c, p) {
  const d = m - 2 * c + p;
  if (!(d < 0)) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (m - p)) / d));
}

/**
 * Best integer displacement of a window inside a search box, then subpixel.
 * Returns { dx, dy, score, second } -- `second` is the best score at least
 * `apart` cells from the peak, so a repetitive pattern (a row of identical
 * fence posts) reads as ambiguous rather than certain.
 */
function searchWindow(ref, mov, x0, y0, pw, ph, cx, cy, r, step = 1, apart = 3) {
  const scores = new Map();
  let best = null;
  for (let dy = cy - r; dy <= cy + r; dy += step) {
    for (let dx = cx - r; dx <= cx + r; dx += step) {
      const v = ncc(ref, mov, x0, y0, pw, ph, dx, dy);
      scores.set(`${dx},${dy}`, v);
      if (!best || v > best.score) best = { dx, dy, score: v };
    }
  }
  if (!best || best.score <= -1) return null;
  if (step > 1) {
    /* Refine around the coarse peak at full resolution. */
    const fine = searchWindow(ref, mov, x0, y0, pw, ph, best.dx, best.dy, step, 1, apart);
    if (fine) best = { ...fine, second: undefined };
  }
  let second = -1;
  for (const [k, v] of scores) {
    const [dx, dy] = k.split(',').map(Number);
    if (Math.max(Math.abs(dx - best.dx), Math.abs(dy - best.dy)) >= apart && v > second) second = v;
  }
  const at = (dx, dy) => ncc(ref, mov, x0, y0, pw, ph, dx, dy);
  const fx = sub(at(best.dx - 1, best.dy), best.score, at(best.dx + 1, best.dy));
  const fy = sub(at(best.dx, best.dy - 1), best.score, at(best.dx, best.dy + 1));
  return { dx: best.dx + fx, dy: best.dy + fy, score: best.score, second };
}

/* ----------------------------------------------------------- the model */

/** Least squares affine from points p -> q (arrays of [x,y]), weights wt. */
export function fitAffine(p, q, wt = null) {
  /* Two independent 3-parameter problems: qx = a p.x + b p.y + c, same for qy. */
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const bx = [0, 0, 0], by = [0, 0, 0];
  for (let i = 0; i < p.length; i++) {
    const v = [p[i][0], p[i][1], 1];
    const k = wt ? wt[i] : 1;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) N[r][c] += k * v[r] * v[c];
      bx[r] += k * v[r] * q[i][0]; by[r] += k * v[r] * q[i][1];
    }
  }
  const sx = solve3(N, bx), sy = solve3(N, by);
  return sx && sy ? [sx[0], sx[1], sx[2], sy[0], sy[1], sy[2]] : null;
}

/** Least squares translation-plus-uniform-scale (no rotation) p -> q. */
export function fitShiftScale(p, q, wt = null) {
  /* q = s p + t: unknowns s, tx, ty. */
  const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (let i = 0; i < p.length; i++) {
    const k = wt ? wt[i] : 1;
    const rows = [[p[i][0], 1, 0, q[i][0]], [p[i][1], 0, 1, q[i][1]]];
    for (const [a0, a1, a2, y] of rows) {
      const v = [a0, a1, a2];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) N[r][c] += k * v[r] * v[c];
        b[r] += k * v[r] * y;
      }
    }
  }
  const s = solve3(N, b);
  return s ? [s[0], 0, s[1], 0, s[0], s[2]] : null;
}

/** Weighted mean translation p -> q. */
export function fitShift(p, q, wt = null) {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < p.length; i++) {
    const k = wt ? wt[i] : 1;
    sx += k * (q[i][0] - p[i][0]); sy += k * (q[i][1] - p[i][1]); n += k;
  }
  return n ? [1, 0, sx / n, 0, 1, sy / n] : null;
}

function solve3(A, b) {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Apply [a,b,c,d,e,f] to [x,y]. */
export const applyAffine = (A, [x, y]) => [A[0] * x + A[1] * y + A[2], A[3] * x + A[4] * y + A[5]];

/** Inverse of an affine. */
export function invertAffine(A) {
  const det = A[0] * A[4] - A[1] * A[3];
  if (Math.abs(det) < 1e-12) return null;
  const a = A[4] / det, b = -A[1] / det, d = -A[3] / det, e = A[0] / det;
  return [a, b, -(a * A[2] + b * A[5]), d, e, -(d * A[2] + e * A[5])];
}

/**
 * The ground's offset, then the ground's shape.
 *
 * 1. THE MODE, NOT THE MAJORITY. Every patch says how far its piece of the
 *    frame moved. Ground patches -- kerbs, drives, beds, mow lines -- say the
 *    same thing to within a few centimetres; a roof says that plus its lean,
 *    which differs with its height, so roofs smear out along one direction
 *    and trees with them. The ground is the tightest cluster, so the start is
 *    the densest point of the patch offsets (mean shift, a 15 cm kernel), not
 *    the average and not the biggest loose group. A loose tolerance merged
 *    roofs into the ground on the Milwaukee bench lot and moved the answer
 *    15 cm toward them.
 *
 * 2. SHAPE ONLY WHEN IT PREDICTS. A scale or an affine always fits a little
 *    better, and on patches bunched in half the frame it can extrapolate
 *    metres into the other half. So each richer model is scored by how well
 *    it predicts patches it was not fitted to (leave-one-out), and is kept
 *    only if that is clearly better than the simpler one's.
 */
export function robustFit(p, q, wt, tol, { kernel = null } = {}) {
  const n = p.length;
  const d = p.map((pi, i) => [q[i][0] - pi[0], q[i][1] - pi[1]]);
  const bw = kernel ?? tol * 0.4;
  /* Density of each offset among all of them. */
  const dens = d.map((di) => d.reduce((s, dj, j) => s + wt[j] * Math.exp(-((di[0] - dj[0]) ** 2 + (di[1] - dj[1]) ** 2) / (2 * bw * bw)), 0));
  let start = 0;
  for (let i = 1; i < n; i++) if (dens[i] > dens[start]) start = i;
  let m = [...d[start]];
  for (let it = 0; it < 50; it++) {
    let sx = 0, sy = 0, sw = 0;
    for (let j = 0; j < n; j++) {
      const k = wt[j] * Math.exp(-((m[0] - d[j][0]) ** 2 + (m[1] - d[j][1]) ** 2) / (2 * bw * bw));
      sx += k * d[j][0]; sy += k * d[j][1]; sw += k;
    }
    const next = [sx / sw, sy / sw];
    const moved = Math.hypot(next[0] - m[0], next[1] - m[1]);
    m = next;
    if (moved < 1e-4) break;
  }
  const kinds = [
    { name: 'shift', k: 1, fit: fitShift, need: 1 },
    { name: 'shift+scale', k: 2, fit: fitShiftScale, need: 6 },
    { name: 'affine', k: 3, fit: fitAffine, need: 10 },
  ];
  const within = (A) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const [x, y] = applyAffine(A, p[i]);
      if (Math.hypot(x - q[i][0], y - q[i][1]) <= tol) out.push(i);
    }
    return out;
  };
  const results = [];
  let seed = within([1, 0, m[0], 0, 1, m[1]]);
  for (const kind of kinds) {
    let inl = seed;
    let A = null;
    for (let round = 0; round < 4 && inl.length >= Math.max(kind.k, kind.need); round++) {
      const next = kind.fit(inl.map((i) => p[i]), inl.map((i) => q[i]), inl.map((i) => wt[i]));
      if (!next) break;
      A = next;
      const again = within(A);
      if (again.length === inl.length && again.every((v, j) => v === inl[j])) break;
      inl = again;
    }
    if (!A || inl.length < Math.max(kind.k, kind.need)) { results.push(null); continue; }
    /* Leave-one-out prediction error over the inliers. */
    let cv = 0, rs = 0;
    for (const i of inl) {
      const rest = inl.filter((j) => j !== i);
      const B = kind.fit(rest.map((j) => p[j]), rest.map((j) => q[j]), rest.map((j) => wt[j]));
      const [x, y] = B ? applyAffine(B, p[i]) : [Infinity, Infinity];
      cv += Math.min(tol * 2, Math.hypot(x - q[i][0], y - q[i][1])) ** 2;
      const [fx, fy] = applyAffine(A, p[i]);
      rs += Math.hypot(fx - q[i][0], fy - q[i][1]) ** 2;
    }
    results.push({ name: kind.name, A, inliers: inl, rms: Math.sqrt(rs / inl.length), cv: Math.sqrt(cv / inl.length) });
    if (kind.name === 'shift') seed = inl;
  }
  let pick = null;
  for (const r of results) {
    if (!r) continue;
    if (!pick) { pick = r; continue; }
    /* Clearly better at predicting, over at least as many patches. */
    if (r.inliers.length >= pick.inliers.length * 0.95 && r.cv < pick.cv * 0.85) pick = r;
  }
  return { pick, all: results, mode: m };
}

/* ------------------------------------------------------------ the whole */

/**
 * Register `mov` to `ref`: both RGBA pictures meant to show the same frame,
 * `groundM` metres across `ref`'s width. Returns an affine taking a pixel of
 * ref (in ref's own pixel units) to the pixel of mov showing the same ground
 * (in mov's pixel units), with diagnostics:
 *
 *   { A, model, confident, inliers, patches, rmsM, spread, offsetM, why, vectors }
 *
 * offsetM is how far the ground at the frame's centre moved, in metres east
 * and north -- the number a person would say ("county is 0.8 m west").
 */
export function registerImages(ref, mov, groundM, {
  cellM = 0.2, reachM = 15, patchM = 9, strideM = 5, localM = 1.5,
  minPatches = 8, maxRmsM = 0.3, minSpread = 0.35, tolM = 0.3,
} = {}) {
  /* Working grid. The patches need detail (a 20 cm cell sees a kerb); the
     global search needs reach, so it runs on a coarser grid first. */
  let cell = cellM;
  let w = Math.round(groundM / cell);
  if (w > 700) { cell = groundM / 700; w = 700; }
  const h = Math.max(16, Math.round((w * ref.height) / ref.width));
  const mh = Math.max(16, Math.round((w * mov.height) / mov.width));
  const mw = w; // mov is resampled onto the same ground width
  const R = orientationFeatures(greyOn(ref.data, ref.width, ref.height, w, h), w, h, { sigma: 1, spread: 1 });
  const M = orientationFeatures(greyOn(mov.data, mov.width, mov.height, mw, mh), mw, mh, { sigma: 1, spread: 1 });

  /* 1. Where, roughly: one shift for the whole frame, on a 4x coarser grid. */
  const cw = Math.round(w / 4), ch = Math.round(h / 4), cmh = Math.round(mh / 4);
  const Rc = orientationFeatures(greyOn(ref.data, ref.width, ref.height, cw, ch), cw, ch, { sigma: 0.7, spread: 1.5 });
  const Mc = orientationFeatures(greyOn(mov.data, mov.width, mov.height, cw, cmh), cw, cmh, { sigma: 0.7, spread: 1.5 });
  const rc = Math.ceil(reachM / (cell * 4));
  const mc = rc + 1;
  const g = searchWindow(Rc, Mc, mc, mc, cw - 2 * mc, ch - 2 * mc, 0, 0, rc, 1, 3);
  const gx = g ? g.dx * 4 : 0, gy = g ? g.dy * 4 : 0;

  /* 2. Patches, each searched a little way around the rough answer. */
  const pw = Math.max(24, Math.round(patchM / cell));
  const st = Math.max(8, Math.round(strideM / cell));
  const r = Math.ceil(localM / cell);
  const vectors = [];
  const energies = [];
  for (let y0 = 0; y0 + pw <= h; y0 += st) {
    for (let x0 = 0; x0 + pw <= w; x0 += st) energies.push(energy(R, x0, y0, pw, pw));
  }
  const eMed = [...energies].sort((a, b) => a - b)[Math.floor(energies.length / 2)] || 0;
  for (let y0 = 0; y0 + pw <= h; y0 += st) {
    for (let x0 = 0; x0 + pw <= w; x0 += st) {
      const e = energy(R, x0, y0, pw, pw);
      if (e < eMed * 0.35) continue; // nothing here: lawn, roof plane, canopy
      const m = searchWindow(R, M, x0, y0, pw, pw, Math.round(gx), Math.round(gy), r, 2, 3);
      if (!m || m.score < 0.25) continue;
      if (m.second > m.score - 0.05) continue; // ambiguous
      const cx = x0 + pw / 2, cy = y0 + pw / 2;
      vectors.push({ x: cx, y: cy, dx: m.dx, dy: m.dy, score: m.score, margin: m.score - m.second });
    }
  }

  const empty = (why) => ({
    A: null, model: null, confident: false, inliers: 0, patches: vectors.length,
    rmsM: null, spread: 0, offsetM: null, why, vectors, cellM: cell,
    rough: { east: gx * cell, north: -gy * cell, score: g?.score ?? null },
  });
  if (vectors.length < 3) return empty(`only ${vectors.length} patches had anything to match`);

  /* 3. The model they agree on, in grid cells. */
  const p = vectors.map((v) => [v.x, v.y]);
  const q = vectors.map((v) => [v.x + v.dx, v.y + v.dy]);
  const wt = vectors.map((v) => Math.max(0.05, v.score) * Math.min(1, v.margin * 5));
  const tol = Math.max(1, tolM / cell);
  /* Mean shift in grid cells: 15 cm. */
  const { pick, all } = robustFit(p, q, wt, tol, { kernel: Math.max(0.5, 0.15 / cell) });
  if (!pick) return empty('no model fitted');

  /* Spread: how much of the frame the agreeing patches cover (bounding box
     of their centres over the frame), so ten patches on one roof cannot
     certify a frame. */
  const xs = pick.inliers.map((i) => p[i][0]), ys = pick.inliers.map((i) => p[i][1]);
  const spread = Math.sqrt(((Math.max(...xs) - Math.min(...xs)) / w) * ((Math.max(...ys) - Math.min(...ys)) / h));
  const rmsM = pick.rms * cell;
  for (let i = 0; i < vectors.length; i++) vectors[i].inlier = pick.inliers.includes(i);

  /* In the pictures' own pixels: grid -> ref px is * (ref.width / w); mov px
     from grid is * (mov.width / mw). */
  const kr = ref.width / w, km = mov.width / mw;
  const [a, b, c, d, e, f] = pick.A;
  const A = [a * km / kr, b * km / kr, c * km, d * km / kr, e * km / kr, f * km];

  /* The centre's ground offset: where the frame centre's ground sits in mov,
     relative to mov's centre, in metres. */
  const [qx, qy] = applyAffine(pick.A, [w / 2, h / 2]);
  const offsetM = { east: (qx - mw / 2) * cell, north: -(qy - mh / 2) * cell };

  const confident = pick.inliers.length >= minPatches && rmsM <= maxRmsM && spread >= minSpread;
  const why = confident ? 'measured'
    : pick.inliers.length < minPatches ? `only ${pick.inliers.length} patches agree (of ${vectors.length})`
      : rmsM > maxRmsM ? `the agreeing patches still differ by ${rmsM.toFixed(2)} m`
        : `the agreeing patches cover too little of the frame (${spread.toFixed(2)})`;
  return {
    A, model: pick.name, confident, inliers: pick.inliers.length, patches: vectors.length,
    rmsM, spread, offsetM, why, vectors, cellM: cell,
    rough: { east: gx * cell, north: -gy * cell, score: g?.score ?? null },
    models: all.map((m) => m && { name: m.name, inliers: m.inliers.length, rmsM: m.rms * cell, cvM: m.cv * cell }),
  };
}

/**
 * A measurement as the editor's {east, north, scale}: the move and scale of
 * the other photo, about the frame's centre, that puts its ground on
 * Mapbox's (lib/align.js movedCorners). register says where Mapbox's centre
 * is in the other photo (offsetM) and how much bigger its ground is there
 * (the map's determinant); the photo moves the other way, by that scale.
 */
export function alignFromRegistration(r) {
  const A = r?.A || [1, 0, 0, 0, 1, 0];
  const scale = 1 / Math.sqrt(Math.abs(A[0] * A[4] - A[1] * A[3]) || 1);
  return {
    east: -scale * (r?.offsetM?.east || 0),
    north: -scale * (r?.offsetM?.north || 0),
    scale: Math.round(scale * 10000) / 10000,
  };
}
