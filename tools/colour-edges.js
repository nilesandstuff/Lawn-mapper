/**
 * COLOUR ON THE EDGES ONLY (owner, 2026-09-27: "I love your idea of using
 * color only on the edges").
 *
 * The decoder answers once per backbone patch (~1 to 5 m), so it finds the
 * lawn but places the edge coarsely: H53 put 41% of all error, and ~90% on
 * the lawns it gets right, within half a metre of the true edge. Colour and
 * texture answer per 15 cm cell and cannot find a lawn on their own (dormant
 * grass, shade -- why colour was set aside), but they can say which side of
 * a line a cell falls on once the line is roughly right.
 *
 * So, per lawn, with NO training data:
 *   1. the decoder's CONFIDENT ground -- more than `innerM` inside its lawn,
 *      or more than `innerM` outside it but inside the property line -- is
 *      this lot's own examples of lawn and of not-lawn;
 *   2. a small logistic model is fitted to those examples on the 14 colour
 *      and texture numbers per cell (public/lib/features.js), so dormant or
 *      shaded grass on THIS lot is judged against grass on THIS lot;
 *   3. only cells within `bandM` of the decoder's edge are re-decided by it,
 *      never under the tree canopy (colour there is a tree), and a 3x3
 *      majority pass stops it leaving speckle.
 * Too few examples on either side and the mask is returned unchanged.
 */
import { edgeDistance } from './edge-band.js';

export function colourEdges(mask, cheap, featureCount, { w, h, mpp, within = null, canopy = null,
  bandM = 1.0, innerM = 1.5, perClass = 3000, minPerClass = 150, seed = 7 } = {}) {
  const n = w * h;
  const cellsFor = (m) => Math.max(1, Math.round(m / mpp));
  const band = cellsFor(bandM);
  const inner = cellsFor(innerM);
  const dist = edgeDistance({ truth: mask, within, w, h, cap: inner + 2 });

  /* 1. This lot's own examples, subsampled evenly with a fixed seed. */
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const pos = [], neg = [];
  for (let i = 0; i < n; i++) {
    if (within && !within[i]) continue;
    if (canopy && canopy[i]) continue;
    if (dist[i] <= inner) continue;
    (mask[i] ? pos : neg).push(i);
  }
  if (pos.length < minPerClass || neg.length < minPerClass) return { mask, changed: 0, fitted: false };
  const pick = (list) => {
    if (list.length <= perClass) return list;
    const out = [];
    const step = list.length / perClass;
    for (let k = 0; k < perClass; k++) out.push(list[Math.min(list.length - 1, Math.floor(k * step + rnd() * step))]);
    return out;
  };
  const P = pick(pos), N = pick(neg);
  const F = featureCount;

  /* 2. Standardise on the examples, then logistic regression by gradient descent. */
  const mean = new Float64Array(F), sd = new Float64Array(F);
  const all = P.concat(N);
  for (const i of all) for (let k = 0; k < F; k++) mean[k] += cheap[i * F + k];
  for (let k = 0; k < F; k++) mean[k] /= all.length;
  for (const i of all) for (let k = 0; k < F; k++) { const d = cheap[i * F + k] - mean[k]; sd[k] += d * d; }
  for (let k = 0; k < F; k++) sd[k] = Math.sqrt(sd[k] / all.length) || 1;
  const x = (i, k) => (cheap[i * F + k] - mean[k]) / sd[k];
  const wts = new Float64Array(F + 1);
  const lr = 0.5, l2 = 1e-3, epochs = 150;
  const wp = 0.5 / P.length, wn = 0.5 / N.length;       // balanced classes
  const grad = new Float64Array(F + 1);
  for (let e = 0; e < epochs; e++) {
    grad.fill(0);
    for (const [list, y, wgt] of [[P, 1, wp], [N, 0, wn]]) {
      for (const i of list) {
        let z = wts[F];
        for (let k = 0; k < F; k++) z += wts[k] * x(i, k);
        const g = (1 / (1 + Math.exp(-z)) - y) * wgt;
        for (let k = 0; k < F; k++) grad[k] += g * x(i, k);
        grad[F] += g;
      }
    }
    for (let k = 0; k < F; k++) wts[k] -= lr * (grad[k] + l2 * wts[k]);
    wts[F] -= lr * grad[F];
  }

  /* 3. Re-decide the band only; then a majority pass over what changed. */
  const out = Uint8Array.from(mask);
  const say = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (dist[i] > band) continue;
    if (within && !within[i]) continue;
    if (canopy && canopy[i]) continue;
    let z = wts[F];
    for (let k = 0; k < F; k++) z += wts[k] * x(i, k);
    say[i] = 1;
    out[i] = z > 0 ? 1 : 0;
  }
  const smooth = Uint8Array.from(out);
  for (let y = 1; y < h - 1; y++) {
    for (let xx = 1; xx < w - 1; xx++) {
      const i = y * w + xx;
      if (!say[i]) continue;
      let votes = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) votes += out[i + dy * w + dx];
      smooth[i] = votes >= 5 ? 1 : 0;
    }
  }
  let changed = 0;
  for (let i = 0; i < n; i++) if (smooth[i] !== mask[i]) changed++;
  return { mask: smooth, changed, fitted: true };
}
