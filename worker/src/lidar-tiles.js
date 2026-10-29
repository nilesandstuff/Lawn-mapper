/**
 * USGS'S TILE-ONLY LIDAR, FOR THE PAGES (core session, 2026-10-29; owner:
 * "make sure we're pulling the newest and most up to date lidar everywhere").
 *
 * Two jobs, both small, the pure parts in public/lib/lidar-tiles.js:
 *
 *   addTileClouds   /api/shade/lidar's ranked answer with USGS's tile-only
 *                   flights over the point added as clouds (the TNM API is
 *                   asked only when USGS's index names a flight no octree
 *                   carries, so most lots cost nothing more).
 *
 *   handleLidarTiles   GET /api/lidar/tiles?tiles=<urls>&box=w,s,e,n[&spacing=m]
 *                   -> the points of those tiles inside the box, as one LAZ
 *                   (EPSG:3857, as an octree node), cropped by the model
 *                   server (tools/modal_serve.py lidar_tiles). 202 with
 *                   {status: 'fetching'} while the server fetches the tiles
 *                   onto its volume the first time; the page asks again.
 *                   Only USGS's own tile urls are accepted, at most 12, over
 *                   a box at most 1.5 km across; a finished crop is kept at
 *                   the edge a week, so a map reopened reads nothing twice.
 *
 * OFF without the model server (ALPHA_URL and ALPHA_TOKEN): the route answers
 * 503 and the pages fall back to the octrees as before.
 */

import { tileSets, tileClouds, withTiles, parseBox, tilesOf, tnmUrl } from '../../public/lib/lidar-tiles.js';
import { workUnits } from '../../public/shade/find.js';

/** The `lidar_tiles` endpoint beside the `start` one Modal published. */
export function tilesUrl(env) {
  if (env?.ALPHA_TILES_URL) return env.ALPHA_TILES_URL;
  if (!env?.ALPHA_URL) return null;
  const u = String(env.ALPHA_URL).replace(/-start(\.modal\.run)/, '-lidar-tiles$1');
  return u === env.ALPHA_URL ? null : u;
}

export const tilesEnabled = (env) => Boolean(tilesUrl(env) && env?.ALPHA_TOKEN);

/**
 * The ranked clouds with the tile-only flights in. `wesm` is USGS's index's
 * answer for the point (already fetched by lidarAt); nothing is asked when
 * every flight it names has an octree. Never throws: the TNM API not
 * answering leaves the answer as it was.
 */
export async function addTileClouds(ranked, wesm, lng, lat, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!ranked?.notOnAws?.length) return ranked;
  const units = workUnits(wesm);
  if (!units.length) return ranked;
  let items = [];
  try {
    const res = await fetchImpl(tnmUrl(lng, lat), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return ranked;
    items = (await res.json())?.items || [];
  } catch {
    return ranked;
  }
  const octreeUnits = (ranked.clouds || []).map((c) => c?.unit?.workunit).filter(Boolean);
  return withTiles(ranked, tileClouds(tileSets(items, units, octreeUnits)));
}

const sortedQuery = (url) => {
  const p = new URLSearchParams(url.searchParams);
  p.sort();
  return p.toString();
};

/*
 * THE CUTS, KEPT IN R2 FOR SIX MONTHS (owner, 2026-10-29: "storing the cuts on
 * cloudflare for a very long time, but not permanently, is a good idea. Maybe
 * 6 months"). Every cut the model server makes for a page is written under
 * lidar-cuts/ in the corpus bucket, keyed by the request; the next page to ask
 * for the same box -- the same person reopening a map, the water map after the
 * shade map, anyone in any city -- is answered from R2 without the model
 * server or its cold start. The edge cache stays in front (a week, per
 * Cloudflare location). The bucket's lifecycle rule (deploy.yml) deletes a cut
 * after CUT_DAYS; the age check here covers the gap until it runs.
 */
export const CUT_PREFIX = 'lidar-cuts/';
export const CUT_DAYS = 180;

export async function cutKey(url) {
  const bytes = new TextEncoder().encode(sortedQuery(url));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return CUT_PREFIX + [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('') + '.laz';
}

async function keptCut(env, key, now = Date.now()) {
  if (!env?.CORPUS) return null;
  try {
    const obj = await env.CORPUS.get(key);
    if (!obj) return null;
    if (obj.uploaded && now - new Date(obj.uploaded).getTime() > CUT_DAYS * 86400000) return null;
    return obj;
  } catch {
    return null;
  }
}

export async function handleLidarTiles(request, url, env, origin, ctx, json, { fetchImpl = fetch } = {}) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405, origin);
  const tiles = tilesOf(url.searchParams);
  if (!tiles) return json({ error: `tiles: 1 to 12 of USGS's rockyweb LAZ urls, comma-separated` }, 400, origin);
  const box = parseBox(url.searchParams.get('box'));
  if (!box) return json({ error: 'box: w,s,e,n in Web Mercator metres, at most 1.5 km across' }, 400, origin);
  const spacing = Math.max(0, Number(url.searchParams.get('spacing')) || 0);
  if (!tilesEnabled(env)) return json({ error: 'The lidar tile reader is off: no model server is configured' }, 503, origin);

  const corsHeaders = json({}, 200, origin).headers;
  const cache = globalThis.caches?.default;
  const key = new Request(`https://lidar-tiles.lawnmapper.internal/crop?${sortedQuery(url)}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const out = new Response(hit.body, hit);
        for (const [k, v] of corsHeaders) out.headers.set(k, v);
        return out;
      }
    } catch { /* read it from the server */ }
  }

  const finish = (bytes, from) => {
    const headers = new Headers(corsHeaders); // the CORS lines; its JSON content type is replaced below
    headers.set('Content-Type', 'application/vnd.laszip');
    headers.set('Cache-Control', 'public, max-age=604800');
    headers.set('X-Lidar-Tiles', String(tiles.length));
    headers.set('X-Lidar-Cut', from);
    const out = new Response(bytes, { status: 200, headers });
    if (cache) {
      try {
        const put = cache.put(key, out.clone());
        if (ctx?.waitUntil) ctx.waitUntil(put);
      } catch { /* kept next time */ }
    }
    return out;
  };

  const rKey = await cutKey(url);
  const kept = await keptCut(env, rKey);
  if (kept) return finish(await kept.arrayBuffer(), 'r2');

  const q = new URLSearchParams({ tiles: tiles.join(','), box: box.join(','), ...(spacing > 0 ? { spacing: String(spacing) } : {}) });
  let res;
  try {
    res = await fetchImpl(`${tilesUrl(env)}?${q}`, {
      headers: { authorization: `Bearer ${env.ALPHA_TOKEN}` },
      signal: AbortSignal.timeout(170000),
    });
  } catch (e) {
    return json({ error: `The lidar tile reader did not answer: ${e?.message || e}` }, 502, origin);
  }
  if (res.status === 202) {
    const body = await res.json().catch(() => ({}));
    return json({ status: 'fetching', ...body }, 202, origin);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    return json({ error: `The lidar tile reader answered ${res.status}`, detail }, 502, origin);
  }
  const bytes = await res.arrayBuffer();
  if (env?.CORPUS) {
    try {
      const put = env.CORPUS.put(rKey, bytes, {
        httpMetadata: { contentType: 'application/vnd.laszip' },
        customMetadata: { tiles: tiles.map((t) => t.split('/').pop()).join(','), box: box.join(','), spacing: String(spacing) },
      });
      if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {})); else await put;
    } catch { /* kept next time */ }
  }
  return finish(bytes, 'server');
}
