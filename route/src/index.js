/**
 * route.<home domain> -- THE ROUTE PLANNER'S WORKER (route session, 2026-10-22).
 *
 * A screenshot of the day's jobs in, the fastest order to drive them out.
 * The page does the reading (OCR in the browser: the screenshot never leaves
 * the phone) and the ordering; this Worker only asks Mapbox, so the token is
 * never in the page:
 *
 *   GET  /api/geocode?q=&near=lng,lat   one address -> { lng, lat, label, accuracy }
 *   POST /api/matrix  { points, [sources], [destinations] } -> { durations, distances }
 *   POST /api/route   { points }        -> { legs, geometry }
 *   /api/shop, /api/catalog              the shop's address and the first document (src/store.js)
 *
 * Only addresses and points reach it for routing -- never the customers'
 * names -- and routing keeps nothing. The one exception is the first Word
 * document, kept once for tuning (src/store.js). Everything else is the page.
 *
 * Nothing here touches Lawn Mapper: its own folder (route/), its own Worker,
 * its own deploy (.github/workflows/route-deploy.yml).
 */

import { geocode, matrix, matrixBlocks, route, validIndexes, validPoints } from './mapbox.js';
import { store } from './store.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

/** Calls from another site's page are refused; the token is for this page. */
export function foreign(request, url) {
  const origin = request.headers.get('Origin');
  return Boolean(origin) && origin !== url.origin;
}

export async function api(request, env, url, fetcher = fetch) {
  if (foreign(request, url)) return json({ error: 'Not from this site' }, 403);
  if (url.pathname === '/api/shop' || url.pathname === '/api/catalog') return store(request, env, url);
  const token = env.MAPBOX_TOKEN;
  if (!token) return json({ error: 'No Mapbox token on the server yet' }, 503);
  try {
    if (url.pathname === '/api/geocode' && request.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      if (q.length < 4 || q.length > 200) return json({ error: 'Address too short or too long' }, 400);
      const near = (url.searchParams.get('near') || '').split(',').map(Number);
      const hit = await geocode(fetcher, token, q, near.length === 2 && near.every(Number.isFinite) ? near : null);
      return hit ? json(hit) : json({ error: 'Address not found' }, 404);
    }
    if ((url.pathname === '/api/matrix' || url.pathname === '/api/route') && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!validPoints(body?.points)) return json({ error: 'Between 2 and 62 points, as [lng, lat]' }, 400);
      if (url.pathname === '/api/route') return json(await route(fetcher, token, body.points));
      const n = body.points.length;
      const sources = validIndexes(body.sources, n);
      const destinations = validIndexes(body.destinations, n);
      if (!sources || !destinations) return json({ error: 'sources and destinations: indexes of points' }, 400);
      if (matrixBlocks(n, sources, destinations).length > 40) return json({ error: 'Too many pairs for one call' }, 400);
      return json(await matrix(fetcher, token, body.points, sources, destinations));
    }
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api(request, env, url);
    return env.ASSETS.fetch(request);
  },
};
