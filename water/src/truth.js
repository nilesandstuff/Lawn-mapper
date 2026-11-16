/**
 * GROUND TRUTH BY PROPERTY (owner, 2026-11-15: "split up by property, so that any walk is permanently associated to a
 * property so we can make refinements to the surface temperature predictions and compare the accuracy across the
 * accumulated walks"; and "once a walk comes in, we'll have the current weather data we need for the time and place").
 *
 * A WALK is one visit with the Yard AR app (the thermal camera now; soil moisture and wind to come, and a walk may carry
 * any of them). The walk's own measurements stay where the core keeps them (GET /api/maps/thermal, docs/MAPS.md); this
 * keeps, in the water Worker's own D1, what the water map adds to each walk:
 *
 *   truth_walks    the walk, for good tied to its map and its parcel (a property may be mapped more than once), its
 *                  times, which kinds of measurement it holds, the walker's notes (air read, wet grass, sprinklers,
 *                  cloud, the sky sweep's summary)
 *   truth_weather  the weather of the walk's minutes, fetched once and FROZEN (lib/momentweather.js), so a later
 *                  archive change or a better source cannot quietly move an old comparison; ?refresh=1 fetches again
 *   truth_results  each comparison, per walk, per kind, per MODEL VERSION (surfacenow.js MODEL_VERSION): the walks
 *                  piled up are scored again whenever the model changes, and the versions set side by side
 *
 *   GET    /api/water/truth?map=&pin=          a property's walks, each with its weather's source and its results
 *   GET    /api/water/truth?all=1              every walk (the measurements page)
 *   POST   /api/water/truth/walk               a walk seen for the first time (or its notes updated)
 *   GET    /api/water/truth/weather?walk=         the walk's frozen weather (404 'not fetched yet' before it is)
 *   POST   /api/water/truth/weather               { walk, lat, lng, extra: { rows } }: the first time, the station's
 *                                                 reports fetched here and the rows the page fetched (Open-Meteo, from
 *                                                 the admin's own address: lib/momentweather.js) added, then frozen
 *          (GET with lat & lng still fetches the station alone)
 *   POST   /api/water/truth/result             a comparison's numbers
 *   DELETE /api/water/truth?walk=              a walk and everything kept for it
 * All admin only. No addresses; the walk's place is its map's, and coordinates passed for the weather are not kept.
 */

