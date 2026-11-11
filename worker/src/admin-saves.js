/**
 * ADMIN SAVES: A TEST MAP MADE IN ONE PRESS (core session, 2026-11-11). The owner: "I want a way to generate a map
 * that is testable without manually opening each tool... add a button on the ai tab, only viewable when logged in as
 * an admin. The button says 'save as admin and auto trace' which does that, and then loads an admin save page which
 * is just a list of the admin saves and links to open each in the various tools... If I leave the page, the trace
 * still gets sent to that map... this shouldn't change anything about the functionality of the site for regular
 * users. Be very careful about that."
 *
 * So everything here is behind the administrator's sign-in (routes-admin.js calls it after its own check), and the
 * public routes change in one way only: a map whose record says `adminSave: true` is left out of GET /api/maps and
 * listed by GET /api/maps?admin=1 instead. Nobody but an administrator can make such a record (this file is the only
 * writer of the flag), so every other account's lists are what they were.
 *
 *   POST /api/admin/admin-saves/trace   { map: the lawn mapper's save record (no shapes needed), segment: the body
 *                                        the page would post to /api/segment }
 *        saves the map as an admin save, starts Turf Trace (the trained model, alpha.js) on its frame, and remembers
 *        the press in admin_traces. Answers { id }.
 *   GET  /api/admin/admin-saves         the admin saves, newest first, each with its tools' dates and its trace
 *   POST /api/admin/admin-saves/check   finish any trace that is ready now (the page's Refresh; the timer does the same)
 *
 * THE TRACE LANDS WITHOUT THE PAGE: the Worker's one-minute timer (index.js scheduled -> finishTraces) asks the model
 * server about each press still waiting; a finished one's mask (kept in R2 by alpha.js pollAlpha) is turned into
 * shapes with the page's own tracer (public/lib/mask.js maskToPolygons, the same limits a detection uses) and
 * written into the map's record. The lawn is the raw trace; the owner edits it in the Lawn Mapper like any map.
 *
 * FOR THE OTHER SESSIONS (the owner: "these admin save maps are fully accessible for all Claude sessions... see them
 * in the r2 bucket", addresses included, never in the repository): every change rewrites admin-saves/index.json in
 * the corpus bucket (private): id, address, place, dates, trace, tools. /api/admin/saved-maps (the key route) marks
 * them too.
 */
import { listMaps, getMap, upsertMap, userOwner } from './unified.js';
import { alphaEnabled, startAlpha, pollAlpha, alphaMaskResponse } from './alpha.js';
import { countyServiceById } from './county.js';
import { decodePng } from './png-probe.js';
import { keepPhoto } from './map-photo.js';
import { maskToPolygons, areaTraceLimits, TRACE_TOLERANCE_M, MAX_TRACE_VERTICES } from '../../public/lib/mask.js';
import { framePxToLngLat, metresPerPixel } from '../../public/lib/mercator.js';
import { measure } from '../../public/lib/area.js';

export const INDEX_KEY = 'admin-saves/index.json';
const MAX_WAIT_MS = 30 * 60 * 1000; // a press not answered in half an hour has failed
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const isAdminSave = (m) => m?.adminSave === true;
const brief = (m, owner = null) => ({
  id: m.id, address: m.address || null, lng: m.lng ?? null, lat: m.lat ?? null, county: m.county || null, at: m.at,
  squareFeet: m.squareFeet ?? null, shapes: Array.isArray(m.shapes) ? m.shapes.length : 0,
  trace: m.trace || null, tools: m.tools || {}, ...(owner ? { owner } : {}),
});

/** The admin saves of one administrator, newest first. */
export async function adminSavesOf(env, user) {
  return (await listMaps(env, userOwner(user))).filter(isAdminSave);
}

/** admin-saves/index.json in the private corpus bucket: every administrator's admin saves, for the other sessions. */
export async function writeIndex(env) {
  if (!env.CORPUS) return;
  const admins = (await env.DB.prepare("SELECT id, email, role FROM users WHERE role = 'admin' ORDER BY created_at").all()).results || [];
  const maps = [];
  for (const a of admins) for (const m of await adminSavesOf(env, a)) maps.push({ ...brief(m), tools: Object.keys(m.tools || {}) });
  maps.sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
  await env.CORPUS.put(INDEX_KEY, JSON.stringify({ at: new Date().toISOString(), maps }, null, 1), { httpMetadata: { contentType: 'application/json' } });
}

