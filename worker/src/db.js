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
 * THE EMAIL IS THE IDENTITY, and a provider is a door to it. Signing in twice
 * lands on one account with one set of saved maps, rather than on two of them
 * wondering where the measurements went -- and the same is true of a second
 * door if one is ever added.
 *
 * Which is only safe because NO UNVERIFIED ADDRESS EVER REACHES THIS FUNCTION.
 * Today there is one way in and receiving the emailed link is itself the proof,
 * so the rule is the mechanism rather than something to remember. It becomes
 * something to remember the moment a provider is added: one that hands over an
 * address it has not checked would let anybody claim anybody's account by
 * typing it in. That is the reason to be careful here, and the reason there is
 * only one door today.
 */
export async function findOrCreateUser(env, { email, name, picture, provider, subject }) {
  const address = String(email || '').trim().toLowerCase();
  if (!address || !address.includes('@')) throw new Error('An email address is required.');

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(address).first();

  if (!user) {
    const id = newId('usr');
    /*
     * The owner's flag, decided at creation.
     *
     * ADMIN_EMAILS is how the first admin exists at all: there is no SQL
     * console on a phone, and an app whose only administrator has to be
     * inserted by hand has no administrator. Listing an address there is a
     * deployment decision, visible in the settings, not something a visitor
     * can do to themselves.
     *
     * NO WELCOME GRANT ANY MORE, and its absence is the anti-farming design
     * rather than a feature removed. A signing-up bonus is exactly what makes
     * a second account worth making: twenty free predictions for the cost of
     * a throwaway address, repeatable. What an account gets now is a bigger
     * DAILY allowance, and a daily allowance cannot be farmed -- a fresh
     * account buys tomorrow's passes today and nothing beyond that.
     *
     * `credits` therefore starts at zero for everybody. It is the bought
     * balance, and nothing has been bought.
     */
    const owner = isAdminEmail(env, address);
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, picture, role, credits, unlimited, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).bind(
      id, address, name || null, picture || null,
      owner ? 'admin' : 'user',
      owner ? 1 : 0,
      now(), now()
    ).run();

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

/**
 * What a free account gets in a day.
 *
 * KEPT UNDER ITS OLD NAME because the old name is what this deployment's
 * settings already say, and the number the owner chose should not change
 * meaning underneath them. It was the one-off welcome grant; it is now the
 * daily allowance, which is a smaller promise made every morning instead of a
 * larger one made once. See limits.js, which is where this actually lives now
 * -- this is a thin reader kept for the callers that have no database handy.
 */
export function welcomeCredits(env) {
  for (const name of ['FREE_DAILY', 'WELCOME_CREDITS']) {
    const raw = Number(env?.[name]);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  }
  return 30;
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
 * Park a one-time secret for a few minutes -- today, a sign-in link.
 *
 * `kind` is carried so that a second sort of short-lived token (an OAuth round
 * trip, an email change confirmation) cannot be spent as a sign-in link by
 * handing it to the wrong endpoint.
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

/* --------------------------------------------------------- the allowance */

/**
 * Today's free passes for one account: how many are gone, and of how many.
 *
 * `limit` is the account's own override if one has been set, and the free-tier
 * number otherwise. A row from a previous day is reported as an unspent day
 * rather than as yesterday's count, which is the same rule the spend below
 * applies -- stated in one place so the badge and the charge cannot disagree
 * about whether it is tomorrow yet.
 */
export async function dailyState(env, user, freeDaily) {
  const tier = Math.max(0, Math.floor(Number(freeDaily) || 0));
  if (!accountsEnabled(env) || !user) return { used: 0, limit: tier, own: false };

  let row = null;
  try {
    row = await env.DB.prepare('SELECT day, used, daily_limit FROM allowances WHERE user_id = ?')
      .bind(user.id).first();
  } catch {
    // An older database without the table. The tier is still the honest answer.
    return { used: 0, limit: tier, own: false };
  }

  const own = row && row.daily_limit !== null && row.daily_limit !== undefined;
  return {
    used: row && row.day === dayKey() ? Math.max(0, row.used) : 0,
    limit: own ? Math.max(0, row.daily_limit) : tier,
    own: Boolean(own),
  };
}

/**
 * Which day the allowance belongs to, where the users are.
 *
 * The same rule and the same zone as the signed-out allowance in quota.js --
 * duplicated as four lines rather than imported, because quota.js is about KV
 * counters and this file is about SQL, and a dependency between them for one
 * date format would be the wrong shape of coupling. If they ever disagree the
 * tests say so: both are asserted against the same expectation.
 */
const RESET_ZONE = 'America/Detroit';
export function dayKey(when = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: RESET_ZONE }).format(when);
  } catch {
    return when.toISOString().slice(0, 10);
  }
}

