/**
 * SINGLE THERMAL PHOTOS, PLACED BY HAND (owner, 2026-11-17: "add individual thermal pics that I manually place. That
 * way I can quickly get a thermal pic or 2 in addition to whatever other readings I can manage quickly"). DEV ONLY:
 * taken in the Yard AR app's development build (its own start page, or this site's field page opened inside the app,
 * through window.LawnARThermal.snap), kept privately by the yard AR site, turned into temperatures by the thermal
 * session's converter, and read here over the main site's Internal entrypoint (docs/MAPS.md: thermalSnaps,
 * thermalSnap, thermalSnapPng, placeThermalSnap). The administrator's only; coordinates go to the private bucket and
 * are never logged.
 *
 *   GET  /api/water/snaps?map=&since=&until=&loose=0   [{ id, at, map, placed, converted }], newest first
 *   GET  /api/water/snaps/one?id=                       the photo: its time, rotation, place and the converter's grid
 *   GET  /api/water/snaps/png?id=                       the converter's false-colour preview
 *   POST /api/water/snaps/place  { id, lng, lat, heading?, saveId?, note? }   where the owner stood
 */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
const SNAP_ID = /^snap-\d{10,16}$/;
const num = (v, lo, hi) => { const x = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(x) && x >= lo && x <= hi ? x : null; };

/** A placement, checked. -> { id, place } or { error } */
export function cleanPlace(b) {
  if (!b || typeof b !== 'object' || !SNAP_ID.test(String(b.id || ''))) return { error: 'which photo?' };
  const lng = num(b.lng, -180, 180), lat = num(b.lat, -90, 90);
  if (lng === null || lat === null) return { error: 'where was it taken?' };
  const heading = num(b.heading, 0, 360);
  const saveId = typeof b.saveId === 'string' && b.saveId.length <= 200 ? b.saveId : null;
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null;
  return { id: b.id, place: { lng, lat, heading, saveId, note } };
}

export async function snaps(request, env, url, { isAdmin }) {
  if (!url.pathname.startsWith('/api/water/snaps')) return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.MAIN) return json({ error: 'no-main', note: 'the water site is not bound to the main site' }, 503);
  try {
    if (url.pathname === '/api/water/snaps' && request.method === 'GET') {
      const opts = {};
      for (const k of ['since', 'until']) { const v = num(url.searchParams.get(k), 0, 1e14); if (v !== null) opts[k] = v; }
      if (url.searchParams.get('loose') === '0') opts.loose = false;
      const list = await env.MAIN.thermalSnaps(url.searchParams.get('map') || null, opts);
      return json({ snaps: Array.isArray(list) ? list : [] });
    }
    const id = url.searchParams.get('id') || '';
    if (url.pathname === '/api/water/snaps/one' && request.method === 'GET') {
      if (!SNAP_ID.test(id)) return json({ error: 'which photo?' }, 400);
      const one = await env.MAIN.thermalSnap(id);
      return one ? json(one) : json({ error: 'Not found' }, 404);
    }
    if (url.pathname === '/api/water/snaps/png' && request.method === 'GET') {
      if (!SNAP_ID.test(id)) return json({ error: 'which photo?' }, 400);
      const png = await env.MAIN.thermalSnapPng(id);
      if (!png?.bytes) return json({ error: 'not converted yet' }, 404);
      return new Response(png.bytes, { headers: { 'Content-Type': png.type || 'image/png', 'Cache-Control': 'private, max-age=300' } });
    }
    if (url.pathname === '/api/water/snaps/place' && request.method === 'POST') {
      let b = null;
      try { b = await request.json(); } catch { /* below */ }
      const c = cleanPlace(b);
      if (c.error) return json({ error: c.error }, 400);
      const r = await env.MAIN.placeThermalSnap(c.id, c.place);
      return r?.error ? json({ error: r.error }, 400) : json({ ok: true, place: r?.place ?? null });
    }
  } catch (e) {
    return json({ error: `the main site: ${e?.message || e}` }, 502);
  }
  return json({ error: 'Not found' }, 404);
}
