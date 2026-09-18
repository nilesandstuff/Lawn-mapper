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
    ['overview'], ['users'], ['log'], ['feedback'], ['corpus'],
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
 * TWO RATES, COUNTED SEPARATELY.
 *
 * Finished maps arrive far faster than disagreements with the detector do,
 * and a future training set wants both: the accepted ones are most of what a
 * model would meet and are where its sense of an ordinary lawn comes from,
 * while the corrected ones are the only evidence of what the detector gets
 * wrong. One number cannot say how much of each there is, so the split is
 * asserted here rather than left to the SQL reading plausibly.
 *
 * The ten-per-cent line is the interesting part and the easiest to get
 * subtly wrong, so a nudge and a real correction are both fed in.
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
  check('and counts separately the ones a person disagreed with',
    body.corpus.corrected === 2,
    'the accepted map and the two-per-cent nudge are kept, just not counted here');
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
  check('and it says WHY rather than going quiet',
    typeof body.corpus?.unavailable === 'string' && /corpus/i.test(body.corpus.unavailable),
    body.corpus?.unavailable);
}

/* ------------------------------- the column that was missing for six deploys */
/*
 * THE EXACT SHAPE OF THE LIVE FAULT, reproduced.
 *
 * `corpus` shipped with sixteen columns. image_key was added to the CREATE
 * four hours later, and CREATE TABLE IF NOT EXISTS does nothing whatever to a
 * table that already exists -- so six deploys reported "schema applied" while
 * the live table stayed at sixteen columns. Rows kept saving, because the
 * INSERT names only the original columns. Reading broke, and said nothing:
 * the count selected image_key, got "no such column", and the catch turned a
 * complete diagnosis into the word "null".
 *
 * This asserts the console now hands back the database's own sentence, because
 * that sentence is the entire difference between a five-minute fix and an
 * afternoon of reading deploy logs.
 */
{
  const { env, ownerToken } = await world();
  env.DB.prepare('DROP TABLE corpus').run();
  env.DB.prepare(`CREATE TABLE corpus (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, lng REAL, lat REAL, county TEXT,
    provider TEXT, model TEXT, mode TEXT, hand_edited INTEGER NOT NULL DEFAULT 0,
    detected_sq_ft INTEGER, square_feet INTEGER, parcel_sq_ft INTEGER,
    frame TEXT, parcel TEXT, shapes TEXT NOT NULL, created_at TEXT NOT NULL
  )`).run();

  const { status, body } = await ask(env, ownerToken, 'overview');
  check('the old sixteen-column table does not break the console', status === 200);
  check('and the console names the missing column',
    /no such column/i.test(body.corpus?.unavailable || '')
      && /image_key/.test(body.corpus?.unavailable || ''),
    body.corpus?.unavailable);

  /*
   * And the migration fixes it -- the same two statements ci-prepare runs,
   * applied here to prove they turn the broken table into a readable one.
   */
  const { parseMigrations, alreadyApplied } = await import('./ci-prepare.js');
  const { readFileSync } = await import('node:fs');
  const sql = parseMigrations(
    readFileSync(new URL('../worker/migrations.sql', import.meta.url), 'utf8')
  );
  check('migrations.sql carries an ALTER for every column added since creation',
    sql.some((s) => /corpus ADD COLUMN image_key/i.test(s))
      && sql.some((s) => /corpus ADD COLUMN image_provider/i.test(s))
      && sql.some((s) => /ledger ADD COLUMN units/i.test(s)),
    sql.join(' | '));

  let already = 0;
  for (const statement of sql) {
    // AWAITED inside the try: run() is async, so without this the rejection
    // sails straight past a synchronous catch and lands as an unhandled one.
    try { await env.DB.prepare(statement).run(); } catch (e) {
      if (alreadyApplied(e.message)) already++; else throw e;
    }
  }
  check('and "duplicate column name" is read as already done, not as a failure',
    already === 1, `ledger.units was already current; ${already} statement(s) skipped`);

  const after = await ask(env, ownerToken, 'overview');
  check('after the migration the count reads clean',
    after.body.corpus?.total === 0 && after.body.corpus?.unavailable === undefined,
    JSON.stringify(after.body.corpus));
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


/* ------------------------------------------------ the training-data panel */
{
  const { env, ownerToken, guestToken } = await world();
  const { recordFinished } = await import('../worker/src/corpus.js');

  check('the corpus panel is refused to everybody who is not an administrator',
    (await ask(env, guestToken, 'corpus')).status === 404);
  check('and to a visitor with no session at all',
    (await ask(env, null, 'corpus')).status === 404);

  const ring = (lng) => [
    [lng, 42.9], [lng, 42.901], [lng + 0.001, 42.901], [lng + 0.001, 42.9], [lng, 42.9],
  ];
  const finish = (lng, over) => recordFinished(env, {
    lng, lat: 42.9, model: 'sam-3', mode: 'exclude',
    shapes: [{ type: 'Polygon', coordinates: [ring(lng)] }],
    ...over,
  });

  const empty = (await ask(env, ownerToken, 'corpus')).body;
  check('an empty corpus reports zero rather than failing',
    empty.stats.total === 0 && Array.isArray(empty.gaps),
    JSON.stringify(empty.stats));

  // Two lawns a long way apart, one with a tree line and a real correction.
  await finish(-85.70, {
    county: 'mi-kent', detectedSqFt: 6000, squareFeet: 4000,
    exclusions: ['woods'], parcelSource: 'county',
  });
  await finish(-97.40, {
    county: 'tx-travis', detectedSqFt: 5000, squareFeet: 5000,
    parcelSource: 'hand',
  });

  /*
   * APPROVED, because the panel measures the training set and a candidate is
   * not in it yet. Counting unreviewed rows would read 1,000 while 300 are
   * verified, which is the one number on that page that must not be hopeful.
   */
  const approveAll = () => env.DB.prepare(
    "UPDATE corpus SET status = 'approved', review_queue = 'priority'"
  ).run();
  await approveAll();

  const { body } = await ask(env, ownerToken, 'corpus');
  check('the panel counts the approved maps', body.stats.total === 2, JSON.stringify(body.stats));
  /*
   * ZERO, though one of these ticked Trees during its detection. That tick is
   * a hint for the review queue and no longer the measurement: until somebody
   * looks at the photograph and grades the canopy, there is nothing in the
   * count. See the section at the end of this file.
   */
  check('ticking Trees during a detection does not by itself count as heavy canopy',
    body.stats.heavyCanopy === 0,
    'it records how the AI was run, not what is on the ground');
  check('and the hand-traced property lines', body.stats.handParcel === 1);
  check('and how many have the AI\'s own outline to compare against',
    body.stats.withDetection === 0,
    'neither of these carried one, which the panel should say rather than assume');

  /*
   * A HAND-TRACED ROW HAS NO COUNTY and must not become one. Before this, the
   * app sent the words "traced by hand" in the county column, so every such
   * row joined one enormous fake county -- and the leave-one-county-out check
   * would have held it out as though it were a region.
   */
  await finish(-86.20, { county: null, parcelSource: 'hand', squareFeet: 900 });
  await approveAll();
  const withHand = (await ask(env, ownerToken, 'corpus')).body;
  check('a traced boundary does not invent a county',
    withHand.stats.counties === 2,
    `${withHand.stats.counties} counties across 3 maps, two of which are real places`);
  check('though it still shows up in the breakdown, named honestly',
    withHand.counties.some((c) => c.name === '(traced by hand)'),
    JSON.stringify(withHand.counties));

  check('two lawns a long way apart count as two separate places',
    withHand.stats.blocks === 3, String(withHand.stats.blocks));

  check('and the advice leads with whatever is furthest behind',
    Array.isArray(withHand.gaps) && withHand.gaps[0].have < withHand.gaps[0].need,
    withHand.gaps[0]?.label);
}

/* ----------------------------- the corpus panel when the table is missing */
{
  const { env, ownerToken } = await world();
  env.DB.prepare('DROP TABLE corpus').run();
  const { status, body } = await ask(env, ownerToken, 'corpus');
  check('a missing corpus table says so instead of erroring', status === 200);
  check('and names the reason', /corpus/i.test(body.unavailable || ''), body.unavailable);
}

/* ------------------------------------------------------ reviewing candidates */
{
  const { env, ownerToken, guestToken } = await world();
  const { recordFinished } = await import('../worker/src/corpus.js');

  for (const p of ['candidates', 'candidate?id=x', 'candidate-image?id=x']) {
    check(`${p.split('?')[0]} is refused to an ordinary account`,
      (await ask(env, guestToken, p)).status === 404);
  }
  check('and a verdict cannot be cast by one either',
    (await ask(env, guestToken, 'review',
      { method: 'POST', body: { id: 'x', status: 'approved' } })).status === 404);

  const ring = (lng) => [
    [lng, 42.9], [lng, 42.901], [lng + 0.001, 42.901], [lng + 0.001, 42.9], [lng, 42.9],
  ];
  const finish = (lng, over) => recordFinished(env, {
    lng, lat: 42.9, model: 'sam-3', mode: 'exclude',
    shapes: [{ type: 'Polygon', coordinates: [ring(lng)] }],
    ...over,
  });

  // A dull one and an interesting one, finished in that order.
  await finish(-85.70, { county: 'mi-kent', detectedSqFt: 5000, squareFeet: 5000 });
  await finish(-97.40, {
    county: 'tx-travis', detectedSqFt: 6000, squareFeet: 4000, exclusions: ['woods'],
  });

  const q = (await ask(env, ownerToken, 'candidates')).body;
  check('both finished maps arrive as candidates', q.waiting === 2, String(q.waiting));
  check('and the more useful one is offered first',
    q.candidates[0].county === 'tx-travis',
    `${q.candidates[0].county} — ${q.candidates[0].why?.join(', ')}`);
  check('with the reason it was chosen',
    q.candidates[0].why.length > 0, q.candidates[0].why?.join(', '));
  check('and everything needed to draw it',
    q.candidates[0].frame === null || typeof q.candidates[0].frame === 'object',
    'frame, parcel and shapes all parsed rather than left as text');
  /*
   * Features now, because a shape needs somewhere to carry "inferred, not
   * seen". Bare geometries from before that change still read -- the console
   * accepts either -- but anything written today has the richer form.
   */
  check('shapes arrive parsed, not as a string',
    Array.isArray(q.candidates[0].shapes)
    && q.candidates[0].shapes[0].geometry?.type === 'Polygon',
    JSON.stringify(q.candidates[0].shapes?.[0])?.slice(0, 90));

  /* ------------------------------------------------ a verdict, and its effects */
  const id = q.candidates[0].id;
  check('approving works',
    (await ask(env, ownerToken, 'review',
      { method: 'POST', body: { id, status: 'approved' } })).body.ok === true);

  const after = (await ask(env, ownerToken, 'candidates')).body;
  check('an approved map leaves the queue', after.waiting === 1, String(after.waiting));

  const panel = (await ask(env, ownerToken, 'corpus')).body;
  check('and the targets count it', panel.stats.total === 1, JSON.stringify(panel.stats));
  check('while the unreviewed one is reported separately, not as progress',
    panel.stats.waiting === 1,
    'counting candidates would read 1,000 while 300 are verified');

  /*
   * A DOUBLE TAP MUST NOT OVERWRITE THE FIRST VERDICT. The update is guarded
   * on status = 'new', so a second press on a slow connection is refused
   * rather than quietly replacing an approval with a rejection.
   */
  const again = await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id, status: 'rejected' } });
  check('and judging the same map twice is refused rather than applied',
    again.status === 409 && again.body.reason === 'already-reviewed-or-changed',
    JSON.stringify(again.body));

  check('a verdict that is neither approve nor reject is refused',
    (await ask(env, ownerToken, 'review',
      { method: 'POST', body: { id, status: 'maybe' } })).status === 400);

  /* Which queue surfaced it is stored, because nothing else could say later. */
  const stored = await env.DB.prepare(
    'SELECT status, review_queue, reviewed_by FROM corpus WHERE id = ?1'
  ).bind(id).first();
  check('the verdict records which queue it came from',
    stored.status === 'approved' && stored.review_queue === 'priority'
      && stored.reviewed_by === 'owner@b.com',
    JSON.stringify(stored),
    );

  /* ------------------------- re-finishing invalidates an approval, on purpose */
  await finish(-97.40, {
    county: 'tx-travis', detectedSqFt: 6000, squareFeet: 4444, exclusions: ['woods'],
  });
  const reset = await env.DB.prepare(
    'SELECT status, reviewed_at, review_queue FROM corpus WHERE id = ?1'
  ).bind(id).first();
  check('editing an approved map sends it back to be reviewed again',
    reset.status === 'new' && reset.reviewed_at === null && reset.review_queue === null,
    'the approval was of the outline, and the outline just changed');

  /* ----------------- and the trap: an edit must not eat the AI's own outline */
  await finish(-86.50, {
    county: 'mi-kent', detectedSqFt: 6000, squareFeet: 4000,
    detectedShapes: [{ geometry: { type: 'Polygon', coordinates: [ring(-86.5001)] } }],
  });
  const before = await env.DB.prepare(
    'SELECT detected_shapes FROM corpus WHERE lng = ?1'
  ).bind(-86.5).first();
  check('an AI outline is stored to begin with', before.detected_shapes !== null);

  // Exactly what a review edit sends: the corrected shape, and no detection,
  // because reopening a map deliberately clears it.
  await finish(-86.50, { county: 'mi-kent', detectedSqFt: 6000, squareFeet: 4200 });
  const kept = await env.DB.prepare(
    'SELECT detected_shapes, square_feet FROM corpus WHERE lng = ?1'
  ).bind(-86.5).first();
  check('but a review edit does NOT erase it',
    kept.detected_shapes === before.detected_shapes && kept.square_feet === 4200,
    'a plain assignment here would have silently deleted the only record of '
    + 'what the AI drew, which is what makes the overshoot measurable');
}

