/**
 * DEV ONLY -- THE THERMAL WALKS OF A MAP, READ BACK (core session, 2026-11-15; android/app/src/dev/README.md,
 * docs/SCAN-PLAN.md section 27). The water map checks its surface temperatures against the owner's thermal camera
 * walks. A walk's raw frames go up from the app (recording.js, &file=thermal); the thermal session's private runner
 * turns them into twins/<walk>/thermal/grid.json (and status.json); the walker's notes are the twin part
 * thermal-notes.json. This puts the three together in the shape the water session asked for.
 *
 *   GET /api/scan/thermal?map=<map>               -> { walks: [{ walk, started, ended, records, ok, error }] }
 *   GET /api/scan/thermal?map=<map>&walk=<walk>   -> the walk (no frame: the main site adds the map's lng/lat)
 *
 * The admin only. Reached by the water map through the main site's GET /api/maps/thermal (worker/src/routes-maps.js),
 * which forwards here over a service binding. Which walks belong to a map: noteWalk() leaves a small object
 * thermal-index/<map>/<walk> when the walk's thermal-placement.json arrives (twin.js PUT).
 */
import { WALK, MAP, keyOf } from './twin.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const indexKey = (map, walk) => `thermal-index/${map}/${walk}`;
const read = async (env, key) => { try { const o = await env.TWIN.get(key); return o ? JSON.parse(await o.text()) : null; } catch { return null; } };

/** A walk's thermal-placement.json has arrived: remember which map it belongs to. Never throws. */
export async function noteWalk(env, walk, body) {
  try {
    const p = JSON.parse(new TextDecoder().decode(body)), map = p?.map;
    if (typeof map !== 'string' || !MAP.test(map) || !WALK.test(walk)) return null;
    // the map's own point when the walk was made: what the walk's east/north metres are measured from, kept in
    // case the map is moved later (private bucket; never printed)
    const origin = Array.isArray(p.origin) && p.origin.length === 2 && p.origin.every(Number.isFinite) ? p.origin : null;
    await env.TWIN.put(indexKey(map, walk), JSON.stringify({ walk, map, origin, at: Date.now() }), { httpMetadata: { contentType: 'application/json' } });
    return map;
  } catch { return null; }
}

/** The walk as the water map reads it: the runner's grid, with the walker's notes laid over it. */
export function walkOf(walk, map, grid, notes, status, origin = null) {
  const air = (notes?.air || []).filter((a) => Number.isFinite(a?.T)).map((a) => ({ T: a.T, at: a.at ?? null, unit: 'C' }));
  return {
    ...(grid || {}),
    walk, map, origin,
    air,
    wet: typeof notes?.wet === 'boolean' ? notes.wet : null,
    sprinklers: typeof notes?.sprinklers === 'boolean' ? notes.sprinklers : null,
    cloud: ['clear', 'broken', 'overcast'].includes(notes?.cloud) ? notes.cloud : null,
    records: Array.isArray(grid?.records) ? grid.records : [],
    status: status ? { ok: status.ok !== false, at: status.at ?? null, version: status.version ?? null, error: status.error ?? null, sky_note: status.sky_note ?? null } : null,
  };
}

export async function thermal(request, env, url, { isAdmin }) {
  if (url.pathname !== '/api/scan/thermal') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.TWIN) return json({ error: 'no-bucket' }, 503);
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  const map = url.searchParams.get('map'), walk = url.searchParams.get('walk');
  if (!MAP.test(map || '')) return json({ error: 'which map?' }, 400);
  if (walk == null) {
    const walks = [];
    let cursor;
    do {
      const page = await env.TWIN.list({ prefix: `thermal-index/${map}/`, cursor, limit: 1000 });
      for (const o of page.objects) walks.push(o.key.split('/')[2]);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const out = await Promise.all(walks.filter((w) => WALK.test(w)).map(async (w) => {
      const s = await read(env, keyOf(w, 'thermal/status.json'));
      const started = Number(w) || null;   // a walk's id is the time it began
      return { walk: w, started, ended: null, records: s?.records ?? null, ok: s ? s.ok !== false : null, error: s?.error ?? (s ? null : 'not converted yet') };
    }));
    return json({ walks: out.sort((a, b) => (b.started || 0) - (a.started || 0)) });
  }
  if (!WALK.test(walk)) return json({ error: 'which walk?' }, 400);
  const idx = await read(env, indexKey(map, walk));
  if (!idx) return json({ error: 'Not found' }, 404);
  const [grid, notes, status] = await Promise.all([read(env, keyOf(walk, 'thermal/grid.json')), read(env, keyOf(walk, 'thermal-notes.json')), read(env, keyOf(walk, 'thermal/status.json'))]);
  if (!grid) return json({ error: status?.error || 'not converted yet', walk, map, status: status || null }, 404);
  return json(walkOf(walk, map, grid, notes, status, idx.origin || null));
}
