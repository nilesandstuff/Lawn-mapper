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

/* THE WEATHER OF A WALK SETTLES BEFORE IT IS FROZEN (2026-11-17: the owner's third walk was scored 14 minutes after it
   ended, before the airport station's next hourly report and the satellite's sunshine were out, and its weather was
   frozen with the weather model's alone). A walk's weather is frozen once it holds both, or once SETTLE_MS have passed;
   until then the walk is scored on what there is and scored again by the hourly sweep. */
export const SETTLE_MS = 6 * 36e5;
/** What a soil check carries (2, 2026-11-17: each reading's distance to the nearest lawn spot the model works out). */
export const SOIL_CHECK = 2;
export const completeWeather = (w) => { const s = w?.sources || []; return s.some((x) => /^ASOS/.test(x?.name || '')) && s.some((x) => /satellite/i.test(x?.name || '')); };

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
    const r = await (job.kind === 'soil' ? soilOne(env, job, base) : scoreOne(env, job, base)).catch((e) => ({ state: 'retry', why: String(e?.message || e) }));
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
  if (!frozen && o.weather?.series?.length && (completeWeather(o.weather) || Date.now() > (p.ended ?? p.started ?? 0) + SETTLE_MS)) await putWeather(env, job.walk, o.weather.sources, o.weather.series);
  const res2 = await putResult(env, { walk: job.walk, model: r.model, kind: 'surface', n: r.n, bias: r.bias, rmse: r.rmse, rho: r.rho,
    detail: { bands: r.bands, sunShade: r.sunShade, used: r.used, open: r.open, v1: r.v1 || null, station: r.station || null, scoring: r.scoring || 1, offLawn: p.offLawn, weather: (frozen || o.weather)?.sources || [], by: 'the water builder' } });
  if (res2.error) return { state: 'failed', why: res2.error };
  return { state: 'done', why: `${r.n} squares` };
}

/* A FIELD VISIT'S SOIL TEMPERATURES AGAINST THE MODEL (2026-11-17): the builder sets each reading against the model's
   soil at the reading's depth and the visit's time (public/analyse.js pointsAt); kept as the visit's check, numbers
   only, as the readings page's moisture checks are, so the readings report can print it. */
async function soilOne(env, job, base) {
  const record = await env.MAIN.saveOf(job.map_id);
  if (!record) return { state: 'failed', why: 'not an admin save, or no longer there' };
  const v = await env.DB.prepare('SELECT id, at, depth_in, unit FROM moisture_visits WHERE id = ?').bind(job.walk).first();
  if (!v || v.unit !== 'soil_f') return { state: 'failed', why: 'no soil temperature visit by that id' };
  const readings = (await env.DB.prepare('SELECT n, lng, lat, value FROM moisture_readings WHERE visit_id = ? ORDER BY n').bind(v.id).all()).results || [];
  const res = await env.WATER_BUILDER.fetch('https://water-builder/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record, id: job.map_id, base, visit: { at: v.at, depth_in: v.depth_in, readings }, view: 'soil' }) });
  const o = await res.json().catch(() => null);
  if (!o?.ok) return { state: 'retry', why: o?.why || `the builder answered ${res.status}` };
  const r = o.result;
  const detail = { kind: 'soil', check: SOIL_CHECK, model: r.model, depth_in: v.depth_in, bias: r.bias, rmse: r.rmse, air: r.air, used: r.used, by: 'the water builder', spots: (r.spots || []).map((x) => ({ n: x.n, value: x.value, model: x.model, lawnM: x.lawnM ?? null, inGrid: x.inGrid ?? null, kind: x.kind ?? null })) };
  await env.DB.prepare('INSERT OR REPLACE INTO moisture_checks (visit_id, checked, rho, n, detail) VALUES (?, ?, ?, ?, ?)').bind(v.id, Date.now(), Number.isFinite(r.rho) ? r.rho : null, r.n, JSON.stringify(detail)).run();
  return { state: 'done', why: `${r.n} soil readings` };
}

/** Every admin save's converted walks the current model has not scored: queued.
 *  -> { saves, walks, converted, waiting, failed, scored, queued } (counts only, for the timer's log) */
export async function sweep(env) {
  const out = { saves: 0, walks: 0, converted: 0, waiting: 0, failed: 0, scored: 0, queued: 0, refetched: 0, soil: 0 };
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
  /* weather frozen too early, or not frozen yet (SETTLE_MS above): a walk of the last ten days, two hours or more after
     it ended, scored again on its weather fetched afresh */
  const now = Date.now();
  const young = (await env.DB.prepare(`SELECT w.walk, w.map_id, w.started, w.ended, tw.walk AS fw, tw.sources, tw.fetched FROM truth_walks w LEFT JOIN truth_weather tw ON tw.walk = w.walk
    WHERE COALESCE(w.ended, w.started) > ? AND EXISTS (SELECT 1 FROM truth_results r WHERE r.walk = w.walk)`).bind(now - 10 * 864e5).all()).results || [];
  for (const r of young) {
    const end = r.ended ?? r.started;
    if (now < end + 2 * 36e5) continue;
    let sources = []; try { sources = JSON.parse(r.sources || '[]'); } catch { /* none */ }
    const early = r.fw && !completeWeather({ sources }) && r.fetched < end + SETTLE_MS;
    if (r.fw && !early) continue;
    if (early) await env.DB.prepare('DELETE FROM truth_weather WHERE walk = ?').bind(r.walk).run();
    await enqueue(env, 'walk', r.map_id, { walk: String(r.walk) }); out.refetched++;
  }
  // the field page's soil temperatures on a test map, not yet checked by this model
  const saveIds = new Set(saves.map((x) => String(x.id)));
  const soil = (await env.DB.prepare(`SELECT v.id, v.map_id, c.detail FROM moisture_visits v LEFT JOIN moisture_checks c ON c.visit_id = v.id WHERE v.unit = 'soil_f' AND v.map_id IS NOT NULL`).all()).results || [];
  for (const v of soil) {
    if (!saveIds.has(String(v.map_id))) continue;
    let d0 = null; try { d0 = JSON.parse(v.detail || 'null'); } catch { /* none */ }
    if (d0?.model === MODEL_VERSION && (d0?.check || 1) >= SOIL_CHECK) continue;
    const job = await env.DB.prepare('SELECT state FROM kit_jobs WHERE key = ?').bind(`soil|${v.map_id}|${v.id}`).first();
    if ((job?.state === 'failed' && (d0?.check || 1) >= SOIL_CHECK) || job?.state === 'queued') continue; // a failed check is not tried again every hour
    await enqueue(env, 'soil', v.map_id, { walk: v.id }); out.soil++;
  }
  return out;
}
