/**
 * The frozen benchmark is the default, and the other sets are named.
 *
 *   node tools/lawn-set.test.js
 */

import assert from 'node:assert/strict';
import { lawnSetClause, lawnSetName, lawnSetDescription, BENCHMARK, printOf } from './lawn-set.js';
import { setPrint } from './train-detector.js';

assert.equal(lawnSetName({}), 'benchmark', 'unset means the benchmark');
assert.equal(lawnSetClause({}), ` AND cohort = '${BENCHMARK}'`);
assert.equal(lawnSetClause({ LAWN_SET: 'all' }), '');
assert.equal(lawnSetClause({ LAWN_SET: 'new' }), ' AND cohort IS NULL');
assert.equal(lawnSetClause({ LAWN_SET: ' Benchmark ' }), ` AND cohort = '${BENCHMARK}'`);
assert.throws(() => lawnSetClause({ LAWN_SET: 'some' }), /LAWN_SET must be/);
assert.match(lawnSetDescription({ LAWN_SET: 'all' }), /NOT the benchmark/);
assert.match(lawnSetDescription({}), /frozen benchmark/);
/* The clause is a fragment that follows an existing WHERE, so it must begin
   with AND and contain no semicolon. */
for (const set of ['benchmark', 'new']) {
  const c = lawnSetClause({ LAWN_SET: set });
  assert.ok(c.startsWith(' AND '), c);
  assert.ok(!c.includes(';'));
}

/* The locked set: exactly the listed ids, quotes escaped; none listed is an error, not "all". */
const lock = { ids: ["-84.5,38.9:sam3:find", "o'brien"], lockedAt: '2026-10-06T18:10:00Z' };
assert.equal(lawnSetClause({ LAWN_SET: 'locked' }, lock), ` AND id IN ('-84.5,38.9:sam3:find','o''brien')`);
assert.throws(() => lawnSetClause({ LAWN_SET: 'locked' }, null), /lists no maps/);
assert.match(lawnSetDescription({ LAWN_SET: 'locked' }, lock), /2 maps, locked 2026-10-06/);
/* Its fingerprint is the one a run prints for the same maps. */
assert.equal(printOf(lock.ids), setPrint(lock.ids.map((id) => ({ id }))));

console.log('lawn set: ok');
