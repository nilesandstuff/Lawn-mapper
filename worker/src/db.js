/**
 * The account store, and the small number of things worth saying about it.
 *
 * Everything here takes `env` rather than reading a module-level handle,
 * because a Worker has no process to hang one on and a test needs to hand in
 * a different database without the code noticing.
 *
 * ACCOUNTS ARE OPTIONAL, EVERYWHERE. A deployment with no D1 binding is not
 * broken -- it is the app as it was before accounts existed: measure, correct,
 * save to this browser. So every function here answers "no" rather than
 * throwing when the binding is missing, and the callers treat that as "signed
 * out" rather than as an error. The alternative is a site that goes down
 * because a database somebody never set up is absent.
 */

/** Is there an account store at all? */
export const accountsEnabled = (env) => Boolean(env?.DB);

/* ------------------------------------------------------------------ ids */

/**
 * A random id, prefixed with what it is.
 *
 * The prefix is not decoration: these end up in logs, in support questions and
 * in the admin console, and "usr_" beside "ses_" is the difference between
 * reading a row and guessing at one. 16 bytes of randomness is far past any
 * guessing attack and short enough to read out loud.
 */
export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A secret nobody but its holder should be able to produce: 32 bytes, base64url.
 *
 * Used for session cookies and magic-link tokens. Only the HASH of one is ever
 * stored -- see hash() -- so a copy of the database is not a set of working
 * logins.
 */
export function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * SHA-256, hex.
 *
 * Deliberately a plain hash and not a password KDF. These inputs are 32 bytes
 * of machine randomness, not something a person chose, so there is no
 * dictionary to run and nothing for a slow hash to buy. It is here so that a
 * leaked backup contains no usable tokens.
 */
export async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison.
 *
 * `a === b` returns as soon as two characters differ, so the time it takes
 * reports how much of a guess was right. Cheap enough that using the careless
 * version would be a choice.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const now = () => new Date().toISOString();
const plus = (ms) => new Date(Date.now() + ms).toISOString();

/* ---------------------------------------------------------------- users */

/**
 * The account for this email, made if there is not one yet.
 *
 * THE EMAIL IS THE IDENTITY, and the provider is a door to it. Somebody who
 * signs in with Google and later uses a magic link to the same address is one
 * person with one set of saved maps, not two accounts wondering where their
 * measurements went. Which is only safe because no unverified address ever
 * reaches this function: a magic link proves the address receives mail, and
 * Google's claim is used only when it says the address is verified. An
 * unverified email here would let anyone claim anyone's account by typing
 * their address into a provider that does not check.
 */
export async function findOrCreateUser(env, { email, name, picture, provider, subject }) {
  const address = String(email || '').trim().toLowerCase();
  if (!address || !address.includes('@')) throw new Error('An email address is required.');

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(address).first();

  if (!user) {
    const id = newId('usr');
    /*
     * The welcome grant, and the owner's flag, decided at creation.
     *
     * ADMIN_EMAILS is how the first admin exists at all: there is no SQL
     * console on a phone, and an app whose only administrator has to be
     * inserted by hand has no administrator. Listing an address there is a
     * deployment decision, visible in the settings, not something a visitor
     * can do to themselves.
     */
    const owner = isAdminEmail(env, address);
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, picture, role, credits, unlimited, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, address, name || null, picture || null,
      owner ? 'admin' : 'user',
      owner ? 0 : welcomeCredits(env),
      owner ? 1 : 0,
      now(), now()
    ).run();

    if (!owner && welcomeCredits(env) > 0) {
      await recordLedger(env, id, welcomeCredits(env), 'welcome', 'new account');
    }
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  } else {
    /*
     * An existing account catches up with the provider, but only upward.
     *
     * A name or picture is filled in if we did not have one, never replaced --
     * signing in with a provider that knows less about you should not blank
     * what another one told us. The admin flag is re-applied every time so
     * that adding an address to ADMIN_EMAILS takes effect on the next sign in
     * rather than requiring the account to be deleted.
     */
    const owner = isAdminEmail(env, address);
    await env.DB.prepare(
      `UPDATE users SET name = COALESCE(name, ?), picture = COALESCE(picture, ?),
              role = CASE WHEN ? = 1 THEN 'admin' ELSE role END,
              unlimited = CASE WHEN ? = 1 THEN 1 ELSE unlimited END,
              last_seen_at = ?
       WHERE id = ?`
    ).bind(name || null, picture || null, owner ? 1 : 0, owner ? 1 : 0, now(), user.id).run();
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  }

  if (provider && subject) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(provider, String(subject), user.id, now()).run();
  }

  return user;
}

