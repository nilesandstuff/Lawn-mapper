/**
 * THE WATER SITE'S WORK QUEUE FOR THE NO-PAGE SCORING (owner, 2026-11-16: "Yes" to the core session's plan -- an
 * admin save's walks scored with no page open, the way the shade map builds them). The main site's timer tells this
 * Worker, over a service binding to its named entrypoint Internal (src/worker.js), when an admin save's shade model
 * lands (modelChanged) and when a thermal walk's grid lands (walkReady). Each is kept here first, in the water D1
 * (table kit_jobs), and answered at once; the work (the map's scoring kit in the water builder, then the walk's score)
 * runs afterwards, so the main site's timer never waits on it and nothing pushed is lost if the work fails.
 * Pure over env.DB; no addresses, no coordinates.
 */

// any id the main site gives (an admin save's is admin|...), without control characters; until 2026-11-16 a narrower
// pattern refused real ids, answered { queued: false }, and the main site counted the push as sent
const ID = /^[^\u0000-\u001f\u007f]{1,200}$/;

/** A job, checked. kind 'model' (a map's scoring kit to build), 'walk' (a walk to score) or 'soil' (a field visit's
 *  soil temperatures to check, 2026-11-17; its visit id kept in walk). -> { row } or { error } */
export function cleanJob(kind, mapId, { walk = null, modelAt = null } = {}, now = Date.now()) {
  // 'lidar' (2026-11-24): a walk on a map with a fused model, scored a second time on the lidar alone
  if (kind !== 'model' && kind !== 'walk' && kind !== 'soil' && kind !== 'lidar') return { error: 'kind: model, walk, soil or lidar' };
  const map_id = typeof mapId === 'string' ? mapId : '';
  if (!ID.test(map_id)) return { error: 'a map id' };
  const w = walk === null || walk === undefined ? null : String(walk);
  if ((kind === 'walk' || kind === 'soil' || kind === 'lidar') && (!w || !ID.test(w))) return { error: kind === 'soil' ? 'a visit id' : 'a walk id' };
  return { row: { key: `${kind}|${map_id}|${w || ''}`, kind, map_id, walk: w, model_at: modelAt === null || modelAt === undefined ? null : String(modelAt).slice(0, 64), queued: now, state: 'queued', tries: 0, detail: null } };
}

/** Keep a job (a repeat of one already queued or done is queued again: the model may have changed). */
export async function enqueue(env, kind, mapId, opts = {}) {
  const { row, error } = cleanJob(kind, mapId, opts);
  if (error) return { queued: false, error };
  if (!env?.DB) return { queued: false, error: 'no database' };
  await env.DB.prepare(`INSERT INTO kit_jobs (key, kind, map_id, walk, model_at, queued, state, tries, detail) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL)
    ON CONFLICT(key) DO UPDATE SET model_at = excluded.model_at, queued = excluded.queued, state = 'queued', tries = 0, detail = NULL`)
    .bind(row.key, row.kind, row.map_id, row.walk, row.model_at, row.queued).run();
  return { queued: true };
}

/** The jobs waiting, oldest first (models before walks: a walk is scored from its map's kit). */
export async function waiting(env, limit = 20) {
  return (await env.DB.prepare("SELECT * FROM kit_jobs WHERE state = 'queued' ORDER BY CASE kind WHEN 'model' THEN 0 ELSE 1 END, queued LIMIT ?").bind(limit).all()).results || [];
}

/** A job's outcome: 'done', 'failed' (with why), or back to 'queued' for another try. */
export async function settle(env, key, state, detail = null) {
  await env.DB.prepare('UPDATE kit_jobs SET state = ?, tries = tries + 1, detail = ? WHERE key = ?').bind(state, detail === null ? null : String(detail).slice(0, 500), key).run();
}
