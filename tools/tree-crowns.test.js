/**
 * The two arithmetic steps between a crown and a picture.
 *
 * WHY THIS FILE EXISTS. The drawing half of workflow 19 has now broken twice,
 * both times eight seconds after a seventeen-minute segmentation step it then
 * threw away, and neither break was in the interesting part. The first was
 * `rasterizePolygon` called with the wrong argument list; the second was the
 * step that was supposed to save the work refusing a colon in a file name.
 * Both were cheap to test and expensive to discover.
 *
 * So the pure arithmetic is tested here, where it costs nothing: does a crown
 * land where it is supposed to land, and is the one number the whole run
 * reports actually measuring what its name says.
 */

import assert from 'node:assert/strict';

import { toGrid, overlap } from './tree-crowns.js';
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
  /* A crown found in a 1024-wide frame has to arrive in the 512 grid the
     renderer and every mask work in. Half the numbers, or the crowns sit in
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
  /* A 20-pixel crown, whole, on ground nobody traced as lawn. The area is the
     rasteriser's business; what matters here is that none of it counts as
     on-lawn, because that is the reading "this toggle should start OFF". */
  const empty = new Uint8Array(GRID * GRID);
  const off = overlap(square(40, 40, 20), empty, null);
  assert.equal(off.area, 400, 'a 20x20 ring is 400 pixels');
  assert.equal(off.onLawn, 0);
  assert.equal(off.inside, 400, 'no property line means everything is inside');
}

{
  /* The same crown sitting entirely inside traced lawn: a toggle that should
     start ON, and the run should say so at 100%. */
  const truth = block(30, 30, 60, 60);
  const on = overlap(square(40, 40, 20), truth, null);
  assert.equal(on.area, 400);
  assert.equal(on.onLawn, 400);
}

{
  /* Half on, half off -- a crown on the boundary of the traced lawn. This is
     the case the end of the log warns about: if every lawn reads like this the
     crowns are not lining up with anybody's judgement. The test is that the
     arithmetic can express it, not that it is good news. */
  const truth = block(0, 0, 50, GRID);
  const straddle = overlap(square(40, 40, 20), truth, null);
  assert.equal(straddle.area, 400);
  assert.equal(straddle.onLawn, 200, 'ten of twenty columns are traced lawn');
}

{
  /* The property line is counted separately from the traced lawn, because a
     crown outside the parcel is not the tracer declining it -- it is somebody
     else's tree, and lumping the two together would read as a judgement that
     was never made. */
  const truth = new Uint8Array(GRID * GRID);
  const within = block(0, 0, 50, GRID);
  const o = overlap(square(40, 40, 20), truth, within);
  assert.equal(o.area, 400);
  assert.equal(o.inside, 200);
  assert.equal(o.onLawn, 0);
}

console.log('tree crowns: ok');
