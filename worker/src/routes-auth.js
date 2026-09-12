/**
 * The sign-in routes, kept out of the main router.
 *
 * Not tidiness: these are the only routes in the app that answer with a
 * REDIRECT and a Set-Cookie rather than with JSON, and the only ones a person
 * arrives at by following a link from somewhere else. Mixing them into the
 * switch that serves the measurement API meant every one of those differences
 * had to be remembered in the middle of unrelated code.
 */

import {
  PROVIDERS, availableProviders, beginOAuth, finishOAuth,
  beginMagicLink, finishMagicLink, signOut, sessionCookie, clearedCookie,
  currentUser,
} from './auth.js';
import {
  accountsEnabled, createSession, publicUser, sweepExpired,
} from './db.js';
import { mailConfigured } from './mail.js';

export const isAuthPath = (pathname) => pathname.startsWith('/api/auth/');

/** https, or a plain-http dev server where a Secure cookie would be dropped. */
const isSecure = (url) => new URL(url).protocol === 'https:';

/**
 * Land somewhere on the site, saying how it went.
 *
 * A redirect rather than a JSON body because the browser got here by
 * NAVIGATING -- from Google, or from a mail client. There is no fetch waiting
 * for a response to read; there is a person looking at a page. The outcome
 * travels in the fragment so the app can say it and then clear it, and so a
 * failed attempt is not left sitting in history as a query string.
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
    return json({
      user: publicUser(user),
      providers: availableProviders(env),
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

  /* ------------------------------------------------- email: ask for a link */
  if (path === 'email') {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405, origin);

    let body = {};
    try { body = await request.json(); } catch { /* an empty body fails below */ }

    const sent = await beginMagicLink(request, env, body.email, body.next);

    /*
     * "bad-email" is told; "no such account" never happens and "send failed"
     * is told too. What is NOT told is whether an account already existed --
     * the link creates one if it has to, so the same answer is the honest one
     * either way, and a sign-in form stops being a way to ask the site which
     * of your friends have signed up.
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

  /* -------------------------------------------------------- a provider */
  const asCallback = path.match(/^([a-z0-9]+)\/callback$/);
  if (asCallback) {
    const done = await finishOAuth(request, env, asCallback[1], url);
    if (done.error) return land(request.url, '/', `signin-error=${done.error}`);

    const session = await createSession(env, done.user.id);
    return land(request.url, done.next, 'signed-in', {
      'Set-Cookie': sessionCookie(session.token, { maxAge: session.maxAge, secure }),
    });
  }

  if (PROVIDERS[path]) {
    const to = await beginOAuth(request, env, path, url.searchParams.get('next'));
    if (!to) return land(request.url, '/', 'signin-error=provider-not-configured');
    return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
  }

  return json({ error: 'Not found' }, 404, origin);
}
