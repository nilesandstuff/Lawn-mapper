// The estimate as the day goes: from the latest tick, the stop you're on, and the rest.
import assert from 'node:assert/strict';
import { timeline } from '../lib/eta.js';

const MIN = 60000;
const T = Date.UTC(2026, 10, 10, 13); // 1:00 PM
const steps = [{ drive: 600, job: 20 }, { drive: 300, job: 30 }, { drive: 300, job: 20, saved: 300 }];

// nothing ticked yet: from now
let r = timeline(steps, 900, { now: T });
assert.deepEqual(r.arrivals.map((a) => (a - T) / MIN), [10, 35, 70]);
assert.equal((r.finish - T) / MIN, 70 + 20 - 5 + 15, 'the ride saves 5 off the last job');
assert.equal(r.left, r.finish - T);

// ticked 10 minutes ago, at the stop before these: on plan, the estimate stands
r = timeline(steps, 900, { now: T, lastTick: T - 10 * MIN });
assert.equal((r.finish - T) / MIN, 100 - 10);
assert.equal((r.arrivals[0] - T) / MIN, 0, 'arriving at the next stop just about now');

// ticked an hour ago: the stop you're on should be done -- behind, it's done now, the rest moves back
r = timeline(steps, 900, { now: T, lastTick: T - 60 * MIN });
assert.equal((r.finish - T) / MIN, 5 + 30 + 5 + 15 + 15, 'from now: the rest after the stop you are on');

// a helper free at 2:00 PM: from then
r = timeline(steps, 900, { now: T, readyAt: T + 60 * MIN });
assert.equal((r.finish - T) / MIN, 60 + 100);

// all done: heading home from the last tick
r = timeline([], 900, { now: T, lastTick: T - 5 * MIN });
assert.equal((r.finish - T) / MIN, 10);
r = timeline([], 900, { now: T, lastTick: T - 60 * MIN });
assert.equal(r.finish, T, 'never before now');
console.log('route eta: ok');
