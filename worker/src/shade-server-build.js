/**
 * AN ADMIN SAVE'S SHADE MODEL, BUILT ON THE SERVER (owner, 2026-11-11: "Ask
 * the shade map to build a way where it runs on cloudflare so I don't need to
 * leave the page open. Again, this is specifically for the admin saves").
 *
 * The build needs more memory than a Worker has, so it runs in the shade
 * builder's Cloudflare Container (shade-builder/, its own Worker, reached by
 * the service binding SHADE_BUILDER). This hands the builder the map's record
 * and the site's origin, and stores what comes back as the map's owner: the
 * finished model (putModel, as PUT /api/maps/model does) and the shade part
 * with the lidar and line-up it chose (putTool), so the shade page and the AR
 * open the map as if it had been built there. The core session calls it for
 * an admin save whose trace is done (worker/src/admin-saves.js). Any map not flagged adminSave is refused.
 *
 *   await buildShadeOnServer(env, owner, key, { base: 'https://lawnmap.<home>' })
 *     -> { ok: true, model, part, seconds, build, lidar } | { ok: false, why }
 */
import { getMap, putModel, putTool } from './unified.js';

export async function buildShadeOnServer(env, owner, key, { base } = {}) {
  if (!env.SHADE_BUILDER) return { ok: false, why: 'the shade builder is not bound (SHADE_BUILDER)' };
  if (!base) return { ok: false, why: 'no site origin' };
  const map = await getMap(env, owner, key);
  if (!map) return { ok: false, why: 'no such map' };
  /* ADMIN SAVES ONLY (owner, 2026-11-11: "this is currently only for use by the admin save path. Visitors to the
     public site won't ever send jobs to this special cloudflare container"): refused here whatever the caller. */
  if (map.adminSave !== true) return { ok: false, why: 'not an admin save: the server build is for admin saves only' };
  let res;
  try {
    res = await env.SHADE_BUILDER.fetch('https://shade-builder/build', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ map: { ...map, id: map.id || key }, base }),
    });
  } catch (e) { return { ok: false, why: `the shade builder did not answer: ${String(e?.message || e).slice(0, 120)}` }; }
  const out = await res.json().catch(() => null);
  if (!out?.ok || !out.model) return { ok: false, why: out?.why || `the shade builder answered ${res.status}` };
  const bytes = Uint8Array.from(atob(out.model), (c) => c.charCodeAt(0));
  const model = await putModel(env, owner, key, 'shade', new Response(bytes).body, bytes.length);
  if (model.error) return { ok: false, why: `the model was not stored: ${model.error}` };
  const part = out.part?.data ? await putTool(env, owner, key, 'shade', out.part.data, out.part.basedOn) : null;
  return { ok: true, model, part, seconds: out.seconds ?? null, build: out.result?.build ?? null, lidar: out.result?.lidar ?? null };
}
