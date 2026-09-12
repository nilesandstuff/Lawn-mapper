/**
 * Accounts, against a real SQLite database with the real schema.
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE is not the JavaScript. It is the SQL and
 * the rules the SQL encodes:
 *
 *   - one account per email address, however many doors lead to it
 *   - a magic link that works exactly once, decided by the database rather
 *     than by a check-then-write that two clicks can both pass
 *   - a credit that cannot be spent twice by two requests racing
 *   - an unverified address that never becomes an account, because the account
 *     IS the address and the alternative is a takeover
 *
 * So this runs the schema file itself and the real statements. A stub would
 * have to reimplement the constraints to be exercised, and would then be
 * testing the reimplementation. See tools/d1.js.
 *
 *   node tools/auth.test.js
 */

import { testDb } from './d1.js';
import {
  findOrCreateUser, createSession, sessionUser, endSession, endAllSessions,
  createChallenge, useChallenge, spendCredits, refundCredits, grantCredits,
  publicUser, isAdminEmail, welcomeCredits, hash, newSecret, timingSafeEqual,
  accountsEnabled, sweepExpired, dailyState, setDailyLimit,
} from '../worker/src/db.js';
import {
  safeNext, looksLikeEmail, readCookie, sessionCookie, beginMagicLink,
  finishMagicLink,
} from '../worker/src/auth.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
};

const env = (extra = {}) => ({ DB: testDb(), ...extra });
const rows = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;

/* ------------------------------------------------------- accounts are optional */
/*
 * A deployment with no database is not broken -- it is the app as it was
 * before accounts existed. Every function has to answer "signed out" rather
 * than throw, or a site goes down because of a feature nobody set up.
 */
{
  check('with no database, nothing is enabled', accountsEnabled({}) === false);
  check('and asking who is signed in answers nobody, rather than throwing',
    (await sessionUser({}, 'anything')) === null);
  check('and sweeping expired rows is a no-op',
    (await sweepExpired({})) === undefined);
}

/* ------------------------------------------------------ the email is the account */
/*
 * THE RULE THE WHOLE DESIGN RESTS ON. Signing in twice must land on ONE
 * account with one set of saved maps -- otherwise a person types their address
 * slightly differently and their measurements are gone.
 *
 * With one door this is a UNIQUE constraint and a lowercase, which is exactly
 * why there is one door: the multi-provider version rested on every provider
 * being checked for a verified address, and that is a rule that fails silently
 * the first time somebody adds a provider carelessly.
 */
{
  const e = env();
  const first = await findOrCreateUser(e, {
    email: 'Sam@Example.com', provider: 'email', subject: 'sam@example.com',
  });
  const second = await findOrCreateUser(e, {
    email: 'sam@example.com', provider: 'email', subject: 'sam@example.com',
  });

  check('signing in twice lands on one account', first.id === second.id,
    `${first.id} vs ${second.id}`);
  check('and the address is stored lowercased, so case cannot fork it',
    first.email === 'sam@example.com', first.email);
  check('and there is exactly one row in users',
    (await rows(e, 'SELECT id FROM users')).length === 1);

  /*
   * The account model still records WHICH door was used, and still supports
   * more than one. Keeping that is what makes adding a provider later a
   * configuration change rather than a migration.
   */
  check('with the way in recorded against it, once',
    (await rows(e, 'SELECT provider FROM identities WHERE user_id = ?', first.id))
      .map((r) => r.provider).join(',') === 'email',
    'the subject is the normalised address, so capitalising it differently does '
    + 'not add a second row saying the same thing');
}

/* An address is required, and has to be one. */
{
  const e = env();
  let threw = false;
  try { await findOrCreateUser(e, { email: '', provider: 'google', subject: 'x' }); }
  catch { threw = true; }
  check('an account cannot be made without an address', threw);
}

