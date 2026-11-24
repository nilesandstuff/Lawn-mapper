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
import { lineUp, saveShape, placeOf } from '../lib/lineup.js';
import { isMoistureUnit } from '../lib/maps.js';

const pinOf = (record) => record?.parcel?.properties?.pin || record?.parcel?.properties?.PIN || null;
const converted = (w) => w && Array.isArray(w.records) && w.records.length > 0;

/** The water site's own origin, from the main site's host: lawnmap.<home> -> https://water.<home>. */
export const waterBase = (env) => `https://water.${String(env.LAWNMAP_HOST || '').split('.').slice(1).join('.')}`;

/* THE WEATHER OF A WALK SETTLES BEFORE IT IS FROZEN (2026-11-17: the owner's third walk was scored 14 minutes after it
   ended, before the airport station's next hourly report and the satellite's sunshine were out, and its weather was
   frozen with the weather model's alone). A walk's weather is frozen once it holds both, or once SETTLE_MS have passed;
   until then the walk is scored on what there is and scored again by the hourly sweep. */
export const SETTLE_MS = 6 * 36e5;
/** What a soil check carries (2, 2026-11-17: each reading's distance to the nearest lawn spot the model works out; 3: and
 *  how far off the map's box it is, the first check having found every spot off it). */
export const SOIL_CHECK = 3;
/** The soil moisture and surface temperature checks, worked out here since 2026-11-18 (owner: "I don't want anything to
 *  have to run in the browser"); a check a page kept before carries no number and is worked out again once. */
export const VISIT_CHECK = 1;
const CHECKED_UNIT = (u) => u === 'soil_f' || u === 'surface_f' || isMoistureUnit(u);
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

/**
 * THE MAP'S FUSED MODEL HANDED TO THE BUILDER (2026-11-24; docs/MAPS.md "The fused model"): the main site's private
 * fusedOf, its overflow parts with it, kept by the builder to answer the page's own request for the file. A map with
 * none hands over nothing, said too, so a file held from before is not used. -> the fused file's write time, or null
 */
async function sendFused(env, id) {
  const post = (part, at, bytes) => env.WATER_BUILDER.fetch(`https://water-builder/fused?id=${encodeURIComponent(id)}&part=${part}&at=${encodeURIComponent(at)}`, { method: 'POST', body: bytes });
  const f = typeof env.MAIN.fusedOf === 'function' ? await env.MAIN.fusedOf(id, 0).catch(() => null) : null;
  if (!f?.bytes) { await (await post(0, '', new Uint8Array(0))).body?.cancel(); return null; }
  const at = String(f.modelAt || 'unknown');
  await (await post(0, at, f.bytes)).body?.cancel();
  for (let part = 1; part <= 8; part++) {
    const o = await env.MAIN.fusedOf(id, part).catch(() => null);
    if (!o?.bytes) break;
    await (await post(part, at, o.bytes)).body?.cancel();
  }
  return at;
}

/** A score's numbers, cut down to what is kept beside another (the lidar alone beside the fused). */
const brief = (r) => ({ n: r.n, bias: r.bias, rmse: r.rmse, rho: r.rho, sun: r.sunShade?.sun || null, shade: r.sunShade?.shade || null, live: r.station ? { bias: r.station.bias, rmse: r.station.rmse } : null });