/** Addresses listed as the site's own. Comma or space separated, any case. */
export function isAdminEmail(env, email) {
  const list = String(env?.ADMIN_EMAILS || '')
    .split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email || '').trim().toLowerCase());
}

/** What a new account starts with. Zero is a valid answer and means "none". */
export function welcomeCredits(env) {
  const raw = Number(env?.WELCOME_CREDITS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 20;
}

/* -------------------------------------------------------------- sessions */

/** Ninety days. Long enough that a phone stays signed in between mowings. */
const SESSION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Start a session. Returns the cookie value, which is never stored.
 *
 * What goes in the table is its hash, so the row proves a cookie is genuine
 * without being one.
 */
export async function createSession(env, userId) {
  const token = newSecret();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, seen_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(await hash(token), userId, now(), plus(SESSION_MS), now()).run();
  return { token, maxAge: Math.floor(SESSION_MS / 1000) };
}

/**
 * The account this cookie belongs to, or null.
 *
 * Expiry is checked in SQL rather than in JavaScript so that a clock, a cached
 * row or a forgotten `new Date()` cannot be the thing standing between an
 * expired session and an account.
 */
export async function sessionUser(env, token) {
  if (!accountsEnabled(env) || !token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  ).bind(await hash(token), now()).first();
  return row || null;
}

/** Note that this session is in use, and push its expiry out. */
export async function touchSession(env, token) {
  if (!accountsEnabled(env) || !token) return;
  await env.DB.prepare('UPDATE sessions SET seen_at = ?, expires_at = ? WHERE id = ?')
    .bind(now(), plus(SESSION_MS), await hash(token)).run();
}

export async function endSession(env, token) {
  if (!accountsEnabled(env) || !token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await hash(token)).run();
}

/** Sign out everywhere. The reason sessions are rows and not signed tokens. */
export async function endAllSessions(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}

/* ------------------------------------------------------------ challenges */

/**
 * Park a one-time secret for a few minutes: a magic link, or an OAuth trip.
 *
 * Returns the token to hand out; only its hash is kept, so the row cannot be
 * turned back into a working link.
 */
export async function createChallenge(env, kind, { email = null, data = null, minutes = 15 } = {}) {
  const token = newSecret();
  await env.DB.prepare(
    `INSERT INTO challenges (id, kind, email, data, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    await hash(token), kind, email,
    data ? JSON.stringify(data) : null,
    now(), plus(minutes * 60 * 1000)
  ).run();
  return token;
}

/**
 * Spend a challenge: valid exactly once, and only before it expires.
 *
 * The UPDATE is what makes it single-use, not the SELECT -- checking and then
 * marking would let two clicks a millisecond apart both pass. `used_at IS
 * NULL` inside the write means the database decides the race, and `changes`
 * says who won.
 */
export async function useChallenge(env, kind, token) {
  if (!accountsEnabled(env) || !token) return null;
  const id = await hash(token);
  const claimed = await env.DB.prepare(
    `UPDATE challenges SET used_at = ?
     WHERE id = ? AND kind = ? AND used_at IS NULL AND expires_at > ?`
  ).bind(now(), id, kind, now()).run();
  if (!claimed.meta?.changes) return null;

  const row = await env.DB.prepare('SELECT * FROM challenges WHERE id = ?').bind(id).first();
  if (!row) return null;
  let data = null;
  try { data = row.data ? JSON.parse(row.data) : null; } catch { data = null; }
  return { email: row.email, data };
}

/**
 * Throw away what has expired.
 *
 * Called opportunistically rather than on a schedule: these tables are small,
 * the delete is indexed, and a cron trigger is one more thing to configure
 * from a phone for a job that is this cheap to do on the way past.
 */
export async function sweepExpired(env) {
  if (!accountsEnabled(env)) return;
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
  ]);
}

/* ---------------------------------------------------------------- credits */

/**
 * A row in the credit history. The balance is the sum; this is what of.
 *
 * `units` is the number of AI passes the row is about, which is not the same
 * as what it cost: the owner's account is uncharged, not unused, and its
 * detections cost real money at Replicate even though no balance moves.
 * Counting usage from `delta` alone would report the busiest account as idle.
 */
export async function recordLedger(env, userId, delta, reason, detail = null, units = 0) {
  await env.DB.prepare(
    'INSERT INTO ledger (user_id, delta, units, reason, detail, at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(userId, delta, units, reason, detail, now()).run();
}

/**
 * Spend credits, or report that there were not enough. Never both.
 *
 * THE WHOLE REASON THIS PROJECT HAS A DATABASE. Read the balance, subtract,
 * write it back, and two presses a second apart both read the same number and
 * both write one less than it -- the second detection is free, and it is not a
 * rare interleaving because exclude mode fires several passes per press.
 *
 * One statement instead: the WHERE clause carries the affordability test, so
 * the database serialises the two attempts and `changes` says which one got
 * the credits. An unlimited account passes the test without the balance
 * moving, and still writes a ledger row, so "unlimited" means uncharged rather
 * than unrecorded.
 */
export async function spendCredits(env, user, amount, detail = null) {
  const cost = Math.max(0, Math.floor(amount));
  if (!cost) return { ok: true, spent: 0, balance: user.credits, unlimited: !!user.unlimited };

  if (user.unlimited) {
    await recordLedger(env, user.id, 0, 'detect', detail, cost);
    return { ok: true, spent: 0, balance: user.credits, unlimited: true };
  }

  const done = await env.DB.prepare(
    'UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?'
  ).bind(cost, user.id, cost).run();

  if (!done.meta?.changes) {
    const fresh = await env.DB.prepare('SELECT credits FROM users WHERE id = ?')
      .bind(user.id).first();
    return { ok: false, spent: 0, balance: fresh?.credits ?? 0, wanted: cost, unlimited: false };
  }

  await recordLedger(env, user.id, -cost, 'detect', detail, cost);
  const fresh = await env.DB.prepare('SELECT credits FROM users WHERE id = ?')
    .bind(user.id).first();
  return { ok: true, spent: cost, balance: fresh?.credits ?? 0, unlimited: false };
}

/**
 * Give credits back when the thing they paid for did not happen.
 *
 * Unconditional, unlike spending: there is no "too many" to fail on, and a
 * refund that silently did not land is money taken for nothing.
 */
export async function refundCredits(env, user, amount, detail = null) {
  const back = Math.max(0, Math.floor(amount));
  if (!back || user.unlimited) return;
  await env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ?')
    .bind(back, user.id).run();
  await recordLedger(env, user.id, back, 'refund', detail, -back);
}

/** Move a balance by hand, from the admin console. */
export async function grantCredits(env, userId, delta, detail = null) {
  const n = Math.floor(Number(delta) || 0);
  if (!n) return null;
  await env.DB.prepare('UPDATE users SET credits = MAX(0, credits + ?) WHERE id = ?')
    .bind(n, userId).run();
  await recordLedger(env, userId, n, 'grant', detail);
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
}

/* -------------------------------------------------------- what to send out */

/**
 * The account as the browser is allowed to see it.
 *
 * A deliberate whitelist rather than the row minus a few fields: a column
 * added later to the table should not appear in an API response because
 * nobody remembered to exclude it.
 */
export const publicUser = (user) => (user ? {
  id: user.id,
  email: user.email,
  name: user.name || null,
  picture: user.picture || null,
  admin: user.role === 'admin',
  credits: user.unlimited ? null : user.credits,
  unlimited: Boolean(user.unlimited),
} : null);
