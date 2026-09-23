/**
 * Saved maps that belong to an account rather than to a browser.
 *
 * The local store is not replaced by this; it is what a signed-out visitor
 * still gets, and it is what the first sign-in hands upward. A person who
 * measured three lawns before making an account has not lost them -- the
 * browser pushes what it has and the account keeps it from then on.
 *
 * THE IDENTITY OF A MAP IS THE SAME EITHER WAY: address, method, arithmetic.
 * Re-measuring the same lot the same way updates that map rather than piling
 * up a third, and one address can hold both its find-grass and its
 * exclude-objects answer. Here that is a UNIQUE constraint doing the work
 * instead of the application remembering to, which is the point of moving it.
 */

import { currentUser } from './auth.js';
import { accountsEnabled, newId } from './db.js';

/**
 * How many an account keeps.
 *
 * Fifty rather than the browser's five, because the reason for five was that a
 * phone's local storage is small and shared with everything else on the
 * device. Neither applies to a row in a table. Still a number rather than no
 * limit: an unbounded list is an unbounded bill and an unscrollable page.
 */
export const MAX_MAPS = 50;

/** A map, as the browser wants it back: the saved record, plus its row id. */
const asSave = (row) => {
  let payload = {};
  try { payload = JSON.parse(row.payload) || {}; } catch { payload = {}; }
  return { ...payload, id: row.key, rowId: row.id, at: row.updated_at };
};

export async function handleMaps(request, env, url, origin, ctx, json) {
  if (!accountsEnabled(env)) return json({ error: 'accounts-disabled' }, 501, origin);

  const user = await currentUser(request, env, ctx);
  /*
   * Signed out is not an error here, it is an answer: the browser falls back
   * to its own store rather than showing a failure. 401 would make a perfectly
   * ordinary state look like something went wrong.
   */
  if (!user) return json({ maps: [], signedIn: false }, 200, origin);

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT * FROM maps WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`
    ).bind(user.id, MAX_MAPS).all();
    return json({ maps: results.map(asSave), signedIn: true, max: MAX_MAPS }, 200, origin);
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

    /*
     * One route for one map and for a pile of them, because the pile is the
     * interesting case: the first sign-in hands up everything the browser was
     * holding, and doing that one request at a time on a phone connection is
     * how a migration half-finishes.
     */
    const incoming = Array.isArray(body.maps) ? body.maps : [body];
    const saved = [];
    for (const map of incoming.slice(0, MAX_MAPS)) {
      const row = await upsertMap(env, user.id, map);
      if (row) saved.push(row);
    }

    await trim(env, user.id);
    return json({ saved: saved.length, signedIn: true }, 200, origin);
  }

  if (request.method === 'DELETE') {
    const key = url.searchParams.get('id');
    if (!key) return json({ error: 'id required' }, 400, origin);
    await env.DB.prepare('DELETE FROM maps WHERE user_id = ? AND key = ?')
      .bind(user.id, key).run();
    return json({ ok: true }, 200, origin);
  }

  return json({ error: 'GET, POST or DELETE' }, 405, origin);
}

/** Write one map, replacing the one it supersedes. */
async function upsertMap(env, userId, map) {
  const key = String(map?.id || '').trim();
  if (!key || !map?.address) return null;

  /*
   * The payload is stored as the browser sent it, minus the fields this table
   * has columns for. Not to save space -- to stop the row and the blob
   * disagreeing about the square footage, which is the kind of difference
   * nobody notices until a support question turns on it.
   */
  const payload = { ...map };
  delete payload.rowId;

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO maps (id, user_id, key, address, lng, lat, county, model, mode,
                       square_feet, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET
       address = excluded.address, lng = excluded.lng, lat = excluded.lat,
       county = excluded.county, model = excluded.model, mode = excluded.mode,
       square_feet = excluded.square_feet, payload = excluded.payload,
       updated_at = excluded.updated_at`
  ).bind(
    newId('map'), userId, key,
    String(map.address).slice(0, 200),
    Number.isFinite(map.lng) ? map.lng : null,
    Number.isFinite(map.lat) ? map.lat : null,
    map.county ? String(map.county).slice(0, 60) : null,
    map.model ? String(map.model).slice(0, 40) : null,
    map.mode ? String(map.mode).slice(0, 20) : null,
    Number.isFinite(map.squareFeet) ? Math.round(map.squareFeet) : null,
    JSON.stringify(payload),
    now, now
  ).run();

  return key;
}

/**
 * Keep the newest, drop the rest.
 *
 * By `updated_at` rather than by creation, because a map you came back to and
 * corrected last week is one you are using, whatever day it was first made.
 */
async function trim(env, userId) {
  await env.DB.prepare(
    `DELETE FROM maps WHERE user_id = ? AND id NOT IN (
       SELECT id FROM maps WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
     )`
  ).bind(userId, userId, MAX_MAPS).run();
}
