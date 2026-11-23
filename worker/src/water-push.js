/**
 * THE WATER SITE'S SCORING WITH NO PAGE OPEN (the owner said yes, 2026-11-16, to the water session's plan with the
 * core session's: a water builder Container in water/ reading the shade map's finished model, a scoring kit per map
 * in the water site's own bucket, and pushes over service bindings to private entrypoints; no token, no robot
 * session). This is the main Worker's half, for ADMIN SAVES ONLY:
 *
 *   - what the private entrypoint (internal.js, binding WATER's counterpart MAIN on the water side) reads: an admin
 *     save's record, its shade model's bytes, its thermal walks (from the yard AR site over SCAN_INTERNAL);
 *   - pushWater, from the one-minute timer every five minutes: WATER.modelChanged(id, modelAt) for each admin save
 *     whose shade model's time changed since the last push (a server build, a browser save, an erasure alike), and
 *     WATER.walkReady(id, walk) for each walk whose converted grid landed since. What was pushed is remembered in the
 *     private bucket (water-push/state-v2.json), so a push is sent once; the water side's daily sweep of adminSaves()
 *     catches any lost on the way.
 *
 * Kept free of the Workers runtime's own modules so the tests (Node) can run it; internal.js holds the entrypoint.
 */
import { listMaps, getMap, userOwner, getModel } from './unified.js';

// v2 (2026-11-16): the water site refused the first pushes ({ queued: false }: its id check was too narrow, since
// fixed) and they had been counted as sent; a fresh record sends everything again
export const PUSH_KEY = 'water-push/state-v2.json';
// an answer of { queued: false } is not sent: it is tried again the next time (the water site's daily sweep is still
// the backstop for anything it never takes)
const taken = (r) => !(r && r.queued === false);
export const PUSH_EVERY_MIN = 5;

async function admins(env) {
  return (await env.DB.prepare("SELECT id, email, role FROM users WHERE role = 'admin' ORDER BY created_at").all()).results || [];
}

/** An admin save by its id, with its owner, or null (anything that is not an admin save is refused). */
export async function findAdminSave(env, id) {
  const key = String(id || '');
  if (!key) return null;
  for (const a of await admins(env)) {
    const owner = userOwner(a), map = await getMap(env, owner, key);
    if (map?.adminSave === true) return { map, owner };
  }
  return null;
}

/** Every admin save: [{ id, modelAt, fusedAt, at }] (modelAt: its shade model's write time, or null before one is built; fusedAt: its fused model's). */
export async function adminSavesList(env) {
  const out = [];
  for (const a of await admins(env)) {
    const owner = userOwner(a);
    for (const m of await listMaps(env, owner)) {
      if (m?.adminSave !== true) continue;
      let modelAt = null, fusedAt = null;
      try { const o = await getModel(env, owner, m.id, 'shade'); modelAt = o?.customMetadata?.at || null; o?.body?.cancel?.(); } catch { modelAt = null; }
      // THE FUSED MODEL's write time too (2026-11-23, the water session's ask: "a fusedAt beside modelAt"; docs/MAPS.md)
      try { const o = await getModel(env, owner, m.id, 'shade', 0, 'fused'); fusedAt = o?.customMetadata?.at || null; o?.body?.cancel?.(); } catch { fusedAt = null; }
      out.push({ id: m.id, modelAt, fusedAt, at: m.at || null });
    }
  }
  return out;
}

/** An admin save's shade model, or one of its overflow parts (1..8): { bytes (gzipped, as GET /api/maps/model returns), modelAt }, or null. */
export async function modelOfSave(env, id, part = 0, file = '') {
  const f = await findAdminSave(env, id);
  if (!f) return null;
  // file 'fused': the fused model (docs/MAPS.md), the same shape of answer; its madeFrom says what it was fused from
  const o = await getModel(env, f.owner, f.map.id, 'shade', part, file);
  if (!o) return null;
  return { bytes: await o.arrayBuffer(), modelAt: o.customMetadata?.at || null, ...(file ? { file, madeFrom: o.customMetadata?.madeFrom || null } : {}) };
}

/** An admin save's thermal walks (walk null) or one walk, as GET /api/maps/thermal answers (one walk: with its frame). */
export async function thermalOfSave(env, id, walk = null) {
  const f = await findAdminSave(env, id);
  if (!f || !env.SCAN_INTERNAL) return null;
  const r = await env.SCAN_INTERNAL.thermalOf(f.map.id, walk == null ? null : String(walk));
  const body = r?.body ?? null;
  if (body && walk != null && !body.error) {
    const o = Array.isArray(body.origin) ? body.origin : [f.map.lng, f.map.lat];
    body.frame = { lng: o[0], lat: o[1], cellM: 0.5, axes: 'east,north metres' };
    delete body.origin;
  }
  return body;
}

/** The timer's push (every PUSH_EVERY_MIN minutes): what changed since the last, to the water site. Never throws. */
export async function pushWater(env, now = Date.now(), list = adminSavesList) {
  if (!env.WATER || !env.CORPUS || !env.DB) return { pushed: 0, why: 'no binding' };
  if (Math.floor(now / 60000) % PUSH_EVERY_MIN !== 0) return { pushed: 0, why: 'not this minute' };
  let state = { models: {}, walks: {} };
  try { const o = await env.CORPUS.get(PUSH_KEY); if (o) state = { models: {}, walks: {}, ...(await o.json()) }; } catch { /* from nothing */ }
  let pushed = 0, changed = false;
  const saves = await list(env);
  for (const s of saves) {
    if (!s.modelAt || state.models[s.id] === s.modelAt) continue;
    try { if (taken(await env.WATER.modelChanged(s.id, s.modelAt))) { state.models[s.id] = s.modelAt; pushed++; changed = true; } } catch { /* the next time */ }
  }
  /* THE FUSED MODEL CHANGED (2026-11-23): WATER.fusedChanged(id, fusedAt), sent once like the model's. Until the
     water side has that method the call throws and nothing is remembered, so the first push after it exists carries
     every fused file there is. */
  state.fused ||= {};
  for (const s of saves) {
    if (!s.fusedAt || state.fused[s.id] === s.fusedAt) continue;
    try { if (taken(await env.WATER.fusedChanged(s.id, s.fusedAt))) { state.fused[s.id] = s.fusedAt; pushed++; changed = true; } } catch { /* the next time */ }
  }
  if (env.SCAN_INTERNAL) {
    const ids = new Set(saves.map((s) => String(s.id)));
    let ready = [];
    try { ready = await env.SCAN_INTERNAL.convertedWalks(); } catch { ready = []; }
    for (const r of ready || []) {
      const k = `${r.map}/${r.walk}`;
      if (!ids.has(String(r.map)) || state.walks[k] === r.at) continue;
      try { if (taken(await env.WATER.walkReady(r.map, r.walk))) { state.walks[k] = r.at; pushed++; changed = true; } } catch { /* the next time */ }
    }
  }
  if (changed) await env.CORPUS.put(PUSH_KEY, JSON.stringify({ ...state, at: new Date(now).toISOString() }), { httpMetadata: { contentType: 'application/json' } });
  return { pushed };
}
