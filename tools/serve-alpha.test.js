/**
 * tools/serve-alpha.mjs: the live server's JavaScript half gives the same
 * answer the scorer would, on the same grid.
 */
import assert from 'node:assert/strict';

import { gridDims, predictionMask, lidarVeto } from './train-detector.js';
import { stage3 } from './stage3.js';
import { STAGE3, SEE_THROUGH, finishLot, prepareFrame, uncertaintyOf, parcelMask } from './serve-alpha.mjs';
import { photoLooksLeafOff } from '../public/lib/finish.js';

const pngOf = (w, h, fill) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = fill(i % w, Math.floor(i / w));
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
};

/* The grid is the scorer's own. */
{
  const frame = { lng: -85.6681, lat: 42.9634, zoom: 19.2, size: 1280, height: 900 };
  const p = prepareFrame(frame);
  const g = gridDims(frame);
  assert.equal(p.w, g.w);
  assert.equal(p.h, g.h);
  assert.ok(Math.abs(p.span - p.mpp * p.w) < 1e-9, 'span is the grid times the cell');
  assert.ok(Math.abs(p.down / p.span - 900 / 1280) < 1e-9, 'a rectangle keeps its shape');
  assert.equal(p.bbox.length, 4);
  assert.ok(p.bbox[2] > p.bbox[0] && p.bbox[3] > p.bbox[1]);
}

/* The final mask is predictionMask -> stage 3 -> lidar veto, as scored. */
{
  const w = 64;
  const h = 48;
  const prob = pngOf(w, h, (x) => (x < 20 || x > 40 ? 230 : 10));      // lawn both sides of a strip
  const canopy = pngOf(w * 2, h * 2, (x) => (x >= 40 && x <= 82 ? 255 : 0)); // a canopy over the strip
  const roof = pngOf(8, 6, (x, y) => (x === 7 && y === 5 ? 255 : 0));
  const got = finishLot({ prob, canopy, roof, voidMask: null, height: null, w, h, mpp: 0.15 });

  let want = predictionMask(prob, w, h);
  const can = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) can[y * w + x] = canopy.data[((y * 2) * w * 2 + x * 2) * 4] >= 128 ? 1 : 0;
  want = stage3(want, can, w, h, { mpp: 0.15, height: null, ...STAGE3 }).mask;
  const roofGrid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sy = Math.min(5, Math.floor((y * 6) / h));
    const sx = Math.min(7, Math.floor((x * 8) / w));
    roofGrid[y * w + x] = roof.data[(sy * 8 + sx) * 4] >= 128 ? 1 : 0;
  }
  want = lidarVeto(want, roofGrid, null);
  assert.deepEqual([...got], [...want]);
}

/* See-through canopy: 'small-100-leafoff' in serving since H127, and 'trust'
   keeps stage 1's lawn under the canopy instead of clearing it. */
{
  assert.equal(SEE_THROUGH, 'small-100-leafoff');
  const w = 64, h = 48;
  const prob = pngOf(w, h, () => 230);                                   // lawn everywhere
  const canopy = pngOf(w * 2, h * 2, (x) => (x >= 40 && x <= 82 ? 255 : 0));
  const lawnAt = (m) => m[10 * w + 30];
  const base = { prob, canopy, roof: null, voidMask: null, height: null, w, h, mpp: 0.15 };
  const trusted = finishLot({ ...base, seeThrough: 'trust' });
  assert.equal(lawnAt(trusted), 1, 'trust: stage 1 stands under the canopy');
  assert.equal(trusted.reduce((a, b) => a + b, 0), w * h);
}

