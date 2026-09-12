/**
 * The console: everything the owner needs to answer a question about the site.
 *
 * WHAT THIS REPLACES. The test log and the feedback list were each reachable by
 * putting a shared token in a URL. That worked, and it has three problems worth
 * fixing rather than living with: a token in a URL ends up in browser history
 * and in whatever sits between, one secret cannot tell two people apart, and
 * there was nowhere at all to do the thing most often wanted -- look at one
 * account and give it some credits.
 *
 * An admin session answers all three. Who did it is knowable, revoking access
 * is ending a session rather than rotating a secret everybody shares, and the
 * same door leads to the ledger and the users as to the logs.
 *
 * THE TOKEN ROUTES ARE LEFT ALONE, deliberately. They are the way back in if
 * something about accounts goes wrong -- and a console that can lock its own
 * administrator out with no second path is a console you cannot safely deploy
 * changes to.
 */

import { currentUser } from './auth.js';
import { accountsEnabled, grantCredits, publicUser } from './db.js';
import { logEntries, loggingEnabled } from './testlog.js';
import { feedbackEntries, feedbackEnabled } from './feedback.js';

export const isAdminPath = (pathname) => pathname.startsWith('/api/admin/');

/**
 * Everything here is refused the same way: 404.
 *
 * Not 403. A visitor who is not an administrator should not learn that there
 * is an administration API here at all -- "forbidden" is a map of what to
 * attack, and the console is not a secret worth the difference between the two
 * but it costs nothing to not advertise it.
 */
const hidden = (json, origin) => json({ error: 'Not found' }, 404, origin);

