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
 *   GET /api/shade/soil?lng=&lat=
 *     The soil at this place (soilNow below): its typical year, the last
 *     365 days, the last 120 hours' average and the latest hour, from
 *     Iowa State's IEMRE (lower 48) or NASA POWER. Cached an hour.
 *
 *   GET /api/shade/climate?lng=&lat=
 *     The typical year at this place from NASA POWER (ten years of daily
 *     data folded into 365 days, public/shade/climate.js): sunlight with
 *     clouds, its diffuse share, the 10th/90th percentiles, mean
 *     temperature. Cached at the edge for 30 days per 0.05 degree cell;
 *     NASA's own grid is coarser than that.
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
import { powerUrl, typicalYear, observedDays, nwsDailyMeans, yearAsItIs } from '../../public/shade/climate.js';
import { fromPush, perSecond, posePerSecond, baroPerSecond } from '../../public/shade/truth.js';
import { currentUser } from './auth.js';
import { handleUsage, logServerError } from './shade-usage.js';

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
  /* Usage and errors (shade-usage.js): the page's events, and the admin page's figures. */
  const usage = await handleUsage(request, url, env, origin, ctx, json);
  if (usage) return usage;
  if (url.pathname === '/api/shade/lidar' && request.method === 'GET') {
    const lng = Number(url.searchParams.get('lng')), lat = Number(url.searchParams.get('lat'));
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
      return json({ error: 'lng and lat required' }, 400, origin);
    }
    try {
      return json(await lidarAt(lng, lat, { ctx }), 200, origin);
    } catch (e) {
      await logServerError(request, env, 'lidar', `The lidar index could not be read: ${e?.message || e}`, { lng, lat });
      return json({ error: 'The lidar index could not be read', detail: String(e?.message || e) }, 502, origin);
    }
  }
  if (url.pathname === '/api/shade/soil' && request.method === 'GET') {
    const lng = Number(url.searchParams.get('lng')), lat = Number(url.searchParams.get('lat'));
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return json({ error: 'lng and lat required' }, 400, origin);
    try {
      const res = json(await soilNow(lng, lat, { ctx }), 200, origin);
      res.headers.set('Cache-Control', 'public, max-age=3600');
      return res;
    } catch (e) {
      return json({ error: 'The soil temperatures could not be read', detail: String(e?.message || e) }, 502, origin);
    }
  }
  if (url.pathname === '/api/shade/climate' && request.method === 'GET') {
    const lng = Number(url.searchParams.get('lng')), lat = Number(url.searchParams.get('lat'));
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
      return json({ error: 'lng and lat required' }, 400, origin);
    }
    try {
      const body = await climateNow(lng, lat, { ctx });
      const res = json(body, 200, origin);
      res.headers.set('Cache-Control', 'public, max-age=21600');
      return res;
    } catch (e) {
      await logServerError(request, env, 'climate', `NASA POWER did not answer: ${e?.message || e}`, { lng, lat });
      return json({ error: 'NASA POWER did not answer', detail: String(e?.message || e) }, 502, origin);
    }
  }
  if (url.pathname === '/api/shade/readings' || url.pathname.startsWith('/api/shade/readings/')) {
    return readings(request, url, env, origin, ctx, json);
  }
  return json({ error: 'Not found' }, 404, origin);
}

/* ------------------------------------------------------- ground truth
 *
 * The owner's light readings from the field (public/shade/truth.js says
 * what they are and how they are judged). ADMIN ONLY, refused with a 404
 * like the console's routes; the one exception is the push itself, which
 * Sensor Logger makes with the secret key in its address.
 *
 *   POST /api/shade/readings?key=K   Sensor Logger's push, or an upload
 *                                    ({ session, lux: [[t, lux]], fix: [[t,
 *                                    lat, lng, acc, speed, bearing]] }) from
 *                                    the readings page (signed in, no key)
 *   GET  /api/shade/readings/key     the push address (made on first ask)
 *   POST /api/shade/readings/key     a new push address; the old one stops
 *   GET  /api/shade/readings/sessions  recordings: first and last time, counts
 *   GET  /api/shade/readings/data?session=&t0=&t1=   fixes, light, orientation, barometer and cuts
 *   POST /api/shade/readings/cuts    { session, t0, t1 } erase; { remove: id }
 */