/**
 * Take `n` passes out of today's allowance, atomically, resetting it if the
 * row belongs to a previous day.
 *
 * THE RESET IS PART OF THE SPEND, not a job that runs at midnight. A scheduled
 * reset is a thing that can fail to run, run twice, or run in the wrong
 * timezone, and its failure mode is everybody locked out until somebody
 * notices. Folding it into the CASE means the first detection of the day does
 * the reset as a side effect of succeeding, and there is nothing to schedule.
 *
 * ONE STATEMENT, for the reason the rest of this file exists: read-modify-write
 * lets two presses a second apart both read the same count and both write one
 * more than it, which is a free detection. The affordability test lives in the
 * WHERE so the database serialises them, and `changes` says who won.
 */
async function spendDaily(env, user, cost, limit) {
  if (cost > limit) return false;
  const day = dayKey();
  try {
    const done = await env.DB.prepare(
      `INSERT INTO allowances (user_id, day, used, daily_limit, updated_at)
       VALUES (?1, ?2, ?3, NULL, ?5)
       ON CONFLICT(user_id) DO UPDATE SET
         day  = ?2,
         used = CASE WHEN allowances.day = ?2 THEN allowances.used + ?3 ELSE ?3 END,
         updated_at = ?5
       WHERE (CASE WHEN allowances.day = ?2 THEN allowances.used ELSE 0 END) + ?3
             <= COALESCE(allowances.daily_limit, ?4)`
    ).bind(user.id, day, cost, limit, now()).run();
    return Boolean(done.meta?.changes);
  } catch {
    return false;
  }
}

/** Hand back passes charged against today's allowance for something that never ran. */
async function unspendDaily(env, user, back) {
  if (!back) return;
  try {
    await env.DB.prepare(
      'UPDATE allowances SET used = MAX(0, used - ?), updated_at = ? WHERE user_id = ? AND day = ?'
    ).bind(back, now(), user.id, dayKey()).run();
  } catch { /* older database; nothing was charged there either */ }
}

/** Raise or clear one account's own daily allowance. `null` puts it back on the tier. */
export async function setDailyLimit(env, userId, value) {
  const n = value === null || value === undefined || value === ''
    ? null
    : Math.max(0, Math.floor(Number(value)));
  if (n !== null && !Number.isFinite(n)) return false;

  await env.DB.prepare(
    `INSERT INTO allowances (user_id, day, used, daily_limit, updated_at)
     VALUES (?1, NULL, 0, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET daily_limit = ?2, updated_at = ?3`
  ).bind(userId, n, now()).run();
  return true;
}

/* ---------------------------------------------------------------- paying */

/**
 * Pay for `n` passes: today's allowance first, bought credits for the rest.
 *
 * THE ORDER IS THE WHOLE DESIGN. Free passes come back tomorrow and bought
 * ones do not, so spending the perishable one first is the only order that
 * does not quietly burn something somebody paid for while a free pass sat
 * unused beside it.
 *
 * AND IT SPLITS. Two free passes left, ten bought, and a four-box press: all
 * of it from one pocket would refuse a detection the account can plainly
 * afford. So the allowance is emptied and the remainder is bought, and if the
 * second half fails the first is handed straight back -- being turned away
 * should not cost anything.
 *
 * The split is computed from a read, which can be stale, and that is safe
 * rather than merely tolerable: both writes carry their own affordability test
 * in SQL, so a stale read can make the split wrong but can never make a pass
 * free. A wrong split fails and unwinds; it does not overdraw.
 *
 * An unlimited account passes without either number moving, and still writes a
 * ledger row -- "unlimited" means uncharged, not unrecorded, because those
 * detections cost real money at Replicate and an account that shows as idle
 * while doing the most detecting is a reporting bug.
 */