import { weatherOfMoment } from '../lib/momentweather.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const txt = (v, n) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));
const num = (v, lo, hi) => { const x = Number(v); return v !== null && v !== '' && Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
export const KINDS = ['surface', 'moisture', 'wind'];
const T_MIN = 1.5e12, T_MAX = 4e12;

/** A posted walk, checked. -> { row } or { error } */
export function cleanWalk(b, now = Date.now()) {
  if (!b || typeof b !== 'object') return { error: 'no walk' };
  const walk = txt(b.walk, 80), map_id = txt(b.map_id, 80);
  if (!walk || !/^[\w.:-]+$/.test(walk)) return { error: 'walk id required (letters, digits, - _ . :)' };
  if (!map_id) return { error: 'map_id required: a walk belongs to a property for good' };
  const started = num(b.started, T_MIN, T_MAX), ended = num(b.ended, T_MIN, T_MAX);
  if (started === null) return { error: 'started (ms) required' };
  const kinds = [...new Set((Array.isArray(b.kinds) ? b.kinds : []).filter((k) => KINDS.includes(k)))];
  const notes = b.notes && typeof b.notes === 'object' ? txt(JSON.stringify(b.notes), 4000) : null;
  return { row: { walk, map_id, parcel_pin: txt(b.parcel_pin, 64), source: txt(b.source, 40) || 'thermal', started, ended: ended !== null && ended >= started ? ended : null, kinds: kinds.join(','), notes, seen: now } };
}

/** A posted result, checked. -> { row } or { error } */
export function cleanResult(b, now = Date.now()) {
  if (!b || typeof b !== 'object') return { error: 'no result' };
  const walk = txt(b.walk, 80), model = txt(b.model, 80), kind = KINDS.includes(b.kind) ? b.kind : null;
  if (!walk || !model || !kind) return { error: 'walk, model and kind required' };
  const n = num(b.n, 0, 1e7);
  if (n === null) return { error: 'n required' };
  return { row: { walk, model, kind, checked: now, n, bias: num(b.bias, -100, 100), rmse: num(b.rmse, 0, 100), rho: num(b.rho, -1, 1), detail: b.detail && typeof b.detail === 'object' ? txt(JSON.stringify(b.detail), 20000) : null } };
}

const WALK_COLS = ['walk', 'map_id', 'parcel_pin', 'source', 'started', 'ended', 'kinds', 'notes', 'seen'];
const RESULT_COLS = ['walk', 'model', 'kind', 'checked', 'n', 'bias', 'rmse', 'rho', 'detail'];

async function stationList(env, url) {
  if (env.ASSETS) {
    const r = await env.ASSETS.fetch(new Request(new URL('/data/asos-stations.json', url)));
    if (r.ok) return r.json();
  }
  const r = await fetch(new URL('/data/asos-stations.json', url));
  return r.json();
}

/* THE SAME WRITES FOR THE NO-PAGE SCORING (src/worker.js, 2026-11-16): a walk, its frozen weather and its result
   kept exactly as the routes below keep them, so a walk scored by the builder reads the same as one scored by a page. */
export async function putWalk(env, body) {
  const { row, error } = cleanWalk(body);
  if (error) return { error };
  await env.DB.prepare(`INSERT INTO truth_walks (${WALK_COLS.join(', ')}) VALUES (${WALK_COLS.map(() => '?').join(', ')})
    ON CONFLICT(walk) DO UPDATE SET map_id = excluded.map_id, parcel_pin = COALESCE(excluded.parcel_pin, truth_walks.parcel_pin), source = excluded.source,
    started = excluded.started, ended = excluded.ended, kinds = excluded.kinds, notes = COALESCE(excluded.notes, truth_walks.notes)`).bind(...WALK_COLS.map((c) => row[c])).run();
  return { ok: true };
}
export async function putWeather(env, walk, sources, series) {
  const kept = await env.DB.prepare('SELECT walk FROM truth_weather WHERE walk = ?').bind(walk).first();
  if (kept) return { ok: true, frozen: true }; // the first weather of a walk stays
  await env.DB.prepare('INSERT INTO truth_weather (walk, fetched, sources, series) VALUES (?, ?, ?, ?)').bind(walk, Date.now(), JSON.stringify(sources || []), JSON.stringify(series || [])).run();
  return { ok: true };
}
export async function frozenWeather(env, walk) {
  const kept = await env.DB.prepare('SELECT * FROM truth_weather WHERE walk = ?').bind(walk).first();
  return kept ? { sources: JSON.parse(kept.sources || '[]'), series: JSON.parse(kept.series || '[]') } : null;
}
export async function putResult(env, body) {
  const { row, error } = cleanResult(body);
  if (error) return { error };
  await env.DB.prepare(`INSERT OR REPLACE INTO truth_results (${RESULT_COLS.join(', ')}) VALUES (${RESULT_COLS.map(() => '?').join(', ')})`).bind(...RESULT_COLS.map((c) => row[c])).run();
  return { ok: true };
}

/** The routes, or null. isAdmin(request, env) -> bool. weatherFn for tests. */
export async function truth(request, env, url, { isAdmin, weatherFn = weatherOfMoment, fetchFn = fetch } = {}) {
  if (url.pathname !== '/api/water/truth' && !url.pathname.startsWith('/api/water/truth/')) return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.DB) return json({ error: 'no-database' }, 503);
  const p = url.pathname;
  const body = async () => { try { return await request.json(); } catch { return null; } };

  if (p === '/api/water/truth/walk') {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    const { row, error } = cleanWalk(await body());
    if (error) return json({ error }, 400);
    // first seen stays first seen; the rest is the newest word
    await env.DB.prepare(`INSERT INTO truth_walks (${WALK_COLS.join(', ')}) VALUES (${WALK_COLS.map(() => '?').join(', ')})
      ON CONFLICT(walk) DO UPDATE SET map_id = excluded.map_id, parcel_pin = COALESCE(excluded.parcel_pin, truth_walks.parcel_pin), source = excluded.source,
      started = excluded.started, ended = excluded.ended, kinds = excluded.kinds, notes = COALESCE(excluded.notes, truth_walks.notes)`).bind(...WALK_COLS.map((c) => row[c])).run();
    return json({ ok: true, walk: row.walk });
  }

  if (p === '/api/water/truth/weather') {
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'method' }, 405);
    const posted = request.method === 'POST' ? (await body()) || {} : {};
    const walk = posted.walk || url.searchParams.get('walk');
    const w = walk ? await env.DB.prepare('SELECT * FROM truth_walks WHERE walk = ?').bind(walk).first() : null;
    if (!w) return json({ error: 'register the walk first' }, 404);
    if (url.searchParams.get('refresh') !== '1') {
      const kept = await env.DB.prepare('SELECT * FROM truth_weather WHERE walk = ?').bind(walk).first();
      if (kept) return json({ walk, fetched: kept.fetched, sources: JSON.parse(kept.sources || '[]'), series: JSON.parse(kept.series || '[]'), frozen: true });
    }
    const lat = num(posted.lat ?? url.searchParams.get('lat'), -90, 90), lng = num(posted.lng ?? url.searchParams.get('lng'), -180, 180);
    if (lat === null || lng === null) return json({ error: request.method === 'GET' ? 'not fetched yet' : 'lat and lng of the property are needed the first time (not kept)' }, request.method === 'GET' ? 404 : 400);
    let got;
    try { got = await weatherFn(await stationList(env, url), lat, lng, w.started, w.ended ?? w.started + 9e5, { fetchFn, extra: posted.extra || null }); } catch (e) { return json({ error: String(e?.message || e) }, 502); }
    const now = Date.now();
    await env.DB.prepare('INSERT OR REPLACE INTO truth_weather (walk, fetched, sources, series) VALUES (?, ?, ?, ?)').bind(walk, now, JSON.stringify(got.sources), JSON.stringify(got.series)).run();
    return json({ walk, fetched: now, sources: got.sources, series: got.series, frozen: false });
  }

  if (p === '/api/water/truth/result') {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    const { row, error } = cleanResult(await body());
    if (error) return json({ error }, 400);
    await env.DB.prepare(`INSERT OR REPLACE INTO truth_results (${RESULT_COLS.join(', ')}) VALUES (${RESULT_COLS.map(() => '?').join(', ')})`).bind(...RESULT_COLS.map((c) => row[c])).run();
    return json({ ok: true });
  }

  if (p === '/api/water/truth') {
    if (request.method === 'DELETE') {
      const walk = url.searchParams.get('walk');
      if (!walk) return json({ error: 'which walk?' }, 400);
      await env.DB.batch(['truth_results', 'truth_weather', 'truth_walks'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE walk = ?`).bind(walk)));
      return json({ ok: true });
    }
    if (request.method !== 'GET') return json({ error: 'method' }, 405);
    const map = url.searchParams.get('map'), pin = url.searchParams.get('pin'), all = url.searchParams.get('all') === '1';
    if (!map && !pin && !all) return json({ error: 'map or pin' }, 400);
    // the property: its parcel when known (every map of it), else the map
    const walks = (all ? await env.DB.prepare('SELECT * FROM truth_walks ORDER BY started DESC LIMIT 500').all() : pin
      ? await env.DB.prepare('SELECT * FROM truth_walks WHERE parcel_pin = ? OR map_id = ? ORDER BY started').bind(pin, map || '').all()
      : await env.DB.prepare('SELECT * FROM truth_walks WHERE map_id = ? ORDER BY started').bind(map).all()).results || [];
    if (!walks.length) return json({ walks: [] });
    const ids = walks.map((w) => w.walk), q = ids.map(() => '?').join(', ');
    const weather = (await env.DB.prepare(`SELECT walk, fetched, sources FROM truth_weather WHERE walk IN (${q})`).bind(...ids).all()).results || [];
    const results = (await env.DB.prepare(`SELECT * FROM truth_results WHERE walk IN (${q}) ORDER BY checked`).bind(...ids).all()).results || [];
    const wBy = new Map(weather.map((r) => [r.walk, { fetched: r.fetched, sources: JSON.parse(r.sources || '[]') }]));
    return json({ walks: walks.map((w) => ({
      ...w, kinds: w.kinds ? w.kinds.split(',') : [], notes: w.notes ? JSON.parse(w.notes) : null,
      weather: wBy.get(w.walk) || null,
      results: results.filter((r) => r.walk === w.walk).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })),
    })) });
  }
  return json({ error: 'Not found' }, 404);
}