/* ----------------------------------------------------------------- the owner */
/*
 * The first admin has to be able to exist without a SQL console, because there
 * is not one on a phone. Listing an address in ADMIN_EMAILS is a deployment
 * decision; nothing a visitor does can put them on that list.
 */
{
  const e = env({ ADMIN_EMAILS: 'owner@example.com, other@example.com' });
  const owner = await findOrCreateUser(e, { email: 'owner@example.com', provider: 'email', subject: 'o' });
  check('an address named as the site\'s own becomes an admin',
    owner.role === 'admin', owner.role);
  check('and is not charged for detections', owner.unlimited === 1, String(owner.unlimited));
  check('and is not given a welcome balance it would never spend',
    owner.credits === 0, String(owner.credits));

  const guest = await findOrCreateUser(e, { email: 'guest@example.com', provider: 'email', subject: 'g' });
  check('while anybody else is an ordinary account', guest.role === 'user' && guest.unlimited === 0);

  /*
   * NOBODY GETS A SIGNING-UP BONUS, and its absence is the anti-farming design
   * rather than a feature somebody forgot.
   *
   * A welcome grant is the only part of this that multiplies: twenty free
   * predictions for the cost of a throwaway address, repeatable all evening.
   * What an account gets instead is a bigger DAILY allowance, which cannot be
   * farmed -- a fresh account buys tomorrow's passes today and nothing more.
   *
   * So `credits` starts at zero for everybody. It is the BOUGHT balance now,
   * and nothing has been bought.
   */
  check('and no account is given a balance just for existing',
    guest.credits === 0, String(guest.credits));
  check('the free tier is a daily allowance instead, and it is the bigger number',
    welcomeCredits(e) === 30 && welcomeCredits(e) > guest.credits,
    `${welcomeCredits(e)} a day`);

  /*
   * Adding an address to the list has to take effect on the next sign-in.
   * Otherwise promoting somebody means deleting their account first.
   */
  const promoted = env({ ADMIN_EMAILS: 'guest@example.com', DB: e.DB });
  const again = await findOrCreateUser(promoted, { email: 'guest@example.com', provider: 'email', subject: 'g' });
  check('adding an address to the list promotes on the next sign-in',
    again.role === 'admin' && again.unlimited === 1, `${again.role}/${again.unlimited}`);

  check('and the list is not case sensitive',
    isAdminEmail({ ADMIN_EMAILS: 'Owner@Example.com' }, 'owner@example.com'));
  check('nor confused by an empty setting',
    isAdminEmail({}, 'anyone@example.com') === false);
  /* An empty ADMIN_EMAILS must not mean "everyone is an admin". */
  check('and an empty entry does not match an empty address',
    isAdminEmail({ ADMIN_EMAILS: ' , , ' }, '') === false);
}

/* -------------------------------------------------------------- sessions */
{
  const e = env();
  const user = await findOrCreateUser(e, { email: 'a@b.com', provider: 'email', subject: 'a' });
  const { token } = await createSession(e, user.id);

  check('a session identifies its account', (await sessionUser(e, token))?.id === user.id);

  /*
   * WHAT IS STORED IS NOT WHAT WAS HANDED OUT. A leaked backup should contain
   * no working logins, which is the same reasoning as not storing passwords.
   */
  const stored = await rows(e, 'SELECT id FROM sessions');
  check('the cookie itself is never stored, only its hash',
    stored[0].id !== token && stored[0].id === await hash(token),
    `${stored[0].id.slice(0, 12)}… vs ${token.slice(0, 12)}…`);

  check('a made-up cookie identifies nobody', (await sessionUser(e, newSecret())) === null);

  await endSession(e, token);
  check('signing out ends it', (await sessionUser(e, token)) === null);

  /* Sign out everywhere: the reason sessions are rows and not signed tokens. */
  const t1 = (await createSession(e, user.id)).token;
  const t2 = (await createSession(e, user.id)).token;
  await endAllSessions(e, user.id);
  check('and signing out everywhere ends all of them',
    (await sessionUser(e, t1)) === null && (await sessionUser(e, t2)) === null);
}

/* An expired session is nobody, and expiry is decided in SQL. */
{
  const e = env();
  const user = await findOrCreateUser(e, { email: 'old@b.com', provider: 'email', subject: 'o' });
  const { token } = await createSession(e, user.id);
  e.DB.raw.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
  check('an expired session identifies nobody', (await sessionUser(e, token)) === null);

  await sweepExpired(e);
  check('and sweeping removes it', (await rows(e, 'SELECT id FROM sessions')).length === 0);
}

