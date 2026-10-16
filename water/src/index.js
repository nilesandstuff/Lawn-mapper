/**
 * water.<home domain> -- THE LAWN WATER TOOL'S WORKER (water session).
 *
 * The page and its modules are static (water/public and water/lib, put
 * together by water/tools/prepare.mjs). The lidar is read by the visitor's
 * browser straight from USGS's public bucket. What the page needs from
 * Lawn Mapper -- the address search, the county's property line, the photo,
 * which lidar flight -- it asks for here, and this asks Lawn Mapper's own
 * public routes server-side: those answer only Lawn Mapper's origin in a
 * browser, so the shade map's way of finding a property is reused exactly
 * without a change to the main site.
 *
 * Only these GET routes, with their own query strings, and nothing stored.
 */

export const PROXIED = ['/api/geocode', '/api/parcel', '/api/imagery', '/api/county-imagery', '/api/shade/lidar'];

export function upstreamFor(url, lawnmap) {
  if (!lawnmap || !PROXIED.includes(url.pathname)) return null;
  return `https://${lawnmap}${url.pathname}${url.search}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const up = request.method === 'GET' ? upstreamFor(url, env.LAWNMAP) : null;
      if (!up) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const res = await fetch(up, { headers: { 'User-Agent': 'lawn-water-tool' }, cf: { cacheTtl: url.pathname === '/api/geocode' ? 0 : 3600 } });
      const headers = new Headers({ 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=600' });
      return new Response(res.body, { status: res.status, headers });
    }
    return env.ASSETS.fetch(request);
  },
};
