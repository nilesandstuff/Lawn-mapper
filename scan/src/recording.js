/**
 * A WALK'S ARCORE RECORDING, FOR REPLAY (core session, 2026-11-08; the owner: "let's do it so I don't have to keep
 * doing the same walks over and over"). The app records ARCore's own input -- the camera, the motion sensors, the
 * Geospatial readings -- to an MP4 while it walks (ARCore Recording & Playback), sends it here in pieces, and can
 * fetch it back to run the walk again through ARCore and the page, as though it were walked again. Kept beside the
 * walk's twin in the private bucket, as twins/<walk>/recording.mp4.
 *
 *   POST /api/scan/recording/start?walk=           -> { upload }          (an R2 multipart upload)
 *   PUT  /api/scan/recording/part?walk=&upload=&n=  one piece (PIECE bytes, the last one fewer) -> { n, etag }
 *   POST /api/scan/recording/done?walk=&upload=     body { parts: [{ n, etag }] } -> { ok, bytes }
 *   GET  /api/scan/recording?walk=                  the MP4
 *   GET  /api/scan/recordings                       the walks that have one, newest first: [{ walk, bytes, at }]
 *
 * The admin only, every method (the app sends the page's own sign-in cookie). Never printed by any workflow: the
 * recording is the yard on video, with its Geospatial position.
 */
import { WALK } from './twin.js';

export const PIECE = 8 * 1024 * 1024;   // R2: every piece but the last the same size, 5 MiB at least
export const NAME = 'recording.mp4';
export const keyOf = (walk) => `twins/${walk}/${NAME}`;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function recording(request, env, url, { isAdmin }) {
  const p = url.pathname;
  if (p !== '/api/scan/recordings' && p !== '/api/scan/recording' && !p.startsWith('/api/scan/recording/')) return null;
  if (!(await isAdmin(request, env))) return json({ error: 'Not found' }, 404);
  if (!env.TWIN) return json({ error: 'no-bucket' }, 503);
  if (p === '/api/scan/recordings') {
    const out = [];
    let cursor;
    do {
      const page = await env.TWIN.list({ prefix: 'twins/', cursor, limit: 1000 });
      for (const o of page.objects) if (o.key.endsWith(`/${NAME}`)) out.push({ walk: o.key.split('/')[1], bytes: o.size, at: o.uploaded });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ recordings: out.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)) });
  }
  const walk = url.searchParams.get('walk');
  if (!WALK.test(walk || '')) return json({ error: 'which walk?' }, 400);
  const key = keyOf(walk);
  if (p === '/api/scan/recording') {
    if (request.method !== 'GET') return json({ error: 'method' }, 405);
    const o = await env.TWIN.get(key);
    if (!o) return json({ error: 'Not found' }, 404);
    return new Response(o.body, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(o.size ?? ''), 'Cache-Control': 'private, no-store' } });
  }
  const upload = url.searchParams.get('upload');
  if (p === '/api/scan/recording/start' && request.method === 'POST') {
    const mp = await env.TWIN.createMultipartUpload(key, { httpMetadata: { contentType: 'video/mp4' } });
    return json({ upload: mp.uploadId, piece: PIECE });
  }
  if (!upload) return json({ error: 'which upload?' }, 400);
  const mp = env.TWIN.resumeMultipartUpload(key, upload);
  if (p === '/api/scan/recording/part' && request.method === 'PUT') {
    const n = Number(url.searchParams.get('n'));
    if (!Number.isInteger(n) || n < 1 || n > 10000) return json({ error: 'which piece?' }, 400);
    const body = await request.arrayBuffer();
    if (body.byteLength > PIECE) return json({ error: `a piece is at most ${PIECE} bytes` }, 413);
    // an upload R2 no longer knows (expired, or finished) answers 404: the app starts that recording afresh
    try { const part = await mp.uploadPart(n, body); return json({ n, etag: part.etag }); } catch (e) { return json({ error: 'no such upload', detail: String(e?.message || e).slice(0, 120) }, 404); }
  }
  if (p === '/api/scan/recording/done' && request.method === 'POST') {
    const b = await request.json().catch(() => null);
    const parts = (b?.parts || []).filter((x) => Number.isInteger(x?.n) && typeof x?.etag === 'string').sort((a, c) => a.n - c.n).map((x) => ({ partNumber: x.n, etag: x.etag }));
    if (!parts.length) return json({ error: 'no pieces' }, 400);
    try { const o = await mp.complete(parts); return json({ ok: true, walk, bytes: o?.size ?? null }); } catch (e) { return json({ error: 'no such upload', detail: String(e?.message || e).slice(0, 120) }, 404); }
  }
  return json({ error: 'method' }, 405);
}
