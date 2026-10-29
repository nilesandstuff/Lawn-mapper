/**
 * THE ADDRESS'S LIDAR, STARTED EARLY (owner, 2026-10-29: "If it's taking 5 to
 * 6 minutes to fetch, that's a problem for the live site... when a user enters
 * an address into lawn map: we should initiate the download, crop it to the
 * sizes needed by the shade map and water map, save it to a cache so it's
 * available to the shade map, water map, and ai detector").
 *
 * GET /api/lidar/warm?lng=&lat=   (the app sends it once an address is
 * confirmed, and does not wait). When the newest flight over the point is
 * one USGS has published only as LAZ tiles, the model server is asked to
 * fetch them onto its volume and cut the square round the address
 * (public/lib/lidar-tiles.js areaAround) -- tools/modal_serve.py lidar_warm.
 * Everything that reads those tiles afterwards (the shade and water maps
 * through /api/lidar/tiles, the detector's press) finds them there, and a
 * box inside the square is cut from it in a second or two. Nothing is asked
 * when the newest flight is in the public octree store: those are read in
 * pieces, fast, already.
 *
 * Answers 202 at once and does the work after (ctx.waitUntil); `&wait=1`
 * waits and says what happened, for a check from a terminal or a workflow.
 */

import { lidarAt } from './shade.js';
import { tilesUrl } from './lidar-tiles.js';
import { areaAround } from '../../public/lib/lidar-tiles.js';

/** The `lidar_warm` endpoint beside the `lidar_tiles` one Modal published. */
export function warmUrl(env) {
  if (env?.ALPHA_WARM_URL) return env.ALPHA_WARM_URL;
  const t = tilesUrl(env);
  if (!t) return null;
  const u = String(t).replace(/-lidar-tiles(\.modal\.run)/, '-lidar-warm$1');
  return u === t ? null : u;
}

/** Ask the server to warm the point's newest tile flight; never throws. */
export async function warmLidar(lng, lat, env, { ctx = null, fetchImpl = fetch, find = lidarAt } = {}) {
  const url = warmUrl(env);
  if (!url || !env?.ALPHA_TOKEN) return { warmed: false, why: 'no model server is configured' };
  let found;
  try {
    found = await find(lng, lat, { ctx, fetchImpl });
  } catch (e) {
    return { warmed: false, why: `the lidar index did not answer (${e?.message || e})` };
  }
  const first = found?.clouds?.[0];
  if (!first) return { warmed: false, why: 'no lidar over this point' };
  if (first.kind !== 'tiles' || !first.tiles?.length) return { warmed: false, why: 'the newest flight is in the public octree store', name: first.name };
  const box = areaAround(lng, lat);
  const q = new URLSearchParams({ tiles: first.tiles.join(','), box: box.map((v) => v.toFixed(2)).join(',') });
  try {
    const res = await fetchImpl(`${url}?${q}`, {
      headers: { authorization: `Bearer ${env.ALPHA_TOKEN}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    return { warmed: res.ok, name: first.name, tiles: first.tiles.length, mb: first.mb, status: res.status, ...body };
  } catch (e) {
    return { warmed: false, why: `the model server did not answer (${e?.message || e})`, name: first.name };
  }
}

export async function handleLidarWarm(request, url, env, origin, ctx, json, { fetchImpl = fetch, find = lidarAt } = {}) {
  if (request.method !== 'GET') return json({ error: 'GET only' }, 405, origin);
  const lng = Number(url.searchParams.get('lng'));
  const lat = Number(url.searchParams.get('lat'));
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 85) {
    return json({ error: 'lng and lat, in degrees' }, 400, origin);
  }
  const work = warmLidar(lng, lat, env, { ctx, fetchImpl, find });
  if (url.searchParams.get('wait') === '1') return json(await work, 200, origin);
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  return json({ status: 'started' }, 202, origin);
}
