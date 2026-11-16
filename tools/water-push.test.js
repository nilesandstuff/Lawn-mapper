// The main Worker telling the water site what changed (worker/src/water-push.js). node tools/water-push.test.js
import assert from 'node:assert/strict';
import { pushWater, PUSH_KEY } from '../worker/src/water-push.js';

const bucket = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? { json: async () => JSON.parse(m.get(k)) } : null), put: async (k, v) => { m.set(k, v); } }; };
const calls = [];
const WATER = { modelChanged: async (id, at) => { calls.push(['model', id, at]); return { queued: true }; }, walkReady: async (id, w) => { calls.push(['walk', id, w]); return { queued: true }; } };
let walks = [{ map: 'home', walk: '1794780697283', at: '2026-11-16T10:00:00.000Z' }, { map: 'not-admin', walk: '1794780697284', at: '2026-11-16T10:00:00.000Z' }];
const SCAN_INTERNAL = { convertedWalks: async () => walks };
const env = { WATER, SCAN_INTERNAL, CORPUS: bucket(), DB: {} };
let saves = [{ id: 'home', modelAt: '2026-11-16T14:31:11.948Z', at: null }, { id: 'work', modelAt: null, at: null }];
const list = async () => saves;
const t0 = Date.parse('2026-11-16T17:00:00Z');   // a fifth minute

// not every minute
assert.equal((await pushWater(env, t0 + 60000, list)).pushed, 0, 'only every fifth minute');
assert.equal(calls.length, 0);
// the first: the home save's model and its walk; not the save with no model yet, nor a walk of a map that is no admin save
assert.equal((await pushWater(env, t0, list)).pushed, 2);
assert.deepEqual(calls, [['model', 'home', '2026-11-16T14:31:11.948Z'], ['walk', 'home', '1794780697283']]);
assert.ok(env.CORPUS.m.has(PUSH_KEY), 'what was pushed is remembered');
// nothing new: nothing sent
calls.length = 0;
assert.equal((await pushWater(env, t0 + 5 * 60000, list)).pushed, 0); assert.equal(calls.length, 0, 'sent once');
// the model rebuilt and a new walk converted: each sent once
saves = [{ id: 'home', modelAt: '2026-11-16T18:00:00.000Z' }, { id: 'work', modelAt: '2026-11-16T18:01:00.000Z' }];
walks = [...walks, { map: 'home', walk: '1794790000000', at: '2026-11-16T18:02:00.000Z' }];
assert.equal((await pushWater(env, t0 + 10 * 60000, list)).pushed, 3);
assert.deepEqual(calls.map((c) => c.slice(0, 2).join(' ')), ['model home', 'model work', 'walk home']);
// a push that fails is tried again the next time
calls.length = 0; saves = [{ id: 'home', modelAt: '2026-11-16T19:00:00.000Z' }];
const flaky = { ...env, WATER: { ...WATER, modelChanged: async () => { throw new Error('down'); } } };
assert.equal((await pushWater(flaky, t0 + 15 * 60000, list)).pushed, 0);
assert.equal((await pushWater(env, t0 + 20 * 60000, list)).pushed, 1, 'sent when the water site answers again');
// refused ({ queued: false }): not counted as sent, so tried again
calls.length = 0; saves = [{ id: 'home', modelAt: '2026-11-16T20:00:00.000Z' }];
const refusing = { ...env, WATER: { ...WATER, modelChanged: async () => ({ queued: false, error: 'which map?' }) } };
assert.equal((await pushWater(refusing, t0 + 25 * 60000, list)).pushed, 0, 'a refusal is not sent');
assert.equal((await pushWater(env, t0 + 30 * 60000, list)).pushed, 1, 'and goes again when taken');
// no water binding yet: nothing, and no error
assert.equal((await pushWater({ CORPUS: bucket(), DB: {} }, t0, list)).pushed, 0);
console.log('water push: ok');
