// tools/lidar-photo.js: the frame built from a box covers exactly that box, and the quarters read as a stretch.
import assert from 'node:assert/strict';
import { frameOfBox, quarterPattern } from './lidar-photo.js';
import { gridForFrame, gridBox } from '../public/shade/grid.js';

{
  const box = [-9500000, 5100000, -9499880, 5100090]; // 120 x 90 m of web mercator
  const f = frameOfBox(box, 1280, 960);
  const back = gridBox(gridForFrame(f, 1280, 960));
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(back[i] - box[i]) < 0.01, `box edge ${i}: ${back[i]} vs ${box[i]}`);
  assert.equal(f.height, 960);
}
{
  // NW, NE, SW, SE: the east half moved 0.4 m further east than the west half over a 40 m frame (half-spacing 20 m) = 2%
  const fit = { quarters: [{ east: 1.0, north: 0.2, score: 0.5 }, { east: 1.4, north: 0.2, score: 0.5 }, { east: 1.0, north: 0.0, score: 0.5 }, { east: 1.4, north: 0.0, score: 0.5 }] };
  const p = quarterPattern(fit, 40, 40);
  assert.equal(p.quartersOk, 4);
  assert.ok(Math.abs(p.stretchEW - 0.02) < 1e-9, `EW ${p.stretchEW}`);
  assert.ok(Math.abs(p.stretchNS - 0.01) < 1e-9, `NS ${p.stretchNS}`); // north half 0.2 m further north than the south half
  assert.ok(Math.abs(p.quartersApartMaxM - Math.hypot(0.4, 0.2)) < 1e-9);
  // a quarter that could not match is left out
  const p2 = quarterPattern({ quarters: [null, { east: 1, north: 0, score: 0.5 }, { east: 1, north: 0, score: 0.05 }, { east: 1.2, north: 0, score: 0.5 }] }, 40, 40);
  assert.equal(p2.quartersOk, 2);
  assert.ok(Number.isNaN(p2.stretchEW), 'no west quarter to compare with');
  assert.equal(p2.stretchNS, 0); // NE and SE agree north-south
}
console.log('lidar-photo: ok');
