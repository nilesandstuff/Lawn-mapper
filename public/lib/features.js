/**
 * What a pixel looks like, as numbers a model can learn from.
 *
 * WHY THIS IS A FILE OF ITS OWN. Everything here is arithmetic over an image
 * and every line of it is silently wrong-able: a colour index with its terms
 * the wrong way round, a window that runs off the edge, a normalisation
 * applied at training and forgotten at prediction. None of those throw. They
 * produce a model that scores badly, and a model that scores badly looks
 * exactly like a task that is hard.
 *
 * WHAT THESE FEATURES ARE FOR. Not to be clever -- to be the FLOOR. If a
 * handful of colour and texture numbers already beats the detector we are
 * paying for, that is worth knowing before anything heavier is built; and if
 * they do not, the pipeline around them has still been proved end to end on
 * real rows, which is the part that has to work before a backbone is worth
 * loading. The feature vector is the seam where something better plugs in.
 *
 * Grass, from a satellite, is mostly three things: it is green, it is rough at
 * the scale of a few pixels, and it sits next to other green. Driveways and
 * roofs are none of those. That is what the columns below say.
 */

/** How many numbers describe one pixel. Asserted in the tests. */
export const FEATURE_COUNT = 14;

export const FEATURE_NAMES = [
  'red', 'green', 'blue',
  'excess green', 'green share', 'brightness', 'saturation',
  'local brightness', 'local roughness',
  'neighbourhood green', 'neighbourhood green spread',
  'excess green, normalised', 'regional brightness', 'relative brightness',
];

/**
 * THE WINDOWS ARE MEASURED IN METRES, and they were not until 2026-09-19.
 *
 * They were fixed pixel counts — 5x5 and 15x15 — which sounds neutral and is
 * not, because these frames run from 5 to 38 cm a cell (H1). A 15x15 window
 * was therefore **75 cm on one lawn and 5.7 metres on another**, so "is this
 * ground rough" and "is the neighbourhood green" were different questions
 * depending on the lot size, and the model was asked to learn one answer to
 * all of them. The ring was deliberately built in metres for exactly this
 * reason; these were simply missed.
 *
 * The values below are what the old pixel counts came to on a typical frame at
 * 12 cm a cell, so a typical lawn sees roughly what it always saw and the
 * extremes stop disagreeing with it.
 */
export const FINE_M = 0.25;    // was 2 px: the texture of mown grass
export const COARSE_M = 0.9;   // was 7 px: is the neighbourhood green
/**
 * And a new one, for the failure the error table put top of the list: shade
 * thrown by a BUILDING, which is 27 to 41 points worse than shade thrown by a
 * tree (H12). Six metres is wide enough to sit inside a house's shadow and
 * still be told that the whole region is dark, which is the fact that
 * separates shadowed grass from a dark roof.
 */
export const WIDE_M = 6;

/**
 * Integral image, so a window average costs four lookups instead of w*h.
 *
 * Float64 deliberately. A 512x512 sum of values under 1 reaches a quarter of a
 * million, and in Float32 the low bits of each addition start disappearing
 * into the running total -- which shows up as a faint grid pattern in the
 * local averages, exactly the sort of artefact that would be read as texture.
 */
