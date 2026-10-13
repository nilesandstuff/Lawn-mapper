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
import { powerUrl, typicalYear } from '../../public/shade/climate.js';
import { fromPush, perSecond, posePerSecond } from '../../public/shade/truth.js';
import { currentUser } from './auth.js';

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
  if (url.pathname === '/api/shade/climate' && request.method === 'GET') {
    const lng = Number(url.searchParams.get('lng')), lat = Number(url.searchParams.get('lat'));
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lng) > 180) {
      return json({ error: 'lng and lat required' }, 400, origin);
    }
    try {
      const body = await climateAt(lng, lat, { ctx });
      const res = json(body, 200, origin);
      res.headers.set('Cache-Control', 'public, max-age=86400');
      return res;
    } catch (e) {
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
 *   GET  /api/shade/readings/data?session=&t0=&t1=   fixes, light and cuts
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
      : { session: String(body?.session || ''), lux: Array.isArray(body?.lux) ? body.lux : [], fix: Array.isArray(body?.fix) ? body.fix : [], orient: Array.isArray(body?.orient) ? body.orient : [] };
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
    const [fix, lux, orient, cuts] = await Promise.all([
      db.prepare('SELECT t, lat, lng, acc, speed, bearing FROM shade_fixes WHERE session = ? AND t BETWEEN ? AND ? ORDER BY t').bind(session, t0, t1).all(),
      db.prepare('SELECT t, lux FROM shade_lux WHERE session = ? AND t BETWEEN ? AND ? ORDER BY t').bind(session, t0 - 2000, t1 + 2000).all(),
      db.prepare('SELECT t, nx, ny, nz, head FROM shade_orient WHERE session = ? AND t BETWEEN ? AND ? ORDER BY t').bind(session, t0 - 2000, t1 + 2000).all(),
      db.prepare('SELECT id, t0, t1 FROM shade_cuts WHERE session = ? ORDER BY t0').bind(session).all(),
    ]);
    return json({
      session,
      fix: (fix.results || []).map((r) => [r.t, r.lat, r.lng, r.acc, r.speed, r.bearing]),
      lux: (lux.results || []).map((r) => [r.t, r.lux]),
      orient: (orient.results || []).map((r) => [r.t, r.nx, r.ny, r.nz, r.head]),
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
export async function storeReadings(db, { session, lux = [], fix = [], orient = [] }) {
  const L = perSecond(lux.filter((r) => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1]))).map((r) => [Number(r[0]), Number(r[1])]));
  const F = fix.filter((r) => Array.isArray(r) && [r[0], r[1], r[2]].every((v) => Number.isFinite(Number(v))));
  const stmts = [];
  for (let i = 0; i < L.length; i += 30) {
    const part = L.slice(i, i + 30);
    stmts.push(db.prepare(`INSERT OR IGNORE INTO shade_lux (session, t, lux) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`)
      .bind(...part.flatMap(([t, l]) => [session, Math.round(t), l])));
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
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return { lux: L.length, fix: F.length, orient: O.length };
}

/** The last ten whole years before `now`. */
export const climateYears = (now = new Date()) => [now.getUTCFullYear() - 10, now.getUTCFullYear() - 1];

/** The typical year at a point, from the edge cache or NASA POWER. */
export async function climateAt(lng, lat, { ctx = null, fetchImpl = fetch, now = new Date() } = {}) {
  const rl = Math.round(lng * 20) / 20, ra = Math.round(lat * 20) / 20;
  const [y0, y1] = climateYears(now);
  const cache = globalThis.caches?.default;
  const key = new Request(`https://shade.lawnmapper.internal/climate-v1/${ra},${rl},${y0}-${y1}.json`);
  const hit = cache && await cache.match(key);
  if (hit) return hit.json();
  const res = await fetchImpl(powerUrl(rl, ra, y0, y1));
  if (!res.ok) throw new Error(`NASA POWER: ${res.status}`);
  const power = await res.json();
  const t = typicalYear(power);
  const round = (a, d) => a.map((v) => Math.round(v * 10 ** d) / 10 ** d);
  const body = {
    lng: rl, lat: ra, years: `${y0}-${y1}`, nYears: t.years,
    source: 'NASA POWER daily (MERRA-2, CERES SYN1deg), community AG',
    ghi: round(t.ghi, 2), ghiP10: round(t.ghiP10, 2), ghiP90: round(t.ghiP90, 2),
    diffuse: round(t.diffuse, 3), tMean: round(t.tMean, 1),
  };
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${30 * DAY}` },
    }));
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return body;
}
