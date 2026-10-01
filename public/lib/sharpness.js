/**
 * HOW SHARP A PHOTO IS, comparable between two photos of the same frame at
 * the same pixel size. Moved here from tools/probe-resolution.js (where H20
 * and H62 measured with it) so the editor can ask the same question of a
 * county photo before making it the default: some county services list 6 cm
 * and serve something far softer (New Jersey's 2020 orthos, 2026-10-01).
 */

/**
 * How much of an image is finer than half its size could hold.
 *
 * Shrink by two, blow back up, and see what is left over. The leftover is
 * detail that only exists at this size. Reported as a share of the image's own
 * overall variation, so a dark frame and a bright one are comparable.
 *
 * Measured on the green channel alone. Satellite imagery is heavily correlated
 * across channels, so three would be three views of one number, and green
 * carries the most signal in vegetation -- which is most of what is here.
 *
 * Sampled on a centre crop. The edges of a static frame can carry compression
 * artefacts and a faint vignette; neither is the ground, and both would answer
 * a question about texture with a fact about the encoder.
 */
export function extraDetail(pixels, width, height, channels) {
  const x0 = Math.floor(width / 4) & ~1;
  const x1 = Math.floor((width * 3) / 4) & ~1;
  const y0 = Math.floor(height / 4) & ~1;
  const y1 = Math.floor((height * 3) / 4) & ~1;
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return null;

  const at = (x, y) => pixels[((y0 + y) * width + (x0 + x)) * channels + 1];

  /* Shrink by two: a box average, which is what any honest downsample does. */
  const hw = w >> 1, hh = h >> 1;
  const small = new Float64Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      small[y * hw + x] = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y)
        + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4;
    }
  }

  /* And back up, bilinear, which is what any honest upsample does. */
  let residual = 0, signal = 0, mean = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { mean += at(x, y); n++; }
  }
  mean /= n;

  for (let y = 0; y < h; y++) {
    const sy = Math.min(hh - 1, Math.max(0, y / 2 - 0.25));
    const y0i = Math.floor(sy), y1i = Math.min(hh - 1, y0i + 1), fy = sy - y0i;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(hw - 1, Math.max(0, x / 2 - 0.25));
      const x0i = Math.floor(sx), x1i = Math.min(hw - 1, x0i + 1), fx = sx - x0i;
      const v = small[y0i * hw + x0i] * (1 - fx) * (1 - fy)
        + small[y0i * hw + x1i] * fx * (1 - fy)
        + small[y1i * hw + x0i] * (1 - fx) * fy
        + small[y1i * hw + x1i] * fx * fy;
      residual += Math.abs(at(x, y) - v);
      signal += Math.abs(at(x, y) - mean);
    }
  }
  if (!signal) return null;
  return { extra: residual / signal, residual: residual / n };
}
