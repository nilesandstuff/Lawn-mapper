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
 *   POST /api/admin/admin-saves/check   finish any trace that is ready now (the page's Refresh; the timer does the same,
 *                                        and then builds the lidar: buildLidar)
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
import { listMaps, getMap, upsertMap, deleteMap, userOwner } from './unified.js';
import { alphaEnabled, startAlpha, pollAlpha, alphaMaskResponse, cancelAlpha } from './alpha.js';
import { countyServiceById } from './county.js';
import { decodePng } from './png-probe.js';
import { keepPhoto } from './map-photo.js';
import { buildShadeOnServer } from './shade-server-build.js';
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

/** Why a press was given up on after half an hour, from the last line the model server wrote about it. */
export const stillWaitingWhy = (stage) => (/waiting for a gpu/i.test(String(stage || ''))
  ? 'the GPU provider had no GPU free for half an hour (nothing is wrong with the map)'
  : 'no answer in half an hour');

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
export async function finishTraces(env, selfOrigin = '', { build = true } = {}) {
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
        if (Date.now() - Date.parse(row.created_at) > MAX_WAIT_MS) {
          const why = stillWaitingWhy(ans.detail);
          await set('failed', why); await mark(env, owner, row.map_key, { status: 'failed', detail: why });
          try { await cancelAlpha(env, row.press); } catch { /* it ends by itself */ } // nobody is waiting: do not pay for the read
        } else if (ans.detail && ans.detail !== row.detail) {
          // the model server's own line about where the lot has got to, for the page (2026-11-11: two presses sat
          // at "working" for half an hour while the GPU provider had no GPU free, and the page could not say so)
          await env.DB.prepare("UPDATE admin_traces SET detail = ?2 WHERE id = ?1 AND status = 'pending'").bind(row.id, String(ans.detail).slice(0, 300)).run();
        }
        continue;
      }
      if (ans.status !== 'succeeded') { await set('failed', ans.detail); await mark(env, owner, row.map_key, { status: 'failed', detail: ans.detail || 'the trained model failed' }); continue; }
      const { origin: _o, ...frame } = framed;
      const shapes = await shapesOf(env, row.press, frame);
      if (!shapes) { await set('failed', 'the mask could not be read'); await mark(env, owner, row.map_key, { status: 'failed', detail: 'the mask could not be read' }); continue; }
      const map = await getMap(env, owner, row.map_key);
      if (!map) { await set('failed', 'the map is gone'); continue; }
      // a map already drawn on since the press (the owner opened it and traced) keeps its own lawn
      if (Array.isArray(map.shapes) && map.shapes.length && map.handEdited) { await set('lidar', 'the map was edited meanwhile: its own lawn kept'); await mark(env, owner, row.map_key, { status: 'kept', detail: 'edited meanwhile' }); continue; }
      const m = shapes.length ? measure({ type: 'FeatureCollection', features: shapes }) : { squareFeet: 0, acres: 0 };
      const { tools: _t, ...record } = map;
      await upsertMap(env, owner, { ...record, shapes, squareFeet: m.squareFeet, acres: m.acres, handEdited: false,
        model: 'alpha', modelVersion: ans.version || record.modelVersion || null, provider: frame.provider || record.provider || 'mapbox',
        frame: { ...(record.frame || {}), ...frame },
        trace: { status: 'done', at: new Date().toISOString(), press: row.press, pieces: shapes.length, uncertainty: ans.uncertainty ?? null, seconds: ans.seconds ?? null } });
      await set('lidar', `${shapes.length} pieces`); // traced; its lidar is built next (buildLidar)
      done++;
    } catch (err) {
      try { await set('failed', err.message); } catch { /* the next tick */ }
    }
  }
  if (rows.length) { try { await writeIndex(env); } catch { /* the next change writes it */ } }
  if (build) { try { await buildLidar(env); } catch { /* the next tick */ } }
  return done;
}

/**
 * THE LIDAR, BUILT WITH NO PAGE OPEN (the owner, 2026-11-11: "Ask the shade map to build a way where it runs on
 * cloudflare so I don't need to leave the page open"; the features session's shade-server-build.js and its Container).
 * A traced admin save (status 'lidar') is claimed ('building', so the next minute's timer cannot start it twice),
 * built, and its row ends 'done' or 'lidar-failed' with what the builder said. One a tick: a build takes 15-60 s.
 * The answer is kept on the ROW, not in the map's record: writing the record again would make the map newer than the
 * model just built from it, and every tool would call the model out of date.
 */
