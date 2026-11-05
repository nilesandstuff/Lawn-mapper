/**
 * A twin's map and the shade map's model, read on a runner (core session): the map from the database with the
 * Cloudflare token (the site's edge answers GitHub's runners 403, as tools/draw-map.mjs found), the model from the
 * main site's bucket by the key routes-maps.js writes it under (unified.js modelKey). Shared by the twin check
 * (twin-check.mjs) and the after-the-walk fix (post-fix.mjs). Neither prints a key or a coordinate.
 */
import { createHash } from 'node:crypto';
import { unpackModel, modelUsable } from '../lib/lidar-model.js';
import { readObject, CORPUS_BUCKET } from './twin-r2.mjs';

/** The saved map with its tools' parts: from the database when the runner has the Cloudflare token (the site's edge
 *  answers GitHub's runners 403, as tools/draw-map.mjs found), else through the site's read-only route. */
export async function readMap(id, site, key) {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    const { query } = await import('../../tools/corpus-db.js');
    const q = `'${String(id).replace(/'/g, "''")}'`;
    const rows = query(`SELECT m.key, m.lng, m.lat, m.payload, m.user_id FROM maps m JOIN users u ON u.id = m.user_id WHERE u.role = 'admin' AND m.key = ${q}`);
    if (!rows.length) throw new Error('no such map among the owner\'s');
    let payload = {}; try { payload = JSON.parse(rows[0].payload) || {}; } catch { /* empty */ }
    const tools = {};
    for (const t of query(`SELECT tool, data FROM map_tools WHERE owner_kind = 'user' AND owner_id = '${String(rows[0].user_id).replace(/'/g, "''")}' AND map_key = ${q}`)) {
      try { tools[t.tool] = { data: JSON.parse(t.data) }; } catch { /* unreadable part */ }
    }
    return { ...payload, lng: payload.lng ?? rows[0].lng, lat: payload.lat ?? rows[0].lat, tools, ownerId: rows[0].user_id };
  }
  if (!site || !key) throw new Error('the map needs the Cloudflare token, or SITE and MAPS_READ_TOKEN');
  const r = await fetch(`${site}/api/admin/saved-maps/one?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`the map could not be read (${r.status})`);
  return (await r.json()).map;
}

/** THE SHADE MAP'S FINISHED MODEL of the map (public/lib/lidar-model.js), as the page reads it: from the main site's
 *  bucket by the key routes-maps.js writes it under (unified.js modelKey), since the site answers the runner 403. */
export async function readModel(mapKey, ownerId) {
  if (!ownerId) throw new Error('the model needs the map\'s owner');
  const key = `models/user/${ownerId}/${createHash('sha256').update(String(mapKey)).digest('hex')}/shade.bin`;
  const bytes = await readObject(CORPUS_BUCKET, key);
  if (!bytes) throw new Error('this map has no lidar model yet: open it in the shade map first, which builds and saves it');
  const m = await unpackModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (!modelUsable(m)) throw new Error('the lidar model is incomplete');
  return m;
}