const READINGS = '/api/shade/readings';
const isAdmin = async (request, env, ctx) => {
  const me = await currentUser(request, env, ctx);
  return Boolean(me && me.role === 'admin');
};
const newKey = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function readings(request, url, env, origin, ctx, json) {
  const hidden = () => json({ error: 'Not found' }, 404, origin);
  if (!env.DB) return hidden();
  const sub = url.pathname.slice(READINGS.length) || '/';
  const db = env.DB;
  if (sub === '/' && request.method === 'POST') {
    /* Every push is logged (shade_push_log), so "nothing arrived" and "it
       arrived and failed" can be told apart (workflow 35). */
    const t0 = Date.now();
    const log = (row) => db.prepare('INSERT INTO shade_push_log (at, session, status, entries, lux, fix, orient, bytes, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(new Date().toISOString(), row.session ?? null, row.status, row.entries ?? null, row.lux ?? null, row.fix ?? null, row.orient ?? null, row.bytes ?? null, Date.now() - t0, row.error ?? null)
      .run().catch(() => {});
    const key = url.searchParams.get('key');
    const ok = key
      ? Boolean(await db.prepare('SELECT 1 FROM shade_push_keys WHERE key = ?').bind(key).first())
      : await isAdmin(request, env, ctx);
    if (!ok) { if (key) await log({ status: 404, error: 'not the current push address' }); return hidden(); }
    let text = '', body;
    try { text = await request.text(); body = JSON.parse(text); } catch { await log({ status: 400, bytes: text.length, error: 'bad JSON' }); return json({ error: 'Bad JSON' }, 400, origin); }
    const got = Array.isArray(body?.payload) ? fromPush(body)
      : { session: String(body?.session || ''), lux: Array.isArray(body?.lux) ? body.lux : [], fix: Array.isArray(body?.fix) ? body.fix : [], orient: Array.isArray(body?.orient) ? body.orient : [], baro: Array.isArray(body?.baro) ? body.baro : [] };
    const entries = Array.isArray(body?.payload) ? body.payload.length : null;
    if (!got.session) { await log({ status: 400, bytes: text.length, entries, error: 'no session' }); return json({ error: 'A session is needed' }, 400, origin); }
    try {
      const n = await storeReadings(db, got);
      await log({ status: 200, session: got.session, bytes: text.length, entries, ...n });
      if (Math.random() < 0.02) await db.prepare('DELETE FROM shade_push_log WHERE id < (SELECT MAX(id) - 2000 FROM shade_push_log)').run().catch(() => {});
      return json({ ok: true, ...n }, 200, origin);
    } catch (e) {
      await log({ status: 500, session: got.session, bytes: text.length, entries, error: String(e?.message || e).slice(0, 300) });
      return json({ error: 'Could not store the readings' }, 500, origin);
    }
  }
  if (!(await isAdmin(request, env, ctx))) return hidden();
  if (sub === '/key') {
    let row = request.method === 'GET' ? await db.prepare('SELECT key FROM shade_push_keys ORDER BY created_at DESC LIMIT 1').first() : null;
    if (!row) {
      const me = await currentUser(request, env, ctx);
      const key = newKey();
      await db.batch([
        db.prepare('DELETE FROM shade_push_keys'),
        db.prepare('INSERT INTO shade_push_keys (key, created_at, created_by) VALUES (?, ?, ?)').bind(key, new Date().toISOString(), me?.email || null),
      ]);
      row = { key };
    }
    return json({ key: row.key, url: `${url.origin}${READINGS}?key=${row.key}` }, 200, origin);
  }
  if (sub === '/sessions' && request.method === 'GET') {
    const { results } = await db.prepare(
      `SELECT f.session, MIN(f.t) AS first, MAX(f.t) AS last, COUNT(*) AS fixes,
              (SELECT COUNT(*) FROM shade_lux l WHERE l.session = f.session) AS lux
       FROM shade_fixes f GROUP BY f.session ORDER BY last DESC LIMIT 200`).all();
    return json({ sessions: results || [] }, 200, origin);
  }
  if (sub === '/data' && request.method === 'GET') {
    const session = url.searchParams.get('session') || '';
    const t0 = Number(url.searchParams.get('t0')) || 0, t1 = Number(url.searchParams.get('t1')) || 8.64e15;
    const [fix, lux, orient, baro, cuts] = await Promise.all([
      db.prepare('SELECT t, lat, lng, acc, speed, bearing FROM shade_fixes WHERE session = ? AND t BETWEEN ? AND ? ORDER BY t').bind(session, t0, t1).all(),
      db.prepare('SELECT t, lux FROM shade_lux WHERE session = ? AND t BETWEEN ? AND ? ORDER BY t').bind(session, t0 - 2000, t1 + 2000).all(),
      db.prepare('SELECT t, nx, ny, nz, head FROM shade_orient WHERE session = ? AND t BETWEEN ? AND ? ORDER BY t').bind(session, t0 - 2000, t1 + 2000).all(),
      db.prepare('SELECT t, hpa, alt FROM shade_baro WHERE session = ? AND t BETWEEN ? AND ? ORDER BY t').bind(session, t0 - 2000, t1 + 2000).all().catch(() => ({ results: [] })),
      db.prepare('SELECT id, t0, t1 FROM shade_cuts WHERE session = ? ORDER BY t0').bind(session).all(),
    ]);
    return json({
      session,
      fix: (fix.results || []).map((r) => [r.t, r.lat, r.lng, r.acc, r.speed, r.bearing]),
      lux: (lux.results || []).map((r) => [r.t, r.lux]),
      orient: (orient.results || []).map((r) => [r.t, r.nx, r.ny, r.nz, r.head]),
      baro: (baro.results || []).map((r) => [r.t, r.hpa, r.alt]),
      cuts: (cuts.results || []).map((r) => [r.t0, r.t1, r.id]),
    }, 200, origin);
  }
  if (sub === '/cuts' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400, origin); }
    if (Number.isFinite(Number(body?.remove))) {
      await db.prepare('DELETE FROM shade_cuts WHERE id = ?').bind(Number(body.remove)).run();
      return json({ ok: true }, 200, origin);
    }
    const t0 = Number(body?.t0), t1 = Number(body?.t1);
    if (!body?.session || !Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return json({ error: 'session, t0 and t1 needed' }, 400, origin);
    const r = await db.prepare('INSERT INTO shade_cuts (session, t0, t1, at) VALUES (?, ?, ?, ?)').bind(String(body.session), t0, t1, new Date().toISOString()).run();
    return json({ ok: true, id: r.meta?.last_row_id ?? null }, 200, origin);
  }
  return hidden();
}

