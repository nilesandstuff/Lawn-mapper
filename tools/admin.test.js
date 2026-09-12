/**
 * The console, and above all who cannot open it.
 *
 * THE ONLY CHECK THAT REALLY MATTERS HERE is the first section: every route
 * refuses everybody who is not an administrator. The console can read the
 * measurement log, which is a list of where identifiable people live, and it
 * can hand out credits that cost real money. A hole in the gate is not a bug
 * in a feature, it is the feature working for the wrong person -- so it is
 * asserted route by route rather than once, because "it checked at the top" is
 * a property that survives exactly until somebody adds a route below the
 * check.
 *
 *   node tools/admin.test.js
 */

import { testDb } from './d1.js';
import { handleAdmin, isAdminPath } from '../worker/src/routes-admin.js';
import { findOrCreateUser, createSession, spendCredits } from '../worker/src/db.js';
import { SESSION_COOKIE } from '../worker/src/auth.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const json = (data, status) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const ctx = { waitUntil() {} };

const kv = () => {
  const store = new Map();
  return {
    store,
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
    async list({ prefix, limit }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { keys: keys.slice(0, limit).map((name) => ({ name })), list_complete: true };
    },
  };
};

async function world() {
  const env = { DB: testDb(), QUOTA: kv(), ADMIN_EMAILS: 'owner@b.com' };
  const owner = await findOrCreateUser(env, { email: 'owner@b.com', provider: 'email', subject: 'o' });
  const guest = await findOrCreateUser(env, { email: 'guest@b.com', name: 'Guest', provider: 'email', subject: 'g' });
  return {
    env,
    owner,
    guest,
    ownerToken: (await createSession(env, owner.id)).token,
    guestToken: (await createSession(env, guest.id)).token,
  };
}

