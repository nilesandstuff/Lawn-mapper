/**
 * SOIL MOISTURE READINGS (water session; owner, 2026-11-02: "I tap a location button, it pulls my gps to see which
 * property I'm at... tap a dot, then it prompts me for the reading... Then I save it... Then later we can run the
 * simulation and see how it holds up"). The page is /moisture (public/moisture.html), the admin only; the readings
 * live in the water Worker's own D1 (water/schema.sql: moisture_visits, moisture_readings).
 *
 *   POST   /api/water/moisture          a visit and its readings; saving the same visit id again replaces it
 *   GET    /api/water/moisture?pin=     the visits on one property (its county parcel number), oldest first
 *   GET    /api/water/moisture          every visit (?format=csv: every reading, for a spreadsheet)
 *   DELETE /api/water/moisture?id=      one visit and its readings
 *
 * No street or house number is kept: the parcel number and the points.
 */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const num = (v, lo, hi) => { const x = Number(v); return v !== null && v !== '' && Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
const txt = (v, n = 120) => (v == null || v === '' ? null : String(v).slice(0, n));
const UNITS = ['vwc', 'scale', 'other'];

export const VISIT_COLS = ['id', 'at', 'saved', 'lng', 'lat', 'parcel_pin', 'county', 'map_id', 'meter', 'unit', 'depth_in', 'note', 'weather'];
export const READING_COLS = ['id', 'visit_id', 'n', 'spot', 'at', 'lng', 'lat', 'value', 'note'];

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
  };
  const readings = [];
  for (const [k, r] of b.readings.entries()) {
    const lng = num(r?.lng, -180, 180), lat = num(r?.lat, -90, 90), value = num(r?.value, -1000, 100000);
    if (lng === null || lat === null || value === null) return { error: `reading ${k + 1}: needs a place and a number` };
    if (unit === 'vwc' && (value < 0 || value > 100)) return { error: `reading ${k + 1}: ${value}% is not a soil moisture` };
    readings.push({ id: `${id}:${k + 1}`, visit_id: id, n: num(r.n, 0, 100000) ?? k + 1, spot: txt(r.spot, 64), at: num(r.at, 1.5e12, now + 864e5) ?? now, lng, lat, value, note: txt(r.note, 500) });
  }
  return { visit, readings };
}

/** Every reading as CSV, with its visit's columns. */
export function toCsv(rows) {
  const cols = ['visit_id', 'visit_at', 'parcel_pin', 'county', 'map_id', 'meter', 'unit', 'depth_in', 'n', 'spot', 'at', 'lng', 'lat', 'value', 'note'];
  const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const when = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : v);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(c === 'at' || c === 'visit_at' ? when(r[c]) : r[c])).join(','))].join('\n');
}

/** The routes, or null when the request is not one of them. isAdmin(request, env) -> bool. */
export async function moisture(request, env, url, { isAdmin }) {
  if (url.pathname !== '/api/water/moisture') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.DB) return json({ error: 'no-database', note: 'the water database is not set up yet' }, 503);
  if (request.method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch { /* below */ }
    const { visit, readings, error } = cleanVisit(body);
    if (error) return json({ error }, 400);
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO moisture_visits (${VISIT_COLS.join(', ')}) VALUES (${VISIT_COLS.map(() => '?').join(', ')})`).bind(...VISIT_COLS.map((c) => visit[c])),
      env.DB.prepare('DELETE FROM moisture_readings WHERE visit_id = ?').bind(visit.id),
      ...readings.map((r) => env.DB.prepare(`INSERT INTO moisture_readings (${READING_COLS.join(', ')}) VALUES (${READING_COLS.map(() => '?').join(', ')})`).bind(...READING_COLS.map((c) => r[c]))),
    ]);
    return json({ ok: true, id: visit.id, readings: readings.length });
  }
  if (request.method === 'GET') {
    const pin = url.searchParams.get('pin');
    if (url.searchParams.get('format') === 'csv') {
      const { results } = await env.DB.prepare('SELECT r.*, v.at AS visit_at, v.parcel_pin, v.county, v.map_id, v.meter, v.unit, v.depth_in FROM moisture_readings r JOIN moisture_visits v ON v.id = r.visit_id ORDER BY v.at, r.n').all();
      return new Response(toCsv(results || []), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="soil-moisture-readings.csv"', 'Cache-Control': 'no-store' } });
    }
    const visits = pin
      ? (await env.DB.prepare('SELECT * FROM moisture_visits WHERE parcel_pin = ? ORDER BY at').bind(pin).all()).results || []
      : (await env.DB.prepare('SELECT * FROM moisture_visits ORDER BY at DESC LIMIT 500').all()).results || [];
    if (!visits.length) return json({ visits: [] });
    const ids = visits.map((v) => v.id);
    const rows = [];
    for (let k = 0; k < ids.length; k += 90) {
      const part = ids.slice(k, k + 90);
      rows.push(...((await env.DB.prepare(`SELECT * FROM moisture_readings WHERE visit_id IN (${part.map(() => '?').join(', ')}) ORDER BY n`).bind(...part).all()).results || []));
    }
    const by = new Map(visits.map((v) => [v.id, { ...v, weather: v.weather ? JSON.parse(v.weather) : null, readings: [] }]));
    for (const r of rows) by.get(r.visit_id)?.readings.push(r);
    return json({ visits: [...by.values()] });
  }
  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'which visit?' }, 400);
    await env.DB.batch([env.DB.prepare('DELETE FROM moisture_readings WHERE visit_id = ?').bind(id), env.DB.prepare('DELETE FROM moisture_visits WHERE id = ?').bind(id)]);
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
}