/* ------------------------------------------------ what counts as a tree line */
/*
 * IT IS THE REVIEWER'S EYE, NOT THE EXCLUSION LIST.
 *
 * The count used to be `exclusions LIKE '%woods%'`, which records that
 * somebody ticked the Trees box during an exclude-mode detection. That is a
 * choice about how the AI was run: the box is off by default and does not
 * exist at all in Find-grass or hand-drawn mode, so a wooded lot traced by
 * hand counted zero -- and the counter sat near zero while the corpus filled
 * with exactly the lawns it was meant to be finding.
 */
{
  const { env, ownerToken } = await world();
  const { recordFinished } = await import('../worker/src/corpus.js');

  const ring = (lng) => [
    [lng, 42.9], [lng, 42.901], [lng + 0.001, 42.901], [lng + 0.001, 42.9], [lng, 42.9],
  ];
  const finish = (lng, over) => recordFinished(env, {
    lng, lat: 42.9, model: 'sam-3', mode: 'find', county: 'mi-kent',
    shapes: [{ type: 'Polygon', coordinates: [ring(lng)] }],
    squareFeet: 4000, ...over,
  });

  /* A wooded lot measured in Find-grass mode: no exclusions exist at all. */
  await finish(-85.11, {});
  /* And one where Trees WAS ticked, which is only a hint. */
  await finish(-85.22, { mode: 'exclude', exclusions: ['woods'] });

  const queue = (await ask(env, ownerToken, 'candidates')).body.candidates;
  const wooded = queue.find((c) => c.id.startsWith('-85.11'));
  const ticked = queue.find((c) => c.id.startsWith('-85.22'));

  check('a map with the Trees box ticked arrives with the grade pre-set',
    ticked?.canopyHint === true, JSON.stringify(ticked?.canopyHint));
  check('and one measured in Find-grass mode does not, having no exclusions',
    wooded?.canopyHint === false,
    'which is the whole fault: the lot may be covered in trees and nothing in '
    + 'the row can know');

  /* Grading it as "canopy decided the edge" is what makes it count. */
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: wooded.id, status: 'approved', canopy: 2 } });
  /* And the pre-set hint can be overruled: it is a suggestion, not the answer. */
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: ticked.id, status: 'approved', canopy: 0 } });

  const panel = (await ask(env, ownerToken, 'corpus')).body;
  check('the hand-judged wooded lot counts, though no exclusion ran on it',
    panel.stats.heavyCanopy === 1, JSON.stringify(panel.stats.heavyCanopy));
  check('and the ticked-Trees map does NOT, because the reviewer said none',
    panel.stats.total === 2 && panel.stats.heavyCanopy === 1,
    'the tick was evidence; the eye is the measurement');

  const stored = await env.DB.prepare(
    'SELECT tree_line FROM corpus WHERE id = ?1'
  ).bind(ticked.id).first();
  check('a "none" is stored as a none rather than as nothing',
    stored.tree_line === 0,
    '"looked, no canopy" and "nobody looked" have to stay different answers');

  /*
   * THE MIDDLE GRADE IS RECORDED AND DOES NOT COUNT.
   *
   * This is the whole reason the tick box became a grade. "Any trees that make
   * the cover ambiguous" is true of every lawn on a wooded street, so a yes/no
   * would be yes everywhere and the hard slice would be the whole corpus. Only
   * "canopy decided the edge" counts toward it.
   */
  await finish(-85.44, {});
  const some = (await ask(env, ownerToken, 'candidates')).body.candidates
    .find((c) => c.id.startsWith('-85.44'));
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: some.id, status: 'approved', canopy: 1 } });

  const graded = (await ask(env, ownerToken, 'corpus')).body;
  check('a lawn with some canopy is recorded without counting as a hard case',
    graded.stats.anyCanopy === 2 && graded.stats.heavyCanopy === 1,
    `any=${graded.stats.anyCanopy} heavy=${graded.stats.heavyCanopy}`);

  /*
   * And the old boolean still lands somewhere sensible, because a console left
   * open in a tab keeps sending one until it is reloaded.
   */
  await finish(-85.55, {});
  const legacy = (await ask(env, ownerToken, 'candidates')).body.candidates
    .find((c) => c.id.startsWith('-85.55'));
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: legacy.id, status: 'approved', treeLine: true } });
  const after = (await ask(env, ownerToken, 'corpus')).body;
  check('an old console still sending a tick is read as the strong grade',
    after.stats.heavyCanopy === 2,
    '"has a tree line" meant this lawn is a tree-line case');

  /*
   * MAPS APPROVED BEFORE THE QUESTION EXISTED CAN STILL ANSWER IT.
   *
   * Every row approved under the old tick box carries no grade, and the report
   * that started this said as much: none of them are marked. Without a way
   * back those rows could never count toward the hard slice however wooded
   * they are -- the definition changed under them, which is the one case where
   * re-opening a settled verdict is the honest thing to do.
   */
  await env.DB.prepare(
    "UPDATE corpus SET status = 'approved', tree_line = NULL WHERE id = ?1"
  ).bind(some.id).run();

  const ungraded = (await ask(env, ownerToken, 'candidates?queue=ungraded')).body.candidates;
  check('an approved map with no grade comes back round to be graded',
    ungraded.some((c) => c.id === some.id),
    ungraded.map((c) => c.id).join(', ') || '(the queue was empty)');
  check('and rows that already have one do not',
    !ungraded.some((c) => c.id === wooded.id),
    'a queue that never empties is not a queue');

  /*
   * Grading it re-affirms the verdict rather than changing it, and keeps the
   * draw that surfaced it: relabelling the row 'ungraded' would lose whether
   * it may sit in the representative slice.
   */
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: some.id, status: 'approved', queue: 'priority', canopy: 2 } });
  const regraded = (await ask(env, ownerToken, 'corpus')).body;
  check('grading an already-approved map counts it without re-approving it',
    regraded.stats.heavyCanopy === 3 && regraded.stats.total === after.stats.total,
    `heavy=${regraded.stats.heavyCanopy} total=${regraded.stats.total}`);

  /*
   * BUT A VERDICT STILL CANNOT BE CHANGED BY A STALE TAP. That is what the
   * status guard was always for -- not "write once", but "do not let a second
   * press change somebody's mind for them".
   */
  const flipped = await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: some.id, status: 'rejected' } });
  check('an approved map cannot be flipped to rejected by a later request',
    flipped.body.ok === false,
    JSON.stringify(flipped.body));

  /* A verdict with no opinion leaves it unjudged rather than guessing. */
  await finish(-85.33, {});
  const third = (await ask(env, ownerToken, 'candidates')).body.candidates
    .find((c) => c.id.startsWith('-85.33'));
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: third.id, status: 'approved' } });
  const silent = await env.DB.prepare(
    'SELECT tree_line FROM corpus WHERE id = ?1'
  ).bind(third.id).first();
  check('and saying nothing about trees leaves it unjudged, not "no"',
    silent.tree_line === null,
    'every approval made before this existed stays honestly unanswered');
}

