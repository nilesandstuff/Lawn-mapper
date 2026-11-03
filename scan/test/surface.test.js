/**
 * scan/lib/surface.js: grass or paving by colour; the lawn as a signed distance; the cost of a surface point.
 *   node scan/test/surface.test.js
 */
import assert from 'node:assert/strict';
import { surfaceOf, lawnField, surfaceCost, tally } from '../lib/surface.js';

assert.equal(surfaceOf(70, 120, 50), 'grass', 'green lawn');
assert.equal(surfaceOf(120, 115, 70), 'grass', 'a dormant, olive lawn');
assert.equal(surfaceOf(150, 150, 145), 'pave', 'concrete');
assert.equal(surfaceOf(95, 95, 100), 'pave', 'asphalt');
assert.equal(surfaceOf(20, 25, 18), null, 'deep shade says nothing');
assert.equal(surfaceOf(110, 70, 40), null, 'mulch or soil says nothing');
assert.equal(surfaceOf(200, 120, 40), null, 'orange leaves say nothing');
assert.deepEqual(tally(['grass', 'pave', null, 'grass']), { grass: 2, pave: 1, none: 1 });

// a 10 x 6 m lawn with a 2 x 2 m bed in it, on a 0.25 m grid
const box = [-10, -10, 10, 10];
const F = lawnField([[[0, 0], [10, 0], [10, 6], [0, 6]], [[4, 2], [6, 2], [6, 4], [4, 4]]], box);
const at = (e, n) => F.sd[Math.floor((box[3] - n) / F.cell) * F.W + Math.floor((e - box[0]) / F.cell)];
assert.ok(at(2, 3) > 1.5 && at(2, 3) < 2.2, `inside, 2 m from the edge: ${at(2, 3)}`);
assert.ok(at(-3, 3) < -2.5, `outside: ${at(-3, 3)}`);
assert.ok(at(5, 3) < 0, `the bed is outside: ${at(5, 3)}`);
assert.ok(Math.abs(at(0.1, 3)) < 0.3, 'at the edge, about 0');
assert.equal(F.cells, 40 * 24 - 64, 'the lawn less the bed, in cells');
// the cost: paving on the lawn and grass off it, past a 15 cm tolerance
assert.equal(surfaceCost('pave', -2), 0); assert.equal(surfaceCost('grass', 2), 0);
assert.ok(Math.abs(surfaceCost('pave', 0.65) - 0.25) < 1e-9, 'paving half a metre in');
assert.equal(surfaceCost('pave', 5), 1, 'capped');
assert.equal(surfaceCost('grass', -5), 0.25, 'grass off the lawn costs less (it may be lawn not traced)');
assert.equal(surfaceCost(null, 3), 0);
console.log('surface: ok');
