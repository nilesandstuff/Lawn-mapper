/**
 * Signing in: a provider, or a link in your email.
 *
 * TWO WAYS IN, AND THEY REACH THE SAME ACCOUNT. The email address is the
 * identity; Google and a magic link are two doors to it. Somebody who signs in
 * with Google today and clicks an emailed link next month is one person with
 * one set of saved maps, not two accounts wondering where their measurements
 * went.
 *
 * WHICH IS ONLY SAFE BECAUSE NO UNVERIFIED ADDRESS GETS THROUGH. A magic link
 * proves the address receives mail by construction. Google's claim is used
 * only when it says `email_verified`. A provider that hands over an address it
 * has not checked would otherwise let anyone take over anyone's account by
 * typing their address into it -- which is exactly how this design fails when
 * a third provider is added carelessly, so it is the rule to keep.
 *
 * ADDING A PROVIDER is a table entry below plus two secrets. The flow is the
 * same for all of them: OAuth 2.0 authorization code with PKCE, state parked
 * in the database for one use, and the token exchanged from the Worker so the
 * client secret never reaches a browser.
 */

import {
  accountsEnabled, createChallenge, useChallenge, createSession, endSession,
  findOrCreateUser, sessionUser, touchSession, publicUser, newSecret,
} from './db.js';
import { sendMagicLink, mailConfigured } from './mail.js';

/* ------------------------------------------------------------- providers */

/**
 * What each provider needs, and where it lives.
 *
 * `profile` is the only part that differs beyond URLs: each provider describes
 * a person in its own shape, and the job here is to turn that into an email,
 * a name and a picture -- or to refuse, if the address is not verified.
 */
export const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    idFrom: 'id_token',
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    /*
     * Google puts the profile in the id_token, so no second request is needed.
     *
     * The token is trusted WITHOUT verifying its signature, which is correct
     * here and would not be elsewhere: it did not arrive from the browser, it
     * came back over a direct TLS connection to Google's token endpoint,
     * authenticated with our client secret. OpenID Connect says so explicitly
     * for the authorization code flow. `aud` is still checked, because a token
     * minted for a different application is not about our user.
     */
    profile: (claims, env) => {
      if (claims.aud !== env.GOOGLE_CLIENT_ID) return null;
      if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return null;
      if (claims.email_verified !== true && claims.email_verified !== 'true') return null;
      return {
        subject: claims.sub,
        email: claims.email,
        name: claims.name || null,
        picture: claims.picture || null,
      };
    },
  },

  /*
   * Facebook is deliberately shaped and not enabled.
   *
   * The flow fits the table above, but the `email` permission needs Business
   * Verification before it works for anyone outside the app's own testers --
   * so switching it on without that produces accounts with no address, which
   * is the one thing this design cannot have. Left here as the shape to fill
   * in rather than as a promise the site cannot keep.
   *
   *   facebook: {
   *     label: 'Facebook',
   *     authorize: 'https://www.facebook.com/v21.0/dialog/oauth',
   *     token: 'https://graph.facebook.com/v21.0/oauth/access_token',
   *     scope: 'email public_profile',
   *     idFrom: 'userinfo',
   *     userinfo: 'https://graph.facebook.com/me?fields=id,name,email,picture',
   *     ...
   *   }
   */
};

/** The providers this deployment actually has keys for. */
export const availableProviders = (env) =>
  Object.entries(PROVIDERS)
    .filter(([, p]) => p.clientId(env) && p.clientSecret(env))
    .map(([id, p]) => ({ id, label: p.label }));

/* --------------------------------------------------------------- cookies */

export const SESSION_COOKIE = 'lm_session';

/**
 * Read one cookie out of a request.
 *
 * Written by hand because the header is a list and the name we want can be a
 * prefix of another one: a naive indexOf finds "lm_session_old" inside a
 * header that does not contain "lm_session" at all.
 */
export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * The session cookie, with the flags that make it one.
 *
 * httpOnly, so a cross-site script cannot read it. SameSite=Lax, so it is not
 * sent on a cross-site POST -- which is what stops another site's form from
 * spending your credits, and is why the API needs no separate CSRF token for
 * ordinary requests. Lax rather than Strict because the OAuth callback and the
 * magic link are both top-level navigations FROM somewhere else, and Strict
 * would drop the cookie on exactly the request that just created it.
 *
 * Secure is dropped on plain http so that `wrangler dev` on localhost can sign
 * in at all; a browser silently discards a Secure cookie over http, which
 * looks like a broken login rather than a refused cookie.
 */
