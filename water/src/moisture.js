/**
 * SOIL MOISTURE READINGS (water session; owner, 2026-11-02: "I tap a location button, it pulls my gps to see which
 * property I'm at... tap a dot, then it prompts me for the reading... Then I save it... Then later we can run the
 * simulation and see how it holds up"). The page is /moisture (public/moisture.html), the admin only; the readings
 * live in the water Worker's own D1 (water/schema.sql: moisture_visits, moisture_readings).
 *
 *   POST   /api/water/moisture          a visit, its readings and its marks (tree trunks); saving the same visit id again replaces it
 *   GET    /api/water/moisture?pin=     the visits on one property (its county parcel number), oldest first
 *   GET    /api/water/moisture          every visit (?format=csv: every reading, for a spreadsheet)
 *   GET    /api/water/moisture?map=     the visits made on one saved map, oldest first (the water map's check)
 *   DELETE /api/water/moisture?id=      one visit and its readings
 *   POST   /api/water/moisture/check    the water map's check of the model against a visit: numbers only
 *   GET    /api/water/moisture/export   every visit with its readings, to the water session's sandbox (owner,
 *                                       2026-11-04: "I'm permitting you to let the data pass outside the sandbox"),
 *                                       read-only, with the header X-Export-Key: a key only that session holds; the
 *                                       repository has its SHA-256 and a date it stops working, never the key
 *
 * No street or house number is kept: the parcel number and the points.
 */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const num = (v, lo, hi) => { const x = Number(v); return v !== null && v !== '' && Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
const txt = (v, n = 120) => (v == null || v === '' ? null : String(v).slice(0, n));
const UNITS = ['vwc', 'scale', 'other'];

export const VISIT_COLS = ['id', 'at', 'saved', 'lng', 'lat', 'parcel_pin', 'county', 'map_id', 'meter', 'unit', 'depth_in', 'note', 'weather', 'placed_on'];
export const READING_COLS = ['id', 'visit_id', 'n', 'spot', 'at', 'lng', 'lat', 'value', 'note'];
export const MARK_COLS = ['id', 'visit_id', 'n', 'kind', 'lng', 'lat', 'note'];
const MARK_KINDS = ['trunk'];

/** A posted visit, checked. -> { visit, readings } or { error } */
export function cleanVisit(b, now = Date.now()) {
  if (!b || typeof b !== 'object') return { error: 'no visit' };
  const id = txt(b.id, 64);
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return { error: 'a visit needs an id' };
  if (!Array.isArray(b.readings) || !b.readings.length) return { error: 'no readings' };
  if (b.readings.length > 500) return { error: 'at most 500 readings a visit' };
  const unit = UNITS.includes(b.unit) ? b.unit : 'other';
  const visit = {
    id, at: num(b.at, 1.5e12, now + 864e5) ?? now, saved: now,
    lng: num(b.lng, -180, 180), lat: num(b.lat, -90, 90),
    parcel_pin: txt(b.parcel_pin, 64), county: txt(b.county, 64), map_id: txt(b.map_id, 64),
    meter: txt(b.meter, 80), unit, depth_in: num(b.depth_in, 0, 48), note: txt(b.note, 2000),
    weather: b.weather ? txt(JSON.stringify(b.weather), 4000) : null,
    placed_on: txt(b.placed_on, 40), // the photo the dots were put on: 'county:<svc>' (the one the lawn was traced on) or 'mapbox'
  };
  const readings = [];
  for (const [k, r] of b.readings.entries()) {
    const lng = num(r?.lng, -180, 180), lat = num(r?.lat, -90, 90), value = num(r?.value, -1000, 100000);
    if (lng === null || lat === null || value === null) return { error: `reading ${k + 1}: needs a place and a number` };
    if (unit === 'vwc' && (value < 0 || value > 100)) return { error: `reading ${k + 1}: ${value}% is not a soil moisture` };
    readings.push({ id: `${id}:${k + 1}`, visit_id: id, n: num(r.n, 0, 100000) ?? k + 1, spot: txt(r.spot, 64), at: num(r.at, 1.5e12, now + 864e5) ?? now, lng, lat, value, note: txt(r.note, 500) });
  }
  // marks (2026-11-04): tree trunks the visitor stood at, ground truth for the water map's trunk finder (lib/trunks.js)
  const marks = [];
  for (const [k, m] of (Array.isArray(b.marks) ? b.marks.slice(0, 200) : []).entries()) {
    const lng = num(m?.lng, -180, 180), lat = num(m?.lat, -90, 90);
    if (lng === null || lat === null) continue;
    marks.push({ id: `${id}:m${k + 1}`, visit_id: id, n: k + 1, kind: MARK_KINDS.includes(m.kind) ? m.kind : 'trunk', lng, lat, note: txt(m.note, 200) });
  }
  return { visit, readings, marks };
}

/** The marks of these visits (none when the table is not there yet). */
async function marksOf(env, ids) {
  const out = [];
  try {
    for (let k = 0; k < ids.length; k += 90) {
      const part = ids.slice(k, k + 90);
      out.push(...((await env.DB.prepare(`SELECT * FROM moisture_marks WHERE visit_id IN (${part.map(() => '?').join(', ')}) ORDER BY n`).bind(...part).all()).results || []));
    }
  } catch { /* no marks table yet */ }
  return out;
}

/** A posted check, kept to numbers: anything that could place a spot (a point, a map id, a note) is dropped. */
export function cleanCheck(b) {
  if (!b || typeof b !== 'object') return { error: 'no check' };
  const visit_id = txt(b.visit_id, 64);
  if (!visit_id || !/^[A-Za-z0-9-]{8,64}$/.test(visit_id)) return { error: 'which visit?' };
  const spots = (Array.isArray(b.spots) ? b.spots : []).slice(0, 500).map((s) => ({
    n: num(s?.n, 0, 100000), value: num(s?.value, -1000, 100000), wet: num(s?.wet, -10, 100), zone: num(s?.zone, -1, 1000),
    kind: num(s?.kind, 0, 50), need: num(s?.need, 0, 10000), tree: num(s?.tree, 0, 1), sun: num(s?.sun, 0, 1),
    lawn: num(s?.lawn, 0, 1), off: num(s?.off, 0, 10000), cells: num(s?.cells, 0, 10000),
  }));
  const settings = {};
  for (const k of ['date', 'depth_in', 'rootMm', 'season', 'irrigated', 'onTraceM', 'nearM']) if (b.settings && b.settings[k] != null) settings[k] = typeof b.settings[k] === 'number' ? b.settings[k] : txt(String(b.settings[k]), 40);
  return { visit_id, rho: num(b.rho, -1, 1), n: num(b.n, 0, 500), detail: JSON.stringify({ spots, settings }) };
}

/** Every reading as CSV, with its visit's columns. */
export function toCsv(rows) {
  const cols = ['visit_id', 'visit_at', 'parcel_pin', 'county', 'map_id', 'meter', 'unit', 'depth_in', 'placed_on', 'n', 'spot', 'at', 'lng', 'lat', 'value', 'note'];
  const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const when = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : v);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(c === 'at' || c === 'visit_at' ? when(r[c]) : r[c])).join(','))].join('\n');
}

