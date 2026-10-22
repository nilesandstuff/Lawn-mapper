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
import { readCookies, sharedCookie, clearCookie } from './unified.js';

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
export function sessionCookie(token, { maxAge, secure = true, host = null }) {
  // ONE SIGN-IN FOR EVERY TOOL (owner, 2026-10-16): given the host, the cookie
  // is set for the whole home domain, so the dashboard on nilesandstuff.com,
  // the lawn mapper and the water map all see it (unified.js sharedCookie).
  if (host) return sharedCookie(SESSION_COOKIE, token, { maxAge, secure, host });
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

/** Every Set-Cookie that signs this browser out: the host-only copy and the shared one. */
export const clearedCookies = (secure, host) => clearCookie(SESSION_COOKIE, { secure, host });

/**
 * Who is asking, and with which cookie, or null. A browser that signed in
 * before the cookie was shared can send two (the old host-only one and the
 * new one); the first that names a live session wins.
 */
export async function currentSession(request, env) {
  if (!accountsEnabled(env)) return null;
  for (const token of readCookies(request, SESSION_COOKIE)) {
    const user = await sessionUser(env, token);
    if (user) return { user, token };
  }
  return null;
}

/** Who is asking, or null. Also nudges the session's expiry along. */
export async function currentUser(request, env, ctx) {
  const s = await currentSession(request, env);
  if (!s) return null;
  if (ctx?.waitUntil) ctx.waitUntil(touchSession(env, s.token));
  return s.user;
}

/* ------------------------------------------------------------ magic link */

/** A plausible address. Not a validator -- the mail either arrives or it does not. */
export const looksLikeEmail = (value) =>
  /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(String(value || '').trim());

/** A path on this site, or the front page. Never somewhere else's. */
export function safeNext(next) {
  // "home:/dashboard" is a path on the home domain this site sits under (the
  // dashboard, owner 2026-10-16); routes-auth.js land() turns it into that
  // one parent and nothing else.
  const n = String(next || '').trim();
  if (n.startsWith('home:')) return `home:${safeNext(n.slice(5))}`;
  const raw = n;
  // A protocol-relative URL ("//evil.example") is a path by the letter of the
  // rule and an offsite redirect in practice, which is why this is not just a
  // leading-slash test. An open redirect on a sign-in endpoint is how a
  // phishing link gets to wear your domain in the address bar.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  /*
   * A QUERY STRING IS KEPT -- it is what makes ?via=paid a paid link rather
   * than the front page -- and A FRAGMENT IS NOT.
   *
   * The redirect appends its own `#signed-in`, which is how the app knows to
   * say so. A fragment already in here would leave two, and the outcome the
   * page reads would be the wrong half of them. Capped as well, because this
   * is stored against the challenge and there is no legitimate long one.
   */
  return raw.split('#')[0].slice(0, 512) || '/';
}

/**
 * Send a sign-in link.
 *
 * ALWAYS ANSWERS THE SAME, whether or not an account exists. "No account with
 * that address" turns a sign-in form into a way to ask the site which of your
 * friends have signed up, one address at a time. The link creates the account
 * if there is not one, so there is nothing to disclose in the first place.
 */
/*
 * HOW MANY SIGN-IN MAILS AN HOUR (2026-10-22 audit): anyone could ask for a
 * link to any address as often as they liked, which is a way to mail-bomb a
 * stranger from this domain and burn the sender's standing. Counted in the
 * QUOTA KV namespace by the hour; a site without it is not limited, as before.
 */
export const MAIL_PER_ADDRESS_HOUR = 5;
export const MAIL_PER_IP_HOUR = 20;

export async function mailRateLimited(request, env, address) {
  const kv = env?.QUOTA;
  if (!kv) return false;
  const hour = Math.floor(Date.now() / 3600000);
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const keys = [[`mail:a:${hour}:${address}`, MAIL_PER_ADDRESS_HOUR], [`mail:i:${hour}:${ip}`, MAIL_PER_IP_HOUR]];
  const counts = await Promise.all(keys.map(([k]) => kv.get(k)));
  if (keys.some(([, cap], i) => Number(counts[i] || 0) >= cap)) return true;
  await Promise.all(keys.map(([k], i) => kv.put(k, String(Number(counts[i] || 0) + 1), { expirationTtl: 3600 })));
  return false;
}

export async function beginMagicLink(request, env, email, next) {
  if (!mailConfigured(env)) return { error: 'no-mail' };
  if (!looksLikeEmail(email)) return { error: 'bad-email' };

  const address = String(email).trim().toLowerCase();
  if (await mailRateLimited(request, env, address)) return { error: 'too-many' };
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
  for (const token of readCookies(request, SESSION_COOKIE)) await endSession(env, token);
}

export { createSession, publicUser, accountsEnabled };
