// The estimate as the day goes: from the latest tick, the stop you're on, and the rest.
import assert from 'node:assert/strict';
import { timeline } from '../lib/eta.js';

const MIN = 60000;
const T = Date.UTC(2026, 10, 10, 13); // 1:00 PM
const steps = [{ drive: 600, job: 20 }, { drive: 300, job: 30, load: 300 }, { drive: 300, job: 20 }];

// nothing ticked yet: from now
let r = timeline(steps, 900, { now: T });
assert.deepEqual(r.arrivals.map((a) => (a - T) / MIN), [10, 40, 75], 'loading up before the driven step: 5 more on the way');
assert.equal((r.finish - T) / MIN, 75 + 20 + 15);
assert.equal(r.left, r.finish - T);

// ticked 10 minutes ago, at the stop before these: on plan, the estimate stands
r = timeline(steps, 900, { now: T, lastTick: T - 10 * MIN });
assert.equal((r.finish - T) / MIN, 110 - 10);
assert.equal((r.arrivals[0] - T) / MIN, 0, 'arriving at the next stop just about now');

// ticked an hour ago: the stop you're on should be done -- behind, it's done now, the rest moves back
r = timeline(steps, 900, { now: T, lastTick: T - 60 * MIN });
assert.equal((r.finish - T) / MIN, 10 + 30 + 5 + 20 + 15, 'from now: the rest after the stop you are on');

// a helper free at 2:00 PM: from then
r = timeline(steps, 900, { now: T, readyAt: T + 60 * MIN });
assert.equal((r.finish - T) / MIN, 60 + 110);

// all done: heading home from the last tick
r = timeline([], 900, { now: T, lastTick: T - 5 * MIN });
assert.equal((r.finish - T) / MIN, 10);
r = timeline([], 900, { now: T, lastTick: T - 60 * MIN });
assert.equal(r.finish, T, 'never before now');
console.log('route eta: ok');
