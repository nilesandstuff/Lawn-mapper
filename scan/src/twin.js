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

import { decodeThings, encodeThings } from '../lib/things.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const MAX_PART = 8 * 1024 * 1024;
export const PART = /^(meta|live|end|splat|fixed|inspect|consensus|thermal-notes|thermal-placement|thermal-snap|view|seg|seg-names|mend|trunks|plants|plants-phone|start|owner-trunks)\.json$|^(inspect-points|view-rgb|view-kind|view-dense|view-mended|erased)\.bin$|^(cloud|track|labels|weak|weaklabels)-\d{4}\.bin$|^keys-\d{4}\.json$|^key-\d{4}\.(jpg|depth|sdepth|rdepth)$|^splat\.splat$|^splat-compare\.jpg$|^mesh\.bin$|^seg-\d{4}\.png$|^segments-[a-z-]{1,40}\.(png|jpg)$|^study-[a-z0-9]{1,24}(\.json|-[a-z0-9-]{1,60}\.(png|jpg))$/;
export const WALK = /^[0-9a-zA-Z_-]{1,40}$/;
const TYPES = { json: 'application/json', bin: 'application/octet-stream', jpg: 'image/jpeg', png: 'image/png' };
export const typeOf = (part) => TYPES[part.split('.').pop()] || 'application/octet-stream';
export const keyOf = (walk, part) => `twins/${walk}/${part}`;

/** A part's name and walk, checked. -> { walk, part } or { error } */
export function checkPart(walk, part) {
  if (!WALK.test(walk || '')) return { error: 'which walk?' };
  if (part != null && !PART.test(part)) return { error: 'not a twin part' };
  return { walk, part };
}


export async function twin(request, env, url, { isAdmin, noteThermal = null, noteSnap = null }) {
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
        // a study kept beside the walk (the segment trial's sheets, docs/SCAN-PLAN.md 30): the start page links to it
        if (/\/segments-[a-z-]+\.jpg$/.test(o.key)) x.segments = (x.segments || 0) + 1;
        if (/\/study-[a-z0-9]+\.json$/.test(o.key)) x.studies = (x.studies || 0) + 1;
        if (/\/seg\.json$/.test(o.key)) x.nameable = true;
        if (/\/view\.json$/.test(o.key)) x.viewable = true; // made ready for the 3D view (cloud.html)
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
    // dev only: a thermal walk's placement says which map it is of (thermal.js keeps that, for the water map)
    if (part === 'thermal-placement.json' && noteThermal) await noteThermal(env, walk, body);
    // dev only: a single thermal photo's notes, sent once its frames are whole (thermal-snap.js lists it)
    if (part === 'thermal-snap.json' && noteSnap) await noteSnap(env, walk, body);
    return json({ ok: true, walk, part, bytes: body.byteLength });
  }
  if (request.method === 'GET') {
    if (part) {
      const o = await env.TWIN.get(keyOf(walk, part));
      if (!o) return json({ error: 'Not found' }, 404);
      // a part that is made again (the 3D view's files, the erasing, the names, the studies) is never kept by the
      // browser: kept an hour, a walk prepared again was shown from its first file (2026-11-21)
      return new Response(o.body, { headers: { 'Content-Type': typeOf(part), 'Cache-Control': /^(view|erased|seg|study|judged|live|meta|mend|trunks|plants|owner-)/.test(part) ? 'private, no-store' : 'private, max-age=3600' } });
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
 *   GET /api/scan/reference?map=&meta=1   { walk, at, bytes } without the bytes, 404 when none
 *   PUT /api/scan/reference?map=&walk=   a new one (the page, at a walk's end; reference-build.mjs writes straight to
 *                                        the bucket too); the one it replaces goes to refs/backup/<map>-<when>.bin
 *
 * The admin only, like the twins: it is the yard's shape.
 */
/* A MAP'S ID (2026-11-16): letters, digits, _ and - up to 64 refused the owner's home map, an admin save whose id is 86
   characters with |, spaces and commas, so its walks' references were never sent ("could not be sent (no signal?)")
   nor read back at a walk's start. Anything without a control character or a slash (which would split the key); the
   key is refs/<id>.bin as written, as reference-build.mjs and warp-keep.mjs write it. Never printed. */
export const MAP = /^[^\x00-\x1f\x7f/]{1,256}$/;
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
/**
 * THE THINGS PLACED ON A MAP (core session, 2026-11-22; scan/lib/things.js): sprinkler heads, gutter tops and
 * outlets, each with its sightings, kept beside the map's reference as things/<map>.json. The page reads them at a
 * walk's start and writes the merged list at its end; the list it replaces is kept as a backup.
 *
 *   GET /api/scan/things?map=   { v: 1, things: [...] } (an empty list when the map has none)
 *   PUT /api/scan/things?map=   the whole list, at most 256 KB; anything that does not read as one is refused
 *
 * The admin only, like the reference. Places are the map's own metres, never degrees.
 */
export const thingsKey = (map) => `things/${map}.json`;
const MAX_THINGS_BYTES = 256 * 1024;
export async function things(request, env, url, { isAdmin }) {
  if (url.pathname !== '/api/scan/things') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.TWIN) return json({ error: 'no-bucket' }, 503);
  const map = url.searchParams.get('map') || '';
  if (!MAP.test(map)) return json({ error: 'which map?' }, 400);
  if (request.method === 'GET') {
    const o = await env.TWIN.get(thingsKey(map));
    const list = o ? decodeThings(await new Response(o.body).text()) : [];
    return new Response(encodeThings(list), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
  }
  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_THINGS_BYTES) return json({ error: `at most ${MAX_THINGS_BYTES} bytes` }, 413);
    let ok = false;
    try { const j = JSON.parse(text); ok = j && j.v === 1 && Array.isArray(j.things); } catch { ok = false; }
    if (!ok) return json({ error: 'not a list of things' }, 400);
    const list = decodeThings(text);
    try { const old = await env.TWIN.get(thingsKey(map)); if (old) await env.TWIN.put(`things/backup/${map}-${Date.now()}.json`, old.body); } catch { /* the new list is kept either way */ }
    await env.TWIN.put(thingsKey(map), encodeThings(list), { httpMetadata: { contentType: 'application/json' }, customMetadata: { walk: url.searchParams.get('walk') || '' } });
    return json({ ok: true, map, things: list.length });
  }
  return json({ error: 'method' }, 405);
}

