// The things a person places in a yard (lib/things.js).
import assert from 'node:assert/strict';
import { addSightings, placeOf, takeAway, standing, decodeThings, encodeThings, KINDS, kindOf } from '../lib/things.js';

const S = (kind, at, grade, walk = 'w1', h = 0) => ({ kind, at, h, walk, grade, t: 1 });

// a first walk places two sprinkler heads and a gutter outlet
let r = addSightings([], [S('sprinkler', [3, 4], 'corners3'), S('sprinkler', [9, 4], 'corners3'), S('gutter-out', [0, 0], 'corners3', 'w1', 0.1), S('nonsense', [1, 1], 'corners3')]);
assert.equal(r.added, 3); assert.equal(r.things.length, 3); assert.deepEqual(r.things.map((t) => t.id), ['t1', 't2', 't3']);

// walk 2 aims at the first head again, 0.4 m off, vouched for only by the earlier walk's shape: the same thing, one
// more sighting, and it does NOT move (three agreeing corners outrank the shape match)
r = addSightings(r.things, [S('sprinkler', [3.4, 4], 'earlier', 'w2')]);
assert.equal(r.added, 0); assert.equal(r.again, 1);
assert.deepEqual(r.things[0].at, [3, 4]); assert.equal(r.things[0].seen.length, 2); assert.equal(r.moved.length, 0);

// two more of the best grade: the middle of the best-vouched sightings
r = addSightings(r.things, [S('sprinkler', [3.2, 4.1], 'corners3', 'w3'), S('sprinkler', [3.1, 3.9], 'corners3', 'w4')]);
assert.deepEqual(r.things[0].at, [3.1, 4]); assert.equal(r.things[0].seen.length, 4);

// a thing first placed loosely is taken over by a better-vouched sighting
let q = addSightings([], [S('gutter-top', [10, 10], 'corners2', 'w1', 2.6)]);
q = addSightings(q.things, [S('gutter-top', [10.6, 10.2], 'corners3', 'w2', 2.8)]);
assert.deepEqual(q.things[0].at, [10.6, 10.2]); assert.equal(q.things[0].grade, 'corners3'); assert.equal(q.moved.length, 1);

// another kind at the same place is another thing; the same kind over a metre away is another thing
q = addSightings(q.things, [S('gutter-out', [10.6, 10.2], 'corners3', 'w2'), S('gutter-top', [12, 10.2], 'corners3', 'w2')]);
assert.equal(q.things.length, 3);

// taken away: marked, not deleted; sighted again it is back
let g = takeAway(r.things, 't2', 'w5');
assert.equal(standing(g).length, 2); assert.equal(g.length, 3);
g = addSightings(g, [S('sprinkler', [9.1, 4], 'corners3', 'w6')]).things;
assert.equal(standing(g).length, 3);

// what is kept reads back; rubbish reads as nothing
assert.deepEqual(decodeThings(encodeThings(g)).map((t) => t.id), ['t1', 't2', 't3']);
assert.deepEqual(decodeThings('{"v":2,"things":[]}'), []); assert.deepEqual(decodeThings('not json'), []);
assert.equal(placeOf([]), null); assert.ok(kindOf('sprinkler') && !kindOf('nope') && KINDS.length === 4);
console.log('things: ok');