/** A finished press's mask as the lawn mapper's shapes, or null. */
async function shapesOf(env, pressId, frame) {
  const res = await alphaMaskResponse(env, pressId);
  if (!res.ok) return null;
  const img = await decodePng(new Uint8Array(await res.arrayBuffer()), { maxPixels: 1 << 26 });
  if (!img) return null;
  const mpp = metresPerPixel(frame, img.width);
  const polygons = maskToPolygons(img, (x, y) => framePxToLngLat(frame, [x, y], img.width, img.height), {
    tolerance: TRACE_TOLERANCE_M / mpp, maxVertices: MAX_TRACE_VERTICES, ...areaTraceLimits(mpp, img.width, img.height),
  });
  return (polygons || []).map((g) => ({ type: 'Feature', properties: {}, geometry: g.type === 'Feature' ? g.geometry : g }));
}

/**
 * Every press still waiting: asked about once; a finished one written into its map. Called by the timer and by the
 * page's Refresh. Never throws: one bad row must not stop the others, and the timer must not fail the Worker.
 */
export async function finishTraces(env, selfOrigin = '') {
  let rows = [];
  try { rows = (await env.DB.prepare("SELECT * FROM admin_traces WHERE status = 'pending' ORDER BY created_at LIMIT 10").all()).results || []; } catch { return 0; }
  let done = 0;
  for (const row of rows) {
    const set = (status, detail = null) => env.DB.prepare('UPDATE admin_traces SET status = ?2, detail = ?3, finished_at = ?4 WHERE id = ?1')
      .bind(row.id, status, detail ? String(detail).slice(0, 300) : null, new Date().toISOString()).run();
    try {
      const user = await env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?').bind(row.user_id).first();
      if (!user || user.role !== 'admin') { await set('failed', 'not an administrator any more'); continue; }
      const owner = userOwner(user);
      let framed = {}; try { framed = JSON.parse(row.frame) || {}; } catch { framed = {}; }
      // the site's own address as the press was made on it (the kept answer's picture links are written with it)
      const ans = await pollAlpha(env, row.press, framed.origin || selfOrigin);
      if (ans.status === 'processing') {
        if (Date.now() - Date.parse(row.created_at) > MAX_WAIT_MS) { await set('failed', 'no answer in half an hour'); await mark(env, owner, row.map_key, { status: 'failed', detail: 'no answer in half an hour' }); }
        continue;
      }
      if (ans.status !== 'succeeded') { await set('failed', ans.detail); await mark(env, owner, row.map_key, { status: 'failed', detail: ans.detail || 'the trained model failed' }); continue; }
      const { origin: _o, ...frame } = framed;
      const shapes = await shapesOf(env, row.press, frame);
      if (!shapes) { await set('failed', 'the mask could not be read'); await mark(env, owner, row.map_key, { status: 'failed', detail: 'the mask could not be read' }); continue; }
      const map = await getMap(env, owner, row.map_key);
      if (!map) { await set('failed', 'the map is gone'); continue; }
      // a map already drawn on since the press (the owner opened it and traced) keeps its own lawn
      if (Array.isArray(map.shapes) && map.shapes.length && map.handEdited) { await set('done', 'the map was edited meanwhile: its own lawn kept'); await mark(env, owner, row.map_key, { status: 'kept', detail: 'edited meanwhile' }); continue; }
      const m = shapes.length ? measure({ type: 'FeatureCollection', features: shapes }) : { squareFeet: 0, acres: 0 };
      const { tools: _t, ...record } = map;
      await upsertMap(env, owner, { ...record, shapes, squareFeet: m.squareFeet, acres: m.acres, handEdited: false,
        model: 'alpha', modelVersion: ans.version || record.modelVersion || null, provider: frame.provider || record.provider || 'mapbox',
        frame: { ...(record.frame || {}), ...frame },
        trace: { status: 'done', at: new Date().toISOString(), press: row.press, pieces: shapes.length, uncertainty: ans.uncertainty ?? null, seconds: ans.seconds ?? null } });
      await set('done', `${shapes.length} pieces`);
      done++;
    } catch (err) {
      try { await set('failed', err.message); } catch { /* the next tick */ }
    }
  }
  if (rows.length) { try { await writeIndex(env); } catch { /* the next change writes it */ } }
  return done;
}