export async function buildLidar(env) {
  if (!env.SHADE_BUILDER) return null;
  const now = () => new Date().toISOString();
  // a build claimed twenty minutes ago and never finished (the Worker was replaced mid-build) is offered again once
  await env.DB.prepare("UPDATE admin_traces SET status = 'lidar', detail = 'retried' WHERE status = 'building' AND finished_at < ?1 AND (detail IS NULL OR detail != 'retried')")
    .bind(new Date(Date.now() - 20 * 60 * 1000).toISOString()).run();
  const row = await env.DB.prepare("SELECT * FROM admin_traces WHERE status = 'lidar' ORDER BY created_at LIMIT 1").first();
  if (!row) return null;
  const claimed = await env.DB.prepare("UPDATE admin_traces SET status = 'building', finished_at = ?2 WHERE id = ?1 AND status = 'lidar'").bind(row.id, now()).run();
  if (!claimed?.meta?.changes) return null;
  const end = (status, detail) => env.DB.prepare('UPDATE admin_traces SET status = ?2, detail = ?3, finished_at = ?4 WHERE id = ?1').bind(row.id, status, String(detail || '').slice(0, 300), now()).run();
  try {
    const user = await env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?').bind(row.user_id).first();
    if (!user || user.role !== 'admin') { await end('lidar-failed', 'not an administrator any more'); return false; }
    let base = ''; try { base = JSON.parse(row.frame)?.origin || ''; } catch { base = ''; }
    const r = await buildShadeOnServer(env, userOwner(user), row.map_key, { base });
    if (!r.ok) { await end('lidar-failed', r.why || 'the shade builder failed'); return false; }
    await end('done', `lidar built in ${r.seconds ?? '?'} s (build ${r.build ?? '?'}${r.lidar ? `, ${typeof r.lidar === 'string' ? r.lidar : r.lidar.name || r.lidar.id || 'survey chosen'}` : ''})`);
    return true;
  } catch (err) { await end('lidar-failed', err.message); return false; }
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
    // each map's lidar, from its newest press (buildLidar keeps the answer on the row)
    const rows = (await env.DB.prepare('SELECT map_key, status, detail, finished_at FROM admin_traces WHERE user_id = ? ORDER BY created_at').bind(me.id).all()).results || [];
    const last = new Map(rows.map((r) => [r.map_key, r]));
    const lidarOf = (key) => { const r = last.get(key); return !r || r.status === 'pending' || r.status === 'failed' ? null : { status: r.status === 'lidar' ? 'waiting' : r.status === 'building' ? 'building' : r.status === 'done' ? 'done' : 'failed', detail: r.status === 'done' || r.status === 'lidar-failed' ? r.detail : null, at: r.finished_at }; };
    return json({ maps: (await adminSavesOf(env, me)).map((m) => ({ ...brief(m), lidar: lidarOf(m.id), working: last.get(m.id)?.status === 'pending' ? last.get(m.id).detail || null : null })) }, 200, origin);
  }

  // DELETE /api/admin/admin-saves?id=   one admin save, every tool's part of it, its lidar file and its presses.
  // Only a map marked as an admin save: an administrator's ordinary maps are deleted where they always were.
  if (path === 'admin-saves' && request.method === 'DELETE') {
    const key = url.searchParams.get('id');
    if (!key) return json({ error: 'id required' }, 400, origin);
    const map = await getMap(env, owner, key);
    if (!map || !isAdminSave(map)) return json({ error: 'Not an admin save' }, 404, origin);
    const waiting = (await env.DB.prepare("SELECT press FROM admin_traces WHERE user_id = ? AND map_key = ? AND status = 'pending'").bind(me.id, key).all()).results || [];
    for (const w of waiting) { try { await cancelAlpha(env, w.press); } catch { /* it ends by itself */ } }
    await env.DB.prepare('DELETE FROM admin_traces WHERE user_id = ? AND map_key = ?').bind(me.id, key).run();
    await deleteMap(env, owner, key);
    try { await writeIndex(env); } catch { /* the next change writes it */ }
    return json({ ok: true }, 200, origin);
  }

  if (path === 'admin-saves/check' && request.method === 'POST') {
    const done = await finishTraces(env, url.origin, { build: false }); // the lidar is the timer's: it takes a minute
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
