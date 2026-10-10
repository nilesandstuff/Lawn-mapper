/**
 * A PHOTO MADE EASIER TO TRACE ON (owner, 2026-10-10: "increasing contrast,
 * saturation, sharpness, lightening shadows and decreasing highlights,
 * widening the spread of greens and browns").
 *
 * FOR THE EYE ONLY. The editor lays this over the frame; what is saved is the
 * outline on the ground, and the detector and training read the original
 * photo, so nothing here reaches a label or a model.
 *
 * In order, on RGBA pixels in place:
 *   1. a tone curve on brightness that lifts shadows and eases highlights,
 *      applied as one gain to all three channels so the colour stays put;
 *   2. greens pushed greener and browns browner (the gap between green and
 *      red widened), which is the line between dormant grass and dirt or
 *      leaf litter (H89: low lawn-to-surroundings contrast is what makes a
 *      lot hard);
 *   3. a little more saturation;
 *   4. a gentle sharpen on brightness, held to a few levels either way so it
 *      cannot draw the bright and dark halos a person would trace instead of
 *      the edge.
 */

export const DEFAULTS = {
  lift: 0.75, ease: 0.4, stretch: 0.35, saturation: 1.06,
  clarity: 0.45, clarityRadius: 5, clarityCap: 16,
  sharpen: 0.6, sharpenCap: 8, maxGain: 2.2,
};

/** The tone curve, 0..1 to 0..1: fixed ends, shadows up, highlights a touch down, never decreasing. */
export function curve(x, { lift = DEFAULTS.lift, ease = DEFAULTS.ease } = {}) {
  return x + lift * x * (1 - x) * (1 - x) - ease * x * x * (1 - x);
}

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
/* Clamped here, not by the array: a plain byte array wraps 256 to 0 and draws
   coloured specks on white (it did, in the first try on a Buffer). */
const c8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
/* 1 below a, 0 above b, smooth between: colour pushes fade out near white,
   where one channel clipping first is what drew coloured specks on white
   railings in the first try. */
const fadeAbove = (v, a, b) => (v <= a ? 1 : v >= b ? 0 : 1 - ((v - a) / (b - a)) ** 2 * (3 - 2 * (v - a) / (b - a)));

/** Box average of `y` over a (2r+1)^2 square, by a summed-area table. */
function boxMean(y, w, h, r) {
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let yy = 0; yy < h; yy++) {
    let row = 0;
    for (let xx = 0; xx < w; xx++) {
      row += y[yy * w + xx];
      sat[(yy + 1) * W + xx + 1] = sat[yy * W + xx + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let yy = 0; yy < h; yy++) {
    const y0 = Math.max(0, yy - r), y1 = Math.min(h, yy + r + 1);
    for (let xx = 0; xx < w; xx++) {
      const x0 = Math.max(0, xx - r), x1 = Math.min(w, xx + r + 1);
      const sum = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
      out[yy * w + xx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/* Brightness moved by `s` levels as one gain on all three channels, so the
   colour stays the colour. */
function nudge(data, i, Y, s) {
  if (!s || Y < 1) return;
  const k = Math.max(0, (Y + s) / Y);
  data[i] = c8(data[i] * k); data[i + 1] = c8(data[i + 1] * k); data[i + 2] = c8(data[i + 2] * k);
}

export function enhance(data, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = w * h;
  for (let i = 0; i < n * 4; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    /* 1. Tone, as a gain on brightness. */
    const Y = luma(r, g, b) / 255;
    if (Y > 0.004) {
      const gain = Math.min(o.maxGain, curve(Y, o) / Y);
      r *= gain; g *= gain; b *= gain;
    }
    const keep = fadeAbove(luma(r, g, b) / 255, 0.78, 0.97);
    /* 2. Green away from red. */
    const d = (g - r) * o.stretch * 0.5 * keep;
    g += d; r -= d;
    /* 3. Saturation about brightness. */
    const L = luma(r, g, b);
    const sat = 1 + (o.saturation - 1) * keep;
    data[i] = c8(L + sat * (r - L));
    data[i + 1] = c8(L + sat * (g - L));
    data[i + 2] = c8(L + sat * (b - L));
  }
  /* 4. Clarity, then sharpen: brightness against a wide and a 3 x 3 average,
     each capped, each as a gain. */
  for (const [amount, radius, cap] of [[o.clarity, o.clarityRadius, o.clarityCap], [o.sharpen, 1, o.sharpenCap]]) {
    if (!(amount > 0) || w <= 2 * radius || h <= 2 * radius) continue;
    const y = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) y[p] = luma(data[i], data[i + 1], data[i + 2]);
    const avg = boxMean(y, w, h, radius);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      nudge(data, i, y[p], Math.max(-cap, Math.min(cap, amount * (y[p] - avg[p]))));
    }
  }
  return data;
}
