/**
 * WHO USES THE SHADE MAP, AND WHAT GOES WRONG FOR THEM (owner, 2026-10-14:
 * "usage statistics and logs ... from non admin users (also exclude my
 * github account and Claude). Include error tracking as well.")
 *
 *   POST /api/shade/event   { kind, detail, client, self }   from the page
 *   POST /api/shade/error   { where, message, client, self }  from the page
 *   GET  /api/shade/admin/usage   the admin page's figures (ADMIN ONLY, 404)
 *
 * The user-agent filter below decides what is COUNTED, nothing more: it
 * is not access control. The figures are protected by the admin route's
 * 404 alone (core session's note, 2026-10-14).
 *
 * NOT RECORDED, decided here and not trusted to the page alone:
 *   - a signed-in admin (the owner);
 *   - a device the owner marked as his own on the admin page (`self`), so
 *     his phone counts for nothing even signed out;
 *   - anything automated: GitHub's runners, the sessions' test browsers and
 *     scripts (headless Chrome, node, curl, python), crawlers and bots, and
 *     anything calling itself Claude or Anthropic.
 *
 * KEPT SMALL ON PURPOSE: no IP address, no user agent, no address or
 * coordinate (the page sends none, and numbers in error text are blanked
 * here too). A random id per browser tells one visitor from another. Both
 * tables trim themselves. Bookkeeping only: nothing here can break a page,
 * and a missing table (before the deploy's schema step) is simply skipped.
 */

import { currentUser } from './auth.js';

const MAX_EVENTS = 50000, MAX_ERRORS = 5000;

/** Automated callers, by their user agent (also an empty one). */
export function isAutomated(ua) {
  const s = String(ua || '');
  if (!s.trim()) return true;
  return /HeadlessChrome|Playwright|Puppeteer|Lighthouse|PhantomJS|Electron|\bnode\b|undici|node-fetch|axios|curl|wget|python|aiohttp|httpx|Go-http-client|Java\/|okhttp|libwww|GitHub|github-actions|Claude|anthropic|bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|preview/i.test(s);
}

/** Free text made safe to keep: one line, numbers that could place someone blanked, short. */
export function scrub(v, max = 300) {
  if (v === null || v === undefined) return null;
  return String(v).replace(/\s+/g, ' ').replace(/-?\d+\.\d{3,}/g, '#').replace(/\d{3,}/g, '#').trim().slice(0, max) || null;
}
const word = (v, max = 40) => (typeof v === 'string' && /^[a-z0-9 _.-]{1,40}$/i.test(v) ? v.slice(0, max) : null);
const clientId = (v) => (typeof v === 'string' && /^[a-z0-9-]{8,40}$/i.test(v) ? v : null);

/** Who is calling: 'skip' with the reason, or a visitor. */
async function caller(request, env, ctx, body) {
  if (isAutomated(request.headers.get('User-Agent'))) return { skip: 'automated' };
  if (body?.self === true || body?.self === 1) return { skip: 'owner device' };
  const me = await currentUser(request, env, ctx).catch(() => null);
  if (me?.role === 'admin') return { skip: 'admin' };
  return { signedIn: me ? 1 : 0 };
}

async function bodyOf(request) {
  try {
    const text = await request.text();
    return text.length > 4000 ? null : JSON.parse(text);
  } catch { return null; }
}

