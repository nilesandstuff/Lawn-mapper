/**
 * The trained head, forward pass only.
 *
 * IN public/lib BECAUSE THE BROWSER AND THE SCORER MUST AGREE. The training
 * tool measures a model against approved lawns and reports a percentage; dev
 * mode then draws that same model over a live photograph. If those two ran
 * different arithmetic the picture on screen would not be the thing the number
 * described, and the number is the only reason to trust the picture.
 *
 * Training stays in tools/ -- it runs once, in CI, and the browser has no use
 * for it.
 */

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Probability of lawn for every row in `x`. */
export function predict(model, x) {
  const { W1, b1, W2, b2, hidden, inputs } = model;
  const n = x.length / inputs;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const off = i * inputs;
    let z2 = b2;
    for (let u = 0; u < hidden; u++) {
      let z = b1[u];
      for (let f = 0; f < inputs; f++) z += W1[u * inputs + f] * x[off + f];
      if (z > 0) z2 += W2[u] * z;            // ReLU, folded into the sum
    }
    out[i] = sigmoid(z2);
  }
  return out;
}

/**
 * A model as it comes back from JSON: plain arrays, revived as typed ones.
 *
 * The weights are shipped as JSON so the file is readable and diffable -- a
 * few hundred numbers, not a binary blob nobody can inspect.
 */
export function reviveModel(json) {
  if (!json || !Array.isArray(json.W1)) return null;
  return {
    W1: Float64Array.from(json.W1),
    b1: Float64Array.from(json.b1),
    W2: Float64Array.from(json.W2),
    b2: json.b2,
    hidden: json.hidden,
    inputs: json.inputs,
    mean: Float64Array.from(json.mean),
    sd: Float64Array.from(json.sd),
    trainedOn: json.trainedOn,
    scoredAt: json.scoredAt,
    errorPct: json.errorPct,
  };
}
