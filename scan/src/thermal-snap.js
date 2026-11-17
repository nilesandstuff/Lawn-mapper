/**
 * DEV ONLY -- SINGLE THERMAL PHOTOS, KEPT AND READ BACK (core session, 2026-11-17; android/app/src/dev/README.md).
 *
 * The owner: "it would be nice to add individual thermal pics that I manually place. That way I can quickly get a
 * thermal pic or 2 in addition to whatever other readings I can manage quickly." Agreed between the sessions the same
 * day: the app takes the photo (ThermalCamera.snap: a fresh shutter reference, a 1 s burst of every frame, a second
 * reference, and the phone's full orientation), kept like a walk's thermal file under an id walks cannot have
 * (snap-<ms>): twins/<id>/thermal.bin, then twins/<id>/thermal-snap.json, its notes, written only once thermal.bin
 * is whole, so the thermal session's converter never starts on half a photo. The converter writes
 * twins/<id>/thermal/snap.json (temperatures and each pixel's angles, in the camera's own view) and snap.png (a
 * preview). The owner places it afterwards on the water site's readings page: twins/<id>/thermal-snap-place.json.
 *
 * Nothing here is a temperature or a calibration; the coordinates stay in the private bucket and are never printed.
 */
import { keyOf } from './twin.js';
import { MAP_ID } from './thermal.js';

export const SNAP_ID = /^snap-[0-9]{10,16}$/;
const LIST = 'thermal-snaps/';
const read = async (env, key) => { try { const o = await env.TWIN.get(key); return o ? JSON.parse(await o.text()) : null; } catch { return null; } };
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** A photo's notes (thermal-snap.json) have arrived: listed, with its time and its map if it had one. Never throws. */
export async function noteSnap(env, id, body) {
  try {
    if (!SNAP_ID.test(id)) return null;
    const m = JSON.parse(new TextDecoder().decode(body));
    const map = typeof m?.map === 'string' && MAP_ID.test(m.map) ? m.map : null;
    const at = num(m?.at, 1e12, 1e14) ?? Number(id.slice(5));
    await env.TWIN.put(`${LIST}${id}`, JSON.stringify({ id, at, map }), { httpMetadata: { contentType: 'application/json' } });
    return id;
  } catch { return null; }
}

/** One photo as the water site reads it, or null: its notes, the converter's answer (null until it has run), and
 *  where the owner placed it (null until then). */
export async function snapOf(env, id) {
  if (!env.TWIN || !SNAP_ID.test(String(id || ''))) return null;
  const [meta, snap, status, place] = await Promise.all([
    read(env, keyOf(id, 'thermal-snap.json')), read(env, keyOf(id, 'thermal/snap.json')),
    read(env, keyOf(id, 'thermal/status.json')), read(env, keyOf(id, 'thermal-snap-place.json')),
  ]);
  if (!meta) return null;
  return { id, at: meta.at ?? Number(id.slice(5)), map: meta.map ?? place?.map ?? null, label: meta.label ?? null, air_C: meta.air_C ?? null,
    emissivity: meta.emissivity ?? null, rotation: meta.rotation ?? null, place: place || null, snap: snap || null,
    status: status ? { ok: status.ok !== false, at: status.at ?? null, error: status.error ?? null } : null };
}

/** The photos, newest first: { id, at, map, placed, converted }. map: only that map's (and, with loose, those not tied
 *  to any map yet); since/until: ms. */
export async function snapsList(env, { map = null, loose = true, since = 0, until = 1e15 } = {}) {
  if (!env.TWIN) return [];
  const rows = [];
  let cursor;
  do {
    const page = await env.TWIN.list({ prefix: LIST, cursor, limit: 1000 });
    for (const o of page.objects) { const id = o.key.slice(LIST.length); if (SNAP_ID.test(id)) rows.push(id); }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const out = [];
  for (const id of rows) {
    const at = Number(id.slice(5));
    if (at < since || at > until) continue;
    const [row, place, conv] = await Promise.all([read(env, `${LIST}${id}`), read(env, keyOf(id, 'thermal-snap-place.json')), env.TWIN.head(keyOf(id, 'thermal/snap.json'))]);
    const m = place?.map ?? row?.map ?? null;
    if (map != null && m !== map && !(loose && m == null)) continue;
    out.push({ id, at, map: m, placed: !!place, converted: !!conv });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The converter's preview picture: { bytes, type } or null. */
export async function snapPng(env, id) {
  if (!env.TWIN || !SNAP_ID.test(String(id || ''))) return null;
  const o = await env.TWIN.get(keyOf(id, 'thermal/snap.png'));
  return o ? { bytes: new Uint8Array(await o.arrayBuffer()), type: 'image/png' } : null;
}

/** Where the owner stood: { lng, lat, heading (deg from north, optional), map (optional) }. -> { ok } or { error }. */
export function checkPlace(p) {
  const lng = num(p?.lng, -180, 180), lat = num(p?.lat, -90, 90);
  if (lng == null || lat == null) return { error: 'lng and lat are needed' };
  const heading = p.heading == null ? null : num(p.heading, 0, 360);
  if (p.heading != null && heading == null) return { error: 'heading is degrees from north, 0 to 360' };
  const map = p.map == null ? null : typeof p.map === 'string' && MAP_ID.test(p.map) ? p.map : undefined;
  if (map === undefined) return { error: 'which map?' };
  return { ok: { lng, lat, heading, map, note: typeof p.note === 'string' ? p.note.slice(0, 200) : null } };
}
export async function placeSnap(env, id, p) {
  if (!env.TWIN || !SNAP_ID.test(String(id || ''))) return { error: 'which photo?' };
  if (!(await env.TWIN.head(keyOf(id, 'thermal-snap.json')))) return { error: 'Not found' };
  const c = checkPlace(p);
  if (c.error) return c;
  const body = { ...c.ok, at: Date.now() };
  await env.TWIN.put(keyOf(id, 'thermal-snap-place.json'), JSON.stringify(body), { httpMetadata: { contentType: 'application/json' } });
  return { ok: true, place: body };
}
