import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { poolPlants } from '../tools/plants-pool.mjs';

const seen = (i0, j0, w, h, vals) => ({ cellM: 0.6096, i0, j0, w, h, capDm: 24, notSeen: 255, enc: 'zlib+base64', clearTo: deflateSync(Buffer.from(Uint8Array.from(vals))).toString('base64') });
// walk A: plant at (0,0) 10-30 dm, (4,0) 10-20, (8,0) 10-20; it looked at square (0,0) of 2 ft and saw 5 dm open
const A = { v: 1, cellM: 0.3048, boxes: [[0, 0, 10, 30], [4, 0, 10, 20], [8, 0, 10, 20]], seen: seen(0, 0, 5, 1, [5, 255, 8, 255, 9]), seenHigh: { a: 1 } };
// walk B: plant at (0,0) 12-34 too; at (4,0) it saw the air open to 24 dm (over A's top); it never looked at (8,0)
const B = { v: 1, cellM: 0.3048, boxes: [[0, 0, 12, 34]], seen: seen(-1, 0, 4, 1, [255, 20, 255, 24]) };
const { doc, stats } = poolPlants([A, B]);
assert.deepEqual(doc.boxes, [[0, 0, 10, 34], [8, 0, 10, 20]], 'both walks: the widest; one walk gainsaid: out; one walk not looked at by the other: kept');
assert.equal(stats.two, 1); assert.equal(stats.one, 1); assert.equal(stats.dropped, 1);
const a = new Uint8Array(inflateSync(Buffer.from(doc.seen.clearTo, 'base64')));
assert.deepEqual([doc.seen.i0, doc.seen.w], [-1, 6]);
assert.equal(a[0], 255, 'never looked'); assert.equal(a[1], 10, 'the most seen (20), but not over the kept plant\'s low (10)');
assert.equal(a[3], 24, 'the gainsaid square: open as walk B saw it'); assert.equal(a[5], 9);
assert.deepEqual(doc.seenHigh, { a: 1 }); assert.equal(doc.walks, 2);
assert.equal(poolPlants([null, {}]).doc, null);
assert.deepEqual(poolPlants([A]).doc.boxes, A.boxes, 'one walk: itself');
console.log('plants-pool: ok');
// the open air above 8 ft, one band a square: the longest any walk claimed, cut where a kept plant stands in it
{ const { joinBands } = await import('../tools/plants-pool.mjs');
  const band = (i0, w, pairs) => ({ cellM: 0.6096, i0, j0: 0, w, h: 1, unitDm: 2, notSeen: 255, enc: 'zlib+base64', bands: deflateSync(Buffer.from(Uint8Array.from(pairs.flat()))).toString('base64') });
  const A = band(0, 3, [[20, 30], [255, 255], [15, 40]]), B = band(1, 3, [[20, 60], [0, 0], [255, 255]]);
  // a plant kept in square 1 (feet 2-3) from 70 to 90 dm (35-45 units): B's band 20-60 cut to its longer part (above on a tie)
  const j = joinBands([A, B], [[2, 0, 70, 90]], 0.3048);
  const a = [...inflateSync(Buffer.from(j.bands, 'base64'))];
  assert.deepEqual([j.i0, j.w], [0, 4]);
  assert.deepEqual(a, [20, 30, 45, 60, 15, 40, 255, 255], 'the longest, cut at the plant (the part above it, the parts being equal); never looked stays');
  assert.equal(joinBands([], [], 0.3048), null); }
console.log('plants-pool (the bands): ok');
// the owner's erasures: a plant square erased is not kept; one erased on 2 ft squares covers the four foot squares under it
{ const { poolPlants: pool, erasedOf } = await import('../tools/plants-pool.mjs');
  const er = erasedOf({ v: 1, plantsCellM: 0.6096, erased: [['p', 0, 0, 'plant'], ['g', 5, 5, 'turf']] });
  assert.deepEqual([...er].sort(), ['0,0', '0,1', '1,0', '1,1']);
  const D = { v: 1, cellM: 0.3048, boxes: [[1, 1, 10, 30], [4, 4, 10, 30]] };
  const r = pool([D], { erased: er });
  assert.deepEqual(r.doc.boxes, [[4, 4, 10, 30]]); assert.equal(r.stats.erasedOut, 1);
  assert.equal(erasedOf({ v: 1, erased: [['p', 3, 3, 'plant']] }).size, 1, 'no size kept and not of that morning: as it is'); }
console.log('plants-pool (the owner\'s erasures): ok');
