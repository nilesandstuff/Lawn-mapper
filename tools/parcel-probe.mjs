/**
 * IS THE COUNTY'S PARCEL SERVER ANSWERING? (core session, 2026-11-09). The features session found GET /api/parcel
 * answering { parcel: null, covered: true } for the owner's lot, where the shade map had found a property line on
 * 2026-11-06. The site's lookup (worker/src/parcel.js) gives up on a county server after 6 s and on any error, and
 * then answers exactly as if there were no parcel, so a slow or failing county server looks like "no parcel".
 *
 * For each of the administrators' saved maps: the site's own lookup (the 6 s limit), then every endpoint and query
 * form of every county that covers the point, each timed with a 30 s limit: HTTP status, milliseconds, ArcGIS error,
 * features. Prints map numbers, county numbers, timings and counts: no address, no coordinate, no county name.
 *
 *   CLOUDFLARE_API_TOKEN=... node tools/parcel-probe.mjs
 */
import { query } from './corpus-db.js';
import { ALL_COUNTIES, candidateCounties } from '../worker/src/counties.js';
import { lookupParcel, endpointsFor, queryVariants } from '../worker/src/parcel.js';

const rows = query("SELECT m.lng, m.lat, m.payload FROM maps m JOIN users u ON u.id = m.user_id WHERE u.role = 'admin' ORDER BY m.updated_at DESC LIMIT 40");
console.log(`Parcel probe: ${rows.length} of the administrators' saved maps.`);
let i = 0;
for (const r of rows) {
  i++;
  let p = {}; try { p = JSON.parse(r.payload) || {}; } catch { /* none */ }
  const lng = Number(p.lng ?? r.lng), lat = Number(p.lat ?? r.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
  const saved = !!p.parcel;
  const keys = candidateCounties(lng, lat);
  if (!keys.length) { console.log(`map ${i}: no county in the registry covers it (a parcel saved with it: ${saved ? 'yes' : 'no'})`); continue; }
  const t0 = Date.now();
  let site = null; try { site = await lookupParcel(lng, lat); } catch { site = null; }
  console.log(`map ${i}: a parcel saved with it: ${saved ? 'yes' : 'no'}; the site's lookup now: ${site ? 'FOUND' : 'none'} in ${Date.now() - t0} ms; ${keys.length} county(ies) to ask`);
  let c = 0;
  for (const key of keys) {
    c++;
    const cfg = ALL_COUNTIES[key];
    if (!cfg?.service) { console.log(`  county ${c}: no service configured`); continue; }
    let e = 0;
    for (const ep of endpointsFor(cfg)) {
      e++;
      let v = 0;
      for (const params of queryVariants(lng, lat, ep.where)) {
        v++;
        const url = `${ep.service}/${ep.layer}/query?${new URLSearchParams(params)}`;
        const t = Date.now();
        let line;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
          const ms = Date.now() - t;
          let body = null; try { body = await res.json(); } catch { /* not JSON */ }
          const n = Array.isArray(body?.features) ? body.features.length : null;
          line = `HTTP ${res.status} in ${ms} ms${ms > 6000 ? ' (OVER the site\'s 6 s limit)' : ''}; ${body?.error ? `ArcGIS error ${body.error.code ?? ''} ${String(body.error.message || '').slice(0, 80)}` : `${n ?? '?'} feature(s)`}`;
        } catch (err) {
          line = `no answer in ${Date.now() - t} ms (${String(err?.name || err).slice(0, 40)})`;
        }
        console.log(`  county ${c}, endpoint ${e}, form ${v}: ${line}`);
      }
    }
  }
}