/**
 * Light and the phone's pose (one mean per second each) and fixes, written
 * in batches that stay under D1's 100 bound values a statement. A repeat of
 * the same second or fix is ignored, so a push Sensor Logger retries does
 * not double up.
 */
export async function storeReadings(db, { session, lux = [], fix = [], orient = [], baro = [] }) {
  const L = perSecond(lux.filter((r) => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1]))).map((r) => [Number(r[0]), Number(r[1])]));
  const F = fix.filter((r) => Array.isArray(r) && [r[0], r[1], r[2]].every((v) => Number.isFinite(Number(v))));
  const stmts = [];
  for (let i = 0; i < L.length; i += 24) {
    const part = L.slice(i, i + 24);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO shade_lux (session, t, lux, lux_max) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`)
      .bind(...part.flatMap(([t, l, mx]) => [session, Math.round(t), l, mx])));
  }
  const n = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  for (let i = 0; i < F.length; i += 14) {
    const part = F.slice(i, i + 14);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO shade_fixes (session, t, lat, lng, acc, speed, bearing) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...part.flatMap((r) => [session, Math.round(Number(r[0])), Number(r[1]), Number(r[2]), n(r[3]), n(r[4]), n(r[5])])));
  }
  const O = posePerSecond(orient.filter((r) => Array.isArray(r) && [0, 1, 2, 3].every((i) => Number.isFinite(Number(r[i]))))
    .map((r) => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number.isFinite(Number(r[4])) ? Number(r[4]) : 0]));
  for (let i = 0; i < O.length; i += 16) {
    const part = O.slice(i, i + 16);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO shade_orient (session, t, nx, ny, nz, head) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...part.flatMap((r) => [session, Math.round(r[0]), r[1], r[2], r[3], r[4]])));
  }
  /* The barometer, one median per second (shade_baro; for the water map's
     ground checks: the phone's height along a pass against the lidar). */
  const B = baroPerSecond(baro.filter((r) => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1]))).map((r) => [Number(r[0]), Number(r[1]), Number.isFinite(Number(r[2])) ? Number(r[2]) : NaN]));
  for (let i = 0; i < B.length; i += 24) {
    const part = B.slice(i, i + 24);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO shade_baro (session, t, hpa, alt) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`)
      .bind(...part.flatMap(([t, p, a]) => [session, Math.round(t), p, a === null || Number.isNaN(a) ? null : a])));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { lux: L.length, fix: F.length, orient: O.length, baro: B.length };
}

