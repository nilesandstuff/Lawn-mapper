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
import {
  accountsEnabled, grantCredits, publicUser, setDailyLimit, dayKey,
} from './db.js';
import { limits, limitsForConsole, setLimit, LIMITS } from './limits.js';
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
    const [people, maps, today, week, month, owed, live, corpus] = await Promise.all([
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
      /*
       * The training corpus: how many finished maps are banked, and how many
       * of them are worth anything.
       *
       * THREE NUMBERS BECAUSE THEY ARE SCARCE IN DIFFERENT WAYS -- not because
       * one kind of row is worth having and the other is not. An earlier
       * version of this comment claimed a map accepted unchanged only teaches
       * a model to imitate the detector, and that is wrong twice over: a
       * student trained on a teacher's own labels routinely beats the teacher
       * once the task is narrow enough, and a training set made only of the
       * detector's FAILURES teaches a model that every lawn is a hard case.
       * Accepted maps are most of the distribution and the calibration comes
       * from them.
       *
       * What is true is narrower. Scattered label error averages out, so more
       * accepted rows are free. DIRECTIONAL error does not -- the detector's
       * known habit of overshooting a tree line by about a quarter is wrong
       * the same way every time, and no quantity of quietly accepted rows will
       * cancel it. Only rows where somebody disagreed carry that signal, and
       * acceptance is the weaker evidence anyway: it can mean the trace was
       * right, or that nobody looked closely at it.
       *
       * So `total` is how much there is and `corrected` is how much of the
       * scarce kind -- the hard cases that fix a known fault, and the clean
       * measure of whether it was fixed. Both are wanted; they simply do not
       * arrive at the same rate.
       *
       * Ten per cent is the line between a correction and a nudge. Dragging a
       * vertex a few feet is somebody tidying an edge; a tenth of the lawn is
       * somebody saying the detector was wrong.
       *
       * `with_image` is separate because a row can save while its photograph
       * does not -- COUNT(column) skips NULLs, which is exactly that case.
       *
       * AND IT MUST NOT BE ABLE TO BREAK THIS PAGE, hence the catch. The
       * console is where you go when something is wrong, including a
       * half-applied schema; losing accounts, credits and the AI spend because
       * a nice-to-have count referenced a missing table would be the worst
       * possible trade. A null here renders as "not recording" and nothing
       * else on the page notices.
       */
      env.DB.prepare(
        `SELECT COUNT(*) total,
                COUNT(image_key) with_image,
                COALESCE(SUM(CASE
                  WHEN detected_sq_ft IS NULL THEN 1
                  WHEN detected_sq_ft > 0
                   AND ABS(square_feet - detected_sq_ft) * 10 >= detected_sq_ft THEN 1
                  ELSE 0 END), 0) corrected
         FROM corpus`
      ).first().catch(() => null),
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
      // Renamed out of SQL's snake_case here rather than in the page, so the
      // console never has to know what the column was called.
      corpus: corpus
        ? { total: corpus.total, withImage: corpus.with_image, corrected: corpus.corrected }
        : null,
      today, week, month, daily,
      logging: loggingEnabled(env),
      feedback: feedbackEnabled(env),
    }, 200, origin);
  }

  /* ------------------------------------------------------------ the prices */
  /*
   * The daily allowances, readable and writable without a deploy.
   *
   * THE REASON THIS ROUTE EXISTS. These numbers are the price list, and every
   * question about them -- is five a day too mean, is the address ceiling
   * stopping a real customer -- is answered by changing one and watching. A
   * change that costs a trip to a repository settings page and a deploy, from
   * a phone, does not get made often enough to answer anything, so the numbers
   * stay at whatever was guessed first.
   */
  if (path === 'settings') {
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

      const rejected = [];
      for (const [key, value] of Object.entries(body || {})) {
        if (!LIMITS[key]) { rejected.push(key); continue; }
        // `null` clears the row and goes back to the deployment's own number.
        // It has to be expressible, or a mistyped value can only be replaced
        // by remembering what was there before it.
        if (!(await setLimit(env, key, value, me.email))) rejected.push(key);
      }
      if (rejected.length) {
        return json({ error: `not a number, or not a setting: ${rejected.join(', ')}` }, 400, origin);
      }
    }

    return json({ settings: await limitsForConsole(env) }, 200, origin);
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

    const tier = (await limits(env)).free_daily;

    const { results } = await env.DB.prepare(
      `SELECT u.*,
              a.day dayk, a.used dayused, a.daily_limit ownlimit,
              (SELECT COUNT(*) FROM maps m WHERE m.user_id = u.id) maps,
              (SELECT COALESCE(SUM(units), 0) FROM ledger l
                WHERE l.user_id = u.id AND l.reason = 'detect') passes
       FROM users u
       LEFT JOIN allowances a ON a.user_id = u.id
       WHERE ? = ''
          OR lower(u.email) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(u.name, '')) LIKE ? ESCAPE '\\'
       ORDER BY u.last_seen_at DESC NULLS LAST LIMIT 100`
    ).bind(q, like, like).all();

    const today = dayKey();

    return json({
      users: results.map((u) => ({
        ...publicUser(u, {
          // A row from a previous day is an unspent day, not yesterday's
          // count -- the same rule the charge applies, so the console and the
          // detection cannot disagree about whether it is tomorrow yet.
          used: u.dayk === today ? Math.max(0, u.dayused || 0) : 0,
          limit: u.ownlimit === null || u.ownlimit === undefined ? tier : u.ownlimit,
        }),
        // The console needs the true balance even for an unlimited account --
        // publicUser hides it, correctly, from the account's own owner.
        rawCredits: u.credits,
        // null means "whatever the free tier is", which is not the same as a
        // hand-set limit that happens to equal it: the second one also means
        // somebody vouched for this account. See allowance.js.
        dailyLimit: u.ownlimit === null || u.ownlimit === undefined ? null : u.ownlimit,
        role: u.role,
        maps: u.maps,
        passes: u.passes,
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
      })),
      tier,
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

    /*
     * This account's own daily allowance, and the door in the address ceiling.
     *
     * Setting one is also how an account is VOUCHED FOR: an office of eight
     * people behind one IP is indistinguishable from eight accounts made by
     * one person, and no rule will ever separate them -- so a person does,
     * here, in four seconds. A vouched account stops being counted against the
     * shared address. See allowance.js.
     *
     * `null` clears it and puts the account back on the free tier, which also
     * un-vouches it. Both directions have to be reachable or the console can
     * only ever make exceptions, never end one.
     */
    if ('dailyLimit' in body) {
      const raw = body.dailyLimit;
      const clear = raw === null || raw === '';
      if (!clear && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
        return json({ error: 'A daily limit is a number of passes, or blank.' }, 400, origin);
      }
      await setDailyLimit(env, id, clear ? null : Number(raw));
    }

    const after = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    const own = await env.DB.prepare('SELECT day, used, daily_limit FROM allowances WHERE user_id = ?')
      .bind(id).first();
    const tier = (await limits(env)).free_daily;

    return json({
      user: {
        ...publicUser(after, {
          used: own && own.day === dayKey() ? Math.max(0, own.used) : 0,
          limit: own && own.daily_limit !== null && own.daily_limit !== undefined
            ? own.daily_limit : tier,
        }),
        rawCredits: after.credits,
        dailyLimit: own && own.daily_limit !== null && own.daily_limit !== undefined
          ? own.daily_limit : null,
        role: after.role,
      },
    }, 200, origin);
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