export async function spendCredits(env, user, amount, detail = null, freeDaily = 0) {
  const cost = Math.max(0, Math.floor(amount));
  const state = await dailyState(env, user, freeDaily);
  const shape = {
    balance: user.credits,
    daily: { used: state.used, limit: state.limit },
    unlimited: !!user.unlimited,
  };

  if (!cost) return { ok: true, spent: 0, fromDaily: 0, ...shape };

  if (user.unlimited) {
    await recordLedger(env, user.id, 0, 'detect', detail, cost);
    return { ok: true, spent: 0, fromDaily: 0, ...shape };
  }

  const headroom = Math.max(0, state.limit - state.used);
  const fromDaily = Math.min(cost, headroom);
  const fromCredits = cost - fromDaily;

  const gotDaily = fromDaily ? await spendDaily(env, user, fromDaily, state.limit) : true;
  if (!gotDaily) return { ok: false, spent: 0, fromDaily: 0, wanted: cost, ...shape };

  if (fromCredits) {
    const paid = await env.DB.prepare(
      'UPDATE users SET credits = credits - ? WHERE id = ? AND credits >= ?'
    ).bind(fromCredits, user.id, fromCredits).run();

    if (!paid.meta?.changes) {
      await unspendDaily(env, user, fromDaily);
      const fresh = await env.DB.prepare('SELECT credits FROM users WHERE id = ?')
        .bind(user.id).first();
      return {
        ok: false, spent: 0, fromDaily: 0, wanted: cost,
        ...shape, balance: fresh?.credits ?? 0,
      };
    }
  }

  /*
   * ONE LEDGER ROW PER PRESS, carrying the passes in `units` and only the
   * bought part in `delta`.
   *
   * `delta` has to stay "what moved the balance" or the balance stops being
   * the sum of its history, which is the one thing the ledger is for. `units`
   * is what the press cost upstream, free or not -- so the console's usage
   * figures count every pass while the balance still reconciles.
   */
  await recordLedger(env, user.id, -fromCredits, 'detect', detail, cost);
  const fresh = await env.DB.prepare('SELECT credits FROM users WHERE id = ?')
    .bind(user.id).first();
  const after = await dailyState(env, user, freeDaily);

  return {
    ok: true,
    spent: fromCredits,
    fromDaily,
    balance: fresh?.credits ?? 0,
    daily: { used: after.used, limit: after.limit },
    unlimited: false,
  };
}

/**
 * Give back what was charged for something that did not happen.
 *
 * Unconditional, unlike spending: there is no "too many" to fail on, and a
 * refund that silently did not land is money taken for nothing. The allowance
 * is unwound first for the same reason it is spent first -- putting it all
 * back as bought credits would turn a failed detection into a small gift.
 */
export async function refundCredits(env, user, amount, detail = null, fromDaily = 0) {
  const back = Math.max(0, Math.floor(amount));
  if (!back || user.unlimited) return;

  const free = Math.min(back, Math.max(0, Math.floor(fromDaily)));
  const bought = back - free;

  if (free) await unspendDaily(env, user, free);
  if (bought) {
    await env.DB.prepare('UPDATE users SET credits = credits + ? WHERE id = ?')
      .bind(bought, user.id).run();
  }
  await recordLedger(env, user.id, bought, 'refund', detail, -back);
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
export const publicUser = (user, daily = null) => (user ? {
  id: user.id,
  email: user.email,
  name: user.name || null,
  picture: user.picture || null,
  admin: user.role === 'admin',
  // The bought balance. Usually zero, and that is not an empty account -- the
  // allowance below is what an ordinary account detects with.
  credits: user.unlimited ? null : user.credits,
  unlimited: Boolean(user.unlimited),
  /*
   * Today's allowance, when the caller looked it up.
   *
   * Sent as used-and-limit rather than as one "left" number so the browser can
   * say "3 of 30 left today" -- a bare 3 reads as an account running out
   * permanently, which is the misunderstanding this whole shape exists to
   * prevent.
   */
  daily: daily ? { used: daily.used, limit: daily.limit } : null,
} : null);