/* ------------------------------------------------------------ challenges */
/*
 * A magic link works ONCE. Decided by the database rather than by reading the
 * row and then marking it: two clicks a millisecond apart would both pass that
 * check, and a forwarded email is two clicks.
 */
{
  const e = env();
  const token = await createChallenge(e, 'magic', { email: 'once@b.com' });

  const first = await useChallenge(e, 'magic', token);
  check('a link identifies the address that asked for it', first?.email === 'once@b.com');

  const second = await useChallenge(e, 'magic', token);
  check('and cannot be used a second time', second === null,
    'a forwarded email is two clicks on the same link');

  /* Kind is part of the claim: an OAuth state must not spend as a magic link. */
  const state = await createChallenge(e, 'oauth', { data: { provider: 'google' } });
  check('a token of one kind cannot be spent as another',
    (await useChallenge(e, 'magic', state)) === null);
  check('but can be spent as its own',
    (await useChallenge(e, 'oauth', state))?.data?.provider === 'google');

  const stale = await createChallenge(e, 'magic', { email: 'late@b.com', minutes: 15 });
  e.DB.raw.prepare('UPDATE challenges SET expires_at = ? WHERE used_at IS NULL')
    .run('2000-01-01T00:00:00.000Z');
  check('an expired link does not work', (await useChallenge(e, 'magic', stale)) === null);
}

/* ---------------------------------------------------------------- credits */
/*
 * THE REASON THIS PROJECT HAS A DATABASE AT ALL.
 *
 * Read the balance, subtract, write it back, and two presses a second apart
 * both read the same number and both write one less -- the second detection is
 * free. Not a rare interleaving: exclude mode fires several passes per press
 * and a phone on a flaky connection retries.
 */
{
  const e = env();
  const user = await findOrCreateUser(e, { email: 'c@b.com', provider: 'email', subject: 'c' });

  /* Bought credits, so there is something to race against. */
  await grantCredits(e, user.id, 3, 'a pack');
  const fresh = await e.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();

  /*
   * Racing: every attempt at once, against a balance that cannot cover them.
   * DAILY is zero here so the race is genuinely about the bought balance --
   * with an allowance in the way the attempts would not compete for anything.
   */
  const attempts = await Promise.all(
    [1, 1, 1, 1, 1].map(() => spendCredits(e, fresh, 1, 'race', 0))
  );
  const won = attempts.filter((a) => a.ok).length;
  const left = await e.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('five requests against three credits spend three, not five',
    won === 3 && left.credits === 0, `${won} succeeded, ${left.credits} left`);

  const broke = await spendCredits(e, { ...fresh, credits: 0 }, 1, 'nope', 0);
  check('and an empty balance refuses rather than going negative',
    broke.ok === false && broke.balance === 0, JSON.stringify(broke));

  /* A refund is unconditional: money taken for nothing is the worse failure. */
  await refundCredits(e, { ...fresh, credits: 0, unlimited: 0 }, 2, 'detector refused', 0);
  const back = await e.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('a refund puts them back', back.credits === 2, String(back.credits));

  /* The ledger explains the balance, which is what people ask about. */
  const history = await rows(e, 'SELECT reason, delta FROM ledger WHERE user_id = ? ORDER BY id', user.id);
  check('and every movement is on the ledger',
    history.some((h) => h.reason === 'grant' && h.delta > 0)
    && history.some((h) => h.reason === 'detect' && h.delta < 0)
    && history.some((h) => h.reason === 'refund' && h.delta > 0),
    history.map((h) => `${h.reason}${h.delta >= 0 ? '+' : ''}${h.delta}`).join(' '));
}

