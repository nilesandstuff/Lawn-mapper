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
import { findOrCreateUser, createSession, spendCredits, dailyState } from '../worker/src/db.js';
import { limits, setLimit, LIMIT_KEYS } from '../worker/src/limits.js';
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
    // The price list. Reading it is harmless; writing it is the whole site's
    // cost guardrail, so it is gated exactly like everything else.
    ['settings'], ['settings', { method: 'POST', body: { anon_daily: 100000 } }],
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

  // Out of the day's allowance, which is what an ordinary detection spends.
  await spendCredits(env, guest, 3, 'three passes', 30);
  await spendCredits(env, owner, 2, 'two passes', 30);   // unlimited: uncharged

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

  /*
   * WHAT IS OWED IS THE BOUGHT BALANCE, and only that.
   *
   * Daily allowances are not a liability -- they expire nightly whether or not
   * anybody spends them, and adding them in would report the site as owing
   * thirty passes to every account that ever signed in. What is owed is what
   * somebody was given or paid for and has not used.
   */
  const { grantCredits } = await import('../worker/src/db.js');
  await grantCredits(env, guest.id, 12, 'a pack');
  const owed = (await ask(env, ownerToken, 'overview')).body;
  check('and reports what is owed to accounts, which the allowance is not',
    owed.creditsOutstanding === 12, String(owed.creditsOutstanding));

  check('with a day-by-day shape for the bill',
    Array.isArray(body.daily) && body.daily[0]?.passes === 5,
    JSON.stringify(body.daily));
}

/* ------------------------------------------------------- the training corpus */
/*
 * THE COUNT THAT FORECASTS ANYTHING IS `corrected`, NOT `total`.
 *
 * A finished map whose outline is the detector's own output, accepted
 * unchanged, is a recording of the detector. Training on a pile of those
 * teaches a model to reproduce the thing it was meant to beat, so counting
 * them towards "enough data to train on" would forecast a milestone that
 * arrives and turns out to be worthless. The distinction is asserted here
 * rather than left to the SQL reading plausibly.
 */
{
  const { env, ownerToken } = await world();
  const { recordFinished } = await import('../worker/src/corpus.js');

  // A closed square. Rings shorter than four points are dropped as degenerate,
  // so this is the smallest shape the store will actually accept.
  const ring = (lng) => [
    [lng, 42.9], [lng, 42.901], [lng + 0.001, 42.901], [lng + 0.001, 42.9], [lng, 42.9],
  ];
  const finish = (lng, over) => recordFinished(env, {
    lng, lat: 42.9, model: 'sam-3', mode: 'subtractive',
    shapes: [{ type: 'Polygon', coordinates: [ring(lng)] }],
    ...over,
  });

  const empty = (await ask(env, ownerToken, 'overview')).body;
  check('an empty corpus reports zero rather than going missing',
    empty.corpus?.total === 0 && empty.corpus?.corrected === 0,
    JSON.stringify(empty.corpus));

  // Accepted as-is: the outline IS the detector's answer.
  const accepted = await finish(-85.61, { detectedSqFt: 5000, squareFeet: 5000 });
  check('a finished map is stored at all', accepted.ok === true,
    accepted.reason || 'ok');
  // A nudge -- two per cent. Somebody tidying an edge, not disagreeing.
  await finish(-85.62, { detectedSqFt: 5000, squareFeet: 5100 });
  // A real correction: a third of the lawn was wrong.
  await finish(-85.63, { detectedSqFt: 6000, squareFeet: 4000 });
  // Drawn from scratch, so there was never a detection to agree with.
  await finish(-85.64, { detectedSqFt: null, squareFeet: 3000 });

  const { body } = await ask(env, ownerToken, 'overview');
  check('the console counts every finished map', body.corpus.total === 4,
    JSON.stringify(body.corpus));
  check('but counts only the ones a person actually disagreed with',
    body.corpus.corrected === 2,
    'the accepted one and the two-per-cent nudge teach a model to be the detector');
  check('and a hand-drawn map counts, having no detection to agree with',
    body.corpus.corrected === 2,
    'detected_sq_ft IS NULL is a different kind of example, not a missing one');

  /*
   * A ROW SAVES WITHOUT ITS PHOTOGRAPH and that is on purpose -- storeImage
   * runs separately so a bad afternoon at Mapbox costs a picture and not the
   * outline. The console has to be able to show that gap, or a corpus of rows
   * with no imagery would read as ready to train on.
   */
  check('and says how many actually have a photograph', body.corpus.withImage === 0,
    'no bucket in this test, so every row is an outline with no picture yet');
}

