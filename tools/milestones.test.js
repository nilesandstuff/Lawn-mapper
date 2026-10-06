import assert from 'node:assert/strict';
import { milestonesReached } from './milestones.js';

assert.equal(milestonesReached(80).length, 0);
assert.equal(milestonesReached(499).length, 0);
assert.equal(milestonesReached(500).length, 1);
assert.match(milestonesReached(612)[0].say, /UperNet/);
assert.equal(milestonesReached(NaN).length, 0);
console.log('milestones: ok');
