/**
 * WALKS SCORED WITH NO PAGE OPEN (owner, 2026-11-16; the core session's plan). The water Worker's timer (src/worker.js
 * scheduled, every five minutes) works through the queue the main site's pushes fill (src/jobs.js):
 *   walk    the admin save's record and the converted walk from the main site (env.MAIN, its Internal entrypoint:
 *           saveOf, thermalOf), the walk's frozen weather if a page froze it first, then the water builder (env.
 *           WATER_BUILDER, builder/server.mjs: the water map worked out as the page does) scores it; the walk, its
 *           weather and its result are kept exactly as a page keeps them (src/truth.js putWalk, putWeather, putResult)
 *   model   an admin save's shade model changed: its walks are scored again (stage 1: the builder works the map out
 *           from the lidar as the page does; stage 2, to-do 27, from the finished model)
 * One walk a run: a map is worked out in minutes, and the next run carries on. A walk not converted yet waits (up to two
 * days of tries); a failure is kept with its reason. Every hour a sweep asks the main site for every admin save's
 * converted walks and queues any the current model has not scored, so a lost push is caught.
 */
import { waiting, settle, enqueue } from './jobs.js';
import { putWalk, putWeather, frozenWeather, putResult } from './truth.js';
import { MODEL_VERSION, SCORING } from '../lib/surfacenow.js';

const pinOf = (record) => record?.parcel?.properties?.pin || record?.parcel?.properties?.PIN || null;
const converted = (w) => w && Array.isArray(w.records) && w.records.length > 0;

/** The water site's own origin, from the main site's host: lawnmap.<home> -> https://water.<home>. */
export const waterBase = (env) => `https://water.${String(env.LAWNMAP_HOST || '').split('.').slice(1).join('.')}`;

/** Work the queue: at most `max` walks scored. -> [{ key, state, why }] */
export async function runQueue(env, { max = 1, base = waterBase(env) } = {}) {
  const out = [];
  if (!env.DB) return out;
  let scored = 0;
  for (const job of await waiting(env, 10)) {
    if (!env.MAIN) { out.push({ key: job.key, state: 'queued', why: 'the main site is not bound yet' }); break; }
    if (job.kind === 'model') {
      // stage 1: the map's converted walks are scored again with the new shade
      const list = (await env.MAIN.thermalOf(job.map_id, null).catch(() => null))?.walks || [];
      let n = 0;
      for (const w of list) if (w.ok === true && w.walk) { await enqueue(env, 'walk', job.map_id, { walk: w.walk }); n++; }
      await settle(env, job.key, 'done', `${n} walk${n === 1 ? '' : 's'} queued to be scored again`);
      out.push({ key: job.key, state: 'done' });
      continue;
    }
    if (scored >= max) break;
    if (!env.WATER_BUILDER) { out.push({ key: job.key, state: 'queued', why: 'the water builder is not bound yet' }); break; }
    scored++;
    const r = await scoreOne(env, job, base).catch((e) => ({ state: 'retry', why: String(e?.message || e) }));
    if (r.state === 'done') await settle(env, job.key, 'done', r.why);
    else if (r.state === 'failed' || job.tries >= (r.state === 'wait' ? 576 : 3)) await settle(env, job.key, 'failed', r.why);
    else await settle(env, job.key, 'queued', r.why); // tries + 1, back in the queue
    out.push({ key: job.key, state: r.state, why: r.why });
  }
  return out;
}

async function scoreOne(env, job, base) {
  const record = await env.MAIN.saveOf(job.map_id);
  if (!record) return { state: 'failed', why: 'not an admin save, or no longer there' };
  const walk = await env.MAIN.thermalOf(job.map_id, job.walk);
  if (walk?.status?.ok === false) return { state: 'failed', why: `the walk could not be converted: ${walk.status.error || 'no reason given'}` };
  if (!converted(walk)) return { state: 'wait', why: 'not converted yet' };
  const frozen = await frozenWeather(env, job.walk);
  const res = await env.WATER_BUILDER.fetch('https://water-builder/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record, id: job.map_id, walk, base, weather: frozen }) });
  const o = await res.json().catch(() => null);
  if (!o?.ok) return { state: 'retry', why: o?.why || `the builder answered ${res.status}` };
  const p = o.placed || {}, r = o.result || {};
  const kept = await putWalk(env, { walk: job.walk, map_id: job.map_id, parcel_pin: pinOf(record), source: 'thermal', started: p.started, ended: p.ended, kinds: p.kinds, notes: p.notes });
  if (kept.error) return { state: 'failed', why: kept.error };
  if (!frozen && o.weather?.series?.length) await putWeather(env, job.walk, o.weather.sources, o.weather.series);
  const res2 = await putResult(env, { walk: job.walk, model: r.model, kind: 'surface', n: r.n, bias: r.bias, rmse: r.rmse, rho: r.rho,
    detail: { bands: r.bands, sunShade: r.sunShade, used: r.used, open: r.open, v1: r.v1 || null, station: r.station || null, scoring: r.scoring || 1, offLawn: p.offLawn, weather: (frozen || o.weather)?.sources || [], by: 'the water builder' } });
  if (res2.error) return { state: 'failed', why: res2.error };
  return { state: 'done', why: `${r.n} squares` };
}

/** Every admin save's converted walks the current model has not scored: queued.
 *  -> { saves, walks, converted, waiting, failed, scored, queued } (counts only, for the timer's log) */
export async function sweep(env) {
  const out = { saves: 0, walks: 0, converted: 0, waiting: 0, failed: 0, scored: 0, queued: 0 };
  if (!env.MAIN || !env.DB) return out;
  const saves = (await env.MAIN.adminSaves().catch(() => null)) || [];
  // scored: by this model, and carrying all a result now carries (SCORING: a walk scored before the station's score is scored again)
  const scored = new Set(((await env.DB.prepare("SELECT walk FROM truth_results WHERE model = ? AND kind = 'surface' AND COALESCE(json_extract(detail, '$.scoring'), 1) >= ?").bind(MODEL_VERSION, SCORING).all()).results || []).map((r) => r.walk));
  out.saves = saves.length;
  for (const s of saves) {
    const list = (await env.MAIN.thermalOf(s.id, null).catch(() => null))?.walks || [];
    for (const w of list) {
      out.walks++;
      if (w.ok === false) { out.failed++; continue; }
      if (w.ok !== true) { out.waiting++; continue; }
      out.converted++;
      if (scored.has(String(w.walk))) { out.scored++; continue; }
      if (w.walk) { await enqueue(env, 'walk', s.id, { walk: String(w.walk) }); out.queued++; }
    }
  }
  return out;
}
