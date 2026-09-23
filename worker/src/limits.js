/**
 * How many AI passes each kind of visitor gets in a day, and where that
 * number comes from.
 *
 * THREE PLACES, IN ORDER: a row in the settings table, then an environment
 * variable, then a constant here. Each is a fallback for the one before, which
 * is what makes the console safe to give numbers to -- a fresh deployment has
 * working limits before anybody opens it, and deleting a setting goes back to
 * the deployment's own number rather than to zero.
 *
 * Zero is a legitimate value and has to survive the fallback chain, so the
 * tests below are "is this a number" and not "is this truthy". `0` meaning
 * "nobody detects without an account" is a policy somebody might want; `0`
 * silently turning into 5 because of a `||` is a bug.
 *
 * WHY THESE ARE EDITABLE AT ALL. The signed-out allowance and the free-account
 * allowance are the price list. Every question about them -- is five too mean,
 * is thirty too generous, is the address ceiling stopping a real customer --
 * is answered by watching what happens after changing it, and a change that
 * costs a deploy does not get made often enough to answer anything.
 */

const now = () => new Date().toISOString();

/**
 * The settings, what they mean, and what they fall back to.
 *
 * `env` is the deployment's own default for the row. The order of this object
 * is the order the console shows them in, so it reads top to bottom as the
 * story of one detection: who is asking, then what the address allows.
 */
export const LIMITS = {
  anon_daily: {
    env: 'ANON_DAILY',
    fallback: 5,
    label: 'Signed out, per browser',
    help: 'AI passes a day for somebody who has not made an account.',
  },
  free_daily: {
    /*
     * WELCOME_CREDITS is read as well, and only as a fallback.
     *
     * It is the variable this deployment already has set, from when a new
     * account got a one-off grant instead of a daily allowance. Honouring it
     * means the number the owner already chose keeps applying across the
     * change rather than silently reverting to the built-in default -- and
     * the new name is what the console writes, so it stops mattering after
     * the first edit.
     */
    env: 'FREE_DAILY',
    envAlso: 'WELCOME_CREDITS',
    fallback: 30,
    label: 'Free account',
    help: 'AI passes a day for a signed-in account. Resets overnight.',
  },
  ip_daily: {
    env: 'IP_DAILY',
    fallback: 80,
    label: 'Any one address',
    help: 'Shared by every browser and every account behind one IP. '
      + 'This is what stops extra accounts from being extra passes.',
  },
  dev_daily: {
    env: 'DEV_DAILY',
    fallback: 80,
    label: 'Developer mode, per browser',
    help: 'Not a privilege and not guarded -- anyone who finds the unlock '
      + 'key gets it. The address ceiling below is the real backstop.',
  },
  ip_daily_dev: {
    env: 'IP_DAILY_DEV',
    fallback: 120,
    label: 'Any one address, developer mode',
    help: 'Has to sit above the developer allowance, or it becomes the '
      + 'binding one and the number above is decoration.',
  },
};

export const LIMIT_KEYS = Object.keys(LIMITS);

/** The deployment's own number for one setting: its variable, or the constant. */
function fromEnv(env, key) {
  const spec = LIMITS[key];
  if (!spec) return null;
  for (const name of [spec.env, spec.envAlso].filter(Boolean)) {
    const raw = Number(env?.[name]);
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  }
  return spec.fallback;
}

/**
 * A short memory of the settings table, per isolate.
 *
 * Every detection and every badge refresh wants these, and without this they
 * are an extra D1 round trip on each -- paid for in latency on a phone, on the
 * request that is already the slowest thing the app does.
 *
 * FIFTEEN SECONDS, and the staleness is the point rather than a compromise: an
 * edit in the console shows up within a quarter of a minute everywhere, which
 * is faster than anyone can check whether it worked, and no amount of
 * invalidation could do better across isolates anyway. Busting it locally on a
 * write is still worth the line, because the console reads back its own change
 * immediately and would otherwise show the old number.
 *
 * KEYED ON THE DATABASE HANDLE, not on nothing.
 *
 * A single module-level `let` would be a cache shared by every database this
 * module ever sees. One isolate serves one deployment with one binding, so in
 * production that is a distinction without a difference -- and it is exactly
 * the sort of "cannot happen here" that is true until a test harness, a
 * preview deployment or a second binding makes it false, and then presents as
 * one site quietly running on another's price list. A WeakMap costs nothing
 * and removes the question.
 */
const CACHE_MS = 15 * 1000;
const cache = new WeakMap();

export function forgetLimits(env) {
  if (env?.DB) cache.delete(env.DB);
}

/**
 * Every limit, resolved. Never throws and never returns a partial answer.
 *
 * A database that is missing, unreachable or older than the settings table
 * gives the environment's numbers, because a site that stops measuring because
 * a lookup table could not be read is a worse outcome than one running on its
 * deployed defaults.
 */
export async function limits(env) {
  const base = {};
  for (const key of LIMIT_KEYS) base[key] = fromEnv(env, key);

  if (!env?.DB) return base;
  const hit = cache.get(env.DB);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...base, ...hit.values };

  const stored = {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN (${LIMIT_KEYS.map(() => '?').join(', ')})`
    ).bind(...LIMIT_KEYS).all();
    for (const row of results || []) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) stored[row.key] = Math.floor(n);
    }
    cache.set(env.DB, { at: Date.now(), values: stored });
  } catch {
    // Older database, no settings table, or D1 having a moment. The defaults
    // are not a degraded mode -- they are the numbers this deploy shipped with.
    return base;
  }

  return { ...base, ...stored };
}

/**
 * Write one setting, or clear it back to the deployment's default.
 *
 * `null` deletes the row rather than storing a zero, so "put this back how it
 * was" is expressible. It has to be, or the only way out of a bad number typed
 * into the console is remembering what the old one was.
 */
export async function setLimit(env, key, value, who = null) {
  if (!env?.DB || !LIMITS[key]) return false;

  if (value === null || value === undefined || value === '') {
    await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
    forgetLimits(env);
    return true;
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return false;

  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, String(Math.floor(n)), now(), who).run();

  forgetLimits(env);
  return true;
}

/**
 * The settings as the console shows them: what is in force, and whether that
 * is a stored choice or the deployment's default.
 *
 * Saying WHICH matters more than it looks. "80" beside a box you just typed 80
 * into tells you nothing about whether the save landed; "80, from the
 * settings" and "80, from the deployment" are different answers to the only
 * question anybody has after pressing save.
 */
export async function limitsForConsole(env) {
  const live = await limits(env);
  const stored = await storedKeys(env);
  return LIMIT_KEYS.map((key) => ({
    key,
    value: live[key],
    fallback: fromEnv(env, key),
    // A stored row that happens to equal the default is still a stored row --
    // asked by value, "is this saved" would answer no for a deliberate choice.
    stored: stored.includes(key),
    label: LIMITS[key].label,
    help: LIMITS[key].help,
  }));
}

/** Which settings are actually rows, as opposed to inherited numbers. */
async function storedKeys(env) {
  if (!env?.DB) return [];
  try {
    const { results } = await env.DB.prepare('SELECT key FROM settings').all();
    return (results || []).map((r) => r.key);
  } catch {
    return [];
  }
}
