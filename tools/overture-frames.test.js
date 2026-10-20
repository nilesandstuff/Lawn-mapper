// tools/overture-frames.js: nearness falls from 1 on the line to 0 at the reach, and the raster lands where the box says.
import assert from 'node:assert/strict';
import { nearness, rasterise } from './overture-frames.js';

{
  const W = 40, H = 20;
  const n = nearness([[[10, 10], [30, 10]]], W, H, 8); // a horizontal line along row 10 (cell centres at .5)
  assert.ok(Math.abs(n[10 * W + 20] - (1 - 0.5 / 8)) < 1e-6, 'on the line (half a cell from it)');
  assert.ok(Math.abs(n[14 * W + 20] - (1 - 4.5 / 8)) < 1e-6, '4.5 cells away');
  assert.equal(n[19 * W + 20], 0, 'past the reach');
  assert.equal(n[10 * W + 0], 0, 'past the end of the line, beyond the reach (9.5 cells)');
  assert.ok(n[10 * W + 9] > 0.8, 'just past the end, within the reach');
  const none = nearness([], W, H, 8);
  assert.ok(!none.some((v) => v > 0), 'no lines: nothing near');
}
{
  // a 40 x 20 m box at the equator, one building in its north-west quarter, a sidewalk along the south edge
  const R = 6378137, box = [0, 0, 40, 20];
  const d = (m) => (m / R) * 180 / Math.PI;
  const ov = {
    buildings: [[[[d(5), d(12)], [d(15), d(12)], [d(15), d(18)], [d(5), d(18)], [d(5), d(12)]]]],
    roads: [{ cls: 'footway', sub: 'sidewalk', width: 1.5, walk: true, lines: [[[d(0), d(1)], [d(40), d(1)]]] },
      { cls: 'residential', sub: null, width: 8, walk: false, lines: [[[d(0), d(-10)], [d(40), d(-10)]]] }],
  };
  const r = rasterise(box, ov);
  assert.equal(r.W, 80); assert.equal(r.H, 40);
  // rows run from the north: y metres up from the south edge is row (20 - y) / 0.5
  const at = (xM, yM) => Math.round((20 - yM) / 0.5) * 80 + Math.round(xM / 0.5);
  assert.equal(r.building[at(10, 15)], 1, 'inside the building (x 10 m, y 15 m)');
  assert.equal(r.building[at(10, 5)], 0, 'open ground below it');
  assert.ok(r.walk[at(20, 1)] > 0.8, 'on the sidewalk along the south edge');
  assert.equal(r.walk[at(20, 19)], 0, 'the north edge is 18 m from it: past the 10 m reach');
  assert.ok(r.road[at(20, 1)] > 0 && r.road[at(20, 1)] < 0.4, 'the road 11 m south of the south edge, within the 15 m reach');
  assert.deepEqual(r.counts, { buildings: 1, walks: 1, roads: 1 });
}
{
  // the lidar's roof 3 cells east and 2 south of Overture's footprint, on a coarser grid (half the cells across)
  const { fitToRoof, shiftRaster } = await import('./overture-frames.js');
  const W = 60, H = 40, b = new Uint8Array(W * H);
  for (let r = 10; r < 24; r++) for (let c = 20; c < 40; c++) b[r * W + c] = 1;
  const roof = { data: new Uint8Array(30 * 20), w: 30, h: 20 };
  for (let r = 6; r < 13; r++) for (let c = 11; c < 21; c++) roof.data[r * 30 + c] = 1; // rows 12-25, cols 22-41 on the fine grid
  const f = fitToRoof(b, W, H, roof, 8, 20);
  assert.equal(f.dx, 2); assert.equal(f.dy, 2);
  assert.ok(f.iou > 0.95 && f.iou0 < 0.7, `iou ${f.iou0} -> ${f.iou}`);
  const moved = shiftRaster(b, W, H, f.dx, f.dy);
  assert.equal(moved[12 * W + 22], 1); assert.equal(moved[10 * W + 20], 0);
  assert.equal(fitToRoof(new Uint8Array(W * H), W, H, roof, 8, 20), null, 'no building: nothing to fit');
  assert.equal(fitToRoof(b, W, H, { data: new Uint8Array(30 * 20), w: 30, h: 20 }, 8, 20), null, 'no roof: nothing to fit to');
}
console.log('overture-frames: ok');
