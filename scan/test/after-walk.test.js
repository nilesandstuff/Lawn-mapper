import assert from 'node:assert/strict';
import { planOf, prefixesOf } from '../tools/after-walk.mjs';
assert.deepEqual(prefixesOf(1795556910374, 1795657888788), ['17955', '17956']);
const W = (id, map, settled = true) => ({ id, map, settled });
// a map with a new walk is due, with the marker's walks behind it, newest first; a map all marked is not; a walk still
// being sent, or naming no map, sets nothing going
const P = (plan) => plan.map(([pool, left]) => [pool.join(','), left.join(',')]);
assert.deepEqual(P(planOf([W('3', 'a'), W('2', 'a'), W('9', 'b'), W('8', 'c', false), W('7', null)], new Map([['a', ['2', '1']], ['b', ['9']]]))), [['3,2,1', '']]);
assert.deepEqual(P(planOf([W('5', 'a')], new Map())), [['5', '']]);
// ten at the most (six until 2026-11-27); the rest named as left out
const many = ['20', '19', '18', '17', '16', '15', '14', '13', '12', '11'];
assert.deepEqual(P(planOf([W('21', 'a'), W('3', 'a')], new Map([['a', { walks: many, left: ['3'], placed: {} }]]))), [['21,20,19,18,17,16,15,14,13,12', '11,3']]);
// left out walks do not make the map due again (a full pool's older walks did, every hour, 2026-11-27)
assert.deepEqual(planOf([W('20', 'a'), W('3', 'a')], new Map([['a', { walks: many, left: ['3'], placed: {} }]])), []);
// an old marker (the list alone): by itself only a walk newer than its oldest is new; asked to repool, all it lacks
assert.deepEqual(planOf([W('9', 'a'), W('2', 'a')], new Map([['a', ['9', '8']]])), []);
assert.deepEqual(P(planOf([W('10', 'a'), W('2', 'a')], new Map([['a', ['9', '8']]]))), [['10,9,8,2', '']]);
assert.deepEqual(P(planOf([W('9', 'a'), W('2', 'a')], new Map([['a', ['9', '8']]]), { repool: true })), [['9,8,2', '']]);
// the well placed first: through the reference, then untried, then by their own corners; never placed, out
{
  const walks = many.map((id) => W(id, 'a')).concat([W('22', 'a')]);
  const placed = { 20: 'none', 19: 'own', 18: 'own', 17: 'ref', 16: 'ref', 15: 'ref', 14: 'ref', 13: 'ref', 12: 'ref', 11: 'ref', 5: 'ref' };
  const [[pool, left]] = planOf(walks, new Map([['a', { walks: many, left: ['5'], placed }]]));
  assert.deepEqual(pool, ['22', '19', '17', '16', '15', '14', '13', '12', '11', '5'], 'new first, then reference-placed, then own-fit');
  assert.deepEqual(left, ['20', '18']);
}
// a new walk is pooled even when nothing could place it before it was tried
assert.deepEqual(P(planOf([W('30', 'a')], new Map([['a', { walks: ['9'], left: [], placed: { 30: 'none' } }]]))), [['30,9', '']]);
console.log('after-walk: ok');
