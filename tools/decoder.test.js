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
import { findPlanRow, labelsPng, predictionMask } from './train-detector.js';

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

/* --------------------------------------------------------------- canopy */
{
  const { canopyMask, heightMask, lidarVeto } = await import('./train-detector.js');
  /* A 4 x 2 mask with its right half lit, brought to an 8 x 4 grid: the
     right half of every row is canopy, and nothing else is. */
  const png = new PNG({ width: 4, height: 2 });
  for (let i = 0; i < 8; i++) {
    const on = i % 4 >= 2 ? 255 : 0;
    png.data[i * 4] = on; png.data[i * 4 + 1] = on; png.data[i * 4 + 2] = on; png.data[i * 4 + 3] = 255;
  }
  const m = canopyMask(PNG.sync.read(PNG.sync.write(png)), 8, 4);
  assert.equal(m.length, 32);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) assert.equal(m[y * 8 + x], x >= 4 ? 1 : 0, `cell ${x},${y}`);
  }
  /* And a 1-BIT PNG, which is what tree-canopy.py writes (Pillow mode "1"),
     reads the same. pngjs cannot write one, so this is a real one, the
     same 4 x 2 picture written by Pillow. */
  const oneBit = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACAQAAAABX00DOAAAADElEQVR4nGMwYGIAAACYADMvBHgeAAAAAElFTkSuQmCC',
    'base64',
  );
  const read = PNG.sync.read(oneBit);
  assert.equal(read.width, 4);
  assert.equal(read.height, 2);
  const m2 = canopyMask(read, 8, 4);
  assert.deepEqual([...m2], [...m], 'a 1-bit mask must read the same as an 8-bit one');
  assert.equal(canopyMask(null, 8, 4), null);

  /* The lidar's height reads the same way, as metres: a tenth of a metre a
     byte, nearest onto the grid, so a 2 m reading is the reading of every
     15 cm cell under it. */
  const hp = new PNG({ width: 2, height: 1 });
  hp.data.set([37, 37, 37, 255, 120, 120, 120, 255]);
  const hm = heightMask(PNG.sync.read(PNG.sync.write(hp)), 4, 2);
  assert.deepEqual([...hm].map((v) => Number(v.toFixed(1))), [3.7, 3.7, 12, 12, 3.7, 3.7, 12, 12]);
  assert.equal(heightMask(null, 4, 2), null);

  /* The lidar veto (H38): roof or void is never lawn, and returns a copy. */
  const lawnIn = Uint8Array.from([1, 1, 1, 1, 0]);
  const vetoOut = lidarVeto(lawnIn, Uint8Array.from([1, 0, 0, 0, 1]), Uint8Array.from([0, 0, 1, 0, 0]));
  assert.deepEqual([...vetoOut], [0, 1, 0, 1, 0]);
  assert.deepEqual([...lawnIn], [1, 1, 1, 1, 0], 'the veto must not change stage 3\'s own mask');
  assert.equal(lidarVeto(lawnIn, null, null), lawnIn, 'no point cloud, no veto');
  assert.deepEqual([...lidarVeto(lawnIn, null, Uint8Array.from([0, 1, 0, 0, 0]))], [1, 0, 1, 1, 0]);
}

/*
 * THE PLAN'S ROW WHEN A RUN SCORED BOTH DECODERS (2026-09-29): the plain
 * decoder is scored first, and "the first row that could be THE PLAN's"
 * drew it -- with the edge refiner's layers empty.
 */
{
  const row = (name) => ({ cfg: { name } });
  const plain = row('the pretrained eye, decoder + stage 3, span, lidar veto');
  const refined = row('decoder, edge refined + stage 3, span, lidar veto');
  assert.equal(findPlanRow([plain, refined]), refined, 'both scored: the refined row is drawn');
  assert.equal(findPlanRow([plain]), plain, 'only the plain decoder: it stands in');
  assert.equal(findPlanRow([row('both')]), undefined, 'neither: nothing');
}

console.log('decoder: ok');
