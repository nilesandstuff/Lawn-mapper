/**
 * The sign-in routes, kept out of the main router.
 *
 * Not tidiness: these are the only routes in the app that answer with a
 * REDIRECT and a Set-Cookie rather than with JSON, and the only one a person
 * arrives at by following a link from their mail client. Mixing them into the
 * switch that serves the measurement API meant every one of those differences
 * had to be remembered in the middle of unrelated code.
 */

import {
  beginMagicLink, finishMagicLink, signOut, sessionCookie, clearedCookie,
  currentUser,
} from './auth.js';
import {
  accountsEnabled, createSession, publicUser, sweepExpired, dailyState,
} from './db.js';
import { mailConfigured } from './mail.js';
import { limits } from './limits.js';
// The paid route's rate and the shape of a payout destination. Shared with the
// queue so the browser cannot be told one number and the owner another.
import { PAYOUT_KINDS, cleanPayoutHandle, PAID_RATE_CENTS, MIN_PAYOUT_CENTS } from './jobs.js';

export const isAuthPath = (pathname) => pathname.startsWith('/api/auth/');

/** https, or a plain-http dev server where a Secure cookie would be dropped. */
const isSecure = (url) => new URL(url).protocol === 'https:';

/**
 * Land somewhere on the site, saying how it went.
 *
 * A redirect rather than a JSON body because the browser got here by
 * NAVIGATING -- from a mail client. There is no fetch waiting for a response
 * to read; there is a person looking at a page. The outcome travels in the
 * fragment so the app can say it and then clear it, so it is never sent to the
 * server, and so a failed attempt is not left sitting in history as a query
 * string.
 */
