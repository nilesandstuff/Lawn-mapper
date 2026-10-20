/**
 * GAUGE READINGS (water session; owner, 2026-10-20: "add a place to enter gauge readings... Both in the live
 * app, to override estimates, and in the back end to provide ground truth"). The water Worker's own D1
 * (env.DB, water/schema.sql):
 *
 *   POST   /api/water/readings        a reading with what was predicted there (any signed-in visitor; while the
 *                                     site is admin only, the admin)
 *   GET    /api/water/readings        every reading, newest first (admin); ?format=csv for a spreadsheet
 *   DELETE /api/water/readings?id=    one taken off (admin)
 *   GET    /admin                     the water tool's admin page (admin): the readings against the model
 *
 * No addresses are kept: a map's id, never its street.
 */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const NUM = ['zone', 'measured_psi', 'predicted_psi', 'predicted_inlet_psi', 'predicted_nozzle_psi', 'head_gpm', 'zone_gpm', 'source_psi', 'rise_ft'];
const TXT = ['map_id', 'head_id', 'method', 'body', 'nozzle', 'kind', 'source_read', 'source_from'];
export const COLUMNS = ['id', 'at', ...TXT, ...NUM, 'typical_pvb', 'typical_valve', 'detail'];

/** A posted reading, checked and cut to the columns. -> { row } or { error } */
export function cleanReading(b, now = Date.now(), id = crypto.randomUUID()) {
  if (!b || typeof b !== 'object') return { error: 'no reading' };
  const m = Number(b.measured_psi);
  if (!Number.isFinite(m) || m < 0 || m > 200) return { error: 'measured_psi must be 0-200' };
  if (!['pitot', 'riser'].includes(b.method)) return { error: "method must be 'pitot' or 'riser'" };
  const row = { id, at: now };
  for (const k of TXT) row[k] = b[k] == null ? null : String(b[k]).slice(0, 120);
  for (const k of NUM) row[k] = Number.isFinite(Number(b[k])) && b[k] !== null && b[k] !== '' ? Number(b[k]) : null;
  row.measured_psi = m;
  row.typical_pvb = b.typical_pvb ? 1 : 0;
  row.typical_valve = b.typical_valve ? 1 : 0;
  const detail = b.detail ? JSON.stringify(b.detail) : null;
  row.detail = detail && detail.length <= 20000 ? detail : null;
  return { row };
}

/** The readings as CSV. */
export function toCsv(rows) {
  const cols = COLUMNS.filter((c) => c !== 'detail');
  const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(','))].join('\n');
}

/** Who is asking, from Lawn Mapper with the visitor's cookie: { user } or null. */
async function me(request, env) {
  if (!env.LAWNMAP || !env.LAWNMAP_HOST) return null;
  try {
    const res = await env.LAWNMAP.fetch(new Request(`https://${env.LAWNMAP_HOST}/api/auth/me`, { headers: { Cookie: request.headers.get('Cookie') || '', Accept: 'application/json' } }));
    return res.ok ? (await res.json())?.user || null : null;
  } catch { return null; }
}

/** The readings routes, or null when the request is not one of them. isAdmin(request) -> bool. */
export async function readings(request, env, url, { isAdmin, who = me } = {}) {
  if (url.pathname !== '/api/water/readings') return null;
  if (!env.DB) return json({ error: 'no-database', note: 'the water database is not set up yet' }, 503);
  if (request.method === 'POST') {
    const user = await who(request, env);
    if (!user) return json({ error: 'sign in to keep a reading' }, 401);
    let body = null;
    try { body = await request.json(); } catch { /* below */ }
    const { row, error } = cleanReading(body);
    if (error) return json({ error }, 400);
    await env.DB.prepare(`INSERT INTO readings (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`).bind(...COLUMNS.map((c) => row[c])).run();
    return json({ ok: true, id: row.id });
  }
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM readings ORDER BY at DESC LIMIT 5000').all();
    if (url.searchParams.get('format') === 'csv') return new Response(toCsv(results || []), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="water-gauge-readings.csv"', 'Cache-Control': 'no-store' } });
    return json({ readings: results || [] });
  }
  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'which reading?' }, 400);
    await env.DB.prepare('DELETE FROM readings WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
}
