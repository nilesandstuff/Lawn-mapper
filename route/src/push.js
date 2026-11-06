/**
 * Notifications (route session, 2026-11-06): "Your route changed" on a
 * phone whose page is closed, by Web Push.
 *
 * The push carries NOTHING: the Worker signs a request to the phone's push
 * service (Google's, Apple's, Mozilla's) with its VAPID key and sends no
 * body, so no message encryption is needed and no address passes through
 * the push service. The phone's service worker (public/sw.js), woken, asks
 * this Worker for the latest message for its subscription and shows it.
 *
 *   GET    /api/push/key                      the public VAPID key, for subscribing
 *   POST   /api/share/<id>/subscribe { person, subscription }
 *   DELETE /api/share/<id>/subscribe { subscription }
 *   GET    /api/push/latest?endpoint=...      what to show (the service worker asks)
 *   PUT    /api/push/config { publicKey, privateJwk }   the keys, with the route key
 *
 * The keys live in KV ("push-vapid"), not the repository; subscriptions and
 * the last message for each in D1 (push_sub, push_msg), 30 days at most.
 */

import { keyed } from './store.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf8 = (s) => new TextEncoder().encode(s);

/** Push services a subscription may point at: nowhere else is ever fetched. */
export const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
export function validEndpoint(e) {
  try { const u = new URL(e); return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname); } catch { return false; }
}

const ready = new WeakSet();
async function init(db) {
  if (ready.has(db)) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS push_sub (endpoint TEXT NOT NULL, day_id TEXT NOT NULL, person_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (endpoint, day_id))').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS push_msg (endpoint TEXT PRIMARY KEY, msg TEXT NOT NULL, at INTEGER NOT NULL)').run();
  ready.add(db);
}

