/**
 * Which places people asked about and could not be served.
 *
 * THE COUNTY LIST IS A GUESS AND THIS IS THE MEASUREMENT. Counties get added
 * because somebody noticed a server existed, which selects for counties that
 * are easy to add rather than counties anybody wants. A ranked list of the
 * addresses that actually came back empty turns "which should I do next" from
 * a hunch into a morning's work with a reason attached.
 *
 * TWO NUMBERS, BECAUSE ONE OF THEM LIES ON ITS OWN. Fifty lookups in a county
 * is one person trying repeatedly or fifty people trying once, and those are
 * opposite findings: the first is somebody stuck -- possibly the owner testing
 * -- and the second is demand. Neither number can be derived from the other,
 * so both are kept.
 */

/** A short, trimmed string or null. Never stores an empty label as a place. */
const text = (v, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
};

/**
 * Record one failed lookup.
 *
 * NEVER THROWS, and that is deliberate rather than lazy. This runs inside the
 * parcel route, and the route's job is to tell somebody whether there is a
 * boundary. A bookkeeping table that is missing, locked, or full must not turn
 * a working "no property line here, trace it by hand" into a failed request --
 * the feature would be costing users the thing it exists to improve.
 *
 * Returns whether it recorded, so a test can tell "wrote nothing on purpose"
 * from "wrote nothing because it broke".
 */
export async function recordParcelGap(env, { county, state, who, covered = false }) {
  if (!env?.DB) return false;

  /*
   * A miss with no county name is not recorded at all.
   *
   * Most of them are the sea, or a point the geocoder placed outside any
   * county it names. Filing those under "unknown" would build the biggest row
   * in the table out of exactly the cases nobody can act on, and it would sit
   * at the top of the ranking this exists to produce.
   */
  const place = text(county, 80);
  const region = text(state, 40);
  if (!place || !region) return false;

  const id = text(who, 64) || 'anon';
  const now = new Date().toISOString();

  try {
    /*
     * Upsert, so the row is the running total for one person in one county.
     * ON CONFLICT rather than a read-then-write: two tabs from the same person
     * would otherwise both read 3 and both write 4.
     *
     * `covered` is OR-ed rather than overwritten -- a county that answered
     * once is configured, whatever a later right-of-way lookup reports.
     */
    await env.DB.prepare(
      `INSERT INTO parcel_gaps (county, state, who, hits, covered, first_at, last_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
       ON CONFLICT(county, state, who) DO UPDATE SET
         hits = hits + 1,
         covered = MAX(covered, ?4),
         last_at = ?5,
         -- Asked again after being resolved: it is open again, and the
         -- old resolution stays readable so the wrong fix can be audited.
         resolution = CASE WHEN status = 'resolved'
           THEN 'REOPENED ' || ?5 || ' -- asked again after: ' || COALESCE(resolution, '') ELSE resolution END,
         status = 'open'`
    ).bind(place, region, id, covered ? 1 : 0, now).run();
    return true;
  } catch {
    return false;
  }
}

/**
 * The orderings this report is allowed to have.
 *
 * A map rather than string interpolation: `sort` arrives from a query string,
 * and ORDER BY cannot be a bound parameter. Anything not named here falls back
 * rather than reaching the database.
 */
export const GAP_SORTS = {
  hits: 'hits DESC, people DESC',
  people: 'people DESC, hits DESC',
  recent: 'last_at DESC',
};

/**
 * The ranked list, already aggregated.
 *
 * GROUPED IN SQL, NOT IN THE CONSOLE, because the list is cut to a limit. A
 * page sorted by hits and then re-sorted by people in the browser is the top
 * fifty by hits in a different order -- which looks exactly like the top fifty
 * by people and is not. Re-asking costs one query and is correct.
 */
export async function parcelGaps(env, { sort = 'hits', limit = 50 } = {}) {
  if (!env?.DB) return { places: [], unavailable: 'no database' };

  const order = GAP_SORTS[sort] ? sort : 'hits';
  const n = Math.max(1, Math.min(200, Number(limit) || 50));

  try {
    const { results } = await env.DB.prepare(
      `SELECT county, state,
              SUM(hits) hits,
              /* One row per person already, so counting rows counts people. */
              COUNT(*) people,
              MAX(covered) configured,
              MAX(last_at) last_at,
              MIN(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) resolved,
              MAX(resolved_at) resolved_at,
              MAX(resolved_by) resolved_by,
              -- An open row's text first: a place asked again after being
              -- resolved says so, whatever the other people's rows still say.
              COALESCE(MAX(CASE WHEN status = 'open' THEN resolution END), MAX(resolution)) resolution
         FROM parcel_gaps
        GROUP BY county, state
        ORDER BY ${GAP_SORTS[order]}
        LIMIT ${n}`
    ).all();

    return {
      sort: order,
      places: (results || []).map((r) => ({
        county: r.county,
        state: r.state,
        hits: r.hits,
        people: r.people,
        /*
         * Told apart because they need opposite work. A county with no entry
         * in the list is one to ADD; a county that is configured and still
         * answered nothing is one whose server, layer or field names want
         * looking at -- or simply a run of right-of-way points, which is why
         * this is shown rather than alerted on.
         */
        configured: Boolean(r.configured),
        lastAt: r.last_at,
        status: r.resolved ? 'resolved' : 'open',
        resolvedAt: r.resolved_at || null,
        resolvedBy: r.resolved_by || null,
        resolution: r.resolution || null,
      })),
    };
  } catch (e) {
    return { places: [], unavailable: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Mark every row for one place open or resolved, with who and why. The
 * deploy does this when the registry has come to serve the county
 * (tools/resolve-logs.js); the console does it by hand.
 */
export async function setGapStatus(env, { county, state, status, by, resolution }) {
  if (!env?.DB) return false;
  const place = text(county, 80), region = text(state, 40);
  if (!place || !region || !['open', 'resolved'].includes(status)) return false;
  try {
    const r = await env.DB.prepare(
      `UPDATE parcel_gaps SET status = ?3, resolved_at = ?4, resolved_by = ?5, resolution = ?6
        WHERE county = ?1 AND state = ?2`
    ).bind(place, region, status, status === 'resolved' ? new Date().toISOString() : null,
      status === 'resolved' ? text(by, 40) : null, text(resolution, 600)).run();
    return (r.meta?.changes ?? 0) > 0;
  } catch { return false; }
}
