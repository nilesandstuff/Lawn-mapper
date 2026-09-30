/**
 * worker/src/usage.js: the console counts every charged press -- signed out,
 * signed in, or on a job -- leaves handed-back ones out, and joins the old
 * ledger-only history without counting a day twice.
 *
 *   node tools/usage.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { countPress, markRefunded, usageSince, usageDaily } from '../worker/src/usage.js';

function d1() {
  const db = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');
  const take = (name) => {
    const at = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
    return schema.slice(at, schema.indexOf(');', at) + 2);
  };
  db.exec(take('ledger'));
  db.exec(take('detect_usage'));
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

const env = { DB: d1() };
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

/* Before this existed: two account presses in the ledger, 3 days ago. */
env.DB.raw.prepare("INSERT INTO ledger (user_id, delta, units, reason, at) VALUES ('u1', 0, 2, 'detect', ?)").run(ago(3));
env.DB.raw.prepare("INSERT INTO ledger (user_id, delta, units, reason, at) VALUES ('u1', 0, 1, 'detect', ?)").run(ago(3));

/* Now: a visitor, an account and a job press; one of them handed back. */
await countPress(env, { id: 'p-visitor-1', passes: 1, who: 'visitor', model: 'alpha' });
await countPress(env, { id: 'p-account-1', passes: 4, who: 'account', model: 'sam3_exclude' });
await countPress(env, { id: 'p-job-1', passes: 1, who: 'job', model: 'alpha' });
await countPress(env, { id: 'p-job-1', passes: 1, who: 'job', model: 'alpha' });   // same press twice: once
/* An account press also writes the ledger today; it must not count twice. */
env.DB.raw.prepare("INSERT INTO ledger (user_id, delta, units, reason, at) VALUES ('u1', 0, 4, 'detect', ?)").run(new Date().toISOString());
await markRefunded(env, 'p-visitor-1');

const today = await usageSince(env, ago(1));
assert.deepEqual(today, { presses: 2, passes: 5 }, 'visitor refunded; account + job counted once each');

const week = await usageSince(env, ago(7));
assert.deepEqual(week, { presses: 4, passes: 8 }, 'plus the two ledger presses from before');

const daily = await usageDaily(env, ago(30));
assert.equal(daily.length, 2);
assert.equal(daily[0].passes, 5);
assert.equal(daily[1].passes, 3);

/* No usage rows yet: the ledger alone, as before. */
const fresh = { DB: d1() };
fresh.DB.raw.prepare("INSERT INTO ledger (user_id, delta, units, reason, at) VALUES ('u1', 0, 2, 'detect', ?)").run(ago(0.5));
assert.deepEqual(await usageSince(fresh, ago(1)), { presses: 1, passes: 2 });

console.log('usage: ok');
