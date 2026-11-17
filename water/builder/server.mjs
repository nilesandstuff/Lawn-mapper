/**
 * THE WATER BUILDER (owner, 2026-11-16): the water map worked out with no page open, in a Cloudflare Container, so an
 * admin save's thermal walk is scored the moment it is converted. Reached only by the water Worker (its binding
 * WATER_BUILDER; worker.js here has no public address).
 *
 *   GET  /health -> { ok, build }   (build: the commit this image was laid out from, build.json)
 *   POST /score { record, id, walk, base } -> { ok, why?, result, weather, placed: { offLawn, kinds, notes, started, ended } }
 *        record: the admin save (the main site's saveOf); walk: its converted walk (thermalOf); base: the water site's
 *        origin, whose public routes the page's own requests go to. The plan is worked out as the page does
 *        (headless.mjs), kept in memory for the next walk on the same map while this container lives.
 * Nothing with a place in it is logged: ids and counts only.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openMap } from './headless.mjs';
import { siteOf, inputsOf } from '../lib/siteof.js';
import { walkRecords } from '../lib/walkrecords.js';
import { weatherOfMoment, openMeteoUrls, parseOpenMeteo } from '../lib/momentweather.js';

const BUILD = (() => { try { return JSON.parse(readFileSync(new URL('./build.json', import.meta.url), 'utf8')).build; } catch { return 'dev'; } })();
const stations = (() => { try { return JSON.parse(readFileSync(new URL('../public/data/asos-stations.json', import.meta.url), 'utf8')); } catch { return []; } })();
const open = new Map(); // map id + record time -> the opened map (one at a time is enough)

/** The weather of the walk's minutes: the airport station and Open-Meteo's satellite sunshine and HRRR, as the page
 *  gathers them (app.js checkWalk; Open-Meteo from this container's address, the station alone when refused). */
async function weatherFor(lat, lng, t0, t1) {
  const rows = [];
  for (const [src, u] of Object.entries(openMeteoUrls(lat, lng, t0, t1))) {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); if (r.ok) rows.push(...parseOpenMeteo(await r.json(), src, t0 - 36e5, t1 + 36e5)); } catch { /* the station alone */ }
  }
  return weatherOfMoment(stations, lat, lng, t0, t1, { extra: { rows } });
}

/** The map worked out (kept: a second request while it is still being worked out waits for the same one), or why not. */
async function mapFor(record, id, base) {
  if (!Number.isFinite(record?.lng) || !Number.isFinite(record?.lat)) return { why: 'the map has no place' };
  const site = siteOf(record, id);
  const key = `${id}|${record.at || ''}|${JSON.stringify(record.shapes || []).length}`;
  if (!open.has(key)) { open.clear(); open.set(key, openMap({ site, inputs: inputsOf(site.water), base })); }
  let run;
  try { run = await open.get(key); } catch (e) { open.delete(key); throw e; }
  // a plan without its shade would score every square as in full sun: no score rather than a wrong one
  const shadeTrouble = (run.plan.trouble || []).find((t) => /shade/.test(t));
  if (shadeTrouble) { open.delete(key); return { why: shadeTrouble }; }
  return { run, site };
}

/* A VISIT'S POINT READINGS (2026-11-17: the field page's soil thermometer): { record, id, base, visit: { at,
   depth_in, readings: [{ n, lng, lat, value (F) }] }, view } -> { ok, result: the worker's pointsAt } */
export async function points({ record, id, base, visit, view = 'soil' }) {
  if (!record || !visit || !base) return { ok: false, why: 'record, visit and base are needed' };
  const { run, why } = await mapFor(record, id, base);
  if (!run) return { ok: false, why };
  const pts = (visit.readings || []).filter((r) => Number.isFinite(r.lng) && Number.isFinite(r.value)).map((r) => ({ n: r.n, lng: r.lng, lat: r.lat, value: (r.value - 32) / 1.8 }));
  const result = await run.ask('pointsAt', { t: visit.at, depthCm: Number.isFinite(visit.depth_in) ? visit.depth_in * 2.54 : 7.5, points: pts, view });
  return result.error ? { ok: false, why: result.error } : { ok: true, result };
}

export async function score({ record, id, walk, base, weather: frozen = null }) {
  if (!record || !walk || !base) return { ok: false, why: 'record, walk and base are needed' };
  const { run, site, why } = await mapFor(record, id, base);
  if (!run) return { ok: false, why };
  const lawnAt = ([lng, lat]) => { const k = run.cellAt?.([lng, lat]); return k >= 0 && run.plan.kinds?.[k] === 1; };
  const placed = walkRecords(walk, site, { lawnAt });
  if (!placed.records.length) return { ok: false, why: `no record of the walk lands on the lawn (${placed.offLawn} off it)`, placed: { ...placed, records: undefined } };
  const t0 = placed.started ?? placed.records[0].tm, t1 = placed.ended ?? placed.records[placed.records.length - 1].tm;
  // the weather a page or an earlier run froze for this walk, else fetched now (and frozen by the Worker)
  let weather = frozen?.series?.length ? frozen : { sources: [], series: [] };
  if (!frozen?.series?.length) { try { weather = await weatherFor(site.lat, site.lng, t0, t1); } catch (e) { weather.why = String(e?.message || e); } }
  const result = await run.walkCheck({ records: placed.records, series: weather.series, notes: placed.notes });
  if (result.error) return { ok: false, why: result.error };
  delete result.pred; // the per-record predictions stay here
  return { ok: true, result, weather, placed: { offLawn: placed.offLawn, kinds: placed.kinds, notes: placed.notes, started: t0, ended: t1 } };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, build: BUILD });
    if (req.method === 'POST' && req.url === '/score') {
      let b = ''; for await (const c of req) b += c;
      const t = Date.now(), out = await score(JSON.parse(b || '{}'));
      console.log(`score ${out.ok ? 'ok' : 'failed'} in ${Math.round((Date.now() - t) / 1000)} s${out.result ? `, ${out.result.n} squares` : ''}`);
      return send(200, out);
    }
    if (req.method === 'POST' && req.url === '/points') {
      let b = ''; for await (const c of req) b += c;
      const t = Date.now(), out = await points(JSON.parse(b || '{}'));
      console.log(`points ${out.ok ? 'ok' : 'failed'} in ${Math.round((Date.now() - t) / 1000)} s${out.result ? `, ${out.result.n} spots` : ''}`);
      return send(200, out);
    }
    send(404, { ok: false, why: 'not found' });
  } catch (e) { send(200, { ok: false, why: String(e?.message || e).slice(0, 300) }); }
});
if (process.env.WATER_BUILDER_LISTEN !== '0') server.listen(Number(process.env.PORT || 8080), () => console.log('water builder listening'));
