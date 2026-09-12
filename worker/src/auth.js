/**
 * Signing in: a link in your email, and nothing else.
 *
 * ONE DOOR, ON PURPOSE. There were three planned -- Google, Facebook, email --
 * and the other two were dropped before they shipped. What they buy is one
 * tap instead of a trip to an inbox; what they cost is a registered
 * application per provider, a consent screen to keep current, a client secret
 * to rotate, and a second and third code path through the single most
 * security-sensitive part of the app. For a tool measuring lawns for a handful
 * of people, that is a great deal of standing obligation for a saved tap.
 *
 * The email link is also the only one that is self-verifying. Receiving it IS
 * the proof, so there is no `email_verified` claim to trust or forget to
 * check -- which was the one rule the multi-provider version rested on and the
 * one that fails silently when a provider is added carelessly. With one door,
 * the rule is not a rule; it is the mechanism.
 *
 * NO PASSWORD, and that is not a compromise either. There is nothing here to
 * forget, to reuse from another site, to leak in a breach, or to reset. The
 * address is the account.
 *
 * If a provider is ever wanted, it is an authorization-code flow with PKCE
 * against this same `findOrCreateUser` -- the account model already supports
 * several doors to one address, and the `identities` table already records
 * which was used.
 */

import {
  accountsEnabled, createChallenge, useChallenge, createSession, endSession,
  findOrCreateUser, sessionUser, touchSession, publicUser,
} from './db.js';
import { sendMagicLink, mailConfigured } from './mail.js';

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
 * ordinary requests. Lax rather than Strict because the magic link is a
 * top-level navigation FROM a mail client, and Strict would drop the cookie on
 * exactly the request that just created it.
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

/* ------------------------------------------------------------ magic link */

/** A plausible address. Not a validator -- the mail either arrives or it does not. */
export const looksLikeEmail = (value) =>
  /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(String(value || '').trim());

/** A path on this site, or the front page. Never somewhere else's. */
export function safeNext(next) {
  const raw = String(next || '').trim();
  // A protocol-relative URL ("//evil.example") is a path by the letter of the
  // rule and an offsite redirect in practice, which is why this is not just a
  // leading-slash test. An open redirect on a sign-in endpoint is how a
  // phishing link gets to wear your domain in the address bar.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

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

/**
 * Spend a link and sign the person in.
 *
 * The address is trusted here because receiving the link IS the verification:
 * the token went to that inbox and came back. Nothing else in this file has to
 * remember to check it, because there is nowhere else an address can enter.
 */
export async function finishMagicLink(env, token) {
  const parked = await useChallenge(env, 'magic', token);
  if (!parked?.email) return { error: 'expired' };

  /*
   * The subject is the NORMALISED address, not the one as typed.
   *
   * `identities` is keyed on (provider, subject), so passing the raw string
   * gave the same person a fresh row every time they capitalised their address
   * differently -- one account, correctly, with four ways in recorded against
   * it, all of them the same way. Harmless and wrong, and the kind of thing
   * that looks like evidence of something when read months later.
   */
  const address = String(parked.email).trim().toLowerCase();
  const user = await findOrCreateUser(env, {
    email: address,
    provider: 'email',
    subject: address,
  });
  return { user, next: safeNext(parked.data?.next) };
}

/* ------------------------------------------------------------- sign out */

export async function signOut(request, env) {
  await endSession(env, readCookie(request, SESSION_COOKIE));
}

export { createSession, publicUser, accountsEnabled };