/* -------------------------------------- when the corpus table is not there */
/*
 * The console is where you go when something is wrong, a half-applied schema
 * included. A nice-to-have count must not be able to take accounts, credits
 * and the AI spend down with it.
 */
{
  const { env, ownerToken } = await world();
  env.DB.prepare('DROP TABLE corpus').run();

  const { status, body } = await ask(env, ownerToken, 'overview');
  check('a missing corpus table does not break the overview', status === 200);
  check('the rest of the numbers still arrive', body.users === 2, JSON.stringify(body.users));
  check('and the corpus reports null, which the page words differently from zero',
    body.corpus === null,
    '"not recording" and "none yet" call for opposite reactions');
}

/* --------------------------------------------------------- the price list */
/*
 * THE NUMBERS HAVE TO BE CHANGEABLE FROM A PHONE, which is the whole reason
 * this route exists -- "is five a day too mean" is answered by changing it and
 * watching, and a change that costs a repository settings page and a deploy
 * does not get made often enough to answer anything.
 */
{
  const { env, ownerToken } = await world();

  const before = await ask(env, ownerToken, 'settings');
  const find = (body, key) => body.settings.find((s) => s.key === key);

  check('the console can read every limit',
    before.body.settings.length === LIMIT_KEYS.length,
    before.body.settings.map((s) => s.key).join(','));
  check('and a fresh deployment is already on working numbers',
    find(before.body, 'anon_daily').value === 5
    && find(before.body, 'free_daily').value === 30,
    'nobody has to open the console before the site works');
  check('which it says are the deployment\'s, not a stored choice',
    find(before.body, 'anon_daily').stored === false);

  const saved = await ask(env, ownerToken, 'settings',
    { method: 'POST', body: { anon_daily: 9, free_daily: 60 } });
  check('a written limit takes effect and is reported back',
    find(saved.body, 'anon_daily').value === 9 && find(saved.body, 'free_daily').value === 60,
    JSON.stringify(saved.body.settings.map((s) => `${s.key}=${s.value}`)));
  check('and is marked as a stored choice rather than an inherited number',
    find(saved.body, 'anon_daily').stored === true);

  /*
   * IT REACHES THE CHARGE, not just the console. A settings page that writes a
   * row nothing reads is the worst of both worlds: it looks like the limit
   * changed and the site keeps refusing at the old number.
   */
  const live = await limits(env);
  check('and the number the charge will use is the one just written',
    live.anon_daily === 9 && live.free_daily === 60, JSON.stringify(live));

  /*
   * ZERO HAS TO SURVIVE. "Nobody detects without an account" is a policy
   * somebody might want, and a `||` chain turns it back into the default
   * silently -- the kind of bug that presents as "I set it to zero and it
   * ignored me".
   */
  await ask(env, ownerToken, 'settings', { method: 'POST', body: { anon_daily: 0 } });
  check('zero is a limit, not a missing one',
    (await limits(env)).anon_daily === 0, String((await limits(env)).anon_daily));

  /* And a way back, or a mistyped number can only be fixed by remembering. */
  const cleared = await ask(env, ownerToken, 'settings',
    { method: 'POST', body: { anon_daily: null } });
  check('clearing one goes back to the deployment\'s own number',
    find(cleared.body, 'anon_daily').value === 5
    && find(cleared.body, 'anon_daily').stored === false,
    String(find(cleared.body, 'anon_daily').value));

  const bad = await ask(env, ownerToken, 'settings',
    { method: 'POST', body: { free_daily: 'lots' } });
  check('nonsense is refused rather than stored',
    bad.status === 400 && (await limits(env)).free_daily === 60,
    `${bad.status}: ${bad.body.error}`);

  const notASetting = await ask(env, ownerToken, 'settings',
    { method: 'POST', body: { admin_is_free: 1 } });
  check('and an invented key is refused rather than quietly kept',
    notASetting.status === 400, `${notASetting.status}`);
}

