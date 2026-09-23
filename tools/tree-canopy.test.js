/**
 * The two arithmetic steps between a canopy patch and a picture.
 *
 * WHY THIS FILE EXISTS. The drawing half of workflow 19 has now broken twice,
 * both times eight seconds after a seventeen-minute segmentation step it then
 * threw away, and neither break was in the interesting part. The first was
 * `rasterizePolygon` called with the wrong argument list; the second was the
 * step that was supposed to save the work refusing a colon in a file name.
 * Both were cheap to test and expensive to discover.
 *
 * So the pure arithmetic is tested here, where it costs nothing: does a clump
 * land where it is supposed to land, and is the one number the whole run
 * reports actually measuring what its name says.
 */

import assert from 'node:assert/strict';

import { toGrid, overlap } from './tree-canopy.js';
import { drawPrediction } from './render-prediction.js';
import { GRID } from './train-detector.js';

const square = (x0, y0, side) => [
  [x0, y0], [x0 + side, y0], [x0 + side, y0 + side], [x0, y0 + side], [x0, y0],
];

/** A mask with one axis-aligned block set, in grid pixels. */
const block = (x0, y0, w, h) => {
  const m = new Uint8Array(GRID * GRID);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) m[y * GRID + x] = 1;
  }
  return m;
};

/* ------------------------------------------------------- the scale factor */

{
  /* A clump found in a 1024-wide frame has to arrive in the 512 grid the
     renderer and every mask work in. Half the numbers, or the clumps sit in
     the top-left quarter of every picture -- which would look like the model
     failing rather than like a forgotten division. */
  const ring = toGrid(square(100, 200, 40), 1024);
  assert.deepEqual(ring[0], [50, 100]);
  assert.deepEqual(ring[2], [70, 120]);

  /* A frame already at grid size is left alone. */
  assert.deepEqual(toGrid(square(10, 10, 5), GRID)[0], [10, 10]);
}

/* ------------------------------------------- the number the run is reporting */

{
  /* A 20-pixel clump, whole, on ground nobody traced as lawn. The area is the
     rasteriser's business; what matters here is that none of it counts as
     on-lawn, because that is the reading "this toggle should start OFF". */
  const empty = new Uint8Array(GRID * GRID);
  const off = overlap(square(40, 40, 20), empty, null);
  assert.equal(off.area, 400, 'a 20x20 ring is 400 pixels');
  assert.equal(off.onLawn, 0);
  assert.equal(off.inside, 400, 'no property line means everything is inside');
}

{
  /* The same clump sitting entirely inside traced lawn: a toggle that should
     start ON, and the run should say so at 100%. */
  const truth = block(30, 30, 60, 60);
  const on = overlap(square(40, 40, 20), truth, null);
  assert.equal(on.area, 400);
  assert.equal(on.onLawn, 400);
}

{
  /* Half on, half off -- a clump on the boundary of the traced lawn. This is
     the case the end of the log warns about: if every lawn reads like this the
     clumps are not lining up with anybody's judgement. The test is that the
     arithmetic can express it, not that it is good news. */
  const truth = block(0, 0, 50, GRID);
  const straddle = overlap(square(40, 40, 20), truth, null);
  assert.equal(straddle.area, 400);
  assert.equal(straddle.onLawn, 200, 'ten of twenty columns are traced lawn');
}

{
  /* The property line is counted separately from the traced lawn, because a
     clump outside the parcel is not the tracer declining it -- it is somebody
     else's tree, and lumping the two together would read as a judgement that
     was never made. */
  const truth = new Uint8Array(GRID * GRID);
  const within = block(0, 0, 50, GRID);
  const o = overlap(square(40, 40, 20), truth, within);
  assert.equal(o.area, 400);
  assert.equal(o.inside, 200);
  assert.equal(o.onLawn, 0);
}

/* ------------------------------- the two pictures have to agree on the clip */