const ask = async (env, token, path, { method = 'GET', body = null } = {}) => {
  const url = new URL(`https://site.test/api/admin/${path}`);
  const req = new Request(url, {
    method,
    headers: {
      Cookie: token ? `${SESSION_COOKIE}=${token}` : '',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await handleAdmin(req, env, url, '', ctx, json);
  return { status: res.status, body: await res.json() };
};

/* ------------------------------------------------------------- the gate */
/*
 * EVERY ROUTE, not just the first one. "It checked at the top" is a property
 * that survives until somebody adds a route below the check.
 */
{
  const { env, guestToken } = await world();
  const routes = [
    ['overview'], ['users'], ['log'], ['feedback'],
    ['ledger?user=usr_x'], ['user', { method: 'POST', body: { id: 'usr_x', grant: 1000 } }],
  ];

  const asStranger = [];
  const asGuest = [];
  for (const [path, opts] of routes) {
    asStranger.push((await ask(env, null, path, opts)).status);
    asGuest.push((await ask(env, guestToken, path, opts)).status);
  }

  check('a signed-out visitor is refused by every route',
    asStranger.every((s) => s === 404), asStranger.join(','));
  check('and so is an ordinary signed-in account',
    asGuest.every((s) => s === 404), asGuest.join(','));

  /*
   * 404 RATHER THAN 403, on purpose. "Forbidden" tells a stranger there is an
   * administration API here and that they have found it; "not found" tells
   * them nothing they did not already have.
   */
  check('and told nothing about what they found',
    (await ask(env, guestToken, 'overview')).body.error === 'Not found');

  /* A deployment with no account store has no console either. */
  const bare = await handleAdmin(
    new Request('https://s/api/admin/overview'), {},
    new URL('https://s/api/admin/overview'), '', ctx, json
  );
  check('with no account store, there is no console at all', bare.status === 404);

  check('and the router only sends admin paths here',
    isAdminPath('/api/admin/users') && !isAdminPath('/api/segment'));
}

/* An account whose credits were taken away is still not an administrator. */
{
  const { env, guest } = await world();
  await env.DB.prepare('UPDATE users SET unlimited = 1, credits = 9999 WHERE id = ?')
    .bind(guest.id).run();
  const token = (await createSession(env, guest.id)).token;
  check('unlimited credits do not make somebody an administrator',
    (await ask(env, token, 'overview')).status === 404,
    'the two are separate flags and the console checks the right one');
}

/* ---------------------------------------------------------- the numbers */
{
  const { env, ownerToken, owner, guest } = await world();

  await spendCredits(env, guest, 3, 'three passes');
  await spendCredits(env, owner, 2, 'two passes');   // unlimited: uncharged

  const { body } = await ask(env, ownerToken, 'overview');
  check('the console counts the accounts', body.users === 2, String(body.users));

  /*
   * THE OWNER'S DETECTIONS COUNT. Its account is uncharged, not unused -- the
   * balance does not move and Replicate still bills for the prediction. A
   * usage figure derived from credits alone would report the account doing the
   * most detecting as doing none, which is exactly backwards for the account
   * most likely to be running experiments.
   */
  check('and counts passes, including the ones nobody was charged for',
    body.today.passes === 5, `${body.today.passes} passes, ${body.today.presses} presses`);
  check('while still counting presses separately',
    body.today.presses === 2,
    'forty passes from ten people and from one person are different situations');

  check('and reports what is owed to accounts',
    body.creditsOutstanding === guest.credits - 3,
    String(body.creditsOutstanding));

  check('with a day-by-day shape for the bill',
    Array.isArray(body.daily) && body.daily[0]?.passes === 5,
    JSON.stringify(body.daily));
}

/* ----------------------------------------------------------- the people */
{
  const { env, ownerToken } = await world();

  const all = await ask(env, ownerToken, 'users');
  check('the list shows everybody', all.body.users.length === 2, String(all.body.users.length));
  check('and the true balance, which the account\'s own view hides',
    all.body.users.every((u) => typeof u.rawCredits === 'number'),
    'publicUser nulls credits for an unlimited account, correctly, and the '
    + 'console is the one place that needs the real number');

  const found = await ask(env, ownerToken, 'users?q=guest');
  check('searching finds one', found.body.users.length === 1, String(found.body.users.length));
  check('and by name as well as address',
    (await ask(env, ownerToken, 'users?q=Guest')).body.users.length === 1);

  /*
   * BINDING THE VALUE IS NOT ENOUGH FOR A LIKE, which is what this found. A
   * bound parameter cannot become SQL -- that part was never in question --
   * but `%` and `_` are wildcards inside a LIKE pattern wherever they come
   * from, so searching for "%" matched every account and "a_b" matched "axb".
   * Not an injection; a search box that quietly does something other than
   * search, noticed much later as "the filter is broken".
   */
  const wild = await ask(env, ownerToken, `users?q=${encodeURIComponent('%')}`);
  check('a search for a wildcard is a search for that character',
    wild.body.users.length === 0, `${wild.body.users.length} matched "%"`);
  const under = await ask(env, ownerToken, `users?q=${encodeURIComponent('gu_st')}`);
  check('and an underscore is an underscore, not "any character"',
    under.body.users.length === 0, `${under.body.users.length} matched "gu_st"`);
}

/* ---------------------------------------------------------- the changes */
{
  const { env, ownerToken, guest } = await world();

  const given = await ask(env, ownerToken, 'user',
    { method: 'POST', body: { id: guest.id, grant: 50, note: 'a refund' } });
  check('credits can be granted', given.body.user.rawCredits === guest.credits + 50,
    String(given.body.user.rawCredits));

  /* And it is on the ledger, so the balance stays explainable. */
  const history = await ask(env, ownerToken, `ledger?user=${guest.id}`);
  check('and the grant is on the ledger with its reason',
    history.body.entries.some((e) => e.reason === 'grant' && e.delta === 50 && /refund/.test(e.detail || '')),
    JSON.stringify(history.body.entries[0]));

  const taken = await ask(env, ownerToken, 'user',
    { method: 'POST', body: { id: guest.id, grant: -1000 } });
  check('taking more than there is stops at zero, not below',
    taken.body.user.rawCredits === 0, String(taken.body.user.rawCredits));

  const freed = await ask(env, ownerToken, 'user',
    { method: 'POST', body: { id: guest.id, unlimited: true } });
  check('an account can be made unlimited', freed.body.user.unlimited === true);

  const promoted = await ask(env, ownerToken, 'user',
    { method: 'POST', body: { id: guest.id, role: 'admin' } });
  check('and an administrator', promoted.body.user.admin === true);

  check('a change to an account that does not exist is refused',
    (await ask(env, ownerToken, 'user', { method: 'POST', body: { id: 'usr_nope', grant: 5 } })).status === 404);

  check('and a GET to the change route is refused',
    (await ask(env, ownerToken, 'user')).status === 405);
}

/*
 * YOU CANNOT TAKE YOUR OWN ADMIN AWAY. Recoverable in principle, since
 * ADMIN_EMAILS re-grants it at the next sign-in -- but only if the address is
 * still listed, and finding that out while locked out of the console is not a
 * thing to discover.
 */
{
  const { env, ownerToken, owner } = await world();
  const out = await ask(env, ownerToken, 'user',
    { method: 'POST', body: { id: owner.id, role: 'user' } });
  check('an administrator cannot remove their own access', out.status === 400, String(out.status));

  const still = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(owner.id).first();
  check('and is still one', still.role === 'admin', still.role);
}

/* ---------------------------------------------------- the logs, unlocked */
/*
 * READ BECAUSE THIS PERSON IS AN ADMINISTRATOR, not because a shared token
 * happens to be configured. Passing the token to itself to hand back read as a
 * check and was not one -- it made the console's access depend on a setting
 * with nothing to do with who is signed in, so a deployment with no LOG_TOKEN
 * had an administrator who could not see the log.
 */
{
  const { env, ownerToken } = await world();
  env.LOG_TESTS = '1';
  env.FEEDBACK = '1';
  delete env.LOG_TOKEN;

  await env.QUOTA.put('log:0000000001:aaa', JSON.stringify({ address: '1 Test St', outcome: 'succeeded' }));
  await env.QUOTA.put('fb:0000000001:bbb', JSON.stringify({ address: '1 Test St', rating: 'bad' }));

  const log = await ask(env, ownerToken, 'log');
  check('an administrator reads the log with no token configured',
    log.body.logging === true && log.body.entries.length === 1,
    JSON.stringify(log.body).slice(0, 90));

  const fb = await ask(env, ownerToken, 'feedback');
  check('and the feedback the same way',
    fb.body.enabled === true && fb.body.entries.length === 1);

  /* Switched off is distinguishable from empty, which is the useful part. */
  const quiet = { ...env, LOG_TESTS: '0', FEEDBACK: '0' };
  check('and a switched-off log says so rather than looking empty',
    (await ask(quiet, ownerToken, 'log')).body.logging === false
    && (await ask(quiet, ownerToken, 'feedback')).body.enabled === false);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
