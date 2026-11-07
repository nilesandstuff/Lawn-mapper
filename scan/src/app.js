/**
 * THE ANDROID APP'S ROUTES (core session, 2026-11-07; android/README.md, docs/SCAN-PLAN.md section 10).
 *
 *   GET /api/app/version   the latest build: { code, name, bridge, at } (workflow "A. Android app" writes it)
 *   GET /api/app/apk       the latest build's APK, for Chrome to download and the phone to install
 *   GET /api/app/pair      from Chrome, signed in: a one-time code for the app, handed over by an intent link
 *   GET /api/app/claim     from the app, with that code: the app's WebView gets the same sign-in, then the page
 *
 * The app's WebView cannot sign in on its own: the sign-in link in the email opens in Chrome, never in the app. So
 * Chrome, already signed in, pairs it: /pair keeps the session for five minutes under a random code and sends Chrome
 * to lawnar://signin?t=<code>; the app opens /claim?t=<code> in its WebView, which sets the session's cookie there
 * once and forgets the code. Every route but /claim sits behind the admin-only gate (src/index.js); /claim is the
 * sign-in itself and carries its own proof.
 *
 * The APK and version.json live in the twin bucket under app/ (private); the signing key too, as app/release.jks,
 * never served.
 */

export const APP_APK = 'app/lawn-ar.apk';
export const APP_VERSION = 'app/version.json';
export const APP_PACKAGE = 'app.lawnmapper.ar';
export const SESSION = 'lm_session';
export const PAIR_MS = 5 * 60 * 1000;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** One cookie's value from a request, or null. */
export function cookieOf(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** A random code, hex. */
export function code(bytes = 24) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Chrome's way to open an app by its link, falling back to nothing (the page says what to do then). */
export const intentFor = (t) => `intent://signin?t=${t}#Intent;scheme=lawnar;package=${APP_PACKAGE};end`;

export const pairCookie = (session, secure = true) => `${SESSION}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`;

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="robots" content="noindex">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;background:#f6f8f7;color:#17201c}@media (prefers-color-scheme:dark){body{background:#101513;color:#e7eeea}a{color:#6aa8ff}}</style></head><body>${body}</body></html>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** The app's routes, or null when the path is not one of them. */
export async function app(request, env, url) {
  if (!url.pathname.startsWith('/api/app/')) return null;
  const p = url.pathname.slice('/api/app/'.length);
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405);

  if (p === 'version') {
    const o = env.TWIN ? await env.TWIN.get(APP_VERSION) : null;
    return json(o ? await o.json() : { code: 0 });
  }

  if (p === 'apk') {
    const o = env.TWIN ? await env.TWIN.get(APP_APK) : null;
    if (!o) return json({ error: 'no app built yet' }, 404);
    return new Response(o.body, { headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="yard-ar.apk"',
      'Cache-Control': 'private, no-store',
    } });
  }

  if (p === 'pair') {
    const session = cookieOf(request, SESSION);
    if (!session || !env.DB) return page('Pair the app', '<h1>Sign in first</h1><p>Open this from the Yard AR page while signed in.</p>', 401);
    const t = code();
    const now = Date.now();
    await env.DB.prepare('DELETE FROM app_pairs WHERE expires < ?').bind(now).run();
    await env.DB.prepare('INSERT INTO app_pairs (token, session, expires) VALUES (?, ?, ?)').bind(t, session, now + PAIR_MS).run();
    return new Response(null, { status: 302, headers: { Location: intentFor(t), 'Cache-Control': 'no-store' } });
  }

  if (p === 'claim') {
    const t = url.searchParams.get('t') || '';
    if (!/^[0-9a-f]{16,64}$/.test(t) || !env.DB) return page('Pair the app', '<h1>That pairing link is not valid</h1><p>On the Yard AR page in Chrome, tap "Open in the app" again.</p>', 400);
    const row = await env.DB.prepare('SELECT session, expires FROM app_pairs WHERE token = ?').bind(t).first();
    await env.DB.prepare('DELETE FROM app_pairs WHERE token = ?').bind(t).run();
    if (!row || row.expires < Date.now()) return page('Pair the app', '<h1>That pairing link has expired</h1><p>On the Yard AR page in Chrome, tap "Open in the app" again (a link lasts five minutes and works once).</p>', 410);
    return new Response(null, { status: 302, headers: { Location: '/?app=1', 'Set-Cookie': pairCookie(row.session, url.protocol === 'https:'), 'Cache-Control': 'no-store' } });
  }

  return json({ error: 'Not found' }, 404);
}
