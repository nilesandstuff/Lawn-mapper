/**
 * scan.<home domain> -- THE YARD AR TOOL'S WORKER (core session, docs/SCAN-PLAN.md).
 *
 * The page and its modules are static (scan/public, scan/lib and the vendored
 * engine, put together by scan/tools/prepare.mjs). Everything about accounts
 * and maps comes from Lawn Mapper's Worker over a service binding (LAWNMAP),
 * addressed to its own host (LAWNMAP_HOST), the way the water tool and the
 * home page's dashboard do it (water/src/index.js, home/src/index.js;
 * docs/MAPS.md): same-origin calls, the shared sign-in cookie travels.
 *
 * ADMIN ONLY while phase 1 (does the tracking hold on both phones) is
 * measured: with ADMIN_ONLY "1" every request but /api/auth/* first asks
 * Lawn Mapper who this is, and anyone but the admin gets a "not open yet"
 * page (404) and no data. It fails closed.
 */

import { walks } from './walks.js';
import { twin } from './twin.js';
import { app } from './app.js';

/** GETs passed on to Lawn Mapper for the page's own use (the photo and the lidar come in phase 2). */
export const PROXIED = ['/api/imagery', '/api/parcel', '/api/shade/lidar', '/api/lidar/tiles'];

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

export const homeOf = (lawnmapHost) => (lawnmapHost || '').split('.').slice(1).join('.');

export function notOpenYet(home) {
  const dash = home ? `https://${home}/dashboard` : '/';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Yard AR</title>
<meta name="robots" content="noindex"><style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;background:#f6f8f7;color:#17201c}@media (prefers-color-scheme:dark){body{background:#101513;color:#e7eeea}a{color:#6aa8ff}}</style></head>
<body><h1>Yard AR isn't open yet</h1><p>It's being tested. <a href="${dash}">Back to your maps</a></p></body></html>`, {
    status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

/** The static answer, never cached where a non-admin could be served it; the engine's big files may sit in the phone's own cache. */
function privately(res, path) {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', path.startsWith('/vendor/') ? 'private, max-age=86400' : 'private, no-store');
  out.headers.set('X-Robots-Tag', 'noindex');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // the app's pairing (src/app.js) is a sign-in too: it carries its own one-time proof
    const signIn = url.pathname.startsWith('/api/auth/') || url.pathname === '/api/app/claim';
    const home = homeOf(env.LAWNMAP_HOST);
    if (env.ADMIN_ONLY === '1' && !signIn && !(await isAdmin(request, env))) {
      return url.pathname.startsWith('/api/') ? notFound() : notOpenYet(home);
    }
    if (!url.pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      return env.ADMIN_ONLY === '1' ? privately(res, url.pathname) : res;
    }
    // the Android app (src/app.js): its build, its download and its pairing
    const appRoute = await app(request, env, url);
    if (appRoute) return appRoute;
    // the walks kept on the site (src/walks.js): the admin only, whether or not the site is open
    const kept = await walks(request, env, url, { isAdmin });
    if (kept) return kept;
    // the walks' twins (src/twin.js): the admin only, the same way
    const twinned = await twin(request, env, url, { isAdmin });
    if (twinned) return twinned;
    const up = upstreamFor(url, env.LAWNMAP_HOST, request.method);
    if (!up) return notFound();
    if (env.LAWNMAP) return env.LAWNMAP.fetch(new Request(up, request));
    return new Response(JSON.stringify({ error: 'no-lawnmap' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  },
};