/** A VAPID JWT for one push service, signed ES256. */
export async function vapidJwt(privateJwk, audience, subject, now = Date.now()) {
  const header = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(utf8(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${claims}`));
  return `${header}.${claims}.${b64u(sig)}`;
}

/**
 * Tell people on a shared day: messages [{ person, title, body, url }].
 * Each of their subscriptions gets the message stored and an empty push;
 * a subscription the push service says is gone (404, 410) is forgotten.
 */
export async function notify(env, dayId, messages, { fetcher = fetch, origin = 'https://route.example.com', now = Date.now() } = {}) {
  const db = env.USAGE;
  const keys = env.ROUTE ? JSON.parse((await env.ROUTE.get('push-vapid')) || 'null') : null;
  if (!db || !keys || !messages.length) return { sent: 0 };
  await init(db);
  const { results } = await db.prepare('SELECT endpoint, person_id FROM push_sub WHERE day_id = ?1').bind(dayId).all();
  let sent = 0;
  await Promise.all((results || []).map(async (row) => {
    const msg = messages.find((m) => m.person === row.person_id);
    if (!msg) return;
    await db.prepare('INSERT INTO push_msg (endpoint, msg, at) VALUES (?1, ?2, ?3) ON CONFLICT(endpoint) DO UPDATE SET msg = ?2, at = ?3')
      .bind(row.endpoint, JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: `route-${dayId}` }), now).run();
    try {
      const jwt = await vapidJwt(keys.privateJwk, new URL(row.endpoint).origin, origin, now);
      const res = await fetcher(row.endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: `vapid t=${jwt}, k=${keys.publicKey}`, 'Content-Length': '0' } });
      if (res.status === 404 || res.status === 410) await db.prepare('DELETE FROM push_sub WHERE endpoint = ?1').bind(row.endpoint).run();
      else if (res.ok) sent += 1;
    } catch { /* one phone unreachable: the rest still go */ }
  }));
  return { sent };
}

/**
 * What a re-split means to each person: "Sam took 5 of your stops. Next:
 * ..." for whoever's list changed, "Lee is helping from 3:00" for the rest
 * when someone joined. Never to the one who did it.
 */
export function messagesFor(before, after, events, { actor = null, id }) {
  const todo = (doc, p) => p.stops.filter((s) => doc.stops[s] && !doc.stops[s].done);
  const out = [];
  after.people.forEach((p, k) => {
    if (p.id === actor) return;
    const was = before.people.find((x) => x.id === p.id);
    const now = todo(after, p);
    const prev = was ? todo(before, was) : [];
    const gained = now.filter((s) => !prev.includes(s)).length;
    const lost = prev.filter((s) => !now.includes(s)).length;
    const url = `/s/${id}?p=${k + 1}`;
    if (gained || lost) {
      const what = [gained ? `${gained} stop${gained === 1 ? '' : 's'} added` : '', lost ? `${lost} taken by someone else` : ''].filter(Boolean).join(', ');
      out.push({ person: p.id, title: 'Your route changed', body: `${what}. ${now.length ? `Next: ${after.stops[now[0]].address}` : 'Nothing left: back to the shop'}.${events[0] ? ` (${events[0]})` : ''}`, url });
    } else {
      const joined = events.find((e) => /is (helping|free to help)/.test(e));
      if (joined && now.length) out.push({ person: p.id, title: 'Help is coming', body: `${joined}.`, url });
    }
  });
  return out;
}

export async function push(request, env, url, now = Date.now()) {
  const db = env.USAGE;
  if (!db || !env.ROUTE) return json({ error: 'No storage on this deploy' }, 503);
  await init(db);
  if (url.pathname === '/api/push/key' && request.method === 'GET') {
    const keys = JSON.parse((await env.ROUTE.get('push-vapid')) || 'null');
    return keys ? json({ publicKey: keys.publicKey }) : json({ error: 'Notifications are not set up' }, 404);
  }
  if (url.pathname === '/api/push/config' && request.method === 'PUT') {
    if (!(await keyed(request, env))) return json({ error: 'Not allowed' }, 403);
    const body = await request.json().catch(() => ({}));
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(body.publicKey || '') || body.privateJwk?.kty !== 'EC' || !body.privateJwk?.d) return json({ error: 'A key pair, please' }, 400);
    await env.ROUTE.put('push-vapid', JSON.stringify({ publicKey: body.publicKey, privateJwk: body.privateJwk }));
    return json({ publicKey: body.publicKey });
  }
  if (url.pathname === '/api/push/latest' && request.method === 'GET') {
    const endpoint = url.searchParams.get('endpoint') || '';
    const row = await db.prepare('SELECT msg FROM push_msg WHERE endpoint = ?1').bind(endpoint).first();
    return row ? new Response(row.msg, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({ error: 'Nothing' }, 404);
  }
  const m = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,20})\/subscribe$/);
  if (m) {
    const body = await request.json().catch(() => ({}));
    const endpoint = body.subscription?.endpoint;
    if (!validEndpoint(endpoint)) return json({ error: 'Not a push subscription' }, 400);
    if (request.method === 'DELETE') {
      await db.prepare('DELETE FROM push_sub WHERE endpoint = ?1 AND day_id = ?2').bind(endpoint, m[1]).run();
      return json({ subscribed: false });
    }
    if (request.method === 'POST') {
      const day = await db.prepare('SELECT doc FROM live WHERE id = ?1').bind(m[1]).first().catch(() => null);
      if (!day) return json({ error: 'No such day' }, 404);
      if (!JSON.parse(day.doc).people.some((p) => p.id === body.person)) return json({ error: 'No such person' }, 400);
      await db.prepare('INSERT INTO push_sub (endpoint, day_id, person_id, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(endpoint, day_id) DO UPDATE SET person_id = ?3, created_at = ?4')
        .bind(endpoint, m[1], String(body.person), now).run();
      await db.prepare('DELETE FROM push_sub WHERE created_at < ?1').bind(now - 30 * 86400000).run();
      return json({ subscribed: true });
    }
  }
  return json({ error: 'Not found' }, 404);
}
