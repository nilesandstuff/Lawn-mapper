/**
 * THE SOIL MOISTURE READINGS SO FAR (water session, 2026-11-02): what the /moisture page has kept in the water
 * database, visit by visit. The repository and its workflow logs are public, so this prints numbers only: visits are
 * #1, #2... in the order they were taken, with no place, parcel number or map id. Run by the workflow's "moisture"
 * task; the check of the model against these readings comes later, on the same footing.
 *
 *   CLOUDFLARE_API_TOKEN=.. CLOUDFLARE_ACCOUNT_ID=.. node water/tools/moisture.mjs
 */
process.env.DB_NAME = 'lawn-water';
const { query } = await import('../../tools/corpus-db.js');

const visits = query('SELECT id, at, parcel_pin, unit, depth_in, meter, weather, map_id FROM moisture_visits ORDER BY at');
const rows = query('SELECT visit_id, spot, value FROM moisture_readings');
const props = new Map(), spotsSeen = new Map();
console.log(`${visits.length} visit${visits.length === 1 ? '' : 's'}, ${rows.length} reading${rows.length === 1 ? '' : 's'}.`);
console.log('=====');
visits.forEach((v, k) => {
  if (!props.has(v.parcel_pin || v.id)) props.set(v.parcel_pin || v.id, props.size + 1);
  const r = rows.filter((x) => x.visit_id === v.id), vals = r.map((x) => x.value).sort((a, b) => a - b);
  const again = r.filter((x) => spotsSeen.has(x.spot)).length;
  for (const x of r) spotsSeen.set(x.spot, true);
  const u = v.unit === 'vwc' ? '%' : v.unit === 'scale' ? ' (scale)' : '';
  const w = (() => { try { return JSON.parse(v.weather || 'null')?.lastTwoDays || '-'; } catch { return '-'; } })();
  console.log(`#${k + 1}  ${new Date(v.at).toISOString().slice(0, 10)}  property ${props.get(v.parcel_pin || v.id)}  ${r.length} readings  ${vals.length ? `${vals[0]}-${vals[vals.length - 1]}${u}, median ${vals[vals.length >> 1]}` : ''}  depth ${v.depth_in ?? '?'} in  re-read ${again}  last 2 days: ${w}${v.map_id ? '  (a saved map)' : ''}`);
});
console.log(`${props.size} propert${props.size === 1 ? 'y' : 'ies'}; ${spotsSeen.size} spots.`);