/**
 * A WALK'S PLANTS ON THE MAP (core session, 2026-11-23; scan/tools/plants.py, plants-keep.mjs): plants/<map>.json,
 * written by the workflow, read here by the scan page when a map opens so it can put them into the scan tool's part
 * of the map's record. Read only; the admin only.
 *   GET /api/scan/plants?map=   the file, or { none: true }
 */
export async function plants(request, env, url, { isAdmin }) {
  if (url.pathname !== '/api/scan/plants') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.TWIN) return json({ error: 'no-bucket' }, 503);
  const map = url.searchParams.get('map') || '';
  if (!MAP.test(map)) return json({ error: 'which map?' }, 400);
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  const o = await env.TWIN.get(`plants/${map}.json`);
  if (!o) return json({ none: true });
  return new Response(o.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

export async function reference(request, env, url, { isAdmin }) {
  if (url.pathname !== '/api/scan/reference') return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.TWIN) return json({ error: 'no-bucket' }, 503);
  const map = url.searchParams.get('map') || '';
  if (!MAP.test(map)) return json({ error: 'which map?' }, 400);
  if (request.method === 'GET' && url.searchParams.get('meta')) {
    // is there one, and from when: for the choice at the start of a walk (the owner, 2026-11-11), without its bytes
    const h = await env.TWIN.head(refKey(map));
    if (!h) return json({ error: 'no reference' }, 404);
    return json({ ok: true, map, walk: h.customMetadata?.walk || '', at: h.uploaded ? new Date(h.uploaded).getTime() : null, bytes: h.size });
  }
  if (request.method === 'GET') {
    const o = await env.TWIN.get(refKey(map));
    // said in its own words: the page takes only this for "none", and tries again on any other 404 (2026-11-10)
    if (!o) return json({ error: 'no reference' }, 404);
    return new Response(o.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Reference-Walk': o.customMetadata?.walk || '' } });
  }
  if (request.method === 'PUT') {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_PART) return json({ error: `at most ${MAX_PART} bytes` }, 413);
    // the one it replaces is kept beside it (the owner, 2026-11-11: "Fresh" replaces the saved walk, the old one a backup)
    try { const old = await env.TWIN.get(refKey(map)); if (old) await env.TWIN.put(`refs/backup/${map}-${old.uploaded ? new Date(old.uploaded).getTime() : Date.now()}.bin`, old.body, { customMetadata: old.customMetadata || {} }); } catch { /* the new one is kept all the same */ }
    await env.TWIN.put(refKey(map), body, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { walk: url.searchParams.get('walk') || '' } });
    return json({ ok: true, map, bytes: body.byteLength });
  }
  return json({ error: 'method' }, 405);
}
