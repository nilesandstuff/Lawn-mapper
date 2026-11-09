/**
 * A WALK PLACED BY AN EARLIER WALK, BY ITS SHAPE (core session, 2026-11-09; SCAN-H32). The owner: "it should be much
 * easier to match the 3d points taken from a phone to the 3d points taken on the same phone." On the three walks of
 * SCAN-H30 the shapes placed four of six pairs at 2.1-3.7 ft with no lidar and no marks, and the share of points
 * landed told the good from the bad on all six (0.37-0.46 against 0.22-0.25).
 *
 * THE REFERENCE: a walk placed by its marks, its depth points carried onto the map (east, north metres round the map's
 * origin, and the walk's own height), the standing things (0.3-4 m over its ground: walls, fences, shrubs, trunks)
 * apart from the ground. Kept per map on the scan site (GET /api/scan/reference?map=), made by
 * scan/tools/reference-build.mjs from a twin.
 *
 * THE FIX: the standing things of this walk so far as a plan, matched against the reference's at every turn (TURN_STEP
 * degrees) by correlation, so no start is needed; the best few refined by ICP in 3D with the ground (four degrees of
 * freedom); the one that lands the most points within LAND_M of the reference's kept, and used only when that share
 * is GATE or more. The same steps as scan/tools/walk_fix_study.py's shapes (small_gicp's GICP there, plain
 * point-to-point ICP here, which a phone can run).
 *
 * Pure: no DOM, no fetch. Points are [u, v, y]: the session's plan (x, -z) and its height y.
 */

export const STAND = [0.3, 4.0];        // m over the phone's ground: standing things
export const SEARCH_CELL = 0.5;          // m: the correlation's cells (run 224: 0.5 m placed 5 of 6 pairs at 1.9-4.3 ft,
                                         // 1 m put one at 7.4 ft; 3-11 s a match on the runner's CPU)
export const TURN_STEP = 4;              // degrees between turns tried
export const MARGIN = 30;                // m round the reference the walk may fall
export const CANDIDATES = 8;             // the best turns refined
export const LAND_M = 0.3;               // m: a point this near the reference's has landed
export const GATE = 0.3;                 // the landed share a fix needs (SCAN-H32: 0.37-0.46 good, 0.22-0.25 wrong)
export const STAND_GATE = 0.12;          // and of the standing things alone: flat ground lands anywhere on a flat lot
                                         // (run 224, the five good: all 0.33-0.41, standing 0.13-0.24; the one refused 0.24)
export const MIN_STAND = 600;            // standing cells (20 cm) the walk needs before a match is tried
export const VOX = 0.2;                  // m: points kept one to a cell this size
const MAX_STAND = 60000, MAX_GROUND = 30000;

const MAGIC = 0x46455257;                // 'WREF'

/* ------------------------------------------------------------- geometry */
export const place = (T, u, v) => {
  const c = Math.cos(T.theta), s = Math.sin(T.theta);
  return [c * u - s * v + T.tx, s * u + c * v + T.ty];
};

/** One turn and shift taking a onto b (both [[x, y]]), least squares. */
export function fitRigid(a, b) {
  const n = a.length;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) { ax += a[i][0]; ay += a[i][1]; bx += b[i][0]; by += b[i][1]; }
  ax /= n; ay /= n; bx /= n; by /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const p = a[i][0] - ax, q = a[i][1] - ay, r = b[i][0] - bx, t = b[i][1] - by;
    sxx += p * r + q * t; sxy += p * t - q * r;
  }
  const th = Math.atan2(sxy, sxx), c = Math.cos(th), s = Math.sin(th);
  return { theta: th, tx: bx - (c * ax - s * ay), ty: by - (s * ax + c * ay), s: 1 };
}

const thinTo = (a, n) => (a.length <= n ? a : a.filter((_, i) => i % Math.ceil(a.length / n) === 0));
const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

