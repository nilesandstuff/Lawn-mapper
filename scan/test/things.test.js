// The things a person places in a yard (lib/things.js).
import assert from 'node:assert/strict';
import { addSightings, placeOf, takeAway, putBack, standing, decodeThings, encodeThings, KINDS, kindOf, pairGutters, forRecord } from '../lib/things.js';

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
assert.equal(standing(putBack(g, 't2')).length, 3); assert.equal(putBack(g, 't1')[0], g[0], 'one not taken away is left as it is');
g = addSightings(g, [S('sprinkler', [9.1, 4], 'corners3', 'w6')]).things;
assert.equal(standing(g).length, 3);

// what is kept reads back; rubbish reads as nothing
assert.deepEqual(decodeThings(encodeThings(g)).map((t) => t.id), ['t1', 't2', 't3']);
assert.deepEqual(decodeThings('{"v":2,"things":[]}'), []); assert.deepEqual(decodeThings('not json'), []);
assert.equal(placeOf([]), null); assert.ok(kindOf('sprinkler') && !kindOf('nope') && KINDS.length === 4);
// A DOWNSPOUT IS A PAIR: an outlet takes the nearest top within 4 m that has none; the pair stays; an outlet alone stays alone
{ let d = addSightings([], [S('gutter-top', [0, 0], 'corners3', 'w1', 2.7), S('gutter-top', [10, 0], 'corners3', 'w1', 2.7), S('gutter-out', [0.4, 0.5], 'corners3', 'w1', 0.1), S('gutter-out', [10.2, 3], 'corners3', 'w1', 0.1), S('gutter-out', [30, 30], 'corners3', 'w1', 0.1)]).things;
  d = pairGutters(d);
  const by = Object.fromEntries(d.map((t) => [t.id, t.pair || null]));
  assert.equal(by.t1, by.t3); assert.equal(by.t2, by.t4); assert.notEqual(by.t1, by.t2); assert.equal(by.t5, null);
  assert.deepEqual(pairGutters(d).map((t) => t.pair || null), d.map((t) => t.pair || null), 'made again, the pairs stay');
  // the top of the first pair taken away: its outlet is alone again, and takes a new top placed there later
  let e = pairGutters(takeAway(d, 't1', 'w2'));
  assert.equal(e.find((t) => t.id === 't3').pair, undefined);
  e = pairGutters(addSightings(e, [S('gutter-top', [0.1, 2.5], 'corners3', 'w3', 2.7)]).things);
  assert.ok(e.find((t) => t.id === 't3').pair && e.find((t) => t.id === 't3').pair === e.find((t) => t.id === 't6').pair);
  // as the map's record holds them: the present place only, in degrees and in the map's metres
  const rec = forRecord(d, ([east, north]) => [-80 + east / 85000, 40 + north / 111000]);
  assert.equal(rec.length, 5);
  const one = rec.find((t) => t.id === 't4');
  assert.deepEqual(Object.keys(one).sort(), ['e', 'grade', 'h', 'id', 'kind', 'last', 'lat', 'lng', 'n', 'pair', 'seen']);
  assert.equal(one.e, 10.2); assert.equal(one.seen, 1); assert.ok(Math.abs(one.lat - (40 + 3 / 111000)) < 1e-6);
  assert.ok(JSON.stringify(forRecord(takeAway(d, 't5', 'w9'), (p) => p)).includes('"gone":true')); }
// a walk that did not close: of two of one kind within 3 m, both seen on that walk alone, the later is the doubled one
{ const { doubled } = await import('../tools/things-fix.mjs');
  const one = (w) => [{ at: [0, 0], walk: w, grade: 'corners3', t: 1 }];
  const T = [{ id: 't1', kind: 'gutter-out', at: [0, 0], seen: one('w') }, { id: 't2', kind: 'gutter-top', at: [1, 0], seen: one('w') }, { id: 't3', kind: 'other', at: [9, 9], seen: one('w') },
    { id: 't4', kind: 'gutter-out', at: [2.1, 0.5], seen: one('w') }, { id: 't5', kind: 'gutter-top', at: [2.7, 0], seen: one('w') },
    { id: 't6', kind: 'gutter-out', at: [0.5, 0], seen: one('v') }, { id: 't7', kind: 'gutter-out', at: [20, 0], seen: one('w') }];
  assert.deepEqual(doubled(T, 'w').map((x) => [x.id, x.of]), [['t4', 't1'], ['t5', 't2']], 'another walk\'s thing, a far one and another kind are left');
  assert.deepEqual(doubled(T, 'v'), []); }
console.log('things: ok');
