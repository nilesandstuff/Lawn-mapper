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
console.log('overture-frames: ok');