export function sessionCookie(token, { maxAge, secure = true }) {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export const clearedCookie = (secure = true) =>
  sessionCookie('', { maxAge: 0, secure });

/** Who is asking, or null. Also nudges the session's expiry along. */
export async function currentUser(request, env, ctx) {
  if (!accountsEnabled(env)) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const user = await sessionUser(env, token);
  if (user && ctx?.waitUntil) ctx.waitUntil(touchSession(env, token));
  return user;
}

/* ----------------------------------------------------------------- PKCE */

/**
 * Proof Key for Code Exchange.
 *
 * The verifier stays on the server and the challenge goes out in the redirect,
 * so an authorization code intercepted on its way back cannot be exchanged by
 * whoever caught it. Not strictly required for a confidential client holding a
 * secret, and cheap enough that skipping it would be a choice rather than a
 * saving.
 */
async function pkce() {
  const verifier = newSecret();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let s = '';
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  const challenge = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

/** Where the provider sends the browser back to. Must match what is registered. */
export const callbackUrl = (url, provider) =>
  `${new URL(url).origin}/api/auth/${provider}/callback`;

/* ------------------------------------------------------------ the flows */

/**
 * Start a provider sign-in: park the state, send the browser onward.
 *
 * `next` is where to land afterwards, and it is deliberately restricted to a
 * path on this site. An open redirect on a sign-in endpoint is how a phishing
 * link gets to wear your domain in the address bar.
 */
export async function beginOAuth(request, env, providerId, next) {
  const provider = PROVIDERS[providerId];
  if (!provider || !provider.clientId(env) || !provider.clientSecret(env)) return null;

  const { verifier, challenge } = await pkce();
  const state = await createChallenge(env, 'oauth', {
    data: { provider: providerId, verifier, next: safeNext(next) },
    minutes: 10,
  });

  const to = new URL(provider.authorize);
  to.searchParams.set('client_id', provider.clientId(env));
  to.searchParams.set('redirect_uri', callbackUrl(request.url, providerId));
  to.searchParams.set('response_type', 'code');
  to.searchParams.set('scope', provider.scope);
  to.searchParams.set('state', state);
  to.searchParams.set('code_challenge', challenge);
  to.searchParams.set('code_challenge_method', 'S256');
  // Ask for the account picker rather than silently reusing whichever Google
  // account the browser happens to be signed in to.
  to.searchParams.set('prompt', 'select_account');
  return to.toString();
}

/** A path on this site, or the front page. Never somewhere else's. */
export function safeNext(next) {
  const raw = String(next || '').trim();
  // A protocol-relative URL ("//evil.example") is a path by the letter of the
  // rule and an offsite redirect in practice, which is why this is not just a
  // leading-slash test.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

/**
 * Finish a provider sign-in.
 *
 * Every failure returns a reason rather than throwing: this runs on a
 * navigation the user can see, so the answer is a page that says what went
 * wrong, not a stack trace.
 */
export async function finishOAuth(request, env, providerId, url) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { error: 'unknown-provider' };

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (url.searchParams.get('error')) return { error: 'declined' };
  if (!code || !state) return { error: 'incomplete' };

  const parked = await useChallenge(env, 'oauth', state);
  if (!parked || parked.data?.provider !== providerId) return { error: 'expired' };

  const body = new URLSearchParams({
    client_id: provider.clientId(env),
    client_secret: provider.clientSecret(env),
    code,
    code_verifier: parked.data.verifier,
    grant_type: 'authorization_code',
    redirect_uri: callbackUrl(request.url, providerId),
  });

  const res = await fetch(provider.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return { error: 'exchange-failed' };

  const tokens = await res.json();
  const claims = decodeJwtPayload(tokens.id_token);
  if (!claims) return { error: 'no-identity' };

  const who = provider.profile(claims, env);
  // The one refusal worth spelling out: an address the provider has not
  // verified cannot be used to claim an account, because the account IS the
  // address.
  if (!who?.email) return { error: 'unverified-email' };

  const user = await findOrCreateUser(env, {
    email: who.email,
    name: who.name,
    picture: who.picture,
    provider: providerId,
    subject: who.subject,
  });
  return { user, next: safeNext(parked.data?.next) };
}

/**
 * The middle third of a JWT, as an object.
 *
 * No signature check, deliberately and safely: see the note on Google's
 * `profile` above -- this token came back over a direct, authenticated TLS
 * connection to the provider's token endpoint, not from the browser. Reading a
 * token that arrived any other way without verifying it would be a hole.
 */
export function decodeJwtPayload(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/');
    const text = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    // atob gives bytes; the payload is UTF-8, so a name with an accent in it
    // needs decoding rather than being read as Latin-1.
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ magic link */

/** A plausible address. Not a validator -- the mail either arrives or it does not. */
export const looksLikeEmail = (value) =>
  /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(String(value || '').trim());

/**
 * Send a sign-in link.
 *
 * ALWAYS ANSWERS THE SAME, whether or not an account exists. "No account with
 * that address" turns a sign-in form into a way to ask the site which of your
 * friends have signed up, one address at a time. The link creates the account
 * if there is not one, so there is nothing to disclose in the first place.
 */
export async function beginMagicLink(request, env, email, next) {
  if (!mailConfigured(env)) return { error: 'no-mail' };
  if (!looksLikeEmail(email)) return { error: 'bad-email' };

  const address = String(email).trim().toLowerCase();
  const token = await createChallenge(env, 'magic', {
    email: address,
    data: { next: safeNext(next) },
    minutes: 20,
  });

  const link = `${new URL(request.url).origin}/api/auth/email/verify?token=${encodeURIComponent(token)}`;
  const sent = await sendMagicLink(env, address, link);
  return sent.ok ? { ok: true } : { error: 'send-failed', detail: sent.detail };
}

/** Spend a link and sign the person in. */
export async function finishMagicLink(env, token) {
  const parked = await useChallenge(env, 'magic', token);
  if (!parked?.email) return { error: 'expired' };

  const user = await findOrCreateUser(env, {
    email: parked.email,
    provider: 'email',
    subject: parked.email,
  });
  return { user, next: safeNext(parked.data?.next) };
}

/* ------------------------------------------------------------- sign out */

export async function signOut(request, env) {
  await endSession(env, readCookie(request, SESSION_COOKIE));
}

export { createSession, publicUser, accountsEnabled };
