/**
 * Saved maps: one record per map, on the server, signed in or not.
 *
 * Since 2026-10-16 (owner: "there's not any actual browser saves, instead use
 * the unified save even for logged out accounts") every map lives here. A
 * signed-out visitor is a guest with ONE map, kept by a cookie for the whole
 * home domain; signing in moves it into the account (unified.js). Every tool
 * opens the same record and keeps its own part beside it (map_tools), so the
 * shade map, the water map and the lawn mapper never overwrite each other.
 *
 * THE IDENTITY OF A MAP IS UNCHANGED: address, method, arithmetic. Re-measuring
 * the same lot the same way updates that map rather than piling up another.
 *
 *   GET    /api/maps              every map, newest first, with its tools' dates
 *   POST   /api/maps              the lawn mapper's record (one, or { maps: [...] })
 *   DELETE /api/maps?id=          a map and every tool's part of it
 *   GET    /api/maps/one?id=      one map with every tool's data
 *   POST   /api/maps/new          a map started by another tool (address, point, line)
 *   POST   /api/maps/tool?id=&tool=   one tool's part: { data, basedOn }
 *   GET    /api/tools             the tools, their order and where they open
 *
 * The contract the other tools build against is docs/MAPS.md.
 */

import { currentUser } from './auth.js';
import { accountsEnabled } from './db.js';
import {
  USER_MAX_MAPS, GUEST_MAX_MAPS, findGuest, newGuest, userOwner, guestOwner,
  listMaps, getMap, upsertMap, deleteMap, putTool, toolsFor,
} from './unified.js';

/** How many an account keeps (unified.js USER_MAX_MAPS). */
export const MAX_MAPS = USER_MAX_MAPS;

export const isMapsPath = (p) => p === '/api/maps' || p.startsWith('/api/maps/') || p === '/api/tools';

/** The answer, with any cookie that made this browser a guest. */
function withCookies(res, cookies) {
  if (!cookies.length) return res;
  const headers = new Headers(res.headers);
  for (const c of cookies) headers.append('Set-Cookie', c);
  headers.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Who this request is for. Signed in: the account. Otherwise the guest this
 * browser already is, or -- only when `create` -- a new one.
 */
async function ownerFor(request, env, ctx, create) {
  const user = await currentUser(request, env, ctx);
  if (user) return { owner: userOwner(user), user, cookies: [] };
  const guest = await findGuest(request, env);
  if (guest) return { owner: guestOwner(guest), cookies: [] };
  if (!create) return { owner: null, cookies: [] };
  const made = await newGuest(request, env);
  return { owner: guestOwner(made.guest), cookies: [made.cookie] };
}

const limitAnswer = {
  error: 'guest-limit',
  max: GUEST_MAX_MAPS,
  message: 'Sign in to keep more than one map. Your map stays: signing in takes it with you.',
};

export async function handleMaps(request, env, url, origin, ctx, json) {
  const path = url.pathname;
  if (path === '/api/tools') {
    const me = await currentUser(request, env, ctx).catch(() => null);
    const res = json({ tools: toolsFor(url.host, { admin: me?.role === 'admin' }) }, 200, origin);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  }
  if (!accountsEnabled(env)) return json({ error: 'accounts-disabled' }, 501, origin);

  const writes = request.method === 'POST';
  const { owner, user, cookies } = await ownerFor(request, env, ctx, writes);
  const reply = (data, status = 200) => withCookies(json(data, status, origin), cookies);
  const who = { signedIn: Boolean(user), guest: owner?.kind === 'guest', max: owner?.max ?? GUEST_MAX_MAPS };

  /* ------------------------------------------------------------ /api/maps */
  if (path === '/api/maps') {
    if (request.method === 'GET') {
      // Signed out with no guest yet: nothing kept, which is an answer, not an error.
      if (!owner) return reply({ maps: [], ...who });
      return reply({ maps: await listMaps(env, owner), ...who });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
      /*
       * One route for one map and for a pile of them: the first sign-in (and,
       * since the unified save, the first visit after it shipped) hands up
       * everything the browser was holding.
       */
      const incoming = Array.isArray(body.maps) ? body.maps : [body];
      const saved = [];
      let refused = 0;
      for (const map of incoming.slice(0, owner.max === GUEST_MAX_MAPS ? incoming.length : USER_MAX_MAPS)) {
        const r = await upsertMap(env, owner, map);
        if (r.key) saved.push({ id: r.key, at: r.at });
        else if (r.error === 'guest-limit') refused++;
      }
      if (!saved.length && refused) return reply({ ...limitAnswer, ...who }, 409);
      return reply({ saved: saved.length, maps: saved, refused, ...who });
    }
    if (request.method === 'DELETE') {
      const key = url.searchParams.get('id');
      if (!key) return reply({ error: 'id required' }, 400);
      if (owner) await deleteMap(env, owner, key);
      return reply({ ok: true });
    }
    return reply({ error: 'GET, POST or DELETE' }, 405);
  }

  /* ------------------------------------------------------- /api/maps/one */
  if (path === '/api/maps/one') {
    const key = url.searchParams.get('id');
    if (!key) return reply({ error: 'id required' }, 400);
    const map = owner ? await getMap(env, owner, key) : null;
    if (!map) return reply({ error: 'no-map', ...who }, 404);
    return reply({ map, ...who });
  }

  /* ------------------------------------------------------- /api/maps/new */
  /*
   * A MAP STARTED BY ANOTHER TOOL (the shade map's own address search, and
   * any tool after it with its own way in). It holds what that tool knows --
   * the address, the point, a property line -- and the lawn mapper fills in
   * the lawn when it is opened on it.
   */
  if (path === '/api/maps/new') {
    if (request.method !== 'POST') return reply({ error: 'POST required' }, 405);
    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const lng = Number(body.lng), lat = Number(body.lat);
    if (!body.address || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      return reply({ error: 'address, lng and lat required' }, 400);
    }
    const id = String(body.id || `${String(body.address).trim().toLowerCase()}|${body.source || 'tool'}`).slice(0, 300);
    const r = await upsertMap(env, owner, {
      id, address: String(body.address), lng, lat,
      county: body.county || null,
      parcel: body.parcel || null,
      startedIn: String(body.source || 'tool').slice(0, 20),
    });
    if (r.error === 'guest-limit') return reply({ ...limitAnswer, ...who }, 409);
    if (r.error) return reply({ error: r.error }, 400);
    return reply({ id: r.key, at: r.at, ...who });
  }

  /* ------------------------------------------------------ /api/maps/tool */
  if (path === '/api/maps/tool') {
    if (request.method !== 'POST' && request.method !== 'PUT') return reply({ error: 'POST required' }, 405);
    const key = url.searchParams.get('id');
    const tool = url.searchParams.get('tool');
    if (!key || !tool) return reply({ error: 'id and tool required' }, 400);
    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Invalid JSON' }, 400); }
    const r = await putTool(env, owner, key, tool, body?.data, body?.basedOn);
    if (r.error === 'no-map') return reply({ error: 'no-map', ...who }, 404);
    if (r.error) return reply(r, 400);
    return reply({ ...r, ...who });
  }

  return reply({ error: 'Not found' }, 404);
}