/** A server-side failure of a shade route, kept like a page's error (no request detail). */
export async function logServerError(request, env, where, message) {
  if (!env?.DB || isAutomated(request.headers.get('User-Agent'))) return;
  try {
    await env.DB.prepare('INSERT INTO shade_errors (at, source, page, message, detail, client, signed_in) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(new Date().toISOString(), 'server', word(where), scrub(message), null, null, null).run();
  } catch { /* not kept */ }
}

export async function handleUsage(request, url, env, origin, ctx, json) {
  const db = env.DB;
  const quiet = () => new Response(null, { status: 204 });
  if (url.pathname === '/api/shade/event' && request.method === 'POST') {
    if (!db) return quiet();
    const body = await bodyOf(request);
    const kind = word(body?.kind);
    if (!kind) return json({ error: 'kind required' }, 400, origin);
    const who = await caller(request, env, ctx, body);
    if (who.skip) return quiet();
    try {
      await db.prepare('INSERT INTO shade_events (at, kind, page, client, signed_in, detail) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(new Date().toISOString(), kind, word(body?.page), clientId(body?.client), who.signedIn, scrub(body?.detail, 120)).run();
      if (Math.random() < 0.01) await db.prepare(`DELETE FROM shade_events WHERE id < (SELECT MAX(id) - ${MAX_EVENTS} FROM shade_events)`).run();
    } catch { /* not kept */ }
    return quiet();
  }
  if (url.pathname === '/api/shade/error' && request.method === 'POST') {
    if (!db) return quiet();
    const body = await bodyOf(request);
    if (!body?.message) return json({ error: 'message required' }, 400, origin);
    const who = await caller(request, env, ctx, body);
    if (who.skip) return quiet();
    try {
      await db.prepare('INSERT INTO shade_errors (at, source, page, message, detail, client, signed_in) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(new Date().toISOString(), 'page', word(body?.page), scrub(body.message), scrub(body?.where, 120), clientId(body?.client), who.signedIn).run();
      if (Math.random() < 0.05) await db.prepare(`DELETE FROM shade_errors WHERE id < (SELECT MAX(id) - ${MAX_ERRORS} FROM shade_errors)`).run();
    } catch { /* not kept */ }
    return quiet();
  }
  if (url.pathname === '/api/shade/admin/usage' && request.method === 'GET') {
    const me = await currentUser(request, env, ctx).catch(() => null);
    if (!db || me?.role !== 'admin') return json({ error: 'Not found' }, 404, origin);
    return json(await usageReport(db), 200, origin);
  }
  return null;
}

/** The admin page's figures: totals over 1, 7 and 30 days, by day, by kind, and the latest rows. */
export async function usageReport(db, now = Date.now()) {
  const since = (d) => new Date(now - d * 86400000).toISOString();
  const all = async (sql, ...b) => { try { return (await db.prepare(sql).bind(...b).all()).results || []; } catch { return []; } };
  const one = async (sql, ...b) => (await all(sql, ...b))[0] || {};
  const window = async (d) => {
    const e = await one(`SELECT COUNT(*) AS events, COUNT(DISTINCT client) AS visitors,
        SUM(CASE WHEN kind = 'open' THEN 1 ELSE 0 END) AS opens,
        SUM(CASE WHEN kind = 'built' THEN 1 ELSE 0 END) AS builds,
        SUM(CASE WHEN signed_in = 1 THEN 1 ELSE 0 END) AS signedIn
      FROM shade_events WHERE at >= ?`, since(d));
    const r = await one('SELECT COUNT(*) AS errors FROM shade_errors WHERE at >= ?', since(d));
    return { ...e, errors: r.errors || 0 };
  };
  const [day, week, month] = await Promise.all([window(1), window(7), window(30)]);
  return {
    totals: { day, week, month },
    byDay: await all(`SELECT substr(at, 1, 10) AS day, COUNT(*) AS events, COUNT(DISTINCT client) AS visitors,
        SUM(CASE WHEN kind = 'built' THEN 1 ELSE 0 END) AS builds FROM shade_events WHERE at >= ? GROUP BY day ORDER BY day`, since(30)),
    byDayErrors: await all('SELECT substr(at, 1, 10) AS day, COUNT(*) AS errors FROM shade_errors WHERE at >= ? GROUP BY day ORDER BY day', since(30)),
    byKind: await all('SELECT kind, COUNT(*) AS n, COUNT(DISTINCT client) AS visitors FROM shade_events WHERE at >= ? GROUP BY kind ORDER BY n DESC', since(30)),
    topErrors: await all('SELECT source, message, COUNT(*) AS n, MAX(at) AS last FROM shade_errors WHERE at >= ? GROUP BY source, message ORDER BY n DESC LIMIT 15', since(30)),
    events: await all('SELECT at, kind, page, client, signed_in AS signedIn, detail FROM shade_events ORDER BY id DESC LIMIT 100'),
    errors: await all('SELECT at, source, page, message, detail, client, signed_in AS signedIn FROM shade_errors ORDER BY id DESC LIMIT 100'),
  };
}
