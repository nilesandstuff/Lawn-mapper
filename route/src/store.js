/**
 * What the route Worker keeps, in its own KV namespace (route session, 2026-10-26).
 *
 *   shop     the shop's address, for the page's "Shop" button. Kept here
 *            and not in the repository, which is public and keeps no street
 *            addresses (CLAUDE.md). Anyone may read it (the page does); only
 *            the key may set it.
 *   catalog  THE FIRST WORD DOCUMENT anyone opens on the page, kept once so
 *            the document reader (lib/doc.js) can be tuned against a real one
 *            (owner, 2026-10-26: "catalog just that first word document").
 *            Later documents are not kept. Only the key reads or deletes it:
 *            it is customers' names and addresses.
 *
 * THE KEY is a random string held by the route session; only its SHA-256 is
 * here (ROUTE_KEY_SHA256, written into wrangler.toml by tools/prepare.mjs),
 * sent as the X-Route-Key header.
 */

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export const MAX_CATALOG = 8 * 1024 * 1024;

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function keyed(request, env) {
  const k = request.headers.get('X-Route-Key');
  return Boolean(k && env.ROUTE_KEY_SHA256 && (await sha256(k)) === env.ROUTE_KEY_SHA256);
}

export async function store(request, env, url) {
  const kv = env.ROUTE;
  if (!kv) return json({ error: 'No storage on this deploy' }, 503);
  const m = request.method;

  if (url.pathname === '/api/shop') {
    if (m === 'GET') {
      const address = await kv.get('shop');
      return address ? json({ address }) : json({ error: 'No shop set' }, 404);
    }
    if (m === 'PUT') {
      if (!(await keyed(request, env))) return json({ error: 'Not allowed' }, 403);
      const body = await request.json().catch(() => null);
      const address = String(body?.address || '').trim();
      if (address.length < 5 || address.length > 200) return json({ error: 'An address, please' }, 400);
      await kv.put('shop', address);
      return json({ address });
    }
  }

  if (url.pathname === '/api/catalog') {
    if (m === 'POST') {
      if (Number(request.headers.get('Content-Length') || 0) > MAX_CATALOG) return json({ error: 'Too big to keep' }, 413);
      if (await kv.get('catalog', { type: 'stream' }).then((s) => { s?.cancel?.(); return Boolean(s); })) {
        return json({ kept: false, reason: 'already have one' }, 409);
      }
      const text = await request.text();
      if (text.length > MAX_CATALOG) return json({ error: 'Too big to keep' }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: 'Not JSON' }, 400); }
      if (!body?.name || typeof body.base64 !== 'string') return json({ error: 'A document, please' }, 400);
      await kv.put('catalog', JSON.stringify({ ...body, at: new Date().toISOString() }));
      return json({ kept: true }, 201);
    }
    if (!(await keyed(request, env))) return json({ error: 'Not allowed' }, 403);
    if (m === 'GET') {
      const v = await kv.get('catalog');
      return v ? new Response(v, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({ error: 'Nothing kept yet' }, 404);
    }
    if (m === 'DELETE') {
      await kv.delete('catalog');
      return json({ deleted: true });
    }
  }
  return json({ error: 'Not found' }, 404);
}
