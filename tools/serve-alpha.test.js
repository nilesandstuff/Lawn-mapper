/**
 * tools/serve-alpha.mjs: the live server's JavaScript half gives the same
 * answer the scorer would, on the same grid.
 */
import assert from 'node:assert/strict';

import { gridDims, predictionMask, lidarVeto } from './train-detector.js';
import { stage3 } from './stage3.js';
import { STAGE3, finishLot, prepareFrame, uncertaintyOf, parcelMask } from './serve-alpha.mjs';

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
