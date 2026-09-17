/**
 * The head: a very small network that says "grass" or "not grass" per pixel.
 *
 * ONE HIDDEN LAYER, SIXTEEN UNITS, and the smallness is the point rather than
 * a compromise. There are twenty lawns. Pixels inside one lawn are not twenty
 * thousand independent facts -- they are one photograph seen twenty thousand
 * times -- so the number of things this can learn has to stay closer to the
 * number of lawns than to the number of pixels. A model with room to memorise
 * twenty gardens will do exactly that and score beautifully on them.
 *
 * Plain arithmetic rather than a framework, because the alternative is a
 * hundreds-of-megabytes dependency in CI to multiply an eleven-wide matrix.
 * The whole thing trains in seconds, which is what makes leaving one lawn out
 * twenty times affordable -- and that, not the model, is the point of the
 * exercise.
 */

import { FEATURE_COUNT } from '../public/lib/features.js';
/* The forward pass lives with the browser's copy: dev mode draws the same
   model this tool scores, and two implementations would drift apart. */
export { predict } from '../public/lib/head.js';

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * The width the default learning rate was chosen at.
 *
 * Every rate is quoted relative to this, so a wider feature set trains at the
 * same effective step rather than at one several times too large. See the
 * scaling in train() for what too large looks like -- it is not a worse score,
 * it is a model that has stopped answering.
 */
const RATE_REFERENCE_INPUTS = 11;

/**
 * Train on pixels.
 *
 * `x` is rows of features laid end to end, `y` is 1 for lawn and 0 for not,
 * `weight` scales each row's contribution -- which is how the class imbalance
 * is handled. A lawn is a third of a frame, so unweighted training is already
 * two thirds right by answering "not grass" every time, and that is the local
 * minimum it will find if nothing stops it.
 */
export function train(x, y, weight, {
  hidden = 16,
  epochs = 16,
  rate = 0.08,
  l2 = 1e-4,
  seed = 1,
  inputs = FEATURE_COUNT,
} = {}) {
  const n = y.length;

  /*
   * A seeded generator, not Math.random. Two runs of the same fold have to
   * give the same answer, or "this change improved it by a point" cannot be
   * told from the shuffle landing differently.
   */
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  /* He initialisation: scaled to the fan-in, so the first pass through does
     not saturate every unit and flatten the gradient before step one. */
  const W1 = new Float64Array(hidden * inputs);
  const b1 = new Float64Array(hidden);
  const W2 = new Float64Array(hidden);
  let b2 = 0;
  const scale = Math.sqrt(2 / inputs);
  for (let i = 0; i < W1.length; i++) W1[i] = (rand() * 2 - 1) * scale;
  for (let i = 0; i < hidden; i++) W2[i] = (rand() * 2 - 1) * Math.sqrt(2 / hidden);

  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const h = new Float64Array(hidden);
  const dh = new Float64Array(hidden);

  for (let epoch = 0; epoch < epochs; epoch++) {
    /* Fisher-Yates, so the order differs per epoch without re-allocating. */
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    /*
     * The step shrinks as it goes: big early to get somewhere, small late so
     * the last few thousand pixels do not undo the shape of the answer.
     *
     * AND IT IS DIVIDED BY THE NUMBER OF INPUTS, which is not a detail. One
     * step changes the sum feeding each unit by roughly the rate times the
     * squared length of the input row -- and with standardised features that
     * length grows with the width. A rate that settles nicely on eleven
     * numbers a pixel therefore overshoots wildly on two hundred, and what
     * overshooting looks like from outside is a model that answers "no lawn"
     * over the whole property: sixteen of twenty folds did exactly that, and
     * it printed as 100% wrong, which reads as a bad model rather than a
     * diverged one.
     *
     * So the rate is quoted per input and scaled by the reference width it was
     * chosen at. Wider feature sets then train at the same effective step, and
     * the comparison between them is about the features rather than about
     * which of them happened to suit one hard-coded number.
     */
    const scale = RATE_REFERENCE_INPUTS / inputs;
    const lr = rate * scale * (1 - epoch / (epochs + 1));

    for (let k = 0; k < n; k++) {
      const i = order[k];
      const off = i * inputs;
      const w = weight ? weight[i] : 1;

      let z2 = b2;
      for (let u = 0; u < hidden; u++) {
        let z = b1[u];
        for (let f = 0; f < inputs; f++) z += W1[u * inputs + f] * x[off + f];
        h[u] = z > 0 ? z : 0;              // ReLU
        dh[u] = z > 0 ? 1 : 0;
        z2 += W2[u] * h[u];
      }
      const p = sigmoid(z2);
      const err = (p - y[i]) * w;          // cross-entropy through the sigmoid

      for (let u = 0; u < hidden; u++) {
        const gh = err * W2[u] * dh[u];
        W2[u] -= lr * (err * h[u] + l2 * W2[u]);
        b1[u] -= lr * gh;
        for (let f = 0; f < inputs; f++) {
          const wi = u * inputs + f;
          W1[wi] -= lr * (gh * x[off + f] + l2 * W1[wi]);
        }
      }
      b2 -= lr * err;
    }
  }

  return { W1, b1, W2, b2, hidden, inputs };
}

/**
 * Weights that make the two answers count equally.
 *
 * Without this the cheapest way to be right most of the time is to call
 * everything "not grass", and a model that has found that is not obviously
 * broken from the outside -- it just scores like a bad detector.
 */
export function balanceWeights(y) {
  let pos = 0;
  for (let i = 0; i < y.length; i++) if (y[i]) pos++;
  const neg = y.length - pos;
  const wPos = pos ? y.length / (2 * pos) : 0;
  const wNeg = neg ? y.length / (2 * neg) : 0;
  const w = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) w[i] = y[i] ? wPos : wNeg;
  return w;
}