export async function handleAdmin(request, env, url, origin, ctx, json) {
  if (!accountsEnabled(env)) return hidden(json, origin);

  const me = await currentUser(request, env, ctx);
  if (!me || me.role !== 'admin') return hidden(json, origin);

  const path = url.pathname.slice('/api/admin/'.length);

  /* ------------------------------------------------------------ overview */
  if (path === 'overview') {
    /*
     * One round trip rather than six.
     *
     * D1 charges per statement and a phone pays for the latency of each, and
     * this is the page that loads first. The shape is ugly and the alternative
     * is a console that takes a second and a half to say hello.
     */
    const [people, maps, today, week, month, owed, live] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) n FROM users').first(),
      env.DB.prepare('SELECT COUNT(*) n FROM maps').first(),
      env.DB.prepare(
        `SELECT COUNT(*) presses, COALESCE(SUM(units), 0) passes FROM ledger
         WHERE reason = 'detect' AND at >= ?`
      ).bind(daysAgo(1)).first(),
      env.DB.prepare(
        `SELECT COUNT(*) presses, COALESCE(SUM(units), 0) passes FROM ledger
         WHERE reason = 'detect' AND at >= ?`
      ).bind(daysAgo(7)).first(),
      env.DB.prepare(
        `SELECT COUNT(*) presses, COALESCE(SUM(units), 0) passes FROM ledger
         WHERE reason = 'detect' AND at >= ?`
      ).bind(daysAgo(30)).first(),
      env.DB.prepare('SELECT COALESCE(SUM(credits), 0) n FROM users WHERE unlimited = 0').first(),
      env.DB.prepare('SELECT COUNT(*) n FROM sessions WHERE expires_at > ?')
        .bind(new Date().toISOString()).first(),
    ]);

    /* Passes per day, which is the shape of the Replicate bill. */
    const { results: daily } = await env.DB.prepare(
      `SELECT substr(at, 1, 10) day, COUNT(*) presses, COALESCE(SUM(units), 0) passes
       FROM ledger WHERE reason = 'detect' AND at >= ?
       GROUP BY day ORDER BY day DESC LIMIT 30`
    ).bind(daysAgo(30)).all();

    return json({
      users: people.n,
      maps: maps.n,
      sessions: live.n,
      creditsOutstanding: owed.n,
      today, week, month, daily,
      logging: loggingEnabled(env),
      feedback: feedbackEnabled(env),
    }, 200, origin);
  }

  /* -------------------------------------------------------------- people */
  if (path === 'users') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();

    /*
     * BINDING THE VALUE IS NOT ENOUGH FOR A LIKE.
     *
     * A bound parameter cannot become SQL -- that part is safe and was never
     * in question. But `%` and `_` are wildcards INSIDE a LIKE pattern
     * wherever they come from, so a search for "%" matched every account and a
     * search for "a_b" matched "axb". Not an injection; just a search box that
     * quietly does something other than search, which is the kind of thing
     * that is noticed as "the filter is broken" long after it stops mattering.
     *
     * So the metacharacters are escaped and the escape is declared. The
     * backslash has to go first, or escaping the others would re-escape it.
     */
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

    const { results } = await env.DB.prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM maps m WHERE m.user_id = u.id) maps,
              (SELECT COALESCE(SUM(units), 0) FROM ledger l
                WHERE l.user_id = u.id AND l.reason = 'detect') passes
       FROM users u
       WHERE ? = ''
          OR lower(u.email) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(u.name, '')) LIKE ? ESCAPE '\\'
       ORDER BY u.last_seen_at DESC NULLS LAST LIMIT 100`
    ).bind(q, like, like).all();

    return json({
      users: results.map((u) => ({
        ...publicUser(u),
        // The console needs the true balance even for an unlimited account --
        // publicUser hides it, correctly, from the account's own owner.
        rawCredits: u.credits,
        role: u.role,
        maps: u.maps,
        passes: u.passes,
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
      })),
    }, 200, origin);
  }

  /* ----------------------------------------------------- one account's history */
  if (path === 'ledger') {
    const id = url.searchParams.get('user');
    if (!id) return json({ error: 'user required' }, 400, origin);
    const { results } = await env.DB.prepare(
      'SELECT delta, units, reason, detail, at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 200'
    ).bind(id).all();
    return json({ entries: results }, 200, origin);
  }

  /* -------------------------------------------------------------- changes */
  if (path === 'user') {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

    const id = String(body.id || '');
    const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!target) return json({ error: 'no such account' }, 404, origin);

    /*
     * YOU CANNOT TAKE YOUR OWN ADMIN AWAY.
     *
     * Recoverable in principle -- ADMIN_EMAILS re-grants it at the next sign-in
     * -- but only if the address is still listed there, and finding that out
     * while locked out of the console is not a thing to discover. The guard
     * costs a line.
     */
    if (id === me.id && body.role && body.role !== 'admin') {
      return json({ error: 'You cannot remove your own administrator access.' }, 400, origin);
    }

    if (Number.isFinite(Number(body.grant)) && Number(body.grant) !== 0) {
      await grantCredits(env, id, Number(body.grant), body.note || `by ${me.email}`);
    }
    if (body.role === 'admin' || body.role === 'user') {
      await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, id).run();
    }
    if (typeof body.unlimited === 'boolean') {
      await env.DB.prepare('UPDATE users SET unlimited = ? WHERE id = ?')
        .bind(body.unlimited ? 1 : 0, id).run();
    }

    const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return json({ user: { ...publicUser(after), rawCredits: after.credits, role: after.role } }, 200, origin);
  }

  /* --------------------------------------------------- the logs, session-gated */
  if (path === 'log') {
    /*
     * Read because this person is an administrator, not because a shared
     * token happens to exist. `logging` still says whether anything is being
     * recorded, so an empty list is distinguishable from a switched-off one.
     */
    if (!loggingEnabled(env)) return json({ entries: [], logging: false }, 200, origin);
    return json({ ...(await logEntries(env, 200)), logging: true }, 200, origin);
  }

  if (path === 'feedback') {
    if (!feedbackEnabled(env)) return json({ entries: [], enabled: false }, 200, origin);
    return json({ ...(await feedbackEntries(env, 100)), enabled: true }, 200, origin);
  }

  return hidden(json, origin);
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
