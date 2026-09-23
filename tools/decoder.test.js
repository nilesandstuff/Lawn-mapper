/**
 * The two pictures that carry a lawn between Node and the decoder.
 *
 * WHAT THIS GUARDS. The decoder trains on labels Node writes and Node scores
 * answers the decoder writes; both cross as PNGs. A channel swapped, a
 * threshold off by one or a picture the wrong size would not fail -- it would
 * train the decoder on the property line instead of the lawn, or score a
 * resampled answer against the wrong cells -- so both directions are checked
 * byte for byte here, and a wrong-sized answer is refused rather than
 * stretched.
 *
 *   node tools/decoder.test.js
 */

import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { labelsPng, predictionMask } from './train-detector.js';

/* ------------------------------------------------------------- labels */
{
  const G = 6, GH = 4;
  const truth = new Uint8Array(G * GH);
  const within = new Uint8Array(G * GH);
  const inferred = new Uint8Array(G * GH);
  truth[0] = 1; truth[7] = 1; truth[23] = 1;
  for (let i = 0; i < G * GH; i++) within[i] = i % G < 4 ? 1 : 0;
  inferred[7] = 1;

  const png = PNG.sync.read(labelsPng({ grid: G, gridH: GH, truth, within, inferred }, PNG));
  assert.equal(png.width, G);
  assert.equal(png.height, GH);
  for (let i = 0; i < G * GH; i++) {
    assert.equal(png.data[i * 4], truth[i] ? 255 : 0, `red at ${i} is the lawn`);
    assert.equal(png.data[i * 4 + 1], within[i] ? 255 : 0, `green at ${i} is the line`);
    assert.equal(png.data[i * 4 + 2], inferred[i] ? 255 : 0, `blue at ${i} is inferred`);
    assert.equal(png.data[i * 4 + 3], 255);
  }

  /* No property line means everything is inside it; nothing marked means
     nothing is inferred. Both must be explicit colours, not missing ones. */
  const bare = PNG.sync.read(labelsPng({ grid: G, gridH: GH, truth, within: null, inferred: null }, PNG));
  for (let i = 0; i < G * GH; i++) {
    assert.equal(bare.data[i * 4 + 1], 255);
    assert.equal(bare.data[i * 4 + 2], 0);
  }

  /* A square lawn with no gridH still writes a square. */
  const sq = PNG.sync.read(labelsPng({ grid: 5, truth: new Uint8Array(25), within: null, inferred: null }, PNG));
  assert.equal(sq.width, 5);
  assert.equal(sq.height, 5);
}

/* -------------------------------------------------------------- answers */
{
  const G = 5, GH = 3;
  const png = new PNG({ width: G, height: GH });
  const probs = [0, 60, 127, 128, 255, 200, 1, 254, 127, 128, 0, 0, 255, 255, 129];
  for (let i = 0; i < G * GH; i++) {
    png.data[i * 4] = probs[i];
    png.data[i * 4 + 1] = probs[i];
    png.data[i * 4 + 2] = probs[i];
    png.data[i * 4 + 3] = 255;
  }
  const bytes = PNG.sync.write(png);
  const got = predictionMask(PNG.sync.read(bytes), G, GH);
  assert.equal(got.length, G * GH);
  for (let i = 0; i < G * GH; i++) {
    assert.equal(got[i], probs[i] >= 128 ? 1 : 0, `cell ${i} at ${probs[i]} cut at the middle`);
  }

  /* A greyscale PNG, which is what Pillow writes for mode "L", reads the
     same: pngjs expands it to RGBA. */
  const grey = new PNG({ width: G, height: GH, colorType: 0, inputColorType: 0, inputHasAlpha: false, bitDepth: 8 });
  grey.data = Buffer.from(probs);
  const greyBytes = PNG.sync.write(grey, { colorType: 0, inputColorType: 0, inputHasAlpha: false });
  const fromGrey = predictionMask(PNG.sync.read(greyBytes), G, GH);
  assert.deepEqual([...fromGrey], [...got]);

  /* The wrong size is refused, not resampled. */
  assert.equal(predictionMask(PNG.sync.read(bytes), G, GH + 1), null);
  assert.equal(predictionMask(PNG.sync.read(bytes), G + 1, GH), null);
  assert.equal(predictionMask(null, G, GH), null);
}

console.log('decoder: ok');
