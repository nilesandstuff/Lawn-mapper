/**
 * The measure behind workflow 20's verdict, against images whose answer is
 * already known.
 *
 * WHY THIS FILE EXISTS. The first version of that measure would have given the
 * wrong verdict, and nothing in the code would have said so. It compared
 * neighbouring pixels with pixels two apart, on the reasoning that an upscale
 * is smooth between its samples. It is -- but a clean 2x upscale scores 0.667
 * there rather than the 0.5 the reasoning predicts, and a GENUINELY SMOOTH
 * field scores 0.5, LOWER than the upscale. So the number ranked flat grass as
 * more suspicious than invented pixels, which is the opposite of its job.
 *
 * That was caught by running it on made-up images with known answers, which is
 * the only reason this file exists. The thresholds in probe-resolution.js are
 * read off these numbers rather than chosen.
 */

import assert from 'node:assert/strict';

import { extraDetail, verdictFor } from './probe-resolution.js';

const W = 256;
const C = 4;

/** An image, green channel only, from a function of x and y. */
const make = (fn) => {
  const p = new Uint8Array(W * W * C);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      p[(y * W + x) * C + 1] = Math.max(0, Math.min(255, Math.round(fn(x, y))));
    }
  }
  return p;
};

/* A repeatable pseudo-random source, so a failure is the same failure twice. */
const source = () => {
  let seed = 1;
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
};

/* ------------------------------------------------------- the four cases */

/** Real texture: every pixel independent, which is as detailed as it gets. */
const rnd1 = source();
const native = make(() => rnd1() * 255);

/**
 * THE SAME CONTENT at half the resolution, blown back up. This is exactly what
 * a provider does when asked for a zoom it does not hold, and it is the case
 * the whole workflow exists to detect.
 */
const rnd2 = source();
const half = [];
for (let i = 0; i < (W / 2) * (W / 2); i++) half.push(rnd2() * 255);
const upscaled = make((x, y) => {
  const hx = x / 2 - 0.25;
  const hy = y / 2 - 0.25;
  const x0 = Math.max(0, Math.min(W / 2 - 1, Math.floor(hx)));
  const y0 = Math.max(0, Math.min(W / 2 - 1, Math.floor(hy)));
  const x1 = Math.min(W / 2 - 1, x0 + 1);
  const y1 = Math.min(W / 2 - 1, y0 + 1);
  const fx = Math.max(0, hx - x0);
  const fy = Math.max(0, hy - y0);
  return half[y0 * (W / 2) + x0] * (1 - fx) * (1 - fy)
    + half[y0 * (W / 2) + x1] * fx * (1 - fy)
    + half[y1 * (W / 2) + x0] * (1 - fx) * fy
    + half[y1 * (W / 2) + x1] * fx * fy;
});

/** Flat ground: a clean gradient, and slow blobs like an open field. */
const ramp = make((x, y) => (x + y) / 2);
const blobs = make((x, y) => 128 + 100 * Math.sin(x / 37) * Math.cos(y / 41));

const score = (img) => extraDetail(img, W, W, C).extra;

/* ------------------------------------------------------- what it must do */

{
  const a = score(native);
  const b = score(upscaled);
  assert.ok(a > 0.6, `real texture should score high, got ${a.toFixed(3)}`);
  assert.ok(b < 0.5, `an upscale should score low, got ${b.toFixed(3)}`);
  /* The ratio is what the verdict is built on: an upscale keeps about 40% of
     what native keeps, so the workflow's 0.5 line sits between them. */
  const keeps = b / a;
  assert.ok(keeps < 0.5,
    `an upscale should keep under half of native, kept ${(100 * keeps).toFixed(0)}%`);
}

{
  /*
   * THE CASE THE FIRST VERSION GOT BACKWARDS. Smooth ground must not look
   * like an upscale -- and here it does not merely differ, it scores far
   * LOWER, which is the right answer: a flat field has nothing above half
   * resolution to lose, so a bigger request genuinely buys nothing on it.
   */
  const flat = Math.max(score(ramp), score(blobs));
  assert.ok(flat < 0.05, `smooth ground should score near zero, got ${flat.toFixed(3)}`);
  assert.ok(flat < score(upscaled),
    'smooth ground must not out-score an upscale, or the number is backwards');
}

{
  /* And the workflow refuses to rule on a featureless pair rather than
     dividing two tiny numbers and reporting the noise as a verdict. */
  assert.ok(score(ramp) < 0.05 && score(blobs) < 0.05,
    'both smooth cases must fall under the "cannot tell" floor of 0.05');
}

/* ------------------------------------------- the labelling, with no network */

{
  /*
   * BOTH OF THIS FILE'S CI FAILURES WERE HERE, not in the arithmetic: once a
   * field renamed in one place and not the other, once an undefined spread.
   * Neither needed Mapbox to catch and both cost a round trip. So the labels
   * are a pure function now and this is what covers them.
   */
  const v = (a, b) => verdictFor(a, b).verdict;

  assert.equal(v(0.80, 0.75), 'real detail', 'as sharp per pixel at both sizes');
  assert.equal(v(0.80, 0.30), 'UPSCALED', 'the bigger frame keeps well under half');
  assert.equal(v(0.80, 0.50), 'partly real', 'between the two lines');

  /* Flat ground is refused rather than ruled on. Both numbers are tiny, so
     their ratio is noise -- and a lawn of open grass would otherwise be
     reported as a confident verdict about Mapbox. */
  assert.equal(v(0.01, 0.005), 'flat, cannot tell');
  assert.equal(v(0.04, 0.049), 'flat, cannot tell', 'just under the floor is still refused');

  /* And a zero denominator does not become NaN and slip through as a verdict. */
  assert.equal(v(0, 0.4), 'UPSCALED');
  assert.equal(verdictFor(0, 0.4).keeps, 0);

  /* The real numbers from the images above land where the thresholds say. */
  const realNative = score(native);
  const anUpscale = score(upscaled);
  assert.equal(v(realNative, anUpscale), 'UPSCALED',
    'the measured upscale must be labelled as one, or the thresholds are wrong');
  assert.equal(v(realNative, realNative), 'real detail');
}

console.log('resolution probe: ok');
