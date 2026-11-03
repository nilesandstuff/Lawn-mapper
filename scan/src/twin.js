/**
 * THE WALKS' TWINS, KEPT ON THE SITE (core session, 2026-11-03; owner: "Can you start saving the outputs of the
 * digital twin that is being constructed? I want to see how it lines up with reality."). What scan/lib/twin.js
 * makes -- the phone's depth points, its track, its camera pictures, the fixes -- in the scan Worker's own R2
 * bucket (env.TWIN, made by scan/tools/r2.mjs), under twins/<walk>/<part>:
 *
 *   PUT    /api/scan/twin?walk=&part=   one part (binary or JSON), replaced when sent again
 *   GET    /api/scan/twin?walk=         the walk's parts and sizes; &part= one part
 *   GET    /api/scan/twins              the walks that have a twin, newest first
 *   DELETE /api/scan/twin?walk=         the walk's twin, all of it
 *
 * The admin only, every method. Never printed by any workflow: a twin holds yard pictures and the yard's shape.
 */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const MAX_PART = 8 * 1024 * 1024;
export const PART = /^(meta|live|end|splat)\.json$|^(cloud|track)-\d{4}\.bin$|^keys-\d{4}\.json$|^key-\d{4}\.jpg$|^splat\.splat$|^splat-compare\.jpg$/;
export const WALK = /^[0-9a-zA-Z_-]{1,40}$/;
const TYPES = { json: 'application/json', bin: 'application/octet-stream', jpg: 'image/jpeg' };
export const typeOf = (part) => TYPES[part.split('.').pop()] || 'application/octet-stream';
export const keyOf = (walk, part) => `twins/${walk}/${part}`;

/** A part's name and walk, checked. -> { walk, part } or { error } */
export function checkPart(walk, part) {
  if (!WALK.test(walk || '')) return { error: 'which walk?' };
  if (part != null && !PART.test(part)) return { error: 'not a twin part' };
  return { walk, part };
}

/** Text parts hold no degrees and no address (the same rule as a walk's results). */
export const leaks = (text) => /"(lng|lat|latitude|longitude|address)"/.test(text);

export async function twin(request, env, url, { isAdmin }) {
  const p = url.pathname;
  if (p !== '/api/scan/twin' && p !== '/api/scan/twins') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.TWIN) return json({ error: 'no-bucket', note: 'the twin bucket is not set up yet' }, 503);
  if (p === '/api/scan/twins') {
    if (request.method !== 'GET') return json({ error: 'method' }, 405);
    const walks = new Map();
    let cursor;
    do {
      const page = await env.TWIN.list({ prefix: 'twins/', cursor, limit: 1000 });
      for (const o of page.objects) {
        const w = o.key.split('/')[1];
        const x = walks.get(w) || { walk: w, parts: 0, bytes: 0, keys: 0, uploaded: 0 };
        x.parts++; x.bytes += o.size; if (/\/key-\d+\.jpg$/.test(o.key)) x.keys++;
        x.uploaded = Math.max(x.uploaded, Date.parse(o.uploaded) || 0);
        walks.set(w, x);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ twins: [...walks.values()].sort((a, b) => b.uploaded - a.uploaded) });
  }
  const { walk, part, error } = checkPart(url.searchParams.get('walk'), url.searchParams.get('part'));
  if (error) return json({ error }, 400);
  if (request.method === 'PUT') {
    if (!part) return json({ error: 'which part?' }, 400);
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_PART) return json({ error: `a part is at most ${MAX_PART} bytes` }, 413);
    if (part.endsWith('.json') && leaks(new TextDecoder().decode(body))) return json({ error: 'a twin holds no coordinates in degrees or addresses' }, 400);
    await env.TWIN.put(keyOf(walk, part), body, { httpMetadata: { contentType: typeOf(part) } });
    return json({ ok: true, walk, part, bytes: body.byteLength });
  }
  if (request.method === 'GET') {
    if (part) {
      const o = await env.TWIN.get(keyOf(walk, part));
      if (!o) return json({ error: 'Not found' }, 404);
      return new Response(o.body, { headers: { 'Content-Type': typeOf(part), 'Cache-Control': 'private, max-age=3600' } });
    }
    const parts = [];
    let cursor;
    do {
      const page = await env.TWIN.list({ prefix: `twins/${walk}/`, cursor, limit: 1000 });
      for (const o of page.objects) parts.push({ name: o.key.slice(`twins/${walk}/`.length), bytes: o.size });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ walk, parts });
  }
  if (request.method === 'DELETE') {
    let cursor, n = 0;
    do {
      const page = await env.TWIN.list({ prefix: `twins/${walk}/`, cursor, limit: 1000 });
      if (page.objects.length) { await env.TWIN.delete(page.objects.map((o) => o.key)); n += page.objects.length; }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ ok: true, deleted: n });
  }
  return json({ error: 'method' }, 405);
}
