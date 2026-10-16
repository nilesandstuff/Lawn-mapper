/**
 * nilesandstuff.com -- the home page (owner, 2026-09-30) and, since
 * 2026-10-16, the dashboard every tool opens from.
 *
 * Static files in home/build, served through this Worker so that the things a
 * static host cannot do get done:
 *
 *   - www.<domain> is sent to the bare domain, so there is one address to
 *     share and one to be indexed (http is sent to https by the zone, "Always
 *     Use HTTPS", tools/https-only.js);
 *   - the dashboard's account calls -- /api/maps*, /api/tools and /api/auth/*
 *     -- are handed to Lawn Mapper's Worker over a service binding (LAWNMAP),
 *     addressed to its own host. So they are same-origin from the dashboard,
 *     the sign-in cookie (set for the whole home domain) travels with them,
 *     and no cross-origin credentials are ever allowed (docs/MAPS.md).
 */
const FORWARDED = (p) => p === '/api/maps' || p.startsWith('/api/maps/')
  || p === '/api/tools' || p.startsWith('/api/auth/');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (FORWARDED(url.pathname)) {
      if (!env.LAWNMAP) return new Response(JSON.stringify({ error: 'no-lawnmap' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      const to = new URL(url.pathname + url.search, `https://${env.LAWNMAP_HOST || `lawnmap.${url.hostname}`}`);
      return env.LAWNMAP.fetch(new Request(to, request));
    }
    return env.ASSETS.fetch(request);
  },
};
