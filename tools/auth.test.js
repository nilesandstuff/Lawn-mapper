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
  accountsEnabled, sweepExpired,
} from '../worker/src/db.js';
import {
  decodeJwtPayload, safeNext, looksLikeEmail, readCookie, sessionCookie,
  PROVIDERS, availableProviders, finishOAuth,
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
 * THE RULE THE WHOLE DESIGN RESTS ON. Google today and a magic link next month
 * must land on one account with one set of saved maps -- otherwise a person
 * signs in the "wrong" way and their measurements are gone.
 */
{
  const e = env();
  const viaGoogle = await findOrCreateUser(e, {
    email: 'Sam@Example.com', name: 'Sam', picture: 'https://x/p.png',
    provider: 'google', subject: 'g-1',
  });
  const viaEmail = await findOrCreateUser(e, {
    email: 'sam@example.com', provider: 'email', subject: 'sam@example.com',
  });

  check('two doors, one account', viaGoogle.id === viaEmail.id,
    `${viaGoogle.id} vs ${viaEmail.id}`);
  check('and the address is stored lowercased, so case cannot fork it',
    viaGoogle.email === 'sam@example.com', viaGoogle.email);
  check('with both ways in recorded against it',
    (await rows(e, 'SELECT provider FROM identities WHERE user_id = ?', viaGoogle.id))
      .map((r) => r.provider).sort().join(',') === 'email,google');
  check('and exactly one row in users',
    (await rows(e, 'SELECT id FROM users')).length === 1);

  /*
   * A provider that knows less must not blank what another one told us.
   * Signing in by email after Google should not wipe the name.
   */
  check('a later sign-in does not erase what an earlier one knew',
    viaEmail.name === 'Sam' && viaEmail.picture === 'https://x/p.png',
    `${viaEmail.name} / ${viaEmail.picture}`);
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
  check('with the welcome credits', guest.credits === welcomeCredits(e), String(guest.credits));

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
  const start = user.credits;

  const one = await spendCredits(e, user, 2, 'two passes');
  check('spending takes exactly what it asked for',
    one.ok && one.spent === 2 && one.balance === start - 2,
    `${start} -> ${one.balance}`);

  /* Racing: every attempt at once, against a balance that cannot cover them. */
  const fresh = await e.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  await e.DB.prepare('UPDATE users SET credits = 3 WHERE id = ?').bind(user.id).run();
  const attempts = await Promise.all(
    [1, 1, 1, 1, 1].map(() => spendCredits(e, { ...fresh, credits: 3 }, 1, 'race'))
  );
  const won = attempts.filter((a) => a.ok).length;
  const left = await e.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('five requests against three credits spend three, not five',
    won === 3 && left.credits === 0, `${won} succeeded, ${left.credits} left`);

  const broke = await spendCredits(e, { ...fresh, credits: 0 }, 1, 'nope');
  check('and an empty balance refuses rather than going negative',
    broke.ok === false && broke.balance === 0, JSON.stringify(broke));

  /* A refund is unconditional: money taken for nothing is the worse failure. */
  await refundCredits(e, { ...fresh, credits: 0, unlimited: 0 }, 2, 'detector refused');
  const back = await e.DB.prepare('SELECT credits FROM users WHERE id = ?').bind(user.id).first();
  check('a refund puts them back', back.credits === 2, String(back.credits));

  /* The ledger explains the balance, which is what people ask about. */
  const history = await rows(e, 'SELECT reason, delta FROM ledger WHERE user_id = ? ORDER BY id', user.id);
  check('and every movement is on the ledger',
    history.some((h) => h.reason === 'welcome')
    && history.some((h) => h.reason === 'detect' && h.delta < 0)
    && history.some((h) => h.reason === 'refund' && h.delta > 0),
    history.map((h) => `${h.reason}${h.delta >= 0 ? '+' : ''}${h.delta}`).join(' '));
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
    Object.keys(shown).sort().join(',') === 'admin,credits,email,id,name,picture,unlimited',
    Object.keys(shown).join(','));
  check('and an unlimited account reports no number to count down',
    shown.credits === null && shown.unlimited === true);
  check('nothing is sent for a signed-out visitor', publicUser(null) === null);
}

/* -------------------------------------------------------- provider claims */
/*
 * AN UNVERIFIED ADDRESS MUST NEVER BECOME AN ACCOUNT. The account IS the
 * address, so a provider that hands over one it has not checked would let
 * anyone take over anyone else's by typing it in. This is the single rule that
 * makes "two doors, one account" safe.
 */
{
  const g = PROVIDERS.google;
  const e = { GOOGLE_CLIENT_ID: 'client-1' };
  const good = {
    aud: 'client-1', iss: 'https://accounts.google.com',
    email_verified: true, email: 'ok@b.com', sub: '123', name: 'OK',
  };

  check('a verified claim becomes a profile', g.profile(good, e)?.email === 'ok@b.com');
  check('an unverified address is refused',
    g.profile({ ...good, email_verified: false }, e) === null);
  check('a missing verification flag is refused too, not assumed true',
    g.profile({ ...good, email_verified: undefined }, e) === null);
  check('a token minted for another application is refused',
    g.profile({ ...good, aud: 'someone-else' }, e) === null);
  check('and one from somewhere that is not Google is refused',
    g.profile({ ...good, iss: 'https://evil.example' }, e) === null);

  check('a provider with no keys configured is not offered',
    availableProviders({}).length === 0);
  check('and one with both is',
    availableProviders({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' })
      .map((p) => p.id).join(',') === 'google');
}

/* An OAuth callback with nothing parked for it cannot mint a session. */
{
  const e = env({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' });
  const url = new URL('https://site.test/api/auth/google/callback?code=x&state=made-up');
  const out = await finishOAuth(new Request(url), e, 'google', url);
  check('a callback carrying a state we never issued is refused',
    out.error === 'expired', JSON.stringify(out));

  const declined = new URL('https://site.test/api/auth/google/callback?error=access_denied');
  check('and a refusal at the provider is reported as one',
    (await finishOAuth(new Request(declined), e, 'google', declined)).error === 'declined');
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

  /* A JWT payload with a non-ASCII name has to survive the trip. */
  const payload = { name: 'Zoë Ström', email: 'z@b.com' };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  check('a provider token is decoded as UTF-8, not Latin-1',
    decodeJwtPayload(`x.${b64}.y`)?.name === 'Zoë Ström',
    decodeJwtPayload(`x.${b64}.y`)?.name);
  check('and rubbish decodes to nothing rather than throwing',
    decodeJwtPayload('not-a-token') === null && decodeJwtPayload('') === null);

  check('comparing secrets does not leak how much was right',
    timingSafeEqual('abc', 'abc') && !timingSafeEqual('abc', 'abd')
    && !timingSafeEqual('abc', 'abcd'));
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
