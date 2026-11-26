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