/* ------------------------------------------------------- the daily allowance */
/*
 * THE CHANGE THIS SECTION EXISTS FOR: credits used to be a permanent balance
 * and are now a daily one. The difference is the whole anti-farming argument
 * -- a fresh account buys tomorrow's passes today and nothing beyond that --
 * so "does it actually reset" is not a detail, it is the property.
 */
{
  const e = env();
  const user = await findOrCreateUser(e, { email: 'd@b.com', provider: 'email', subject: 'd' });
  const TIER = 10;

  const first = await spendCredits(e, user, 4, 'four passes', TIER);
  check('a detection comes out of the day\'s allowance, not the balance',
    first.ok && first.spent === 0 && first.fromDaily === 4,
    JSON.stringify(first.daily));

  const state = await dailyState(e, user, TIER);
  check('and the day\'s count says so', state.used === 4 && state.limit === TIER,
    `${state.used} of ${state.limit}`);

  /* All or nothing, the same rule as everywhere else. */
  const tooBig = await spendCredits(e, user, 9, 'nine passes', TIER);
  check('a press that does not fit in what is left is refused whole',
    !tooBig.ok && (await dailyState(e, user, TIER)).used === 4,
    JSON.stringify(tooBig));

  /*
   * THE RESET IS PART OF THE SPEND, not a scheduled job -- so it is tested by
   * ageing the row rather than by waiting for midnight. A row from a previous
   * day is not stale data to sweep up; it simply does not match today's key.
   */
  e.DB.raw.prepare('UPDATE allowances SET day = ? WHERE user_id = ?').run('2000-01-01', user.id);
  const tomorrow = await dailyState(e, user, TIER);
  check('yesterday\'s count is not today\'s', tomorrow.used === 0, String(tomorrow.used));

  const morning = await spendCredits(e, user, 9, 'the next day', TIER);
  check('and the press that did not fit yesterday fits this morning',
    morning.ok && morning.fromDaily === 9, JSON.stringify(morning.daily));

  /*
   * Racing the reset: several presses at once against a row that belongs to a
   * previous day. Each one folds the reset into its own statement, so the
   * danger is that they ALL reset and each starts from zero -- which would
   * hand out an unbounded number of free passes at midnight.
   */
  const r = env();
  const racer = await findOrCreateUser(r, { email: 'r@b.com', provider: 'email', subject: 'r' });
  await spendCredits(r, racer, 1, 'yesterday', 5);
  r.DB.raw.prepare('UPDATE allowances SET day = ? WHERE user_id = ?').run('2000-01-01', racer.id);

  const dawn = await Promise.all(
    [1, 1, 1, 1, 1, 1, 1, 1].map(() => spendCredits(r, racer, 1, 'dawn', 5))
  );
  const through = dawn.filter((a) => a.ok).length;
  check('and eight presses at the stroke of midnight spend five, not forty',
    through === 5 && (await dailyState(r, racer, 5)).used === 5,
    `${through} got through`);
}

/* --------------------------------------------- the allowance, then the balance */
/*
 * Free passes perish and bought ones do not, so the perishable pocket is
 * emptied first. Any other order quietly burns something somebody paid for
 * while a free pass sits unused beside it.
 */
{
  const e = env();
  const user = await findOrCreateUser(e, { email: 'split@b.com', provider: 'email', subject: 's' });
  await grantCredits(e, user.id, 10, 'a pack');
  const have = await e.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();

  const free = await spendCredits(e, have, 2, 'within the day', 3);
  check('the day\'s passes go first while there are any',
    free.ok && free.fromDaily === 2 && free.spent === 0, JSON.stringify(free));

  /*
   * ONE PASS OF ALLOWANCE LEFT AND A THREE-PASS PRESS. Taking it all from one
   * pocket would refuse a detection the account can plainly afford, so the
   * charge splits: the last free pass, then two bought ones.
   */
  const mixed = await spendCredits(e, have, 3, 'across both', 3);
  check('and a press that outgrows the day finishes on the bought balance',
    mixed.ok && mixed.fromDaily === 1 && mixed.spent === 2,
    `${mixed.fromDaily} free + ${mixed.spent} bought`);

  const now = await e.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('which is what actually left the balance', now.credits === 8, String(now.credits));

  /*
   * AND A REFUND GOES BACK INTO THE POCKETS IT CAME OUT OF. Putting all five
   * back as bought credits would turn every failed detection into a small
   * gift, and one that compounds.
   */
  await refundCredits(e, have, 3, 'the detector refused', 1);
  const after = await e.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('a refund puts the free part back as free and the bought part as bought',
    after.credits === 10 && (await dailyState(e, have, 3)).used === 2,
    `${after.credits} bought, ${(await dailyState(e, have, 3)).used} of 3 used`);
}

