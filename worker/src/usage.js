/**
 * Every charged detect press, for the console's usage figures (owner,
 * 2026-09-30). See detect_usage in schema.sql for why the ledger was not
 * enough: it only ever saw signed-in accounts.
 *
 * Bookkeeping only. Nothing here can refuse or break a detection: every write
 * is caught, and a missing table (before the deploy's schema step) is simply
 * not counted.
 */

const now = () => new Date().toISOString();

export async function countPress(env, { id, passes, who, model }) {
  if (!env?.DB || !passes) return;
  try {
    await env.DB.prepare(
      `INSERT INTO detect_usage (id, at, passes, who, model) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO NOTHING`
    ).bind(id || `u-${crypto.randomUUID()}`, now(), passes, who || null, model || null).run();
  } catch { /* not counted; never a failed detection */ }
}

export async function markRefunded(env, id) {
  if (!env?.DB || !id) return;
  try {
    await env.DB.prepare('UPDATE detect_usage SET refunded = 1 WHERE id = ?1').bind(id).run();
  } catch { /* as above */ }
}

/**
 * Presses and passes since `since`, and per day for the chart.
 *
 * From detect_usage where it has rows, and from the ledger (accounts only,
 * the old source) for the days before it began -- so the history does not
 * drop to nothing on the day this started, and nothing is counted twice.
 * Handed-back presses are left out: they cost the person nothing.
 */
export async function usageSince(env, since) {
  let first = null;
  try {
    first = (await env.DB.prepare('SELECT MIN(at) first FROM detect_usage').first())?.first || null;
  } catch { first = null; }
  const cut = first || '9999';
  const [fresh, old] = await Promise.all([
    first
      ? env.DB.prepare(
        `SELECT COUNT(*) presses, COALESCE(SUM(passes), 0) passes FROM detect_usage
          WHERE refunded = 0 AND at >= ?1`
      ).bind(since).first()
      : Promise.resolve({ presses: 0, passes: 0 }),
    env.DB.prepare(
      `SELECT COUNT(*) presses, COALESCE(SUM(units), 0) passes FROM ledger
        WHERE reason = 'detect' AND at >= ?1 AND at < ?2`
    ).bind(since, cut).first(),
  ]);
  return {
    presses: (fresh?.presses || 0) + (old?.presses || 0),
    passes: (fresh?.passes || 0) + (old?.passes || 0),
  };
}

export async function usageDaily(env, since) {
  let first = null;
  try {
    first = (await env.DB.prepare('SELECT MIN(at) first FROM detect_usage').first())?.first || null;
  } catch { first = null; }
  const cut = first || '9999';
  const [fresh, old] = await Promise.all([
    first
      ? env.DB.prepare(
        `SELECT substr(at, 1, 10) day, COUNT(*) presses, COALESCE(SUM(passes), 0) passes
           FROM detect_usage WHERE refunded = 0 AND at >= ?1 GROUP BY day`
      ).bind(since).all()
      : Promise.resolve({ results: [] }),
    env.DB.prepare(
      `SELECT substr(at, 1, 10) day, COUNT(*) presses, COALESCE(SUM(units), 0) passes
         FROM ledger WHERE reason = 'detect' AND at >= ?1 AND at < ?2 GROUP BY day`
    ).bind(since, cut).all(),
  ]);
  const byDay = new Map();
  for (const r of [...(old.results || []), ...(fresh.results || [])]) {
    const d = byDay.get(r.day) || { day: r.day, presses: 0, passes: 0 };
    d.presses += r.presses;
    d.passes += r.passes;
    byDay.set(r.day, d);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 30);
}