/* H127, LIVE: under a small clump in the open, the detector's own answer
   stands only when the photo looks leaf-off. A bare crown here is grey (no
   green) and a leafy one green; the server's leafOff answer decides it the
   same way on the page, without the photo. */
{
  const w = 80, h = 60, mpp = 0.15;
  /* No lawn under the clump (decoder says 30% there), lawn everywhere else. */
  const inClump = (x, y) => x >= 30 && x < 50 && y >= 15 && y < 35;     // 3 m x 3 m: a small clump
  const prob = pngOf(w, h, (x, y) => (inClump(x, y) ? 77 : 230));
  /* The canopy is written at twice the grid; stage 3 would fill this
     clump with lawn (it is ringed by lawn), so trusting the detector shows. */
  const canopy = pngOf(w * 2, h * 2, (x, y) => (inClump(x >> 1, y >> 1) ? 255 : 0));
  const photoOf = (grey) => {
    const p = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let i = 0; i < w * h; i++) {
      const [r, g, b] = grey ? [120, 118, 112] : [40, 110, 35];
      p.data[i * 4] = r; p.data[i * 4 + 1] = g; p.data[i * 4 + 2] = b; p.data[i * 4 + 3] = 255;
    }
    return p;
  };
  const base = { prob, canopy, roof: null, voidMask: null, height: null, w, h, mpp };
  const at = (m) => m[25 * w + 40];
  const stage3Fills = finishLot({ ...base, seeThrough: 'off' });
  assert.equal(at(stage3Fills), 1, 'stage 3 calls the ringed clump lawn');
  assert.equal(photoLooksLeafOff({ canopy, photo: photoOf(true), w, h, mpp }), true, 'grey crowns: leaf-off');
  assert.equal(photoLooksLeafOff({ canopy, photo: photoOf(false), w, h, mpp }), false, 'green crowns: leaf-on');
  assert.equal(photoLooksLeafOff({ canopy, photo: null, w, h, mpp }), null, 'no photo, no answer');
  assert.equal(at(finishLot({ ...base, photo: photoOf(true) })), 0, 'leaf-off photo: the detector stands');
  assert.equal(at(finishLot({ ...base, photo: photoOf(false) })), 1, 'leaf-on photo: stage 3 as before');
  assert.equal(at(finishLot({ ...base, leafOff: true })), 0, 'the page: the server\'s leaf-off answer, no photo');
  assert.equal(at(finishLot({ ...base, leafOff: false, photo: photoOf(true) })), 1, 'and it overrides the photo');
  assert.equal(at(finishLot({ ...base })), 1, 'nothing to judge by: stage 3, as before');
}

/* Uncertainty: the share of cells neither clearly lawn nor clearly not. */
{
  const grey = Uint8Array.from([0, 255, 128, 100, 250, 5, 60, 200]);
  assert.equal(uncertaintyOf(grey, null), 4 / 8);
  assert.equal(uncertaintyOf(grey, Uint8Array.from([1, 1, 1, 0, 0, 0, 0, 0])), 1 / 3);
  assert.equal(uncertaintyOf(new Uint8Array(0), null), null);
}

/* A parcel becomes a mask on the grid; no parcel means the whole frame. */
{
  const frame = { lng: -85.6681, lat: 42.9634, zoom: 19, size: 640 };
  const d = 0.0001;
  const parcel = { type: 'Polygon', coordinates: [[[-85.6681 - d, 42.9634 - d], [-85.6681 + d, 42.9634 - d], [-85.6681 + d, 42.9634 + d], [-85.6681 - d, 42.9634 + d], [-85.6681 - d, 42.9634 - d]]] };
  const m = parcelMask(parcel, frame, 100, 100);
  assert.ok(m[50 * 100 + 50] && !m[0], 'the middle is in, the corner is out');
  assert.equal(parcelMask(null, frame, 100, 100), null);
  const multi = { type: 'MultiPolygon', coordinates: [parcel.coordinates] };
  assert.deepEqual([...parcelMask(multi, frame, 100, 100)], [...m], 'a one-part MultiPolygon is the same lot');
}

console.log('serve-alpha: ok');

/* The serving grid (S64): unasked, the training cap; asked, up to the limit. */
{
  const { prepareFrame: prep, serveCap, SERVE_GRID_MAX, SERVE_GRID_LIMIT } = await import('./serve-alpha.mjs');
  const big = { lng: -85.7, lat: 42.83, zoom: 18.6, size: 4096, height: 4096 };
  const plain = prep(big, { gridMax: 1024 });
  const fine = prep(big, { gridMax: 3072 });
  const unasked = prep(big);
  if (!(Math.max(unasked.w, unasked.h) <= SERVE_GRID_MAX)) throw new Error(`unasked grid ${unasked.w}x${unasked.h} is over the serving cap`);
  if (!(Math.max(fine.w, fine.h) > Math.max(plain.w, plain.h) && fine.mpp < plain.mpp)) throw new Error('a finer grid was asked for and not given');
  if (Math.abs(fine.span - plain.span) > 1e-6 * plain.span) throw new Error('the grid changed the ground it covers');
  if (serveCap(99999) !== SERVE_GRID_LIMIT || serveCap(10) !== 1024 || serveCap(undefined) !== SERVE_GRID_MAX) throw new Error('serveCap bounds');
  const small = { lng: -85.7, lat: 42.83, zoom: 21, size: 640 };
  if (JSON.stringify(prep(small)) !== JSON.stringify(prep(small, { gridMax: 3072 }))) throw new Error('a small lot must not change with the cap');
  console.log('serve grid: ok');
}