export const EXPORT_KEY_SHA256 = 'eefe21c55f4eceb9254875aadfd979ef3e65cde2d77ce7ff5ee4addefdcba81b';
export const EXPORT_UNTIL = Date.parse('2026-12-05T00:00:00Z');

/** Does the request carry the export key, before its date? */
export async function exportKeyOk(request, now = Date.now()) {
  const key = request.headers.get('X-Export-Key');
  if (!key || key.length > 200 || now >= EXPORT_UNTIL) return false;
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= h.charCodeAt(i) ^ EXPORT_KEY_SHA256.charCodeAt(i);
  return diff === 0;
}

/** The routes, or null when the request is not one of them. isAdmin(request, env) -> bool. */
export async function moisture(request, env, url, { isAdmin }) {
  if (url.pathname === '/api/water/moisture/export') {
    if (request.method !== 'GET' || !(await exportKeyOk(request))) return json({ error: 'Not found' }, 404);
    if (!env.DB) return json({ error: 'no-database' }, 503);
    const visits = (await env.DB.prepare('SELECT * FROM moisture_visits ORDER BY at').all()).results || [];
    const rows = (await env.DB.prepare('SELECT * FROM moisture_readings ORDER BY visit_id, n').all()).results || [];
    let checks = [];
    try { checks = (await env.DB.prepare('SELECT * FROM moisture_checks').all()).results || []; } catch { /* none yet */ }
    const by = new Map(visits.map((v) => [v.id, { ...v, weather: v.weather ? JSON.parse(v.weather) : null, readings: [], marks: [] }]));
    for (const r of rows) by.get(r.visit_id)?.readings.push(r);
    for (const m of await marksOf(env, visits.map((v) => v.id))) by.get(m.visit_id)?.marks.push(m);
    return json({ visits: [...by.values()], checks });
  }
  if (url.pathname !== '/api/water/moisture' && url.pathname !== '/api/water/moisture/check') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.DB) return json({ error: 'no-database', note: 'the water database is not set up yet' }, 503);
  if (url.pathname === '/api/water/moisture/check') {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    let body = null;
    try { body = await request.json(); } catch { /* below */ }
    const c = cleanCheck(body);
    if (c.error) return json({ error: c.error }, 400);
    await env.DB.prepare('INSERT OR REPLACE INTO moisture_checks (visit_id, checked, rho, n, detail) VALUES (?, ?, ?, ?, ?)').bind(c.visit_id, Date.now(), c.rho, c.n, c.detail).run();
    return json({ ok: true });
  }
  if (request.method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch { /* below */ }
    const { visit, readings, marks, error } = cleanVisit(body);
    if (error) return json({ error }, 400);
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO moisture_visits (${VISIT_COLS.join(', ')}) VALUES (${VISIT_COLS.map(() => '?').join(', ')})`).bind(...VISIT_COLS.map((c) => visit[c])),
      env.DB.prepare('DELETE FROM moisture_readings WHERE visit_id = ?').bind(visit.id),
      ...readings.map((r) => env.DB.prepare(`INSERT INTO moisture_readings (${READING_COLS.join(', ')}) VALUES (${READING_COLS.map(() => '?').join(', ')})`).bind(...READING_COLS.map((c) => r[c]))),
      env.DB.prepare('DELETE FROM moisture_marks WHERE visit_id = ?').bind(visit.id),
      ...marks.map((m) => env.DB.prepare(`INSERT INTO moisture_marks (${MARK_COLS.join(', ')}) VALUES (${MARK_COLS.map(() => '?').join(', ')})`).bind(...MARK_COLS.map((c) => m[c]))),
    ]);
    return json({ ok: true, id: visit.id, readings: readings.length, marks: marks.length });
  }
  if (request.method === 'GET') {
    const pin = url.searchParams.get('pin'), map = url.searchParams.get('map');
    if (url.searchParams.get('format') === 'csv') {
      const { results } = await env.DB.prepare('SELECT r.*, v.at AS visit_at, v.parcel_pin, v.county, v.map_id, v.meter, v.unit, v.depth_in, v.placed_on FROM moisture_readings r JOIN moisture_visits v ON v.id = r.visit_id ORDER BY v.at, r.n').all();
      return new Response(toCsv(results || []), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="soil-moisture-readings.csv"', 'Cache-Control': 'no-store' } });
    }
    const visits = pin
      ? (await env.DB.prepare('SELECT * FROM moisture_visits WHERE parcel_pin = ? ORDER BY at').bind(pin).all()).results || []
      : map ? (await env.DB.prepare('SELECT * FROM moisture_visits WHERE map_id = ? ORDER BY at').bind(map).all()).results || []
      : (await env.DB.prepare('SELECT * FROM moisture_visits ORDER BY at DESC LIMIT 500').all()).results || [];
    if (!visits.length) return json({ visits: [] });
    const ids = visits.map((v) => v.id);
    const rows = [];
    for (let k = 0; k < ids.length; k += 90) {
      const part = ids.slice(k, k + 90);
      rows.push(...((await env.DB.prepare(`SELECT * FROM moisture_readings WHERE visit_id IN (${part.map(() => '?').join(', ')}) ORDER BY n`).bind(...part).all()).results || []));
    }
    const by = new Map(visits.map((v) => [v.id, { ...v, weather: v.weather ? JSON.parse(v.weather) : null, readings: [], marks: [] }]));
    for (const r of rows) by.get(r.visit_id)?.readings.push(r);
    for (const m of await marksOf(env, ids)) by.get(m.visit_id)?.marks.push(m);
    return json({ visits: [...by.values()] });
  }
  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'which visit?' }, 400);
    await env.DB.batch([env.DB.prepare('DELETE FROM moisture_readings WHERE visit_id = ?').bind(id), env.DB.prepare('DELETE FROM moisture_marks WHERE visit_id = ?').bind(id), env.DB.prepare('DELETE FROM moisture_visits WHERE id = ?').bind(id)]);
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
}
