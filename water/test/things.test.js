/** Things placed in a Yard AR walk, offered to the water map (lib/things.js). Made-up places near a generic point. */
import assert from 'node:assert/strict';
import { offersFrom, offerWords, SAME_M } from '../lib/things.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const M = 1 / 111320, k = Math.cos((41.88 * Math.PI) / 180), P = (e, n) => ({ lng: -87.63 + (e * M) / k, lat: 41.88 + n * M });
const things = [
  { id: 't1', kind: 'sprinkler', ...P(0, 0), grade: 'corners3', seen: 2 },
  { id: 't2', kind: 'sprinkler', ...P(5, 0), grade: 'unsure', seen: 1 },
  { id: 't3', kind: 'sprinkler', ...P(10, 0), grade: 'corners2', gone: true },
  { id: 't4', kind: 'gutter-top', ...P(0, 10), grade: 'corners3', pair: 'd1' },
  { id: 't5', kind: 'gutter-out', ...P(0, 12), grade: 'corners2', pair: 'd1' },
  { id: 't6', kind: 'gutter-out', ...P(8, 12), grade: 'earlier' },
  { id: 't7', kind: 'other', ...P(3, 3), grade: 'corners3' },
  { id: 't8', kind: 'sprinkler', grade: 'corners3' }, // no place: left out
];

test('heads and downspouts offered: a pair is one downspout, an outlet alone has no top, the unsure unticked', () => {
  const o = offersFrom(things);
  assert.deepEqual(o.heads.map((h) => [h.ids[0], h.tick]), [['t1', true], ['t2', false]]);
  assert.equal(o.spouts.length, 2);
  assert.deepEqual(o.spouts[0].ids, ['t5', 't4']); assert.ok(o.spouts[0].from && o.spouts[0].to); assert.equal(o.spouts[0].grade, 'corners2');
  assert.equal(o.spouts[1].from, null); assert.equal(o.spouts[1].grade, 'earlier');
  assert.equal(o.other, 1);
  assert.equal(offerWords(o), '2 sprinkler heads and 2 downspouts');
});

test('what is already placed by hand within a metre stays and is not offered; an answered thing is not offered again', () => {
  const near = P(0.5 * SAME_M, 0), o = offersFrom(things, { heads: [[near.lng, near.lat]], downspouts: [{ from: null, to: [P(8, 12.4).lng, P(8, 12.4).lat] }], answered: ['t2'] });
  assert.equal(o.heads.length, 0); assert.equal(o.same, 2);
  assert.deepEqual(o.spouts.map((s) => s.ids[0]), ['t5']);
  assert.equal(offerWords(offersFrom([])), '');
});

console.log(`\n${passed} passed`);
