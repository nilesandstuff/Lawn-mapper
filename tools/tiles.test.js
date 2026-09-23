/**
 * The paste that turns a tiled detection back into one mask.
 *
 * The Worker cuts a big lot into an n x n grid of pictures and the model
 * answers each; the browser pastes the answers at (col * w, row * h). What is
 * checked here is that a pixel lands where its piece says it does, in every
 * corner, and that a wrong-sized or missing piece is refused rather than
 * pasted somewhere plausible.
 *
 *   node tools/tiles.test.js
 */

import assert from 'node:assert/strict';
import { stitchMasks } from '../public/lib/tiles.js';

/* A w x h piece painted one flat colour, so its provenance is readable from
   any pixel of the stitch. */
const flat = (w, h, v) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
};

const px = (img, x, y) => img.data[(y * img.width + x) * 4];

{
  const out = stitchMasks([
    { col: 0, row: 0, image: flat(3, 2, 10) },
    { col: 1, row: 0, image: flat(3, 2, 20) },
    { col: 0, row: 1, image: flat(3, 2, 30) },
    { col: 1, row: 1, image: flat(3, 2, 40) },
  ], 2, 2);

  assert.equal(out.width, 6);
  assert.equal(out.height, 4);
  assert.equal(out.data.length, 6 * 4 * 4);

  /* Every pixel of every quadrant is its own piece's colour. */
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 6; x++) {
      const want = (y < 2 ? 10 : 30) + (x < 3 ? 0 : 10);
      assert.equal(px(out, x, y), want, `pixel ${x},${y}`);
    }
  }
  /* And the alpha survived the copy -- the binarizer treats transparent as
     background, so a lost alpha channel is a lost lawn. */
  assert.equal(out.data[3], 255);
  assert.equal(out.data[out.data.length - 1], 255);
}

{
  /* Order of arrival must not matter: predictions are polled in parallel. */
  const out = stitchMasks([
    { col: 1, row: 1, image: flat(2, 2, 40) },
    { col: 0, row: 0, image: flat(2, 2, 10) },
    { col: 1, row: 0, image: flat(2, 2, 20) },
    { col: 0, row: 1, image: flat(2, 2, 30) },
  ], 2, 2);
  assert.equal(px(out, 0, 0), 10);
  assert.equal(px(out, 3, 0), 20);
  assert.equal(px(out, 0, 3), 30);
  assert.equal(px(out, 3, 3), 40);
}

{
  /* One piece is a copy, not a special case. */
  const out = stitchMasks([{ col: 0, row: 0, image: flat(5, 5, 7) }], 1, 1);
  assert.equal(out.width, 5);
  assert.equal(px(out, 4, 4), 7);
}

{
  assert.throws(() => stitchMasks([
    { col: 0, row: 0, image: flat(2, 2, 1) },
    { col: 1, row: 0, image: flat(3, 2, 1) },
  ], 2, 1), /different sizes/);

  assert.throws(() => stitchMasks([
    { col: 0, row: 0, image: flat(2, 2, 1) },
  ], 2, 2), /Expected 4/);

  assert.throws(() => stitchMasks([
    { col: 0, row: 0, image: flat(2, 2, 1) },
    { col: 2, row: 0, image: flat(2, 2, 1) },
  ], 2, 1), /off the grid/);

  assert.throws(() => stitchMasks([], 1, 1), /No mask pieces/);
}

console.log('tiles: ok');
