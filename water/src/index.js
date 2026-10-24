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
 * Nothing else under /api/ is passed on. The one thing this Worker keeps is gauge readings, in its own D1
 * (src/readings.js, water/schema.sql), and the admin page that reads them (/admin, the admin only).
 *
 * OPEN TO EVERYONE since 2026-10-23 (owner: "Make the water map accessible to
 * everyone now"); water/tools/prepare.mjs writes ADMIN_ONLY "0". The gate below is
 * kept for closing it again (owner, 2026-10-16: "make the water site
 * admin-only too until we're ready to ship"). While ADMIN_ONLY is "1"
 * (water/tools/prepare.mjs writes it), every request but /api/auth/* first
 * asks Lawn Mapper who this is -- /api/auth/me with the visitor's own
 * cookie, the account shared across the home domain -- and anyone who is
 * not the admin gets a "not open yet" page (404) and no data. It fails
 * closed: no binding, or no answer, is no.
 */

import { readings } from './readings.js';

export const PROXIED = ['/api/geocode', '/api/parcel', '/api/imagery', '/api/county-imagery', '/api/shade/lidar', '/api/water/layers'];

/** The account routes, as home/src/index.js FORWARDED names them. */
export const ACCOUNT = (p) => p === '/api/maps' || p.startsWith('/api/maps/') || p === '/api/tools' || p.startsWith('/api/auth/');

/** Where a request goes on Lawn Mapper, or null when it is not passed on. */
export function upstreamFor(url, lawnmapHost, method = 'GET') {
  if (!lawnmapHost) return null;
  const pass = ACCOUNT(url.pathname) || (method === 'GET' && PROXIED.includes(url.pathname));
  return pass ? `https://${lawnmapHost}${url.pathname}${url.search}` : null;
}

/** Is this request from the admin? Asked of Lawn Mapper with the visitor's cookie; any failure is no. */
export async function isAdmin(request, env) {
  if (!env.LAWNMAP || !env.LAWNMAP_HOST) return false;
  try {
    const res = await env.LAWNMAP.fetch(new Request(`https://${env.LAWNMAP_HOST}/api/auth/me`, {
      headers: { Cookie: request.headers.get('Cookie') || '', Accept: 'application/json' },
    }));
    if (!res.ok) return false;
    return (await res.json())?.user?.admin === true;
  } catch {
    return false;
  }
}

export function notOpenYet(home) {
  const dash = home ? `https://${home}/dashboard` : '/';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Lawn Water</title>
<meta name="robots" content="noindex"><style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;background:#f6f8f7;color:#17201c}@media (prefers-color-scheme:dark){body{background:#101513;color:#e7eeea}a{color:#6aa8ff}}</style></head>
<body><h1>Lawn Water isn't open yet</h1><p>It's being tested. <a href="${dash}">Back to your maps</a></p></body></html>`, {
    status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const signIn = url.pathname.startsWith('/api/auth/');
    if (env.ADMIN_ONLY === '1' && !signIn && !(await isAdmin(request, env))) {
      return url.pathname.startsWith('/api/') ? notFound() : notOpenYet(env.LAWNMAP_HOST?.split('.').slice(1).join('.'));
    }
    // the water tool's admin page: the admin only, whether or not the site is open (src/readings.js)
    if (url.pathname === '/admin' || url.pathname === '/admin.html') {
      if (!(await isAdmin(request, env))) return notOpenYet(env.LAWNMAP_HOST?.split('.').slice(1).join('.'));
      const res = await env.ASSETS.fetch(new Request(new URL('/admin.html', url), request));
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', 'private, no-store');
      return out;
    }
    const kept = await readings(request, env, url, { isAdmin });
    if (kept) return kept;
    if (!url.pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      if (env.ADMIN_ONLY !== '1') return res;
      // nothing behind the gate is cached anywhere a non-admin could be served it
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', 'private, no-store');
      return out;
    }
    const up = upstreamFor(url, env.LAWNMAP_HOST, request.method);
    if (!up) return notFound();
    if (env.LAWNMAP) return env.LAWNMAP.fetch(new Request(up, request));
    if (ACCOUNT(url.pathname)) return new Response(JSON.stringify({ error: 'no-lawnmap' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    // no binding (a local run): the public routes over the internet
    const res = await fetch(up, { headers: { 'User-Agent': 'lawn-water-tool' } });
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } });
  },
};
