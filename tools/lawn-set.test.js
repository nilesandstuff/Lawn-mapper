/**
 * The frozen benchmark is the default, and the other sets are named.
 *
 *   node tools/lawn-set.test.js
 */

import assert from 'node:assert/strict';
import { lawnSetClause, lawnSetName, lawnSetDescription, BENCHMARK } from './lawn-set.js';

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

console.log('lawn set: ok');
