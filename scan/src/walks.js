/**
 * THE WALKS, KEPT ON THE SITE (owner, 2026-11-01: "save logs for the admin page so I don't need to copy and
 * paste them"). The scan Worker's own D1 (env.DB, scan/schema.sql):
 *
 *   POST   /api/scan/walks        a walk's results as the page makes them (scan/lib/walk.js summary): kept by its
 *                                 id, replaced when posted again (a taped distance typed later)
 *   GET    /api/scan/walks        the walks, newest first; ?id= one walk's results
 *   DELETE /api/scan/walks?id=    one taken off
 *
 * The admin only, every method. What is kept is what the page copies: distances and counts, no positions, no
 * addresses. Workflow "S. Yard AR tool", task `walks`, prints them to its log (scan/tools/walks.mjs).
 */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const MAX_JSON = 200000;
const ENGINES = new Set(['webxr', '8thwall', 'native']); // native: the Android app (android/, 2026-11-07)

/** A posted walk, checked. -> { row } or { error } */
export function cleanWalk(b, now = Date.now()) {
  if (!b || typeof b !== 'object') return { error: 'no walk' };
  const id = String(b.id || '').trim();
  if (!/^[0-9a-zA-Z_-]{1,40}$/.test(id)) return { error: 'a walk needs an id' };
  if (!ENGINES.has(b.engine)) return { error: 'engine must be webxr, 8thwall or native' };
  const text = JSON.stringify(b);
  if (text.length > MAX_JSON) return { error: `a walk is at most ${MAX_JSON} bytes of JSON` };
  if (/"(lng|lat|latitude|longitude|address)"/.test(text)) return { error: 'a walk holds no coordinates or addresses' };
  const at = Date.parse(b.when);
  return { row: { id, at: Number.isFinite(at) ? at : now, engine: b.engine, phone: String(b.phone || '').slice(0, 200), json: text } };
}

/** The walks routes, or null when the request is not one of them. */
export async function walks(request, env, url, { isAdmin }) {
  if (url.pathname !== '/api/scan/walks') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.DB) return json({ error: 'no-database', note: 'the scan database is not set up yet' }, 503);
  if (request.method === 'POST') {
    let body = null;
    try { body = await request.json(); } catch { /* below */ }
    const { row, error } = cleanWalk(body);
    if (error) return json({ error }, 400);
    await env.DB.prepare('INSERT OR REPLACE INTO walks (id, at, engine, phone, json) VALUES (?, ?, ?, ?, ?)').bind(row.id, row.at, row.engine, row.phone, row.json).run();
    return json({ ok: true, id: row.id });
  }
  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (id) {
      const row = await env.DB.prepare('SELECT json FROM walks WHERE id = ?').bind(id).first();
      return row ? new Response(row.json, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({ error: 'Not found' }, 404);
    }
    const { results } = await env.DB.prepare('SELECT id, at, engine, phone, json FROM walks ORDER BY at DESC LIMIT 100').all();
    return json({ walks: (results || []).map((r) => { let s = null; try { s = JSON.parse(r.json); } catch { /* kept raw */ } return { id: r.id, at: r.at, engine: r.engine, phone: r.phone, summary: s }; }) });
  }
  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'which walk?' }, 400);
    await env.DB.prepare('DELETE FROM walks WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  return json({ error: 'method' }, 405);
}
