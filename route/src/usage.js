/**
 * Mapbox use, counted as Mapbox bills it, and stopped before the free
 * allowance runs out (owner, 2026-10-26: "so we never go above the free
 * limit").
 *
 *   geocode     one per request (Temporary Geocoding: 100,000 free a month)
 *   matrix      sources x destinations per request (Matrix: 100,000 elements)
 *   directions  one per request (Directions: 100,000)
 *
 * EVERY CALL IS RESERVED BEFORE IT IS SENT, in one SQL statement that adds
 * the units only if the total stays within the cap -- so two plans at once
 * cannot both slip under it. A call that does not fit is refused (429) and
 * nothing goes to Mapbox. No meter (no database bound) refuses everything:
 * an uncounted call is the one thing this exists to prevent.
 *
 * THE CAPS SIT BELOW THE FREE AMOUNTS ON PURPOSE:
 *   - geocode at 45,000: Lawn Mapper's address search uses the same
 *     account's 100,000 and does not count its own, so the planner keeps to
 *     less than half.
 *   - matrix and directions at 95,000: nothing else on the site uses them
 *     (checked 2026-10-26), and 5% covers retries and any difference between
 *     this count and Mapbox's.
 *
 * Months are calendar months, UTC, as Mapbox's free allowances reset.
 */

export const FREE = { geocode: 100000, matrix: 100000, directions: 100000 };
export const CAP = { geocode: 45000, matrix: 95000, directions: 95000 };

export class LimitError extends Error {
  constructor(api, resets) {
    super(api === 'meter'
      ? 'Mapbox use cannot be counted right now, so nothing was sent. Try again later.'
      : `This month's free Mapbox allowance for ${({ geocode: 'address lookups', matrix: 'drive times', directions: 'drawing routes' })[api]} is used up. It resets ${new Date(`${resets}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}.`);
    this.api = api;
    this.resets = resets;
  }
}

export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
export function resetsOn(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

const ready = new WeakSet();
async function init(db) {
  if (ready.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS usage (month TEXT NOT NULL, api TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (month, api))').run();
  ready.add(db);
}

/** Add units to this month's count; with a cap, only if the total stays within it. True if added. */
async function addUnits(db, api, units, cap, now) {
  await init(db);
  const month = monthOf(now);
  await db.prepare('INSERT OR IGNORE INTO usage (month, api, used) VALUES (?1, ?2, 0)').bind(month, api).run();
  const row = await db.prepare(cap == null
    ? 'UPDATE usage SET used = used + ?3 WHERE month = ?1 AND api = ?2 RETURNING used'
    : 'UPDATE usage SET used = used + ?3 WHERE month = ?1 AND api = ?2 AND used + ?3 <= ?4 RETURNING used')
    .bind(...(cap == null ? [month, api, units] : [month, api, units, cap])).first();
  return Boolean(row);
}

/**
 * The meter the Mapbox calls go through.
 *   reserve(api, units)  before a call: throws LimitError if it would pass the cap
 *   add(api, units)      a retry of a call already reserved: counted, never refused
 */
export function meter(env, now = () => Date.now()) {
  const db = env.USAGE;
  return {
    async reserve(api, units) {
      if (!units) return;
      if (!db || !CAP[api]) throw new LimitError('meter');
      let ok;
      try { ok = await addUnits(db, api, units, CAP[api], now()); } catch { throw new LimitError('meter'); }
      if (!ok) throw new LimitError(api, resetsOn(now()));
    },
    async add(api, units) {
      if (db && units) await addUnits(db, api, units, null, now()).catch(() => {});
    },
  };
}

/** This month's use: each API's count and cap, and the smallest share left, in percent. */
export async function report(env, now = Date.now()) {
  const apis = {};
  for (const k of Object.keys(CAP)) apis[k] = { used: 0, cap: CAP[k], free: FREE[k] };
  if (env.USAGE) {
    await init(env.USAGE);
    const { results } = await env.USAGE.prepare('SELECT api, used FROM usage WHERE month = ?1').bind(monthOf(now)).all();
    for (const r of results || []) if (apis[r.api]) apis[r.api].used = r.used;
  }
  const left = Math.min(...Object.values(apis).map((a) => Math.max(0, 1 - a.used / a.cap)));
  return { month: monthOf(now), resets: resetsOn(now), counting: Boolean(env.USAGE), left: Math.floor(left * 1000) / 10, apis };
}