function integral(values, w, h) {
  const out = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += values[y * w + x];
      out[(y + 1) * (w + 1) + (x + 1)] = out[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return out;
}

/** Mean over the window of radius r centred on (x, y), clipped at the edges. */
function windowMean(sum, w, h, x, y, r) {
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(w - 1, x + r);
  const y1 = Math.min(h - 1, y + r);
  const area = (x1 - x0 + 1) * (y1 - y0 + 1);
  const S = (xx, yy) => sum[yy * (w + 1) + xx];
  return (S(x1 + 1, y1 + 1) - S(x0, y1 + 1) - S(x1 + 1, y0) + S(x0, y0)) / area;
}

/**
 * Every pixel of an RGB image as a feature vector, laid out one after another.
 *
 * `rgb` is Uint8 RGB or RGBA. Returns a Float32Array of w*h*FEATURE_COUNT.
 */
export function imageFeatures(rgb, w, h, { channels = 4, mpp } = {}) {
  /*
   * mpp IS REQUIRED, LOUDLY.
   *
   * The windows below are distances on the ground, so a caller that forgets
   * the scale would silently get windows of a different size from the ones
   * the model was trained with — which does not throw, does not look wrong,
   * and produces a model of nothing in particular. That is the exact shape of
   * every bug this file's header warns about, so it is an error rather than a
   * default.
   */
  if (!(mpp > 0)) {
    throw new Error('imageFeatures needs mpp (metres per pixel): the windows '
      + 'are distances on the ground, and guessing one silently changes what '
      + 'every texture column means');
  }
  const n = w * h;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const luma = new Float32Array(n);
  const exg = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const r = rgb[i * channels] / 255;
    const g = rgb[i * channels + 1] / 255;
    const b = rgb[i * channels + 2] / 255;
    R[i] = r; G[i] = g; B[i] = b;
    luma[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    /*
     * Excess green: 2G - R - B. The standard cheap vegetation index for
     * ordinary colour imagery, and the one thing here that separates grass
     * from a grey driveway regardless of how bright the day was.
     *
     * "Regardless of how bright the day was" is true across DAYS and false
     * across a SHADOW EDGE, which is the distinction that matters here. In
     * shade r, g and b all shrink together, so this shrinks with them: the
     * project's main vegetation signal fades out exactly where the error table
     * says the error is (H12). The normalised version below is the fix, and
     * both are kept because the raw one still carries absolute brightness,
     * which a driveway in full sun does not have.
     */
    exg[i] = 2 * g - r - b;
  }

  /*
   * TWO SCALES, AND THEY ANSWER DIFFERENT QUESTIONS. The small window asks
   * whether this pixel sits in rough ground -- mown grass has texture at a few
   * pixels, asphalt does not. The large one asks what the neighbourhood is,
   * which is what rescues grass in shadow: dark, but surrounded by lawn.
   */
  const radius = (metres) => Math.max(1, Math.round(metres / mpp));
  const FINE = radius(FINE_M);
  const COARSE = radius(COARSE_M);
  const WIDE = radius(WIDE_M);

  const sumL = integral(luma, w, h);
  const sumL2 = integral(luma.map((v) => v * v), w, h);
  const sumE = integral(exg, w, h);
  const sumE2 = integral(exg.map((v) => v * v), w, h);

  const out = new Float32Array(n * FEATURE_COUNT);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * FEATURE_COUNT;
      const r = R[i], g = G[i], b = B[i];
      const total = r + g + b + 1e-6;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);

      const mL = windowMean(sumL, w, h, x, y, FINE);
      const mL2 = windowMean(sumL2, w, h, x, y, FINE);
      const mE = windowMean(sumE, w, h, x, y, COARSE);
      const mE2 = windowMean(sumE2, w, h, x, y, COARSE);

      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = exg[i];
      out[o + 4] = g / total;
      out[o + 5] = luma[i];
      out[o + 6] = (max - min) / (max + 1e-6);
      out[o + 7] = mL;
      /*
       * Variance as mean-of-squares minus square-of-mean, floored at zero.
       * Floating point makes that difference very slightly negative on a
       * perfectly flat patch, and Math.sqrt of it is NaN -- which propagates
       * through training and produces a model of nothing at all.
       */
      out[o + 8] = Math.sqrt(Math.max(0, mL2 - mL * mL));
      out[o + 9] = mE;
      out[o + 10] = Math.sqrt(Math.max(0, mE2 - mE * mE));

      /*
       * EXCESS GREEN WITHOUT THE BRIGHTNESS. Dividing by the total removes the
       * illumination and leaves the colour, so grass in a building's shadow
       * reads as green rather than as dark. This is the one column here aimed
       * squarely at the biggest number in the error table.
       */
      out[o + 11] = exg[i] / total;

      /*
       * HOW BRIGHT THE WHOLE REGION IS, and how this pixel compares to it.
       *
       * Together these say whether a dark pixel is dark because it sits in a
       * large dark area — a shadow — or dark because it is a dark thing, which
       * is the distinction nothing in this vector could previously make. A
       * shadowed lawn is dark with a dark neighbourhood and a ratio near one;
       * a wet asphalt drive in full sun is dark with a BRIGHT neighbourhood
       * and a ratio well under one.
       *
       * The ratio is the useful half and the absolute is kept beside it,
       * because a ratio alone cannot tell an overcast frame from a sunlit one.
       */
      const mW = windowMean(sumL, w, h, x, y, WIDE);
      out[o + 12] = mW;
      out[o + 13] = luma[i] / (mW + 1e-6);
    }
  }
  return out;
}

/**
 * Mean and spread of each column, for putting features on a common scale.
 *
 * MEASURED ON THE TRAINING SET AND CARRIED WITH THE MODEL. Standardising each
 * fold against its own numbers would let the held-out lawn influence its own
 * scaling, which is a quiet way of testing on what you trained on.
 */
export function featureStats(rows, count = FEATURE_COUNT) {
  const n = rows.length / count;
  const mean = new Float64Array(count);
  const sd = new Float64Array(count);
  for (let i = 0; i < n; i++) for (let f = 0; f < count; f++) mean[f] += rows[i * count + f];
  for (let f = 0; f < count; f++) mean[f] /= n || 1;
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < count; f++) {
      const d = rows[i * count + f] - mean[f];
      sd[f] += d * d;
    }
  }
  /* A constant column has no spread; dividing by it would be a division by
     zero, and leaving it at 1 simply makes it a constant the model can use. */
  for (let f = 0; f < count; f++) sd[f] = Math.sqrt(sd[f] / (n || 1)) || 1;
  return { mean, sd };
}

/** Apply stats in place. Same function at training and prediction, on purpose. */
export function standardise(rows, { mean, sd }, count = FEATURE_COUNT) {
  const n = rows.length / count;
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < count; f++) {
      rows[i * count + f] = (rows[i * count + f] - mean[f]) / sd[f];
    }
  }
  return rows;
}