/** The last ten whole years before `now`. */
export const climateYears = (now = new Date()) => [now.getUTCFullYear() - 10, now.getUTCFullYear() - 1];

/** The typical year at a point, from the edge cache or NASA POWER. */
export async function climateAt(lng, lat, { ctx = null, fetchImpl = fetch, now = new Date() } = {}) {
  const rl = Math.round(lng * 20) / 20, ra = Math.round(lat * 20) / 20;
  const [y0, y1] = climateYears(now);
  const cache = globalThis.caches?.default;
  const key = new Request(`https://shade.lawnmapper.internal/climate-v3/${ra},${rl},${y0}-${y1}.json`);
  const hit = cache && await cache.match(key);
  if (hit) return hit.json();
  const [res, soilIem] = await Promise.all([fetchImpl(powerUrl(rl, ra, y0, y1)), iemreTypical(ra, rl, { ctx, fetchImpl, now }).catch(() => null)]);
  if (!res.ok) throw new Error(`NASA POWER: ${res.status}`);
  const power = await res.json();
  const t = typicalYear(power);
  const round = (a, d) => a.map((v) => Math.round(v * 10 ** d) / 10 ** d);
  const body = {
    lng: rl, lat: ra, years: `${y0}-${y1}`, nYears: t.years,
    source: 'NASA POWER daily (MERRA-2, CERES SYN1deg), community AG',
    ghi: round(t.ghi, 2), ghiP10: round(t.ghiP10, 2), ghiP90: round(t.ghiP90, 2),
    diffuse: round(t.diffuse, 3), tMean: round(t.tMean, 1),
    /* The soil, for winter dormancy: Iowa State's IEMRE where it answers
       (owner, 2026-10-26: "switch to the Iowa model as long as it holds true
       to other locations"; shade findings 29: dormancy within a median 4
       days of 111 measured U.S. stations' against NASA's 8, and closer in
       Germany too), NASA's top layer elsewhere. */
    tSoil: soilIem || (t.tSoil ? round(t.tSoil, 1) : null),
    tSoilSource: soilIem ? 'iemre' : t.tSoil ? 'nasa' : null,
  };
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${30 * DAY}` },
    }));
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return body;
}

const NWS_AGENT = 'lawn-mapper shade map (https://lawnmap.nilesandstuff.com)';
const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * THIS YEAR'S WEATHER at a point (climate.js yearAsItIs): the days lived so
 * far from NASA POWER, the week ahead from the NWS point forecast (US only;
 * skipped where it does not answer), the rest the typical year plus the
 * recent anomaly fading. Cached six hours. Returns { tMeanNow, weather:
 * { observedThrough, forecastTo, anomaly, today } } or null when POWER's
 * daily data could not be read.
 */
export async function weatherNow(lng, lat, typical, { ctx = null, fetchImpl = fetch, now = new Date() } = {}) {
  const typicalTMean = Array.isArray(typical) ? typical : typical.tMean, typicalSoil = Array.isArray(typical) || typical.tSoilSource === 'iemre' ? null : typical.tSoil || null;
  const rl = Math.round(lng * 20) / 20, ra = Math.round(lat * 20) / 20, year = now.getUTCFullYear();
  const cache = globalThis.caches?.default;
  const key = new Request(`https://shade.lawnmapper.internal/climate-now-v3/${ra},${rl},${ymd(now)}.json`);
  const hit = cache && await cache.match(key);
  if (hit) return hit.json();
  const u = 'https://power.larc.nasa.gov/api/temporal/daily/point?' + new URLSearchParams({ parameters: 'T2M,TSOIL1', community: 'AG', longitude: rl.toFixed(3), latitude: ra.toFixed(3), start: `${year}0101`, end: ymd(now), format: 'JSON' });
  const res = await fetchImpl(u).catch(() => null);
  if (!res?.ok) return null;
  const power = await res.json();
  const observed = observedDays(power), observedSoil = observedDays(power, 'TSOIL1');
  let forecast = {};
  try {
    const pts = await fetchImpl(`https://api.weather.gov/points/${ra.toFixed(4)},${rl.toFixed(4)}`, { headers: { 'User-Agent': NWS_AGENT, Accept: 'application/geo+json' } });
    const fUrl = pts.ok ? (await pts.json())?.properties?.forecast : null;
    const fc = fUrl ? await fetchImpl(fUrl, { headers: { 'User-Agent': NWS_AGENT, Accept: 'application/geo+json' } }) : null;
    if (fc?.ok) forecast = nwsDailyMeans((await fc.json())?.properties?.periods);
  } catch { forecast = {}; }
  const y = yearAsItIs(typicalTMean, observed, forecast, { today: now });
  const dayOf = (k) => (k === null ? null : new Date(Date.UTC(year, 0, 1 + k)).toISOString().slice(0, 10));
  /* The soil this year: the days lived so far, then the typical soil plus the recent anomaly fading (no forecast of it). */
  const soilNow = typicalSoil && Object.keys(observedSoil).length ? yearAsItIs(typicalSoil, observedSoil, {}, { today: now }) : null;
  const body = {
    tMeanNow: y.tMean.map((v) => Math.round(v * 10) / 10),
    tSoilNow: soilNow ? soilNow.tMean.map((v) => Math.round(v * 10) / 10) : null,
    weather: { observedThrough: dayOf(y.through), forecastTo: dayOf(y.forecastTo), anomaly: Math.round(y.anomaly * 10) / 10, today: y.today, source: 'NASA POWER daily T2M this year; NWS point forecast; typical year plus the recent anomaly, fading' },
  };
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${6 * 3600}` } }));
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return body;
}

/*
 * THE SOIL at a point (the shade map's soil view, public/shade/soil.js).
 *
 * WHERE IT COMES FROM. Iowa State's IEMRE (mesonet.agron.iastate.edu/iemre,
 * free, no key; the lower 48 states) where it answers, NASA POWER's top
 * soil layer elsewhere. Scored against the measured daily soil of 16 NOAA
 * reference stations through 2025 (shade findings 28): IEMRE's daily soil
 * at 5 cm is off by 2.1 C on average with no bias, NASA's by 2.7 C and 1.6 C
 * too cold (3.2 C in winter, 5-6 C at two western stations).
 *
 * Returns { source, depth, typical: [365 C] | null (ten years folded, as
 * climate.js typicalYear), daily: { 'YYYYMMDD': C } (the last 365 days),
 * latest: { t (ms), c } | null, trail: { mean, from, to (ms), hours } | null
 * (the last 120 hours, IEMRE only) }.
 */
const IEM = 'https://mesonet.agron.iastate.edu/iemre';
const iso = (d) => d.toISOString().slice(0, 10);
const fToC = (f) => ((f - 32) * 5) / 9;

/** Days { 'YYYYMMDD': C } -> the typical year: each day the mean of the same date +-half days over every year (as typicalYear). */
export function foldYear(days, half = 7) {
  const by = Array.from({ length: 365 }, () => []);
  for (const [d, c] of Object.entries(days)) if (Number.isFinite(c)) by[dayIndexOf(d)].push(c);
  const out = [];
  for (let k = 0; k < 365; k++) {
    let s = 0, n = 0;
    for (let j = -half; j <= half; j++) for (const c of by[(k + j + 365) % 365]) { s += c; n++; }
    out.push(n ? Math.round((s / n) * 10) / 10 : NaN);
  }
  return out.every(Number.isFinite) ? out : null;
}
const dayIndexOf = (ymdS) => {
  const y = +ymdS.slice(0, 4), m = +ymdS.slice(4, 6) - 1, d = +ymdS.slice(6, 8);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const doy = Math.round((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000);
  return leap && doy >= 59 ? Math.max(58, doy - 1) : doy;
};

/** IEMRE's daily soil (the mean of its 4-inch high and low) over a span -> { 'YYYYMMDD': C } with its domain ('conus', 'europe') as `.domain`, or null outside its maps. */
async function iemreDays(lat, lng, from, to, fetchImpl) {
  const r = await fetchImpl(`${IEM}/multiday/${iso(from)}/${iso(to)}/${lat.toFixed(3)}/${lng.toFixed(3)}/json`);
  if (!r.ok) return null;
  const j = await r.json();
  if (!Array.isArray(j?.data)) return null;
  const out = {};
  for (const d of j.data) if (Number.isFinite(d.soil4t_high_f) && Number.isFinite(d.soil4t_low_f)) out[d.date.replace(/-/g, '')] = Math.round(fToC((d.soil4t_high_f + d.soil4t_low_f) / 2) * 10) / 10;
  Object.defineProperty(out, 'domain', { value: j.iemre_domain || null });
  return out;
}

/**
 * IEMRE's typical year of soil at a point: its ten whole years before `now`,
 * daily, folded (foldYear). Kept at the edge a month. Null outside its maps.
 * Read by the soil view and, since 2026-10-26, by the growing season's
 * dormancy day (climateAt's tSoil; shade findings 29).
 */
export async function iemreTypical(ra, rl, { ctx = null, fetchImpl = fetch, now = new Date() } = {}) {
  const cache = globalThis.caches?.default;
  const tKey = new Request(`https://shade.lawnmapper.internal/soil-typical-v1/iemre/${ra},${rl},${now.getUTCFullYear() - 10}.json`);
  const tHit = cache && await cache.match(tKey);
  if (tHit) return (await tHit.json()).typical;
  const years = Array.from({ length: 10 }, (_, i) => now.getUTCFullYear() - 10 + i);
  const all = {};
  for (const part of await Promise.all(years.map((y) => iemreDays(ra, rl, new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y, 11, 31)), fetchImpl).catch(() => null)))) Object.assign(all, part || {});
  const typical = Object.keys(all).length > 3000 ? foldYear(all) : null;
  if (typical && cache) {
    const put = cache.put(tKey, new Response(JSON.stringify({ typical }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${30 * DAY}` } }));
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return typical;
}

export async function soilNow(lng, lat, { ctx = null, fetchImpl = fetch, now = new Date() } = {}) {
  const rl = Math.round(lng * 20) / 20, ra = Math.round(lat * 20) / 20;
  const cache = globalThis.caches?.default;
  const key = new Request(`https://shade.lawnmapper.internal/soil-v2/${ra},${rl},${now.toISOString().slice(0, 13)}.json`);
  const hit = cache && await cache.match(key);
  if (hit) return hit.json();
  const keep = async (k, body, seconds) => {
    if (!cache) return;
    const put = cache.put(k, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` } }));
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  };
  const yearAgo = new Date(now.getTime() - 365 * 86400000);
  let body = null;
  /* IEMRE: the last year's days, the last week's hours, and ten years for the typical year (kept a month). */
  const daily = await iemreDays(ra, rl, yearAgo, now, fetchImpl).catch(() => null);
  if (daily && Object.keys(daily).length) {
    const hours = [];
    await Promise.all(Array.from({ length: 7 }, (_, i) => new Date(now.getTime() - (6 - i) * 86400000)).map(async (d) => {
      const r = await fetchImpl(`${IEM}/hourly/${iso(d)}/${ra.toFixed(3)}/${rl.toFixed(3)}/json`).catch(() => null);
      const j = r?.ok ? await r.json().catch(() => null) : null;
      for (const h of j?.data || []) if (Number.isFinite(h.soil4t_f) && h.valid_utc) hours.push([Date.parse(h.valid_utc), fToC(h.soil4t_f)]);
    }));
    const past = [...new Map(hours.filter(([t]) => t <= now.getTime()).map((h) => [h[0], h])).values()].sort((x, y) => x[0] - y[0]);
    const last = past.slice(-120);
    const latest = past.length ? { t: past[past.length - 1][0], c: Math.round(past[past.length - 1][1] * 10) / 10 } : null;
    const trail = last.length >= 96 ? { mean: Math.round((last.reduce((s, h) => s + h[1], 0) / last.length) * 10) / 10, from: last[0][0], to: last[last.length - 1][0], hours: last.length } : null;
    const typical = await iemreTypical(ra, rl, { ctx, fetchImpl, now });
    body = { source: 'iemre', domain: daily.domain, depth: 'the top 4 inches (about 10 cm)', words: "Iowa State's IEMRE soil model (hourly, current)", typical, daily, latest, trail };
  } else {
    /* NASA POWER: daily about 5 days behind, hourly about 3; the typical year is the climate route's. */
    const week = new Date(now.getTime() - 8 * 86400000);
    const q = (kind, from) => `https://power.larc.nasa.gov/api/temporal/${kind}/point?` + new URLSearchParams({ parameters: 'TSOIL1', community: 'AG', longitude: rl.toFixed(3), latitude: ra.toFixed(3), start: ymd(from), end: ymd(now), format: 'JSON', ...(kind === 'hourly' ? { 'time-standard': 'UTC' } : {}) });
    const [d, h] = await Promise.all([fetchImpl(q('daily', yearAgo)), fetchImpl(q('hourly', week)).catch(() => null)]);
    if (!d.ok) throw new Error(`NASA POWER: ${d.status}`);
    const days = {};
    for (const [k, v] of Object.entries(observedDays(await d.json(), 'TSOIL1'))) days[k] = Math.round(v * 10) / 10;
    let latest = null;
    if (h?.ok) {
      const hrs = observedDays(await h.json(), 'TSOIL1'); // keys 'YYYYMMDDHH'
      const lastH = Object.keys(hrs).sort().pop();
      if (lastH) latest = { t: Date.UTC(+lastH.slice(0, 4), +lastH.slice(4, 6) - 1, +lastH.slice(6, 8), +lastH.slice(8, 10)), c: Math.round(hrs[lastH] * 10) / 10 };
    }
    body = { source: 'nasa', depth: 'the top soil layer (about 10 cm)', words: "NASA POWER's soil model (MERRA-2, about 5 days behind)", typical: null, daily: days, latest, trail: null };
  }
  await keep(key, body, 3600);
  return body;
}

/** The typical year and this year's weather together (the /api/shade/climate answer). */
export async function climateNow(lng, lat, opts = {}) {
  const typical = await climateAt(lng, lat, opts);
  const now = await weatherNow(lng, lat, typical, opts).catch(() => null);
  return now ? { ...typical, ...now } : typical;
}

/*
 * THE SHADE MAP'S OWN ADDRESS (owner, 2026-10-18): shade.<home domain>
 * (shade-site/, tools/shade-prepare.js). Lawn Mapper's Worker runs first for
 * the old pages (wrangler.toml run_worker_first) and sends them there, query
 * and all -- ONLY when the deploy says the shade Worker is up (SHADE_HOST,
 * passed to this Worker's deploy only after the shade Worker deployed), so a
 * failed shade deploy can never redirect to a dead address. Without it (a
 * failed step, workers.dev, a local run) the pages are served here as before.
 */
export const SHADE_PAGES = {
  '/shade': '/', '/shade.html': '/', '/shade-trees': '/trees', '/shade-trees.html': '/trees',
  '/shade-log': '/log', '/shade-log.html': '/log', '/shade-admin': '/admin', '/shade-admin.html': '/admin',
};
export const isShadePage = (p) => Object.prototype.hasOwnProperty.call(SHADE_PAGES, p);
export function shadePage(request, url, env) {
  const host = String(env.SHADE_HOST || '').trim();
  if (host && url.hostname !== host) return Response.redirect(`https://${host}${SHADE_PAGES[url.pathname]}${url.search}`, 301);
  return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found\n', { status: 404 });
}