/* ------------------------------------------------------- a vouched account */
/*
 * An office of eight behind one IP is indistinguishable from eight accounts
 * made by one person, and no rule will ever separate them -- so a person
 * decides, in the console, by giving the account its own daily limit.
 */
{
  const e = env();
  const user = await findOrCreateUser(e, { email: 'firm@b.com', provider: 'email', subject: 'f' });

  const before = await dailyState(e, user, 30);
  check('an ordinary account is on the free tier and is not vouched',
    before.limit === 30 && before.own === false, JSON.stringify(before));

  await setDailyLimit(e, user.id, 400);
  const raised = await dailyState(e, user, 30);
  check('a hand-set limit is the account\'s own, and marks it vouched',
    raised.limit === 400 && raised.own === true, JSON.stringify(raised));

  const big = await spendCredits(e, user, 200, 'a working day', 30);
  check('and it can spend past the free tier', big.ok && big.fromDaily === 200,
    JSON.stringify(big.daily));

  /* Both directions, or the console can only ever make exceptions. */
  await setDailyLimit(e, user.id, null);
  const cleared = await dailyState(e, user, 30);
  check('clearing it puts the account back on the tier, and un-vouches it',
    cleared.limit === 30 && cleared.own === false, JSON.stringify(cleared));
  check('and today\'s spending is not forgotten along with it',
    cleared.used === 200, String(cleared.used));
}

/* An unlimited account is uncharged, not unrecorded. */
{
  const e = env({ ADMIN_EMAILS: 'owner@b.com' });
  const owner = await findOrCreateUser(e, { email: 'owner@b.com', provider: 'email', subject: 'o' });
  const spend = await spendCredits(e, owner, 5, 'free');
  check('an unlimited account is never short', spend.ok && spend.spent === 0);

  const after = await e.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(owner.id).first();
  check('and its balance does not move', after.credits === 0, String(after.credits));
  check('but the detection is still on the ledger, so usage is countable',
    (await rows(e, 'SELECT id FROM ledger WHERE user_id = ? AND reason = ?', owner.id, 'detect')).length === 1);
}

/* Granting, from the admin console. */
{
  const e = env();
  const user = await findOrCreateUser(e, { email: 'g@b.com', provider: 'email', subject: 'g' });
  const after = await grantCredits(e, user.id, 50, 'bought a pack');
  check('a grant moves the balance', after.credits === user.credits + 50, String(after.credits));

  const taken = await grantCredits(e, user.id, -1000, 'clawback');
  check('and taking more than there is stops at zero, not below',
    taken.credits === 0, String(taken.credits));
}

/* --------------------------------------------------------- what goes out */
{
  const e = env({ ADMIN_EMAILS: 'o@b.com' });
  const owner = await findOrCreateUser(e, { email: 'o@b.com', provider: 'email', subject: 'o' });
  const shown = publicUser(owner);

  /*
   * A WHITELIST, NOT THE ROW MINUS A FEW FIELDS. A column added to the table
   * later must not appear in an API response because nobody remembered to
   * exclude it.
   */
  check('only the agreed fields reach the browser',
    Object.keys(shown).sort().join(',') === 'admin,credits,daily,email,id,name,picture,unlimited',
    Object.keys(shown).join(','));
  check('and an unlimited account reports no number to count down',
    shown.credits === null && shown.unlimited === true);
  check('nothing is sent for a signed-out visitor', publicUser(null) === null);
}

