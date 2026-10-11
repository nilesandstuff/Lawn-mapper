/**
 * THE SHADE MAP'S API (features session): /api/shade/*.
 *
 *   GET /api/shade/lidar?lng=&lat=
 *     Which public 3DEP point clouds were flown over this exact point, best
 *     first, with their flight dates, quality level and leaf season, and
 *     which newer flights USGS lists that are not in the public store:
 *       { clouds: [{ name, url, year, density, epoch, confirmed, unit }],
 *         notOnAws: [{ workunit, ql, start, end, season }], footprints }
 *
 * WHY HERE AND NOT IN THE BROWSER. Hobu's footprint file is 8.7 MB: too much
 * for a phone per property, and a copy shipped with the site goes stale as
 * USGS adds projects. On the Workers Paid plan parsing it is ~100 ms of CPU,
 * so the Worker reads it, keeps the outlines (not just boxes: a Nevada
 * survey's box covers Salt Lake City, its outline does not), and holds them
 * in memory and in the edge cache for a day. Then the point is checked
 * against the outlines exactly, and against USGS's own index (WESM) for the
 * dates; public/shade/find.js does the ranking, the same code the tests run.
 */

import { rankClouds, wesmUrl } from '../../public/shade/find.js';
import { EPT_BASE } from '../../public/shade/names.js';

export const FOOTPRINTS = 'https://raw.githubusercontent.com/hobuinc/usgs-lidar/master/boundaries/resources.geojson';
const CACHE_KEY = 'https://shade.lawnmapper.internal/footprints-v1.json';
const DAY = 86400;

export const isShadePath = (pathname) => pathname.startsWith('/api/shade/');

const round = (ring) => ring.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);

/** One footprint feature -> { name, url?, count, km2, bbox, polys }. Pure. */
export function footprintEntry(f) {
  const p = f?.properties || {};
  const polys = f?.geometry?.type === 'Polygon' ? [f.geometry.coordinates]
    : f?.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly[0] || []) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  }
  if (!p.name || !(w < e && s < n)) return null;
  const km2 = polys.reduce((t, poly) => t + poly.reduce((u, ring, i) => u + (i ? -1 : 1) * ringKm2(ring), 0), 0);
  return {
    name: p.name,
    ...(p.url && p.url !== `${EPT_BASE}${p.name}/ept.json` ? { url: p.url } : {}),
    count: p.count || null,
    km2: Math.round(km2 * 100) / 100,
    bbox: [w, s, e, n],
    polys: polys.map((poly) => poly.map(round)),
  };
}

/** Area of a lng/lat ring in km^2 (spherical excess, small-ring form). */
function ringKm2(ring) {
  const R = 6371.0088, rad = Math.PI / 180;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    a += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad));
  }
  return Math.abs((a * R * R) / 2);
}

function insideRing(ring, lng, lat) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[k];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is the point inside the footprint, holes honoured? */
export function covers(entry, lng, lat) {
  const [w, s, e, n] = entry.bbox;
  if (lng < w || lng > e || lat < s || lat > n) return false;
  return entry.polys.some((poly) => insideRing(poly[0], lng, lat) && !poly.slice(1).some((h) => insideRing(h, lng, lat)));
}

let memory = null; // { at, entries } -- an isolate lives for many requests

async function footprints(ctx, fetchImpl = fetch) {
  if (memory && Date.now() - memory.at < DAY * 1000) return memory.entries;
  const cache = globalThis.caches?.default;
  const key = new Request(CACHE_KEY);
  const hit = cache && await cache.match(key);
  if (hit) {
    memory = { at: Date.now(), entries: await hit.json() };
    return memory.entries;
  }
  const res = await fetchImpl(FOOTPRINTS);
  if (!res.ok) throw new Error(`footprints: ${res.status}`);
  const entries = ((await res.json()).features || []).map(footprintEntry).filter(Boolean);
  memory = { at: Date.now(), entries };
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(entries), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${DAY}` },
    }));
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return entries;
}

/** The answer for one point. Pure but for the two fetches. */
export async function lidarAt(lng, lat, { ctx = null, fetchImpl = fetch } = {}) {
  const [entries, wesm] = await Promise.all([
    footprints(ctx, fetchImpl),
    fetchImpl(wesmUrl(lng, lat)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const over = entries.filter((e) => covers(e, lng, lat)).map(({ polys, ...rest }) => rest);
  const { clouds, notOnAws } = rankClouds({ projects: over }, wesm, lng, lat);
  return { clouds, notOnAws, wesm: !!wesm, footprints: entries.length };
}

export async function handleShade(request, url, env, origin, ctx, json) {
  if (url.pathname === '/api/shade/lidar' && request.method === 'GET') {
    const lng = Number(url.searchParams.get('lng')), lat = Number(url.searchParams.get('lat'));
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
      return json({ error: 'lng and lat required' }, 400, origin);
    }
    try {
      return json(await lidarAt(lng, lat, { ctx }), 200, origin);
    } catch (e) {
      return json({ error: 'The lidar index could not be read', detail: String(e?.message || e) }, 502, origin);
    }
  }
  return json({ error: 'Not found' }, 404, origin);
}
