/**
 * THE PHOTO A SAVED MAP WAS TRACED ON, KEPT WITH THE MAP (core session, 2026-11-09). The owner, on the yard AR tool
 * falling back to Mapbox when a county photo could not be had: "If that's an issue that can potentially happen, then
 * that's a bug that needs addressing. The photo a map is traced on should be accessible indefinitely."
 *
 * Every tool that puts things on a map by eye (the yard AR tool's reference and check points first) needs the very
 * picture the outline was drawn on: a county service can move, change its photos or stop answering, and Mapbox
 * replaces its imagery. So the picture is taken once, when the map is saved, and kept beside the map's other files in
 * the bucket (unified.js modelKey: models/<kind>/<owner>/<sha256(map)>/photo.bin), never fetched again while the map
 * is saved on the same photo. It is taken again only when the map is saved on a different one (another service, a
 * new line-up, a new frame).
 *
 * What it is: the frame the editor saved, at the corpus's capture scale (imagery.js liveCaptureFrame: 10 cm a pixel
 * where one request reaches), as the editor SHOWED it -- a county photo moved by the editor's line-up
 * (county-picture.js countyPicture with align), else Mapbox. Its frame (EPSG:4326 centre, zoom, size) goes with it, so a
 * reader lays it down exactly (public/lib photo.js toPx with that frame).
 *
 *   GET /api/maps/photo?id=   the picture; X-Photo-Frame (JSON) and X-Photo-Source headers. A map saved before this
 *                             existed gets it on first ask: the finished map's banked photo when the corpus has one
 *                             for it (taken at Finish), else taken then.
 */
import { modelKey } from './unified.js';
import { countyServiceById } from './county.js';
import { countyPicture } from './county-picture.js';
import { encodePng } from './tile-mosaic.js';
import { liveCaptureFrame, imagePixels, imageHeightPixels, imageryUrl } from './imagery.js';

/** What a saved map was traced on: { provider, svc, align, frame } or null (no frame saved). */
export function photoSpec(map) {
  const f = map?.frame;
  if (!f || ![f.lng, f.lat, f.zoom, f.size].every(Number.isFinite)) return null;
  const frame = { lng: f.lng, lat: f.lat, zoom: f.zoom, size: f.size, height: Number.isFinite(f.height) ? f.height : f.size };
  if (map.provider === 'county' && map.countySvc != null) {
    const a = map.countyAlign;
    const align = a && [a.east, a.north, a.scale].every(Number.isFinite) ? { east: a.east, north: a.north, scale: a.scale } : null;
    return { provider: 'county', svc: String(map.countySvc), align, frame };
  }
  return { provider: 'mapbox', svc: null, align: null, frame };
}

/** Two specs are the same photo when every part matches (rounded, so a re-save of the same frame is not a change). */
export function specId(spec) {
  if (!spec) return '';
  const r = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
  const f = spec.frame, a = spec.align;
  return [spec.provider, spec.svc || '', a ? `${r(a.east, 2)},${r(a.north, 2)},${r(a.scale, 4)}` : '', r(f.lng, 6), r(f.lat, 6), r(f.zoom, 3), f.size, f.height].join('|');
}

const photoKey = (owner, key) => modelKey(owner, key, 'photo');

/** Take the picture now: { bytes, type, frame } or throws. */
export async function takePhoto(env, spec, { fetcher = fetch } = {}) {
  const shot = liveCaptureFrame(spec.frame);
  if (spec.provider === 'county') {
    const svc = await countyServiceById(env, spec.svc);
    if (!svc) throw new Error('the county photo service is not in the catalogue');
    const img = await countyPicture(svc, shot.frame, { W: imagePixels(shot.frame), H: imageHeightPixels(shot.frame), align: spec.align, fetcher });
    if (!img) throw new Error('the county service drew nothing');
    return { bytes: await encodePng(img), type: 'image/png', frame: shot.frame };
  }
  const token = env.MAPBOX_SERVER_TOKEN || env.MAPBOX_TOKEN;
  const url = token && imageryUrl('mapbox', shot.frame, token, env);
  if (!url) throw new Error('no Mapbox token');
  const res = await fetcher(url, { signal: AbortSignal.timeout(20000) });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) throw new Error(`Mapbox answered ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), type, frame: shot.frame };
}

async function put(env, owner, key, spec, got, from) {
  await env.CORPUS.put(await photoKey(owner, key), got.bytes, {
    httpMetadata: { contentType: got.type },
    customMetadata: { spec: specId(spec), frame: JSON.stringify(got.frame), source: spec.provider, from, at: new Date().toISOString() },
  });
}

/**
 * Keep the map's photo if it is not kept already for this spec (on save: ctx.waitUntil). Never throws; answers
 * { ok, kept } or { ok: false, reason }.
 */
export async function keepPhoto(env, owner, key, map, opts = {}) {
  try {
    if (!env?.CORPUS) return { ok: false, reason: 'no-bucket' };
    const spec = photoSpec(map);
    if (!spec) return { ok: false, reason: 'no-frame' };
    const head = await env.CORPUS.head(await photoKey(owner, key));
    if (head?.customMetadata?.spec === specId(spec)) return { ok: true, kept: 'already' };
    await put(env, owner, key, spec, await takePhoto(env, spec, opts), 'saved');
    return { ok: true, kept: 'taken' };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * The finished map's banked photo (corpus.js storeMapPhoto, taken at Finish), when the corpus has one for this map:
 * its row id begins with the frame's centre at five places (corpus.js idFor). The newest of that photo kind.
 */
async function fromCorpus(env, spec) {
  if (!env?.DB || !env?.CORPUS) return null;
  const at = `${spec.frame.lng.toFixed(5)},${spec.frame.lat.toFixed(5)}:`;
  const row = await env.DB.prepare(
    'SELECT image_key, image_frame FROM corpus WHERE id LIKE ?1 AND image_key IS NOT NULL AND image_provider = ?2 ORDER BY at DESC LIMIT 1',
  ).bind(`${at}%`, spec.provider).first().catch(() => null);
  if (!row?.image_key || !row.image_frame) return null;
  const obj = await env.CORPUS.get(row.image_key);
  if (!obj) return null;
  let frame = null; try { frame = JSON.parse(row.image_frame); } catch { return null; }
  return { bytes: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType || 'image/png', frame };
}

/** The map's photo, kept: an R2 object (with customMetadata.frame), or { error }. Takes it first when there is none. */
export async function mapPhoto(env, owner, key, map) {
  if (!env?.CORPUS) return { error: 'no-bucket' };
  const spec = photoSpec(map);
  const k = await photoKey(owner, key);
  let obj = await env.CORPUS.get(k);
  if (obj && (!spec || obj.customMetadata?.spec === specId(spec))) return obj;
  if (!spec) return { error: 'no-frame' };
  // none yet for this photo: the corpus's copy taken at Finish when it has one, else take it now
  let got = null, from = 'first asked';
  try { got = await fromCorpus(env, spec); if (got) from = 'the corpus (taken at Finish)'; } catch { got = null; }
  // never another photo in its place: a kept one of a different spec is not this map's photo any more
  try { if (!got) got = await takePhoto(env, spec); } catch (e) { return { error: String(e?.message || e).slice(0, 160) }; }
  await put(env, owner, key, spec, got, from);
  obj = await env.CORPUS.get(k);
  return obj || { error: 'not kept' };
}
