/**
 * Handoffs from Route Reader, the Android helper (route session, 2026-11-19):
 * the pages it read, kept a day under a random id, for the planner to open.
 *
 *   POST /api/handoff { pages | images, width, app, ... }  -> { id }
 *   GET  /api/handoff/<id>                                -> what was sent
 *   GET  /api/handoff                                      the recent ones (route key): what went
 *                                                          wrong when a reading does not come out
 *
 * They hold customers' names and addresses: a day, the 20 newest, and the
 * id is the only key besides the route session's.
 */

import { keyed } from './store.js';
import { newId } from './share.js';

export const KEEP_SECONDS = 86400;
const MAX_BYTES = 20 * 1024 * 1024;
const KEEP = 20;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function handoff(request, env, url, now = Date.now()) {
  const kv = env.ROUTE;
  if (!kv) return json({ error: 'No storage on this deploy' }, 503);
  if (url.pathname === '/api/handoff' && request.method === 'POST') {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: 'Too much to send at once' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'Not JSON' }, 400); }
    const pages = Array.isArray(body.pages) ? body.pages : [];
    const images = Array.isArray(body.images) ? body.images : [];
    if (!pages.length && !images.length) return json({ error: 'Nothing was read' }, 400);
    const id = `${now.toString(36)}${newId(8)}`;
    await kv.put(`handoff:${id}`, text, {
      expirationTtl: KEEP_SECONDS,
      metadata: { at: now, app: String(body.app || '').slice(0, 80), pages: pages.length, images: images.length, version: String(body.version || '').slice(0, 20), device: String(body.device || '').slice(0, 60) },
    });
    const { keys } = await kv.list({ prefix: 'handoff:' });
    for (const k of keys.map((x) => x.name).sort().reverse().slice(KEEP)) await kv.delete(k);
    return json({ id }, 201);
  }
  if (url.pathname === '/api/handoff' && request.method === 'GET') {
    if (!(await keyed(request, env))) return json({ error: 'Not allowed' }, 403);
    const { keys } = await kv.list({ prefix: 'handoff:' });
    return json(keys.map((k) => ({ id: k.name.slice(8), ...(k.metadata || {}) })).sort((a, b) => b.at - a.at));
  }
  const id = url.pathname.match(/^\/api\/handoff\/([A-Za-z0-9]{8,40})$/)?.[1];
  if (id && request.method === 'GET') {
    const v = await kv.get(`handoff:${id}`);
    return v ? new Response(v, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({ error: 'This reading has expired' }, 404);
  }
  return json({ error: 'Not found' }, 404);
}
