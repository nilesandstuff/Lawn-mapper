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
 *
 * Coordinates in degrees are allowed here (the owner, 2026-11-07: "I just didn't want the gps for my own house, or
 * work, in the very public github files"): the bucket is private and the tools that read it print counts only. The
 * walks' summaries (src/walks.js) still refuse them, because the walk listing prints those in public workflow logs.
 */

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const MAX_PART = 8 * 1024 * 1024;
export const PART = /^(meta|live|end|splat|fixed|inspect|consensus)\.json$|^inspect-points\.bin$|^(cloud|track|labels)-\d{4}\.bin$|^keys-\d{4}\.json$|^key-\d{4}\.(jpg|depth)$|^splat\.splat$|^splat-compare\.jpg$|^mesh\.bin$/;
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

/*
 * THE MAP'S REFERENCE WALK (core session, 2026-11-09; scan/lib/walkref.js, SCAN-H32): an earlier walk placed by its
 * marks, its points on the map, that places later walks by their shape. One per map, under refs/<map>.bin.
 *
 *   GET /api/scan/reference?map=   the reference (bytes), 404 when the map has none
 *   PUT /api/scan/reference?map=   a new one (scan/tools/reference-build.mjs writes it straight to the bucket too)
 *
 * The admin only, like the twins: it is the yard's shape.
 */
export const MAP = /^[0-9a-zA-Z_-]{1,64}$/;
/**
 * THE MAP'S PHOTO STRETCHED ONTO THE LIDAR (core session, 2026-11-10; docs/SCAN-PLAN.md section 17,
 * scan/tools/warp_study.py and warp-keep.mjs): warp.json and warped-<photo>.png, kept under refs/warp/<map>/ by the
 * study, read by the placement map. The admin only, like the reference. GET only: the study writes them through the
 * Cloudflare API.
 */
const WARP_FILE = /^(warp\.json|warped-[a-z]+\.png)$/;
export async function warp(request, env, url, { isAdmin }) {
  if (url.pathname !== '/api/scan/warp') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.TWIN) return json({ error: 'no-bucket' }, 503);
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  const map = url.searchParams.get('map') || '', file = url.searchParams.get('file') || '';
  if (!MAP.test(map) || !WARP_FILE.test(file)) return json({ error: 'which map and file?' }, 400);
  const o = await env.TWIN.get(`refs/warp/${map}/${file}`);
  if (!o) return json({ error: 'Not found' }, 404);
  return new Response(o.body, { headers: { 'Content-Type': file.endsWith('.json') ? 'application/json' : 'image/png', 'Cache-Control': 'private, no-store' } });
}

export const refKey = (map) => `refs/${map}.bin`;
export async function reference(request, env, url, { isAdmin }) {
  if (url.pathname !== '/api/scan/reference') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.TWIN) return json({ error: 'no-bucket' }, 503);
  const map = url.searchParams.get('map') || '';
  if (!MAP.test(map)) return json({ error: 'which map?' }, 400);
  if (request.method === 'GET') {
    const o = await env.TWIN.get(refKey(map));
    // said in its own words: the page takes only this for "none", and tries again on any other 404 (2026-11-10)
    if (!o) return json({ error: 'no reference' }, 404);
    return new Response(o.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Reference-Walk': o.customMetadata?.walk || '' } });
  }
  if (request.method === 'PUT') {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_PART) return json({ error: `at most ${MAX_PART} bytes` }, 413);
    await env.TWIN.put(refKey(map), body, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { walk: url.searchParams.get('walk') || '' } });
    return json({ ok: true, map, bytes: body.byteLength });
  }
  return json({ error: 'method' }, 405);
}
