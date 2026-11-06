// The live day: a heavy route, ticks, a helper comes free, the re-split, and what may be saved.
import assert from 'node:assert/strict';
import { applySplit, checkUpdate, describe, planToLive, problem, problemPoints, standing, taking } from '../lib/live.js';
import { rebalance } from '../lib/split.js';

let seed = 5;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const shop = { label: 'Shop', lng: -85.72, lat: 42.78 };
const stop = (i) => ({ address: `${100 + i} Test St`, city: 'Town', name: `C${i}`, minutes: 20 + (i % 3) * 5, sqft: 5000 + i, label: `${100 + i} Test St, Town`, lng: -85.7 + rand() * 0.2, lat: 42.75 + rand() * 0.15 });
const plan = { at: 1, shop, people: [{ name: 'Pat', stops: Array.from({ length: 14 }, (_, i) => stop(i)), legs: Array.from({ length: 14 }, () => ({ duration: 300, distance: 3000 })) }] };

let doc = planToLive(plan, { id: 'abc' });
assert.equal(Object.keys(doc.stops).length, 14);
assert.equal(doc.people[0].into.s1, null, 'a blank start: no drive to the first stop');
assert.deepEqual(doc.people[0].into.s2, { duration: 300, distance: 3000 });
assert.deepEqual(doc.people[0].back, { duration: 300, distance: 3000 });

// Pat does three stops
const T0 = Date.UTC(2026, 10, 6, 15);
['s1', 's2', 's3'].forEach((s, i) => { doc.stops[s].done = { at: T0 + i * 1800000, by: 'Pat' }; });
assert.deepEqual(standing(doc)[0].done, ['s1', 's2', 's3']);
assert.equal(standing(doc)[0].todo.length, 11);

// Sam opens the link and is free now, at a known spot
doc.people.push({ id: 'p2', name: 'Sam', stops: [], into: {}, back: null, geometry: null, readyAt: T0 + 5400000, start: { lng: -85.65, lat: 42.85, label: 'Where Sam was' }, free: true, helper: true });
const now = T0 + 5400000;
assert.deepEqual(taking(doc).map((p) => p.id), ['p1', 'p2']);
const { points, index } = problemPoints(doc);
assert.equal(points.at(-1).key, 'shop');
assert.ok(index.has('s3'), "Pat's position: the last stop done");
assert.ok(index.has('at:p2'), "Sam's position: where they said");
const dist = (a, b) => Math.hypot((a.lng - b.lng) * 81000, (a.lat - b.lat) * 111000);
const M = points.map((a) => points.map((b) => dist(a, b) * 1.3));
const D = M.map((r) => r.map((x) => x / 12));
const pr = problem(doc, D, index, now);
assert.deepEqual(pr.kept, ['s4', null], 'Pat keeps the stop they are on; Sam keeps nothing');
assert.equal(pr.persons[0].anchor, index.get('s4'));
assert.ok(pr.persons[0].fixed > 20 * 60, 'the kept stop: the drive to it and its job');
assert.equal(pr.persons[1].anchor, index.get('at:p2'));
const res = rebalance(D, { persons: pr.persons, current: pr.current, shop: pr.shop, service: pr.service });
const { doc: next, changes } = applySplit(doc, pr, res.routes, D, M, points, now);
assert.deepEqual(next.people[0].stops.slice(0, 4), ['s1', 's2', 's3', 's4'], 'done stops, then the kept one, first');
assert.ok(next.people[1].stops.length > 2, 'Sam gets stops');
assert.equal(next.people[0].stops.length + next.people[1].stops.length, 14);
assert.ok(next.people[1].into[next.people[1].stops[0]], "Sam's first drive is known: from where Sam is");
assert.equal(next.people[1].geometry, null);
assert.equal(checkUpdate(doc, next), null, 'a good update');
const lines = describe(doc, changes);
assert.match(lines[0], /^Sam took \d+ stops? \(\d+ from Pat\)$/);

// what may not be saved
const bad = (f) => { const x = structuredClone(next); f(x); return checkUpdate(doc, x); };
assert.match(bad((x) => x.people[1].stops.push('s5')), /twice/);
assert.match(bad((x) => { x.people[1].stops = []; }), /missing/);
assert.match(bad((x) => { x.people.pop(); }), /missing|A stop/);
assert.match(bad((x) => { x.people[0].stops = x.people[0].stops.filter((s) => s !== 's1'); x.people[1].stops.push('s1'); }), /done stop moved/);
assert.match(bad((x) => { x.people[1].stops.push('s99'); }), /No such stop/);
assert.match(bad((x) => { x.people[1].name = ''; }), /name/);

// a helper who will be free in an hour: nothing kept, the wait counted
const later = structuredClone(doc);
later.people[1].readyAt = now + 3600000;
const pr2 = problem(later, D, index, now);
assert.equal(pr2.persons[1].fixed, 3600);
// a person done with everything who has not volunteered: not part of it
const finished = structuredClone(next);
for (const s of finished.people[1].stops) finished.stops[s].done = { at: now, by: 'Sam' };
finished.people[1].free = false;
assert.deepEqual(taking(finished).map((p) => p.id), ['p1']);
console.log(`route live: ok (Sam took ${next.people[1].stops.length} of Pat's 11)`);

// riding between close stops: kept in the doc, marked on the legs a re-split writes
{
  const { rideAdjust } = await import('../lib/ride.js');
  const near = { at: 1, shop, people: [{ name: 'Pat', stops: [
    { address: '1 A St', lng: -85.7, lat: 42.8, minutes: 20 },
    { address: '2 A St', lng: -85.7 + 150 / 81900, lat: 42.8, minutes: 20 }, // 150 m east: close by road
    { address: '3 B St', lng: -85.6, lat: 42.9, minutes: 20 },
  ], legs: [] }] };
  const d2 = planToLive(near, { id: 'n' });
  assert.deepEqual(d2.ride, { road: 305, yard: 70, save: 300 }, 'the default rules');
  d2.people.push({ id: 'h', name: 'Sam', stops: [], into: {}, back: null, geometry: null, readyAt: 0, start: { lng: -85.61, lat: 42.89, label: 'x' }, free: true, helper: true });
  const { points: P, index: I } = problemPoints(d2);
  const MM = P.map((a) => P.map((b) => Math.hypot((a.lng - b.lng) * 81900, (a.lat - b.lat) * 111000) * 1.2));
  const DD = MM.map((r) => r.map((x) => x / 12));
  const R = rideAdjust(DD, MM, P, (i) => Boolean(d2.stops[P[i].key]), d2.ride);
  const pr3 = problem(d2, R.D, I, 1);
  const res3 = rebalance(R.D, { persons: pr3.persons, current: pr3.current, shop: pr3.shop, service: pr3.service, timeMs: 200 });
  const { doc: n3 } = applySplit(d2, pr3, res3.routes, DD, MM, P, 1);
  const pat = n3.people[0];
  const i1 = pat.stops.indexOf('s1');
  assert.equal(pat.stops[i1 + 1], 's2', 'the close pair stays together, with the stop Pat is on');
  assert.equal(pat.into.s2.ride, 'road');
  assert.equal(pat.into.s2.saved, 300);
  assert.ok(n3.people[1].stops.includes('s3'), 'the far stop goes to Sam, who is near it');
}
console.log('route live riding: ok');
