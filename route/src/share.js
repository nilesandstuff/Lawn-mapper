/**
 * Shared routes (route session, 2026-11-06): a split day kept under a short
 * random id, for a link each person opens on their own phone.
 *
 *   POST /api/share { plan }  -> { id }       kept 30 days
 *   GET  /api/share/<id>      -> { plan, at }
 *   /s/<id>                   the page that shows it (public/share.html)
 *
 * The id is the only key: 12 random letters and digits, so a link can be
 * passed on but not guessed. It holds customers' addresses and names, so it
 * goes no further than a link the owner sends.
 */

export const KEEP_DAYS = 30;
const MAX_BYTES = 400 * 1024;
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export function newId(n = 12) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
}

export async function share(request, env, url) {
  const kv = env.ROUTE;
  if (!kv) return json({ error: 'No storage on this deploy' }, 503);
  if (url.pathname === '/api/share' && request.method === 'POST') {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: 'Too big to share' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'Not JSON' }, 400); }
    if (!Array.isArray(body?.plan?.people) || !body.plan.people.length) return json({ error: 'A split route, please' }, 400);
    const id = newId();
    await kv.put(`share:${id}`, JSON.stringify({ plan: body.plan, at: new Date().toISOString() }), { expirationTtl: KEEP_DAYS * 86400 });
    return json({ id, keepDays: KEEP_DAYS }, 201);
  }
  const id = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,20})$/)?.[1];
  if (id && request.method === 'GET') {
    const v = await kv.get(`share:${id}`);
    return v ? new Response(v, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({ error: 'This link has expired or never existed' }, 404);
  }
  return json({ error: 'Not found' }, 404);
}