/* The deployment's variables are the defaults, and the table beats them. */
{
  const env = { DB: testDb(), ANON_DAILY: '7', WELCOME_CREDITS: '44' };
  check('a repository variable sets the default',
    (await limits(env)).anon_daily === 7, String((await limits(env)).anon_daily));
  /*
   * WELCOME_CREDITS IS STILL READ, deliberately. It is the variable this
   * deployment already has set, from when an account got a one-off grant
   * rather than a daily allowance -- so honouring it means the number the
   * owner already chose keeps applying across the change instead of silently
   * reverting to the built-in default.
   */
  check('and the old WELCOME_CREDITS name still means the free tier',
    (await limits(env)).free_daily === 44, String((await limits(env)).free_daily));

  await setLimit(env, 'free_daily', 12, 'a test');
  check('a stored setting beats the deployment\'s variable',
    (await limits(env)).free_daily === 12, String((await limits(env)).free_daily));

  /* A site with no database still has numbers rather than no limits at all. */
  check('and with no database at all the variables still apply',
    (await limits({ ANON_DAILY: '3' })).anon_daily === 3);
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

/* -------------------------------------------------------- vouching for one */
/*
 * THE ANSWER TO "A BUSINESS CANNOT USE THIS BECAUSE ITS OFFICE SHARES ONE IP".
 *
 * Eight people in an office behind one address are indistinguishable from
 * eight accounts made by one person, and no rule will ever separate them. So
 * one is not attempted: a person looks, decides, and sets the account's own
 * daily limit -- which both raises its allowance and takes it out of the
 * shared-address count entirely.
 */
{
  const { env, ownerToken, guest } = await world();

  const plain = await ask(env, ownerToken, 'users?q=guest');
  check('an ordinary account is on the tier and shows no limit of its own',
    plain.body.users[0].dailyLimit === null
    && plain.body.users[0].daily.limit === plain.body.tier,
    JSON.stringify(plain.body.users[0].daily));

  const raised = await ask(env, ownerToken, 'user',
    { method: 'POST', body: { id: guest.id, dailyLimit: 500 } });
  check('the console can give one account its own daily allowance',
    raised.body.user.dailyLimit === 500 && raised.body.user.daily.limit === 500,
    JSON.stringify(raised.body.user.daily));
  check('and the charge sees it, not just the console',
    (await dailyState(env, guest, 30)).limit === 500
    && (await dailyState(env, guest, 30)).own === true,
    JSON.stringify(await dailyState(env, guest, 30)));

  /* Both directions, or the console can only ever make exceptions. */
  const cleared = await ask(env, ownerToken, 'user',
    { method: 'POST', body: { id: guest.id, dailyLimit: null } });
  check('and can put the account back on the free tier',
    cleared.body.user.dailyLimit === null
    && (await dailyState(env, guest, 30)).own === false,
    JSON.stringify(cleared.body.user.daily));

  const bad = await ask(env, ownerToken, 'user',
    { method: 'POST', body: { id: guest.id, dailyLimit: 'plenty' } });
  check('nonsense is refused rather than stored as a limit of nothing',
    bad.status === 400, `${bad.status}: ${bad.body.error}`);
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
