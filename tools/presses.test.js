/**
 * worker/src/presses.js: a press is handed back once, only to whoever paid,
 * and never after the detector answered. Run against a real SQLite (Node's
 * built-in) with the table exactly as schema.sql makes it.
 *
 *   node tools/presses.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openPress, releasePress, pressIdOf } from '../worker/src/presses.js';

/* D1's prepare/bind/first/run over SQLite. */
function d1() {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS detect_presses'));
  db.exec(table.slice(0, table.indexOf(';', table.indexOf('created_at);')) + 1));
  return {
    raw: db,
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        first: async () => st.get(...args) ?? null,
        run: async () => st.run(...args),
        all: async () => ({ results: st.all(...args) }),
      };
      return api;
    },
  };
}

/* Upstream: Replicate's prediction status, set per test. */
let upstream = {};
globalThis.fetch = async (url, init = {}) => {
  const m = String(url).match(/predictions\/([^/]+)(\/cancel)?$/);
  if (m && init.method === 'POST') return new Response('{}');
  return new Response(JSON.stringify({ status: upstream[m?.[1]] || 'processing' }));
};

const row = { clientId: 'c1', userId: null, n: 2, fromDaily: null, ids: ['aaa111', 'bbb222'] };

assert.equal(pressIdOf('0b7c2f5e-1111-2222'), '0b7c2f5e-1111-2222');
assert.equal(pressIdOf("x'; --"), null);

/* Still running: handed back once, and only once. */
{
  const env = { DB: d1() };
  upstream = { aaa111: 'succeeded', bbb222: 'processing' };
  assert.equal(await openPress(env, 'press-0001', row), 'open');
  const first = await releasePress(env, 'press-0001', { clientId: 'c1', userId: null });
  assert.equal(first.refunded, true);
  assert.equal(first.row.n, 2);
  assert.deepEqual(first.stop, ['bbb222'], 'only the unfinished one is stopped');
  const second = await releasePress(env, 'press-0001', { clientId: 'c1', userId: null });
  assert.equal(second.refunded, undefined);
  assert.equal(second.already, true);
}

/* Every prediction had answered: the trace was there, so it counts. */
{
  const env = { DB: d1() };
  upstream = { aaa111: 'succeeded', bbb222: 'succeeded' };
  await openPress(env, 'press-0002', row);
  const got = await releasePress(env, 'press-0002', { clientId: 'c1', userId: null });
  assert.equal(got.finished, true);
  assert.equal(env.DB.raw.prepare("SELECT state FROM detect_presses WHERE id = 'press-0002'").get().state, 'open');
}

/* Failed upstream is handed back. */
{
  const env = { DB: d1() };
  upstream = { aaa111: 'failed', bbb222: 'succeeded' };
  await openPress(env, 'press-0003', row);
  assert.equal((await releasePress(env, 'press-0003', { clientId: 'c1', userId: null })).refunded, true);
}

/* Somebody else's press is not theirs to hand back. */
{
  const env = { DB: d1() };
  upstream = {};
  await openPress(env, 'press-0004', { ...row, userId: 'u1' });
  assert.equal((await releasePress(env, 'press-0004', { clientId: 'c2', userId: 'u1' })).forbidden, true);
  assert.equal((await releasePress(env, 'press-0004', { clientId: 'c1', userId: 'u2' })).forbidden, true);
  assert.equal((await releasePress(env, 'press-0004', { clientId: 'c1', userId: 'u1' })).refunded, true);
}

/* A cancel that beats the press: the press finds it and hands itself back, once. */
{
  const env = { DB: d1() };
  const early = await releasePress(env, 'press-0005', { clientId: 'c1', userId: null });
  assert.equal(early.pending, true);
  assert.equal(await openPress(env, 'press-0005', row), 'cancelled');
  assert.equal(await openPress(env, 'press-0005', row), null, 'not twice');
  assert.equal((await releasePress(env, 'press-0005', { clientId: 'c1', userId: null })).already, true);
}

/* No database, or no press id: nothing recorded, nothing refundable. */
assert.equal(await openPress({}, 'press-0006', row), null);
assert.equal(await openPress({ DB: d1() }, null, row), null);

console.log('presses: ok');
