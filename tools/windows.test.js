/**
 * That the head reads a windowed feature grid in register with the picture.
 *
 * tools/windows_test.py proves the Python side stitches patches where the
 * photograph has them, and records how far past the picture's edge the grid
 * runs (`cover`). This is the other half: that sampleAt honours the cover, so
 * a photograph pixel lands on its own patch. Without the division every
 * feature on a windowed lawn sits up and left of the ground it describes, by
 * more the further right it is -- a mis-registration that would never fail,
 * only train a slightly worse head.
 *
 *   node tools/windows.test.js
 */

import assert from 'node:assert/strict';
import { sampleAt } from './backbone.js';

/* A grid whose one feature is the column index, so what sampleAt returns says
   which patch it read. Twelve columns over a picture that is ten patches wide:
   the last two are padding, cover 1.2. */
const grid = (gridW, gridH, coverX, coverY) => {
  const data = new Float32Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) data[y * gridW + x] = x;
  return { data, gridW, gridH, dim: 1, coverX, coverY };
};

const GRID_PX = 512; // the head's pixel space, as in train-detector.js
const out = new Float32Array(1);

{
  const feat = grid(12, 12, 1.2, 1.2);
  /* A photograph pixel at fraction f of the width sits on patch f * 10 (ten
     real patches across); bilinear reading returns f * 10 - 0.5 between
     patch centres. */
  for (const f of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    sampleAt(feat, f * GRID_PX, 0, GRID_PX, out, 0);
    const want = Math.min(11, Math.max(0, f * 10 - 0.5));
    assert.ok(Math.abs(out[0] - want) < 1e-4,
      `at ${f} of the width: read patch ${out[0].toFixed(3)}, the picture is at ${want.toFixed(3)}`);
  }
  /* The right-hand edge of the PICTURE is the tenth patch, not the twelfth:
     the padding is never read. */
  sampleAt(feat, GRID_PX - 1e-6, 0, GRID_PX, out, 0);
  assert.ok(out[0] < 9.51 && out[0] > 9.49, `edge read patch ${out[0]}`);
}

{
  /* And a one-pass grid, with no cover recorded, reads exactly as before. */
  const feat = grid(10, 10, undefined, undefined);
  sampleAt(feat, 0.5 * GRID_PX, 0, GRID_PX, out, 0);
  assert.ok(Math.abs(out[0] - 4.5) < 1e-6, `no cover: ${out[0]}`);
  const withCover = grid(10, 10, 1, 1);
  sampleAt(withCover, 0.5 * GRID_PX, 0, GRID_PX, out, 0);
  assert.ok(Math.abs(out[0] - 4.5) < 1e-6, `cover 1: ${out[0]}`);
}

{
  /* Rows use their own cover; a non-square windowing must not leak across. */
  const feat = grid(12, 10, 1.2, 1);
  sampleAt(feat, 0.5 * GRID_PX, 0.5 * GRID_PX, GRID_PX, out, 0);
  assert.ok(Math.abs(out[0] - 4.5) < 1e-4, `x with cover: ${out[0]}`);
}

console.log('windows: ok');