/** A trace's state written into the map's own record, the rest of the record untouched. */
async function mark(env, owner, key, trace) {
  const map = await getMap(env, owner, key);
  if (!map) return;
  const { tools: _t, ...record } = map;
  await upsertMap(env, owner, { ...record, trace: { ...trace, at: new Date().toISOString() } });
}

/** The routes, for an administrator already checked by routes-admin.js. Returns a Response, or null for another path. */
export async function handleAdminSaves(request, env, url, origin, ctx, json, me) {
  const path = url.pathname.slice('/api/admin/'.length);
  if (path !== 'admin-saves' && !path.startsWith('admin-saves/')) return null;
  if (!me || me.role !== 'admin') return json({ error: 'Not found' }, 404, origin);
  const owner = userOwner(me);

  if (path === 'admin-saves' && request.method === 'GET') {
    return json({ maps: (await adminSavesOf(env, me)).map((m) => brief(m)) }, 200, origin);
  }

  if (path === 'admin-saves/check' && request.method === 'POST') {
    const done = await finishTraces(env, url.origin);
    return json({ ok: true, finished: done }, 200, origin);
  }

  if (path === 'admin-saves/trace' && request.method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch { body = null; }
    const map = body?.map, seg = body?.segment || {};
    if (!map?.id || !map?.address) return json({ error: 'a map with an id and an address is needed' }, 400, origin);
    if (!alphaEnabled(env)) return json({ error: 'Turf Trace is not served on this site' }, 503, origin);
    const lng = Number(seg.lng), lat = Number(seg.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return json({ error: 'the frame to trace is needed (segment.lng, lat, zoom, size)' }, 400, origin);
    const zoom = Math.min(21, Math.max(15, Number(seg.zoom) || 19));
    const size = clampInt(seg.size, 64, 1280, 640), height = clampInt(seg.height, 64, 1280, size);
    const svc = seg.provider === 'county' ? await countyServiceById(env, seg.svc) : null;
    if (svc) svc.selfOrigin = url.origin;
    // saved first: a press that cannot start still leaves the map, to trace by hand or press again
    const record = { ...map, adminSave: true, shapes: Array.isArray(map.shapes) ? map.shapes : [], trace: { status: 'starting', at: new Date().toISOString() } };
    delete record.tools;
    const saved = await upsertMap(env, owner, record);
    if (!saved.key) return json({ error: saved.error || 'the map could not be saved' }, 400, origin);
    if (ctx?.waitUntil) ctx.waitUntil(keepPhoto(env, owner, saved.key, record).catch(() => {}));
    let begun;
    try {
      begun = await startAlpha(env, { frame: { lng, lat, zoom, size, height }, parcel: seg.parcel || map.parcel?.geometry || null, naipAlign: svc ? null : seg.naipAlign || null, county: svc });
    } catch (err) {
      await mark(env, owner, saved.key, { status: 'failed', detail: `Turf Trace could not start: ${err.message}` });
      if (ctx?.waitUntil) ctx.waitUntil(writeIndex(env).catch(() => {}));
      return json({ id: saved.key, trace: 'failed', detail: err.message }, 200, origin);
    }
    const frame = { ...begun.frame, provider: begun.provider || 'mapbox', origin: url.origin };
    await env.DB.prepare(
      "INSERT INTO admin_traces (id, user_id, map_key, press, frame, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
    ).bind(crypto.randomUUID(), me.id, saved.key, begun.id, JSON.stringify(frame), new Date().toISOString()).run();
    await mark(env, owner, saved.key, { status: 'pending', press: begun.id });
    if (ctx?.waitUntil) ctx.waitUntil(writeIndex(env).catch(() => {}));
    return json({ id: saved.key, trace: 'pending' }, 200, origin);
  }

  return json({ error: 'Not found' }, 404, origin);
}