/** Points kept one to a VOX cell (the first), as [u, v, y]. */
export function voxel(points, vox = VOX) {
  const seen = new Set(), out = [];
  for (const p of points) {
    const k = `${Math.floor(p[0] / vox)},${Math.floor(p[1] / vox)},${Math.floor(p[2] / vox)}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------- the reference */
/**
 * A reference from a walk placed by its marks: stand and ground [[u, v, y]] in its session, T its marks' turn and
 * shift. -> { stand: Float32Array [e, n, y, ...], ground: Float32Array, at }
 */
export function buildRef({ stand, ground }, T, at = Date.now()) {
  const out = (pts, max) => {
    const kept = thinTo(voxel(pts), max), a = new Float32Array(kept.length * 3);
    kept.forEach((p, i) => { const [e, n] = place(T, p[0], p[1]); a[i * 3] = e; a[i * 3 + 1] = n; a[i * 3 + 2] = p[2]; });
    return a;
  };
  return { stand: out(stand, MAX_STAND), ground: out(ground, MAX_GROUND), at };
}

/** The reference as bytes: 'WREF', u32 version 1, u32 stand count, u32 ground count, f64 at, then the points. */
export function encodeRef(ref) {
  const ns = ref.stand.length / 3, ng = ref.ground.length / 3;
  const buf = new ArrayBuffer(24 + (ns + ng) * 12), dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 1, true); dv.setUint32(8, ns, true); dv.setUint32(12, ng, true);
  dv.setFloat64(16, ref.at || 0, true);
  const f = new Float32Array(buf, 24);
  f.set(ref.stand, 0); f.set(ref.ground, ns * 3);
  return new Uint8Array(buf);
}
export function decodeRef(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = u.byteOffset % 4 === 0 ? u.buffer : u.slice().buffer, off = u.byteOffset % 4 === 0 ? u.byteOffset : 0;
  const dv = new DataView(buf, off);
  if (u.length < 24 || dv.getUint32(0, true) !== MAGIC) return null;
  const ns = dv.getUint32(8, true), ng = dv.getUint32(12, true);
  if (u.length < 24 + (ns + ng) * 12) return null;
  const f = new Float32Array(buf, off + 24, (ns + ng) * 3);
  return { stand: f.slice(0, ns * 3), ground: f.slice(ns * 3), at: dv.getFloat64(16, true) };
}

/* ------------------------------------------------------------- FFT (radix 2) */
function fft1(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
/** In place 2D FFT of an N x N grid (rows of N), N a power of two. */
function fft2(re, im, N, inverse = false) {
  const r = new Float64Array(N), i_ = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    const o = y * N;
    for (let x = 0; x < N; x++) { r[x] = re[o + x]; i_[x] = im[o + x]; }
    fft1(r, i_, inverse);
    for (let x = 0; x < N; x++) { re[o + x] = r[x]; im[o + x] = i_[x]; }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { r[y] = re[y * N + x]; i_[y] = im[y * N + x]; }
    fft1(r, i_, inverse);
    for (let y = 0; y < N; y++) { re[y * N + x] = r[y]; im[y * N + x] = i_[y]; }
  }
}

/* ------------------------------------------------------------- a 3D nearest-point lookup */
/* Cells as wide as the search distance, so a lookup reads only the 27 round the point; numeric keys (a string key
   per lookup cost two thirds of the fix's time). */
const KEY = (x, y, z) => (x + 2048) * 16777216 + (y + 2048) * 4096 + (z + 2048);
function hashOf(points3, cell) {
  const map = new Map();
  for (let i = 0; i < points3.length; i += 3) {
    const k = KEY(Math.floor(points3[i] / cell), Math.floor(points3[i + 1] / cell), Math.floor(points3[i + 2] / cell));
    let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(i);
  }
  return {
    nearest(x, y, z, maxD) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let best = -1, bd = maxD * maxD;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const list = map.get(KEY(cx + a, cy + b, cz + c));
        if (!list) continue;
        for (const i of list) {
          const d = (points3[i] - x) ** 2 + (points3[i + 1] - y) ** 2 + (points3[i + 2] - z) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      return best;
    },
  };
}
/** One lookup per search distance, made when first asked for. */
function lookups(points3) {
  const by = new Map();
  return (d) => { if (!by.has(d)) by.set(d, hashOf(points3, d)); return by.get(d); };
}

/* ------------------------------------------------------------- the fix */
/**
 * This walk placed on the reference. walk: { stand: [[u, v, y]], ground: [[u, v, y]] } in its session.
 * -> { ok, T: { theta, tx, ty, s }, tz, landed, second, stand, ms, why }
 */
export function shapeFix(ref, walk, { cell = SEARCH_CELL, step = TURN_STEP, margin = MARGIN, gate = GATE, standGate = STAND_GATE, minStand = MIN_STAND } = {}) {
  const t0 = Date.now();
  const stand = voxel(walk.stand || []), ground = voxel(walk.ground || []);
  if (!ref || ref.stand.length < 300) return { ok: false, why: 'no reference for this map yet' };
  if (stand.length < minStand) return { ok: false, why: `${stand.length} standing points so far (${minStand} wanted): walk on, looking at walls, fences and shrubs`, stand: stand.length };
  // the reference's plan
  const A = ref.stand;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < A.length; i += 3) { x0 = Math.min(x0, A[i]); x1 = Math.max(x1, A[i]); y0 = Math.min(y0, A[i + 1]); y1 = Math.max(y1, A[i + 1]); }
  x0 -= margin; y0 -= margin; x1 += margin; y1 += margin;
  const nxA = Math.ceil((x1 - x0) / cell) + 1, nyA = Math.ceil((y1 - y0) / cell) + 1;
  const ws = thinTo(stand, 8000);
  // the walk's grid is at most this wide at any turn (its points lie within wr of its session's origin... but it
  // need not be centred there: measured from its own centre)
  let mx = 0, my = 0; for (const p of ws) { mx += p[0]; my += p[1]; } mx /= ws.length; my /= ws.length;
  let rad = 0; for (const p of ws) rad = Math.max(rad, Math.hypot(p[0] - mx, p[1] - my));
  const nW = Math.ceil((2 * rad) / cell) + 2;
  let N = 1; while (N < Math.max(nxA, nyA) + nW) N <<= 1;
  if (N > 1024) return { ok: false, why: 'the reference is too large to search at once' };
  // the reference's plan in the frequency domain, once
  const Are = new Float64Array(N * N), Aim = new Float64Array(N * N);
  for (let i = 0; i < A.length; i += 3) {
    const c = Math.floor((A[i] - x0) / cell), r = Math.floor((A[i + 1] - y0) / cell);
    Are[r * N + c] += 1;
  }
  let meanA = 0;
  for (let r = 0; r < nyA; r++) for (let c = 0; c < nxA; c++) { const k = r * N + c; Are[k] = Math.log1p(Are[k]); meanA += Are[k]; }
  meanA /= nxA * nyA;
  for (let r = 0; r < nyA; r++) for (let c = 0; c < nxA; c++) Are[r * N + c] -= meanA;
  fft2(Are, Aim, N);
  const cands = [];
  const Wre = new Float64Array(N * N), Wim = new Float64Array(N * N);
  for (let deg = 0; deg < 360; deg += step) {
    const th = (deg * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
    Wre.fill(0); Wim.fill(0);
    let qx0 = Infinity, qy0 = Infinity;
    const Q = ws.map((p) => { const q = [c * p[0] - s * p[1], s * p[0] + c * p[1]]; qx0 = Math.min(qx0, q[0]); qy0 = Math.min(qy0, q[1]); return q; });
    for (const q of Q) {
      const cc = Math.floor((q[0] - qx0) / cell), rr = Math.floor((q[1] - qy0) / cell);
      if (cc < nW && rr < nW) Wre[rr * N + cc] += 1;
    }
    let meanW = 0;
    for (let r = 0; r < nW; r++) for (let cc = 0; cc < nW; cc++) { const k = r * N + cc; Wre[k] = Math.log1p(Wre[k]); meanW += Wre[k]; }
    meanW /= nW * nW;
    for (let r = 0; r < nW; r++) for (let cc = 0; cc < nW; cc++) Wre[r * N + cc] -= meanW;
    fft2(Wre, Wim, N);
    // A times the conjugate of W, back: the score of each offset of W's corner in A's grid
    for (let k = 0; k < N * N; k++) {
      const ar = Are[k], ai = Aim[k], br = Wre[k], bi = -Wim[k];
      Wre[k] = ar * br - ai * bi; Wim[k] = ar * bi + ai * br;
    }
    fft2(Wre, Wim, N, true);
    let best = -Infinity, bk = 0;
    for (let k = 0; k < N * N; k++) if (Wre[k] > best) { best = Wre[k]; bk = k; }
    let r = Math.floor(bk / N), cc = bk % N;
    if (r > N - nW) r -= N;
    if (cc > N - nW) cc -= N;
    cands.push({ score: best, th, tx: x0 + cc * cell - qx0, ty: y0 + r * cell - qy0 });
  }
  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const k of cands) {
    if (picked.every((p) => Math.abs((((k.th - p.th) * 180) / Math.PI + 540) % 360 - 180) > 10 || Math.hypot(k.tx - p.tx, k.ty - p.ty) > 3)) picked.push(k);
    if (picked.length >= CANDIDATES) break;
  }
  // ICP in 3D (the turn about the vertical, the shift, the height), standing things and ground together
  const tgt = new Float32Array(ref.stand.length + ref.ground.length);
  tgt.set(ref.stand, 0); tgt.set(ref.ground, ref.stand.length);
  const H = lookups(tgt);
  const src = [...thinTo(stand, 5000), ...thinTo(ground, 2500)];
  const gy = [];
  for (let i = 2; i < ref.ground.length; i += 3) gy.push(ref.ground[i]);
  const tz0 = ground.length && gy.length ? median(gy) - median(ground.map((p) => p[2])) : 0;
  /* The landed share on all the walk's points in their own proportions, ground and standing things alike, as the
     study measured it (SCAN-H32's gate): run 222 scored the ICP's sample (two standing points to one ground) and read
     0.23-0.30 where the study read 0.22-0.46 for the same placements. */
  const all = [...thinTo(stand, 20000), ...thinTo(ground, 10000)];
  const ns = Math.min(stand.length, 20000);
  const landedOf = (T, tz) => {
    let n = 0, nst = 0;
    const h = H(LAND_M);
    all.forEach((p, i) => { const [e, nn] = place(T, p[0], p[1]); if (h.nearest(e, nn, p[2] + tz, LAND_M) >= 0) { n++; if (i < ns) nst++; } });
    return { all: n / all.length, stand: ns ? nst / ns : 0 };
  };
  const results = [];
  for (const k of picked) {
    let T = { theta: k.th, tx: k.tx, ty: k.ty, s: 1 }, tz = tz0;
    for (const d of [1.5, 1.5, 0.8, 0.8, 0.5, 0.5, 0.4, 0.3, 0.3]) {
      const a = [], b = [], dz = [], h = H(d);
      for (const p of src) {
        const [e, nn] = place(T, p[0], p[1]);
        const j = h.nearest(e, nn, p[2] + tz, d);
        if (j < 0) continue;
        a.push([p[0], p[1]]); b.push([tgt[j], tgt[j + 1]]); dz.push(tgt[j + 2] - p[2]);
      }
      if (a.length < 30) break;
      T = fitRigid(a, b); tz = median(dz);
    }
    const L = landedOf(T, tz);
    results.push({ T, tz, landed: L.all, standLanded: L.stand });
  }
  results.sort((a, b) => b.landed - a.landed);
  const best = results[0];
  const other = results.find((r) => Math.hypot(r.T.tx - best.T.tx, r.T.ty - best.T.ty) > 2
    || Math.abs((((r.T.theta - best.T.theta) * 180) / Math.PI + 540) % 360 - 180) > 5);
  const out = { T: best.T, tz: best.tz, landed: +best.landed.toFixed(3), standLanded: +best.standLanded.toFixed(3), second: other ? +other.landed.toFixed(3) : null, stand: stand.length, ms: Date.now() - t0 };
  if (best.landed < gate) return { ...out, ok: false, why: `only ${Math.round(best.landed * 100)}% of the walk's points land on the earlier walk's (${Math.round(gate * 100)}% wanted)` };
  if (best.standLanded < standGate) return { ...out, ok: false, why: `the ground lines up but only ${Math.round(best.standLanded * 100)}% of the walls, fences and shrubs do (${Math.round(standGate * 100)}% wanted)` };
  return { ...out, ok: true, why: null };
}