/*
 * LOOKING BACK AT MAPS THAT WERE ALREADY JUDGED.
 *
 * Approving used to be one-way. That was fine while the only question was "is
 * this good enough to train on", and stopped being fine once the question
 * became "did the app save what the person actually drew" -- which cannot be
 * answered from the outside of a settled row. So there are two more queues,
 * and a deliberate way to change a verdict that is still not the same thing as
 * a stale tap changing one by accident.
 */
{
  const { env, ownerToken } = await world();
  const { recordFinished } = await import('../worker/src/corpus.js');

  const ring = (lng) => [
    [lng, 41.5], [lng, 41.501], [lng + 0.001, 41.501], [lng + 0.001, 41.5], [lng, 41.5],
  ];
  const finish = (lng) => recordFinished(env, {
    lng, lat: 41.5, model: 'sam-3', mode: 'find', county: 'oh-lucas',
    shapes: [{ type: 'Polygon', coordinates: [ring(lng)] }],
    squareFeet: 4000,
  });

  await finish(-83.11);
  await finish(-83.22);

  const fresh = (await ask(env, ownerToken, 'candidates')).body.candidates;
  const good = fresh.find((c) => c.id.startsWith('-83.11'));
  const bad = fresh.find((c) => c.id.startsWith('-83.22'));

  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: good.id, status: 'approved', queue: 'random', canopy: 1 } });
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: bad.id, status: 'rejected', queue: 'priority' } });

  const approvedQ = (await ask(env, ownerToken, 'candidates?queue=approved')).body.candidates;
  const rejectedQ = (await ask(env, ownerToken, 'candidates?queue=rejected')).body.candidates;

  check('an approved map can be found again',
    approvedQ.some((c) => c.id === good.id),
    approvedQ.map((c) => c.id).join(', ') || '(empty)');
  check('and a rejected one, which had nowhere to be looked at before',
    rejectedQ.some((c) => c.id === bad.id),
    rejectedQ.map((c) => c.id).join(', ') || '(empty)');
  check('the two queues do not leak into each other',
    !approvedQ.some((c) => c.id === bad.id) && !rejectedQ.some((c) => c.id === good.id));

  /*
   * The card has to be able to SAY what it is looking at before it offers to
   * change it. A button reading "Reject" over an already-rejected map is a
   * button that does nothing, and the reviewer cannot tell.
   */
  const back = approvedQ.find((c) => c.id === good.id);
  check('the row arrives carrying its verdict',
    back.status === 'approved' && Boolean(back.reviewedAt),
    JSON.stringify({ status: back.status, at: back.reviewedAt }));
  check('and the grade already on it, not the woods-box guess',
    back.canopy === 1,
    'showing the guess would overwrite a real answer on the next save');

  /* Unchanged: a request with no say in the matter still cannot flip one. */
  const stale = await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: bad.id, status: 'approved' } });
  check('a bare request still cannot change a settled verdict',
    stale.body.ok === false,
    JSON.stringify(stale.body));

  /* Saying so plainly can. */
  const deliberate = await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: bad.id, status: 'approved', queue: 'priority', canopy: 0, force: true } });
  check('but a deliberate change of mind goes through',
    deliberate.body.ok === true,
    JSON.stringify(deliberate.body));

  const moved = await env.DB.prepare(
    'SELECT status, tree_line FROM corpus WHERE id = ?1'
  ).bind(bad.id).first();
  check('and the row really moves',
    moved.status === 'approved' && moved.tree_line === 0,
    JSON.stringify(moved));

  /*
   * The draw that surfaced a row must survive being looked at again: it is
   * what tells the export whether the row may sit in the representative slice,
   * and browsing is not a draw.
   */
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: good.id, status: 'approved', queue: 'random', canopy: 2, force: true } });
  const kept = await env.DB.prepare(
    'SELECT review_queue FROM corpus WHERE id = ?1'
  ).bind(good.id).first();
  check('and re-judging keeps which queue originally surfaced it',
    kept.review_queue === 'random',
    kept.review_queue);
}