async function scoreOne(env, job, base) {
  const record = await env.MAIN.saveOf(job.map_id);
  if (!record) return { state: 'failed', why: 'not an admin save, or no longer there' };
  const walk = await env.MAIN.thermalOf(job.map_id, job.walk);
  if (walk?.status?.ok === false) return { state: 'failed', why: `the walk could not be converted: ${walk.status.error || 'no reason given'}` };
  if (!converted(walk)) return { state: 'wait', why: 'not converted yet' };
  const frozen = await frozenWeather(env, job.walk);
  const lidarOnly = job.kind === 'lidar';
  // the fused model, when the map has one, goes to the builder first; the second score ('lidar') is told to leave it
  const fusedAt = await sendFused(env, job.map_id);
  const res = await env.WATER_BUILDER.fetch('https://water-builder/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record, id: job.map_id, walk, base, weather: frozen, lidarOnly }) });
  const o = await res.json().catch(() => null);
  if (!o?.ok) return { state: 'retry', why: o?.why || `the builder answered ${res.status}` };
  const p = o.placed || {}, r = o.result || {};
  if (lidarOnly) {
    /* THE SAME WALK ON THE LIDAR ALONE, kept beside its score on the fused model (the two side by side are the test of
       whether the fused model is nearer reality: docs/MAPS.md) */
    const row = await env.DB.prepare("SELECT detail FROM truth_results WHERE walk = ? AND model = ? AND kind = 'surface'").bind(job.walk, r.model).first();
    if (!row) return { state: 'failed', why: 'no score on the fused model to keep it beside' };
    let d = {}; try { d = JSON.parse(row.detail || '{}') || {}; } catch { /* none */ }
    d.lidarAlone = { ...brief(r), fusedAt: d.fusedAt ?? null, at: Date.now() };
    await env.DB.prepare("UPDATE truth_results SET detail = ? WHERE walk = ? AND model = ? AND kind = 'surface'").bind(JSON.stringify(d), job.walk, r.model).run();
    return { state: 'done', why: `${r.n} squares on the lidar alone` };
  }
  const kept = await putWalk(env, { walk: job.walk, map_id: job.map_id, parcel_pin: pinOf(record), source: 'thermal', started: p.started, ended: p.ended, kinds: p.kinds, notes: p.notes });
  if (kept.error) return { state: 'failed', why: kept.error };
  if (!frozen && o.weather?.series?.length && (completeWeather(o.weather) || Date.now() > (p.ended ?? p.started ?? 0) + SETTLE_MS)) await putWeather(env, job.walk, o.weather.sources, o.weather.series);
  const res2 = await putResult(env, { walk: job.walk, model: r.model, kind: 'surface', n: r.n, bias: r.bias, rmse: r.rmse, rho: r.rho,
    detail: { bands: r.bands, sunShade: r.sunShade, edge: r.edge || null, used: r.used, open: r.open, v1: r.v1 || null, station: r.station || null, scoring: r.scoring || 1, shape: r.shape || null, fusedAt, align: alignOf(record), offLawn: p.offLawn, weather: (frozen || o.weather)?.sources || [], by: 'the water builder' } });
  if (res2.error) return { state: 'failed', why: res2.error };
  // every square with its factors and sensitivities, for the residual analysis (tools/residuals.py)
  if (r.diag?.rows?.length) await env.DB.prepare('INSERT OR REPLACE INTO truth_squares (walk, model, scoring, checked, n, data) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(job.walk, r.model, r.scoring || 1, Date.now(), r.diag.rows.length, JSON.stringify(r.diag)).run().catch(() => null);
  return { state: 'done', why: `${r.n} squares${r.shape?.model === 'fused' ? ' on the fused model' : ''}` };
}

/* A FIELD VISIT'S SOIL TEMPERATURES AGAINST THE MODEL (2026-11-17): the builder sets each reading against the model's
   soil at the reading's depth and the visit's time (public/analyse.js pointsAt); kept as the visit's check, numbers
   only, as the readings page's moisture checks are, so the readings report can print it. */
async function soilOne(env, job, base) {
  const record = await env.MAIN.saveOf(job.map_id);
  if (!record) return { state: 'failed', why: 'not an admin save, or no longer there' };
  const v = await env.DB.prepare('SELECT id, at, depth_in, unit, air_f, weather FROM moisture_visits WHERE id = ?').bind(job.walk).first();
  if (!v || !CHECKED_UNIT(v.unit)) return { state: 'failed', why: 'no visit by that id that the model is checked against' };
  const readings = (await env.DB.prepare('SELECT n, lng, lat, value FROM moisture_readings WHERE visit_id = ? ORDER BY n').bind(v.id).all()).results || [];
  const soil = v.unit === 'soil_f';
  let wx = null; try { wx = JSON.parse(v.weather || 'null'); } catch { /* none */ }
  const visit = { at: v.at, depth_in: v.depth_in, unit: v.unit, air_f: v.air_f, watered: !!(wx?.sprinklers || wx?.lastTwoDays === 'watered'), readings };
  await sendFused(env, job.map_id);
  const res = await env.WATER_BUILDER.fetch('https://water-builder/points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ record, id: job.map_id, base, visit, view: soil ? 'soil' : 'visit' }) });
  const o = await res.json().catch(() => null);
  if (!o?.ok && o?.final) { // no fair comparison (a surface visit at dusk): kept as checked, with why, and not tried again
    await env.DB.prepare('INSERT OR REPLACE INTO moisture_checks (visit_id, checked, rho, n, detail) VALUES (?, ?, NULL, 0, ?)').bind(v.id, Date.now(), JSON.stringify({ kind: 'visit', check: VISIT_CHECK, by: 'the water builder', why: o.why, spots: [], settings: {} })).run();
    return { state: 'done', why: `not compared: ${o.why}` };
  }
  if (!o?.ok) return { state: 'retry', why: o?.why || `the builder answered ${res.status}` };
  const r = o.result;
  const detail = soil
    ? { kind: 'soil', check: SOIL_CHECK, model: r.model, depth_in: v.depth_in, bias: r.bias, rmse: r.rmse, air: r.air, used: r.used, by: 'the water builder', spots: (r.spots || []).map((x) => ({ n: x.n, value: x.value, model: x.model, lawnM: x.lawnM ?? null, inGrid: x.inGrid ?? null, boxM: x.boxM ?? null, kind: x.kind ?? null })) }
    : { kind: 'visit', check: VISIT_CHECK, by: 'the water builder', spots: r.spots || [], settings: r.settings || {} };
  await env.DB.prepare('INSERT OR REPLACE INTO moisture_checks (visit_id, checked, rho, n, detail) VALUES (?, ?, ?, ?, ?)').bind(v.id, Date.now(), Number.isFinite(r.rho) ? r.rho : null, r.n, JSON.stringify(detail)).run();
  return { state: 'done', why: `${r.n} ${soil ? 'soil readings' : 'readings on the lawn'}` };
}

/** Every admin save's converted walks the current model has not scored: queued.
 *  -> { saves, walks, converted, waiting, failed, scored, queued } (counts only, for the timer's log) */
export async function sweep(env) {
  const out = { saves: 0, walks: 0, converted: 0, waiting: 0, failed: 0, scored: 0, queued: 0, refetched: 0, soil: 0, lined: 0, waitingVisits: 0, unpinned: 0, made: 0, notMade: 0 };
  if (!env.MAIN || !env.DB) return out;
  const saves = (await env.MAIN.adminSaves().catch(() => null)) || [];
  // scored: by this model, and carrying all a result now carries (SCORING: a walk scored before the station's score is scored again)
  const rows = (await env.DB.prepare("SELECT walk, json_extract(detail, '$.fusedAt') AS fusedAt, json_extract(detail, '$.shape.model') AS shape, json_extract(detail, '$.lidarAlone.fusedAt') AS aloneAt FROM truth_results WHERE model = ? AND kind = 'surface' AND COALESCE(json_extract(detail, '$.scoring'), 1) >= ?").bind(MODEL_VERSION, SCORING).all()).results || [];
  const scoredRow = new Map(rows.map((r) => [r.walk, r])), scored = new Set(scoredRow.keys());
  out.saves = saves.length;
  for (const s of saves) {
    const list = (await env.MAIN.thermalOf(s.id, null).catch(() => null))?.walks || [];
    for (const w of list) {
      out.walks++;
      if (w.ok === false) { out.failed++; continue; }
      if (w.ok !== true) { out.waiting++; continue; }
      out.converted++;
      const sr = scoredRow.get(String(w.walk));
      /* THE FUSED MODEL (2026-11-24): a walk scored before the map's fused model was made, or on an older one, is
         scored again; one scored on a fused model is scored once more on the lidar alone, to be set beside it */
      const stale = sr && (s.fusedAt || null) !== (sr.fusedAt || null);
      if (sr && !stale) {
        out.scored++;
        if (sr.shape === 'fused' && sr.aloneAt !== sr.fusedAt) {
          const j = await env.DB.prepare('SELECT state FROM kit_jobs WHERE key = ?').bind(`lidar|${s.id}|${w.walk}`).first();
          if (j?.state !== 'queued' && j?.state !== 'failed') { await enqueue(env, 'lidar', s.id, { walk: String(w.walk) }); out.alone = (out.alone || 0) + 1; }
        }
        continue;
      }
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
  // walks and visits filed under a map id cut short (at 80 or 64 characters, before 2026-11-18): the full id restored
  out.mended = await mendIds(env, saves.map((x) => String(x.id))).catch(() => 0);
  // every field visit put on the test map of the lot it was taken on, before the soil checks below look for them
  Object.assign(out, await lineUpVisits(env, saves).catch(() => ({ lined: 0, waitingVisits: 0, unpinned: 0, made: 0, notMade: 0 })));
  // the field page's visits on a test map that the model is checked against (soil temperature, soil moisture, surface
  // temperature), not yet checked here, or by an older check
  const saveIds = new Set(saves.map((x) => String(x.id)));
  const vs = (await env.DB.prepare('SELECT v.id, v.map_id, v.unit, c.detail FROM moisture_visits v LEFT JOIN moisture_checks c ON c.visit_id = v.id WHERE v.map_id IS NOT NULL').all()).results || [];
  for (const v of vs) {
    if (!saveIds.has(String(v.map_id)) || !CHECKED_UNIT(v.unit)) continue;
    let d0 = null; try { d0 = JSON.parse(v.detail || 'null'); } catch { /* none */ }
    const soil = v.unit === 'soil_f', want = soil ? SOIL_CHECK : VISIT_CHECK;
    const has = d0 && (soil ? d0.model === MODEL_VERSION : true) ? d0.check || (soil ? 1 : 0) : -1;
    if (has >= want) continue;
    if (!(await env.DB.prepare('SELECT 1 AS x FROM moisture_readings WHERE visit_id = ? LIMIT 1').bind(v.id).first())) continue; // marks alone: nothing to check
    const job = await env.DB.prepare('SELECT state, queued FROM kit_jobs WHERE key = ?').bind(`soil|${v.map_id}|${v.id}`).first();
    if (job?.state === 'queued' || (job?.state === 'failed' && Date.now() - job.queued < 864e5)) continue; // a failed check is tried again a day later, not every hour
    await enqueue(env, 'soil', v.map_id, { walk: v.id }); out.soil++;
  }
  return out;
}

/**
 * THE FIELD READINGS ON THE TEST MAP OF THE LOT THEY WERE TAKEN ON (owner, 2026-11-17: "Line the readings up by the
 * location... Do this automatically so I don't have to do it"; lib/lineup.js says how). A moved visit's old check is
 * cleared, so it is checked again on its own map; a lot with none gets one made (below). -> { lined (moved onto a
 * test map), waitingVisits (no test map of their lot yet), unpinned (taken off a test map of another lot), made (test
 * maps made), notMade (lots refused one) }: counts only, for the timer's log.
 */
export async function lineUpVisits(env, saves, { make = true } = {}) {
  const out = { lined: 0, waitingVisits: 0, unpinned: 0, made: 0, notMade: 0 };
  const shapes = [];
  for (const s of saves) { const rec = await env.MAIN.saveOf(s.id).catch(() => null); if (rec) shapes.push(saveShape(String(s.id), rec)); }
  const visits = (await env.DB.prepare('SELECT id, map_id, parcel_pin, lng, lat FROM moisture_visits').all()).results || [];
  const byVisit = new Map();
  for (const r of (await env.DB.prepare('SELECT visit_id, lng, lat FROM moisture_readings').all()).results || []) {
    if (!byVisit.has(r.visit_id)) byVisit.set(r.visit_id, []);
    byVisit.get(r.visit_id).push(r);
  }
  const all = visits.map((v) => ({ ...v, readings: byVisit.get(v.id) || [] }));
  const { moves, waiting: unhoused } = lineUp(all, shapes);
  for (const m of moves) {
    await env.DB.prepare('UPDATE moisture_visits SET map_id = ? WHERE id = ?').bind(m.to, m.id).run();
    try { await env.DB.prepare('DELETE FROM moisture_checks WHERE visit_id = ?').bind(m.id).run(); } catch { /* no checks table yet */ }
    if (m.to) out.lined++; else out.unpinned++;
  }
  out.waitingVisits = unhoused.length;
  /* A LOT WITH NO TEST MAP GETS ONE (the owner: readings "cued up to have an admin map made for them later"; the core's
     makeWholeSave, 2026-11-18: the whole property as lawn, as the button makes it, or the save already holding the
     point). Once a day at most per lot; then the readings are lined up onto it at once. */
  if (make && unhoused.length && typeof env.MAIN.makeWholeSave === 'function') {
    const lots = new Map();
    for (const v of all.filter((x) => unhoused.includes(x.id))) {
      const pt = placeOf(v, v.readings);
      if (!pt) continue;
      const lot = v.parcel_pin ? `pin:${v.parcel_pin}` : `at:${pt[0].toFixed(4)},${pt[1].toFixed(4)}`;
      if (!lots.has(lot)) lots.set(lot, pt);
    }
    let any = false;
    for (const [lot, pt] of lots) {
      const was = await env.DB.prepare('SELECT tried FROM lot_saves WHERE lot = ?').bind(lot).first();
      if (was && Date.now() - was.tried < 864e5) continue;
      const r = await env.MAIN.makeWholeSave(pt[0], pt[1]).catch((e) => ({ error: String(e?.message || e) }));
      await env.DB.prepare('INSERT OR REPLACE INTO lot_saves (lot, tried, made, why) VALUES (?, ?, ?, ?)').bind(lot, Date.now(), r?.id ?? null, r?.error ? String(r.error).slice(0, 200) : null).run();
      if (r?.id) { out.made++; any = true; } else out.notMade++;
    }
    if (any) {
      const again = await lineUpVisits(env, (await env.MAIN.adminSaves().catch(() => null)) || saves, { make: false });
      out.lined += again.lined; out.unpinned += again.unpinned; out.waitingVisits = again.waitingVisits;
    }
  }
  return out;
}

/** Map ids cut short when they were kept (truth.js at 80, moisture.js at 64, until 2026-11-18): where a kept id is the
 *  start of exactly one test map's id, the full id is put back. -> how many rows were mended */
export async function mendIds(env, saveIds) {
  let n = 0;
  for (const [table, col] of [['truth_walks', 'map_id'], ['moisture_visits', 'map_id']]) {
    const ids = (await env.DB.prepare(`SELECT DISTINCT ${col} AS id FROM ${table} WHERE ${col} IS NOT NULL`).all()).results || [];
    for (const { id } of ids) {
      if (saveIds.includes(id) || id.length < 60) continue;
      const full = saveIds.filter((s) => s.length > id.length && s.startsWith(id));
      if (full.length !== 1) continue;
      const r = await env.DB.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).bind(full[0], id).run();
      n += r?.meta?.changes ?? 1;
    }
  }
  return n;
}

/** How a save's lidar was lined up with its photo (the core session, 2026-11-18: "the first thing to correlate with
 *  your prediction errors"): the shade part's fit and the size of its shift, the photo's provider; numbers and words
 *  only. A fit that is not confident means the lidar is on the datum alone. */
export function alignOf(record) {
  const l = record?.tools?.shade?.data?.lidar || null, f = l?.fit || null, k = Math.cos(((record?.lat || 0) * Math.PI) / 180);
  const m = Array.isArray(l?.shift) ? Math.round(Math.hypot(l.shift[0], l.shift[1]) * k * 100) / 100 : null;
  return { shade: !!l, confident: f ? !!f.confident : null, why: f?.why ? String(f.why).slice(0, 80) : null, shiftM: m, provider: record?.provider || null, lineup: !!record?.countyAlign, trace: record?.trace?.status || null };
}
