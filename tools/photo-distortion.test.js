// tools/photo-distortion.js residualField: a pure scale reads as a stretch, a pure shift as none.
import assert from 'node:assert/strict';
import { residualField } from './photo-distortion.js';

const cell = 0.2, w = 200, h = 200; // a 40 m frame
const grid = [];
for (let y = 10; y < h; y += 20) for (let x = 10; x < w; x += 20) grid.push([x, y]);

{
  // one shift of 5 cells east, 2 south: no field
  const f = residualField(grid.map(([x, y]) => ({ x, y, dx: 5, dy: 2, inlier: true })), cell, w, h);
  assert.equal(f.patches, grid.length);
  assert.ok(Math.abs(f.shiftM[0] - 1) < 1e-9 && Math.abs(f.shiftM[1] + 0.4) < 1e-9);
  assert.ok(Math.abs(f.stretchEW) < 1e-9 && Math.abs(f.stretchNS) < 1e-9 && f.sideToSideM < 1e-9 && f.offShare === 0);
}
{
  // the other photo 2% bigger about the centre: dx = 0.02 (x - 100), dy = 0.02 (y - 100)
  const f = residualField(grid.map(([x, y]) => ({ x, y, dx: 0.02 * (x - 100), dy: 0.02 * (y - 100), inlier: true })), cell, w, h);
  assert.ok(Math.abs(f.stretchEW - 0.02) < 1e-6, `EW ${f.stretchEW}`);
  assert.ok(Math.abs(f.stretchNS - 0.02) < 1e-6, `NS ${f.stretchNS}`); // north third sits further north (dy more negative) than the south
  assert.ok(Math.abs(f.skewEN) < 1e-6 && Math.abs(f.skewNE) < 1e-6);
  assert.ok(f.sideToSideM > 0.5 && f.sideToSideM < 0.6, `side to side ${f.sideToSideM}`); // 2% of 26.7 m between the thirds' centres
  assert.ok(f.offShare > 0.3, 'the corners are off by more than 0.3 m');
}
{
  // outliers do not count; too few inliers gives no field
  const f = residualField([{ x: 1, y: 1, dx: 9, dy: 9, inlier: false }, { x: 2, y: 2, dx: 0, dy: 0, inlier: true }], cell, w, h);
  assert.equal(f.patches, 1);
  assert.equal(f.sideToSideM, undefined);
}
console.log('photo-distortion: ok');