/* --------------------------------------------------------- the magic link */
/*
 * RECEIVING THE LINK IS THE VERIFICATION. There is no `email_verified` claim
 * to trust, forget to check, or get wrong when a provider is added -- the
 * token went to that inbox and came back, which is the whole proof. This is
 * the reason the single door is not a compromise.
 */
{
  const sent = [];
  const e = env({ RESEND_API_KEY: 'test', MAIL_FROM: 'a@b.com' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };

  const req = new Request('https://site.test/api/auth/email', { method: 'POST' });
  const asked = await beginMagicLink(req, e, 'New@Example.com', '/saved');
  globalThis.fetch = realFetch;

  check('asking for a link sends exactly one email', asked.ok && sent.length === 1,
    JSON.stringify(asked));
  check('to the address that asked for it', sent[0].body.to[0] === 'new@example.com',
    sent[0]?.body?.to?.[0]);

  /* The link has to be followable from a mail client that shows plain text. */
  const link = sent[0].body.text.match(/https:\/\/\S+/)?.[0];
  check('and carries a link on this site, not somewhere else',
    link?.startsWith('https://site.test/api/auth/email/verify?token='), link);

  const token = new URL(link).searchParams.get('token');
  const signedIn = await finishMagicLink(e, token);
  check('following it creates the account and signs them in',
    signedIn.user?.email === 'new@example.com', JSON.stringify(signedIn.error || signedIn.user?.email));
  check('and lands where they were, not on the front page',
    signedIn.next === '/saved', signedIn.next);

  /*
   * ONCE. A forwarded email is two clicks on the same link, and an inbox is
   * not a place where a reusable credential should sit for twenty minutes.
   */
  check('and it cannot be followed a second time',
    (await finishMagicLink(e, token)).error === 'expired');

  check('a token nobody issued signs nobody in',
    (await finishMagicLink(e, 'made-up')).error === 'expired');
}

/* No mail provider is no sign-in, said plainly rather than failing on submit. */
{
  const e = env();
  const req = new Request('https://site.test/api/auth/email', { method: 'POST' });
  check('with no mail configured there is no way in, and it says so',
    (await beginMagicLink(req, e, 'a@b.com')).error === 'no-mail');
  check('and an implausible address is refused before anything is sent',
    (await beginMagicLink(req, env({ RESEND_API_KEY: 'x' }), 'not-an-address')).error
      === 'bad-email');
}

/* ------------------------------------------------------------- the small parts */
{
  /*
   * An open redirect on a sign-in endpoint is how a phishing link gets to wear
   * your domain in the address bar. A protocol-relative URL is a path by the
   * letter of "starts with a slash" and an offsite redirect in practice.
   */
  check('a sign-in cannot be redirected off the site',
    safeNext('https://evil.example') === '/'
    && safeNext('//evil.example') === '/'
    && safeNext('') === '/');
  check('but a path on the site is kept', safeNext('/saved') === '/saved');

  check('a plausible address is accepted', looksLikeEmail('a.b+c@example.co.uk'));
  check('and an implausible one is not',
    !looksLikeEmail('no-at-sign') && !looksLikeEmail('a@b') && !looksLikeEmail(''));

  /*
   * Cookie parsing by hand, because the name we want can be a prefix of
   * another: a naive search finds "lm_session_old" in a header with no
   * "lm_session" in it at all.
   */
  const req = (v) => new Request('https://x/', { headers: { Cookie: v } });
  check('the right cookie is read out of a list',
    readCookie(req('a=1; lm_session=wanted; z=3'), 'lm_session') === 'wanted');
  check('and a similarly named one is not mistaken for it',
    readCookie(req('lm_session_old=wrong'), 'lm_session') === null);

  const cookie = sessionCookie('tok', { maxAge: 100 });
  check('the session cookie is not readable by script', /HttpOnly/.test(cookie));
  check('and is not sent on a cross-site POST, which is the CSRF guard',
    /SameSite=Lax/.test(cookie));
  check('and is https-only in production', /Secure/.test(cookie));
  check('but not over plain http, where a browser would silently drop it',
    !/Secure/.test(sessionCookie('tok', { maxAge: 100, secure: false })),
    'otherwise signing in on a dev server looks broken rather than refused');

  check('comparing secrets does not leak how much was right',
    timingSafeEqual('abc', 'abc') && !timingSafeEqual('abc', 'abd')
    && !timingSafeEqual('abc', 'abcd'));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