{
  /*
   * THE BUG THIS PINS, found by looking at the pictures rather than at the
   * code. The canopy mask was clipped to the property line while the clump
   * outlines over it were not, so the canopy appeared to stop dead at a
   * boundary the clumps carried on past. It reads as the mask being truncated,
   * which is exactly what it was.
   *
   * A clump ring is never clipped -- it comes straight from the watershed --
   * so the canopy under it must not be either. The rule is that the two
   * pictures are clipped the same way or neither is trustworthy.
   */
  const G = 64;
  const photo = new Uint8Array(G * G * 4).fill(100);
  for (let i = 3; i < photo.length; i += 4) photo[i] = 255;
  const truth = new Uint8Array(G * G);

  /* A property line down the middle, and canopy on both sides of it. */
  const within = new Uint8Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G / 2; x++) within[y * G + x] = 1;
  const canopy = new Uint8Array(G * G);
  for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) canopy[y * G + x] = 1;

  /*
   * AGAINST A BASELINE, not against the flat photograph. Everything beyond the
   * property line is DIMMED before anything is drawn on it, so "this pixel is
   * not 100 any more" is true of the whole outside half whether a mask was
   * painted there or not -- which is what the first version of this test
   * counted, and it failed on the correct behaviour.
   */
  const base = drawPrediction({ photo, truth, within, rings: [], grid: G });
  const painted = (out, from, to) => {
    let n = 0;
    for (let y = 20; y < 44; y++) {
      for (let x = from; x < to; x++) {
        const p = (y * G + x) * 4;
        if (out[p] !== base[p] || out[p + 1] !== base[p + 1] || out[p + 2] !== base[p + 2]) n++;
      }
    }
    return n;
  };

  const clipped = drawPrediction({ photo, truth, within, mask: canopy, grid: G });
  const whole = drawPrediction({
    photo, truth, within, mask: canopy, grid: G, clipMask: false,
  });

  assert.ok(painted(clipped, 20, 32) > 0, 'the default still paints inside the line');
  assert.ok(painted(whole, 20, 32) > 0, 'and so does the unclipped one');

  /*
   * NOT ZERO BEYOND THE LINE, and the reason is worth writing down rather than
   * loosening the number until it passes. The clipped mask gets a SOLID
   * boundary drawn round it so a stipple has an edge to read, and that outline
   * is stamped as a 3x3 blob per cell -- so it lands one pixel past the clip
   * it is tracing. One column of a 24-row shape is 24 pixels, which is what
   * this measures, and it is thickness rather than leakage.
   *
   * The distinction the test is really making is the one the bug got wrong:
   * clipped shows a sliver beyond the line, unclipped shows the whole canopy.
   */
  const bleed = painted(clipped, 32, 44);
  const full = painted(whole, 32, 44);
  assert.ok(bleed <= 2 * 24, `clipped should only bleed the outline's width, got ${bleed}`);
  assert.ok(full > 4 * bleed,
    `clipMask:false should paint the whole canopy beyond the line, got ${full} vs ${bleed}`);
  /* Roughly as much canopy outside as in, for a blob straddling the line
     evenly -- which is the shape of the thing that was being hidden. */
  assert.ok(full > 0.5 * painted(whole, 20, 32));

  /* Weaker outside than inside, so "found here" and "yours" stay distinct.
     Sampled on a pixel the stipple is guaranteed to hit: ((x>>1)+(y>>1))%2. */
  const shift = (x, y) => {
    const p = (y * G + x) * 4;
    /* How far the mask moved this pixel from where the dimming left it. */
    return Math.abs(whole[p] - base[p]) + Math.abs(whole[p + 2] - base[p + 2]);
  };
  const inX = 22, outX = 34, atY = 22;
  assert.equal(((inX >> 1) + (atY >> 1)) & 1, 0, 'the sample pixel is one the stipple paints');
  assert.equal(((outX >> 1) + (atY >> 1)) & 1, 0, 'and so is the one beyond the line');
  assert.ok(shift(outX, atY) > 0, 'beyond the line is painted at all');
  assert.ok(shift(inX, atY) > shift(outX, atY),
    'and painted more weakly than the ground somebody is actually measuring');
}

console.log('tree canopy: ok');