function land(url, path, outcome, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${new URL(url).origin}${path}${outcome ? `#${outcome}` : ''}`,
      // A sign-in outcome is about one person and one moment. Nothing should
      // keep it, least of all a shared proxy.
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export async function handleAuth(request, env, url, origin, ctx, json) {
  const path = url.pathname.slice('/api/auth/'.length);
  const secure = isSecure(request.url);

  /*
   * Nothing here works without a database, and saying so plainly beats every
   * route failing in its own way. A deployment with no D1 binding is not
   * broken -- it is the app as it was before accounts, and the browser reads
   * this to know not to offer a sign-in button at all.
   */
  if (!accountsEnabled(env)) {
    return json({ error: 'accounts-disabled' }, 501, origin);
  }

  /* --------------------------------------------------------- who am I */
  if (path === 'me') {
    const user = await currentUser(request, env, ctx);
    // Swept here rather than on a schedule: it is the request that happens on
    // every page load, the deletes are indexed, and a cron trigger is one more
    // thing to set up from a phone for a job this cheap.
    if (ctx?.waitUntil) ctx.waitUntil(sweepExpired(env));
    /*
     * Today's allowance travels with the account, not only with the quota
     * badge. The account sheet is where somebody looks when the badge says
     * they are out, so it is the one place that must not be able to show a
     * stale or different number.
     */
    const daily = user && !user.unlimited
      ? await dailyState(env, user, (await limits(env)).free_daily)
      : null;
    return json({
      user: publicUser(user, daily),
      // Whether this deployment can send a link. Without it there is no way in
      // at all, and the panel says so rather than showing a form that cannot
      // work.
      email: mailConfigured(env),
    }, 200, origin);
  }

  /* ------------------------------------------------------- sign out */
  if (path === 'signout') {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);
    await signOut(request, env);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': clearedCookie(secure),
        'Cache-Control': 'no-store',
      },
    });
  }

  /* ------------------------------------------- where to send what is owed */
  /*
   * A PAYMENT ADDRESS IS NOT AN IDENTIFIER, and everything about this route
   * follows from that.
   *
   * It lives on the account rather than in the link, which is the whole reason
   * the paid route goes through sign-in. In a URL it would be typed once per
   * device with no way to correct a typo, it would sit in every access log the
   * request touches, and there would be no second way to reach somebody when a
   * payment bounced.
   *
   * It is kept EXACTLY as typed -- see cleanPayoutHandle, which removes
   * control characters and nothing else. The cleaner that guards a worker id
   * strips '@', which would turn dave@example.com into daveexample.com and
   * leave the owner guessing where the at sign went.
   */
  if (path === 'payout') {
    const user = await currentUser(request, env, ctx);
    if (!user) return json({ error: 'Sign in first' }, 401, origin);

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const kind = PAYOUT_KINDS.includes(String(body?.kind || '')) ? String(body.kind) : null;
      const handle = cleanPayoutHandle(body?.handle);
      if (!kind || !handle) {
        return json({
          error: 'Need a destination',
          reason: 'Pick Venmo or PayPal and give the username or email that '
            + 'goes with it.',
        }, 400, origin);
      }

      await env.DB.prepare(
        'UPDATE users SET payout_kind = ?2, payout_handle = ?3, payout_at = ?4 WHERE id = ?1'
      ).bind(user.id, kind, handle, new Date().toISOString()).run();

      return json({ ok: true, kind, handle }, 200, origin);
    }

    return json({
      kind: user.payout_kind || null,
      handle: user.payout_handle || null,
    }, 200, origin);
  }

  /* --------------------------------------------- how my own tracing is going */
  /*
   * SCOPED TO THE SIGNED-IN ACCOUNT AND NOTHING ELSE. Every row here is read
   * by `worker = user.id`, which is the id the paid route takes from the
   * session rather than from the request -- so there is no parameter to
   * tamper with and no way to ask about somebody else.
   *
   * It exists because "did my map get approved" is otherwise unanswerable from
   * the worker's side, and a person who cannot see that has to take the
   * owner's word for what they are owed.
   */
  if (path === 'mywork') {
    const user = await currentUser(request, env, ctx);
    if (!user) return json({ error: 'Sign in first' }, 401, origin);

    const totals = await env.DB.prepare(
      `SELECT
         COUNT(*)                                                AS sent,
         SUM(CASE WHEN state = 'submitted' THEN 1 ELSE 0 END)    AS waiting,
         SUM(CASE WHEN state = 'kept'      THEN 1 ELSE 0 END)    AS approved,
         SUM(CASE WHEN state = 'excused'   THEN 1 ELSE 0 END)    AS excused,
         SUM(CASE WHEN state = 'refused'   THEN 1 ELSE 0 END)    AS refused
       FROM lawn_jobs
      WHERE worker = ?1 AND submitted_at IS NOT NULL`
    ).bind(user.id).first();

    const recent = await env.DB.prepare(
      `SELECT id, county, state, submitted_at, decided_at
         FROM lawn_jobs
        WHERE worker = ?1 AND submitted_at IS NOT NULL
        ORDER BY submitted_at DESC LIMIT 40`
    ).bind(user.id).all();

    /*
     * ONLY APPROVED MAPS EARN, and the arithmetic is done here rather than in
     * the browser so there is one answer to "what am I owed" rather than two
     * that can disagree. An excused map -- "not good enough, but a hard lawn"
     * -- is explicitly not an approval and pays nothing.
     */
    const approved = Number(totals?.approved || 0);
    return json({
      sent: Number(totals?.sent || 0),
      waiting: Number(totals?.waiting || 0),
      approved,
      excused: Number(totals?.excused || 0),
      refused: Number(totals?.refused || 0),
      rateCents: PAID_RATE_CENTS,
      earnedCents: approved * PAID_RATE_CENTS,
      minPayoutCents: MIN_PAYOUT_CENTS,
      payout: { kind: user.payout_kind || null, handle: user.payout_handle || null },
      maps: (recent.results || []).map((r) => ({
        county: r.county || null,
        state: r.state,
        submittedAt: r.submitted_at,
        decidedAt: r.decided_at || null,
      })),
    }, 200, origin);
  }

  /* ------------------------------------------------- email: ask for a link */
  if (path === 'email') {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);

    let body = {};
    try { body = await request.json(); } catch { /* an empty body fails below */ }

    const sent = await beginMagicLink(request, env, body.email, body.next);

    /*
     * "bad-email" is told; "send failed" is told too. What is NOT told is
     * whether an account already existed -- the link creates one if it has to,
     * so the same answer is the honest one either way, and a sign-in form
     * stops being a way to ask the site which of your friends have signed up.
     */
    if (sent.error === 'bad-email') {
      return json({ error: 'bad-email', message: 'That does not look like an email address.' }, 400, origin);
    }
    if (sent.error === 'no-mail') {
      return json({ error: 'no-mail', message: 'This site cannot send email yet.' }, 501, origin);
    }
    if (sent.error) {
      return json({ error: 'send-failed', message: sent.detail || 'The email could not be sent.' }, 502, origin);
    }
    return json({ ok: true }, 200, origin);
  }

  /* ---------------------------------------------- email: follow the link */
  if (path === 'email/verify') {
    const done = await finishMagicLink(env, url.searchParams.get('token'));
    if (done.error) return land(request.url, '/', `signin-error=${done.error}`);

    const session = await createSession(env, done.user.id);
    return land(request.url, done.next, 'signed-in', {
      'Set-Cookie': sessionCookie(session.token, { maxAge: session.maxAge, secure }),
    });
  }

  return json({ error: 'Not found' }, 404, origin);
}
