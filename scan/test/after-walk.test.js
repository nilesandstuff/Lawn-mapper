import assert from 'node:assert/strict';
import { planOf, prefixesOf } from '../tools/after-walk.mjs';
assert.deepEqual(prefixesOf(1795556910374, 1795657888788), ['17955', '17956']);
const W = (id, map, settled = true) => ({ id, map, settled });
// a map with a new walk is due, with the marker's walks behind it, newest first; a map all marked is not; a walk still
// being sent, or naming no map, sets nothing going
assert.deepEqual(planOf([W('3', 'a'), W('2', 'a'), W('9', 'b'), W('8', 'c', false), W('7', null)], new Map([['a', ['2', '1']], ['b', ['9']]])), [['3', '2', '1']]);
assert.deepEqual(planOf([W('5', 'a')], new Map()), [['5']]);
assert.equal(planOf([W('9', 'a'), W('8', 'a')], new Map([['a', ['7', '6', '5', '4', '3']]]))[0].length, 6);
// a full pool's older walks do not make the map due again (they did, every hour, 2026-11-27)
assert.deepEqual(planOf([W('9', 'a'), W('2', 'a'), W('1', 'a')], new Map([['a', ['9', '8', '7', '6', '5', '4']]])), []);
assert.deepEqual(planOf([W('10', 'a'), W('2', 'a')], new Map([['a', ['9', '8', '7', '6', '5', '4']]])), [['10', '9', '8', '7', '6', '5']]);
assert.deepEqual(planOf([W('2', 'a')], new Map([['a', ['9', '8']]])), [['9', '8', '2']], 'a pool not full still takes an older walk');
console.log('after-walk: ok');
