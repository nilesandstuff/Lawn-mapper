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
import { WALK, keyOf } from './twin.js';

/* ANY MAP'S ID (2026-11-16): the site's map rule (twin.js MAP: letters, digits, _ and -, up to 64) refused the owner's
   home map, an admin save whose id is 86 characters with |, spaces and commas, so its thermal walk was converted but
   never filed under it, and the water site saw no walks at all. A map's id here is anything without control characters
   (and no slash, which would split the key), and it is written into the bucket's keys encoded. Never printed. */
export const MAP_ID = /^[^\x00-\x1f\x7f/]{1,256}$/;
export const mapKey = (map) => encodeURIComponent(map);

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const indexKey = (map, walk) => `thermal-index/${mapKey(map)}/${walk}`;
const read = async (env, key) => { try { const o = await env.TWIN.get(key); return o ? JSON.parse(await o.text()) : null; } catch { return null; } };

/** A walk's thermal-placement.json has arrived: remember which map it belongs to. Never throws. */
export async function noteWalk(env, walk, body) {
  try {
    const p = JSON.parse(new TextDecoder().decode(body)), map = p?.map;
    if (typeof map !== 'string' || !MAP_ID.test(map) || !WALK.test(walk)) return null;
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
  const r = await thermalData(env, url.searchParams.get('map'), url.searchParams.get('walk'));
  return json(r.body, r.status);
}

/** A map's walks (walk null) or one walk, as { status, body }: the admin route above and the private entrypoint
 *  (index.js Internal, reached only by the main Worker's binding, for the water site's scoring with no page open)
 *  both answer from here. */
export async function thermalData(env, map, walk = null) {
  const json = (body, status = 200) => ({ body, status });
  if (!env.TWIN) return json({ error: 'no-bucket' }, 503);
  if (!MAP_ID.test(map || '')) return json({ error: 'which map?' }, 400);
  if (walk == null) {
    const walks = [];
    let cursor;
    do {
      const page = await env.TWIN.list({ prefix: `thermal-index/${mapKey(map)}/`, cursor, limit: 1000 });
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

/** Every walk whose converted grid has landed: [{ map, walk, at }], `at` the time its status was written. For the main
 *  Worker's timer, which tells the water site of each new one (worker/src/internal.js pushWater). */
export async function convertedWalks(env) {
  if (!env.TWIN) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.TWIN.list({ prefix: 'thermal-index/', cursor, limit: 1000 });
    for (const o of page.objects) {
      const [, enc, walk] = o.key.split('/');
      let map = null; try { map = decodeURIComponent(enc || ''); } catch { map = null; }
      if (!MAP_ID.test(map || '') || !WALK.test(walk || '')) continue;
      const st = await env.TWIN.head(keyOf(walk, 'thermal/status.json'));
      const grid = st ? await env.TWIN.head(keyOf(walk, 'thermal/grid.json')) : null;
      if (st && grid) out.push({ map, walk, at: (st.uploaded || grid.uploaded || new Date(0)).toISOString() });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}