/*
 * WHERE PEOPLE ASKED AND GOT NOTHING.
 *
 * The counties list grew by somebody noticing a server existed, which selects
 * for counties that are easy to add rather than ones anybody wants. This is
 * the evidence for the other question, and it is only evidence if the two
 * numbers mean what they say.
 */
{
  const { env, ownerToken } = await world();
  const { recordParcelGap } = await import('../worker/src/gaps.js');

  /* One county, one person, asked four times. */
  for (let i = 0; i < 4; i++) {
    await recordParcelGap(env, { county: 'Kalamazoo County', state: 'MI', who: 'alice' });
  }
  /* Another, three different people, once each. */
  for (const who of ['bob', 'carol', 'dave']) {
    await recordParcelGap(env, { county: 'Barry County', state: 'MI', who });
  }

  const byHits = (await ask(env, ownerToken, 'parcel-gaps?sort=hits')).body;
  const byPeople = (await ask(env, ownerToken, 'parcel-gaps?sort=people')).body;

  const kzoo = byHits.places.find((p) => p.county === 'Kalamazoo County');
  const barry = byHits.places.find((p) => p.county === 'Barry County');

  /*
   * THE DISTINCTION THE WHOLE THING RESTS ON. Four lookups from one person and
   * three from three people: whichever number you read alone, you get the
   * counties the wrong way round. One is somebody stuck -- quite possibly the
   * owner testing -- and the other is demand.
   */
  check('repeat lookups by one person count as one person',
    kzoo?.hits === 4 && kzoo?.people === 1,
    JSON.stringify(kzoo));
  check('and separate people are counted separately',
    barry?.hits === 3 && barry?.people === 3,
    JSON.stringify(barry));

  check('sorting by times asked puts the busiest county first',
    byHits.places[0].county === 'Kalamazoo County',
    byHits.places.map((p) => `${p.county}:${p.hits}`).join(', '));
  check('and sorting by people puts the most wanted county first',
    byPeople.places[0].county === 'Barry County',
    byPeople.places.map((p) => `${p.county}:${p.people}`).join(', '));

  /*
   * A county that IS configured and still answered nothing is a different job
   * from one that is missing -- a server to look at rather than a county to
   * add -- so the two are never one row type.
   */
  await recordParcelGap(env, { county: 'Kent County', state: 'MI', who: 'erin', covered: true });
  const withKent = (await ask(env, ownerToken, 'parcel-gaps?sort=hits')).body;
  check('a configured county that answered nothing is marked as such',
    withKent.places.find((p) => p.county === 'Kent County')?.configured === true,
    'adding a county that is already in the list would be the wrong fix');
  check('and one that was never configured is not',
    withKent.places.find((p) => p.county === 'Barry County')?.configured === false);

  /*
   * A MISS WITH NO COUNTY NAME IS NOT RECORDED. Most of those are the sea, or
   * a point the geocoder placed outside any county it names. Filing them under
   * "unknown" would build the biggest row in the table out of precisely the
   * cases nobody can act on, and put it at the top of the ranking.
   */
  const before = (await ask(env, ownerToken, 'parcel-gaps')).body.places.length;
  check('a lookup with no county name is dropped rather than filed as unknown',
    (await recordParcelGap(env, { county: null, state: 'MI', who: 'frank' })) === false
    && (await recordParcelGap(env, { county: '   ', state: '', who: 'frank' })) === false,
    'an "unknown" row would outgrow every real one and rank above them');
  check('and nothing was added to the list by trying',
    (await ask(env, ownerToken, 'parcel-gaps')).body.places.length === before);

  /*
   * An unknown sort must not reach the database. ORDER BY cannot be a bound
   * parameter, so the only safe shape is a fixed map with a fallback.
   */
  const odd = (await ask(env, ownerToken, 'parcel-gaps?sort=hits;DROP TABLE users--')).body;
  check('an unrecognised sort falls back rather than being interpolated',
    odd.sort === 'hits' && Array.isArray(odd.places),
    JSON.stringify(odd.sort));

  /*
   * And it must never be able to break the lookup it rides along with. The
   * parcel route's job is to say whether there is a boundary; a bookkeeping
   * table that is missing must not turn that into a failed request.
   */
  await env.DB.prepare('DROP TABLE parcel_gaps').run();
  let threw = null;
  try {
    await recordParcelGap(env, { county: 'Ottawa County', state: 'MI', who: 'gail' });
  } catch (e) { threw = e.message; }
  check('recording a miss with no table to write to fails quietly',
    threw === null,
    threw || 'a visitor being turned away must not also get an error');
}

