/**
 * water.<home domain> -- THE LAWN WATER TOOL'S WORKER (water session).
 *
 * The page and its modules are static (water/public and water/lib, put
 * together by water/tools/prepare.mjs). The lidar is read by the visitor's
 * browser straight from USGS's public bucket. Everything else comes from
 * Lawn Mapper's Worker over a service binding (LAWNMAP), addressed to its
 * own host (LAWNMAP_HOST), the way the home site's dashboard does it
 * (home/src/index.js; docs/MAPS.md):
 *
 *   ACCOUNT   /api/maps*, /api/tools, /api/auth/* -- the saved maps, with
 *             the visitor's cookie (set for the whole home domain), so the
 *             calls are same-origin and no cross-origin credentials exist.
 *   PROPERTY  geocode, parcel, imagery, county-imagery and the shade map's
 *             lidar search: the shade map's way of finding a property. Those
 *             answer only Lawn Mapper's origin in a browser.
 *
 * Nothing else under /api/ is passed on, and this Worker stores nothing.
 */

export const PROXIED = ['/api/geocode', '/api/parcel', '/api/imagery', '/api/county-imagery', '/api/shade/lidar'];

/** The account routes, as home/src/index.js FORWARDED names them. */
export const ACCOUNT = (p) => p === '/api/maps' || p.startsWith('/api/maps/') || p === '/api/tools' || p.startsWith('/api/auth/');

/** Where a request goes on Lawn Mapper, or null when it is not passed on. */
export function upstreamFor(url, lawnmapHost, method = 'GET') {
  if (!lawnmapHost) return null;
  const pass = ACCOUNT(url.pathname) || (method === 'GET' && PROXIED.includes(url.pathname));
  return pass ? `https://${lawnmapHost}${url.pathname}${url.search}` : null;
}

const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const up = upstreamFor(url, env.LAWNMAP_HOST, request.method);
    if (!up) return notFound();
    if (env.LAWNMAP) return env.LAWNMAP.fetch(new Request(up, request));
    if (ACCOUNT(url.pathname)) return new Response(JSON.stringify({ error: 'no-lawnmap' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    // no binding (a local run): the public routes over the internet
    const res = await fetch(up, { headers: { 'User-Agent': 'lawn-water-tool' } });
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } });
  },
};
