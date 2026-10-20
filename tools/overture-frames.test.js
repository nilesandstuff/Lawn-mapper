// tools/overture-frames.js: nearness falls from 1 on the line to 0 at the reach, and the one channel lands where the box says.
import assert from 'node:assert/strict';
import { nearness, rasterise, LINE_REACH_M } from './overture-frames.js';

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
  // a 40 x 20 m box at the equator, a sidewalk along the south edge, a road 10 m south of it (outside)
  const R = 6378137, box = [0, 0, 40, 20];
  const d = (m) => (m / R) * 180 / Math.PI;
  const ov = {
    buildings: [[[[d(5), d(12)], [d(15), d(12)], [d(15), d(18)], [d(5), d(18)], [d(5), d(12)]]]],
    roads: [{ cls: 'footway', sub: 'sidewalk', width: 1.5, walk: true, lines: [[[d(0), d(1)], [d(40), d(1)]]] },
      { cls: 'residential', sub: null, width: 8, walk: false, lines: [[[d(0), d(-10)], [d(40), d(-10)]]] }],
  };
  const r = rasterise(box, ov);
  assert.equal(r.W, 80); assert.equal(r.H, 40);
  assert.equal(LINE_REACH_M, 2, 'a short skirt, inside any road');
  // rows run from the north: y metres up from the south edge is row (20 - y) / 0.5
  const at = (xM, yM) => Math.round((20 - yM) / 0.5) * 80 + Math.round(xM / 0.5);
  assert.ok(r.line[at(20, 1)] > 0.8, 'on the sidewalk line along the south edge');
  assert.equal(r.line[at(20, 4)], 0, '3 m from it: past the 2 m reach');
  assert.equal(r.line[at(20, 19)], 0, 'the north edge: nothing');
  assert.equal(r.line[at(10, 15)], 0, 'the building is not a channel any more (owner, 2026-10-20)');
  assert.ok(!('building' in r), 'no building raster written');
  assert.deepEqual(r.counts, { walks: 1, roads: 1 });
  const none = rasterise(box, { roads: [] });
  assert.ok(!none.line.some((v) => v > 0) && none.counts.roads === 0, 'no lines: an empty channel');
}
console.log('overture-frames: ok');