/*
 * ------------------------------------------------------ every map, and a
 * verdict cast from the list rather than from a queue.
 *
 * The list is where duplicates are visible, so it is where one of them gets
 * rejected. That verdict goes through the same route the console uses, and
 * the risk is entirely in what ELSE that route writes: it sets the queue and
 * the canopy grade outright, so a caller that does not send them back erases
 * them while doing something that looks unrelated.
 */
{
  const { env, ownerToken, guestToken } = await world();
  const { recordFinished } = await import('../worker/src/corpus.js');

  check('the every-map list is refused to everybody who is not an administrator',
    (await ask(env, guestToken, 'maps')).status === 404);
  check('and to a visitor with no session at all',
    (await ask(env, null, 'maps')).status === 404);

  const ring = (lng) => [
    [lng, 42.9], [lng, 42.901], [lng + 0.001, 42.901], [lng + 0.001, 42.9], [lng, 42.9],
  ];
  /* Two maps eleven metres apart -- the duplicate this page exists for -- and
     one a long way off that must not be dragged into the pair. */
  await recordFinished(env, {
    lng: -85.70, lat: 42.9, model: 'sam-3', mode: 'exclude', county: 'mi-kent',
    squareFeet: 4000,
    shapes: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(-85.70)] } },
      { type: 'Feature', properties: { inferred: true }, geometry: { type: 'Polygon', coordinates: [ring(-85.702)] } },
    ],
  });
  await recordFinished(env, {
    lng: -85.70001, lat: 42.9, model: 'sam-3', mode: 'include', county: 'mi-kent',
    squareFeet: 3900,
    shapes: [{ type: 'Polygon', coordinates: [ring(-85.70001)] }],
  });
  await recordFinished(env, {
    lng: -97.40, lat: 42.9, model: 'sam-3', mode: 'exclude', county: 'tx-travis',
    squareFeet: 5000,
    shapes: [{ type: 'Polygon', coordinates: [ring(-97.40)] }],
  });

  /* Approved out of the RANDOM draw and graded, which is the state that has
     something to lose: both facts are about to travel through a page whose
     job has nothing to do with either. */
  await env.DB.prepare(
    "UPDATE corpus SET status = 'approved', review_queue = 'random', tree_line = 2"
  ).run();

  const list = (await ask(env, ownerToken, 'maps')).body;
  check('the list carries every map', list.maps.length === 3, String(list.maps.length));
  check('and groups the two that are the same lawn',
    list.duplicates.length === 1 && list.duplicates[0].length === 2,
    JSON.stringify(list.duplicates));

  const twin = list.maps.find((m) => m.marked > 0);
  check('and says which copy has the inferred marks on it',
    twin && twin.marked === 1 && twin.pieces === 2,
    JSON.stringify(twin && { pieces: twin.pieces, marked: twin.marked }));
  check('and hands back the queue and grade the page will have to return',
    twin.reviewQueue === 'random' && twin.canopy === 2,
    JSON.stringify({ queue: twin.reviewQueue, canopy: twin.canopy }));

  /* The whole point of the page: drop one copy. */
  const loser = list.maps.find((m) => m.id !== twin.id && m.county === 'mi-kent');
  const verdict = await ask(env, ownerToken, 'review', {
    method: 'POST',
    body: {
      id: loser.id, status: 'rejected', force: true,
      queue: loser.reviewQueue || 'list', canopy: loser.canopy,
    },
  });
  check('a duplicate can be rejected from the list', verdict.body.ok === true,
    JSON.stringify(verdict.body));

  const after = await env.DB.prepare(
    'SELECT status, review_queue, tree_line FROM corpus WHERE id = ?1'
  ).bind(loser.id).first();
  check('and it really is rejected', after.status === 'rejected', JSON.stringify(after));
  /*
   * THE TWO COLUMNS THAT ARE NOT THE POINT. `random` is the only value meaning
   * "drawn blind", and it is what lets a row sit in the representative slice
   * of the eval; the grade is somebody's reading of a photograph. Rejecting a
   * duplicate is not a reason to lose either, and if this page ever forgets to
   * send them back, the loss is silent.
   */
  check('without losing which draw surfaced it',
    after.review_queue === 'random', after.review_queue);
  check('or the canopy grade somebody gave it',
    after.tree_line === 2, String(after.tree_line));

  /* Putting one back is the undo, and must not need a different route. */
  const undo = await ask(env, ownerToken, 'review', {
    method: 'POST',
    body: {
      id: loser.id, status: 'approved', force: true,
      queue: loser.reviewQueue || 'list', canopy: loser.canopy,
    },
  });
  const back = await env.DB.prepare('SELECT status FROM corpus WHERE id = ?1')
    .bind(loser.id).first();
  check('and a rejected map can be put back', undo.body.ok === true && back.status === 'approved',
    JSON.stringify(back));

  /*
   * A row nobody ever queued is judged from the list, so 'list' is what
   * surfaced it. It must be stored as itself: falling through to 'priority'
   * would credit a deliberate choice to a draw that never happened, and
   * becoming 'random' would put it in the representative slice on a lie.
   */
  const stranger = list.maps.find((m) => m.county === 'tx-travis');
  await env.DB.prepare("UPDATE corpus SET status = 'new', review_queue = NULL WHERE id = ?1")
    .bind(stranger.id).run();
  await ask(env, ownerToken, 'review',
    { method: 'POST', body: { id: stranger.id, status: 'rejected', queue: 'list' } });
  const fresh = await env.DB.prepare('SELECT review_queue FROM corpus WHERE id = ?1')
    .bind(stranger.id).first();
  check('a verdict from the list records the list, not a queue it never came from',
    fresh.review_queue === 'list', fresh.review_queue);
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
