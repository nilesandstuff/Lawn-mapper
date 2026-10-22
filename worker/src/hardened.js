/*
 * EVERY ANSWER THIS WORKER BUILDS gets the same three headers the static pages
 * get from public/_headers (Cloudflare applies that file to assets only, not
 * to Worker responses -- 2026-10-22 audit: /api/*, robots.txt, the 404 shell
 * and every redirect went out without HSTS). An API answer with no caching
 * rule of its own is private and uncached; one that names an origin varies
 * by it. Headers are copied onto a fresh Response because a redirect's are
 * immutable.
 */
export function hardened(res, request) {
  const out = new Response(res.body, res);
  const h = out.headers;
  if (!h.has('Strict-Transport-Security')) h.set('Strict-Transport-Security', 'max-age=31536000');
  if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (h.has('Access-Control-Allow-Origin') && !h.has('Vary')) h.set('Vary', 'Origin');
  let path = '';
  try { path = new URL(request.url).pathname; } catch { path = ''; }
  if (path.startsWith('/api/') && !h.has('Cache-Control')) h.set('Cache-Control', 'private, no-store');
  return out;
}
