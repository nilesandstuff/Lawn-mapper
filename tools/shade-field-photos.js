/**
 * THE LIDAR UNDER THE OWNER'S STOPS AGAINST NEWER PHOTOS (features session,
 * 2026-10-14; owner: "compare lidar with more recent photos" -- trees grow,
 * get cut, houses get built). His area's lidar was flown 2016-18. For each
 * stop of a day, in 120 m squares, every photo the site offers there --
 * the county's own flights (Ottawa: 2024 leaf-off, 2021 leaf-on, 2018
 * leaf-off; the core session's catalogue) and Mapbox -- is read the way
 * tools/shade-check-imagery.js reads it: leaf-on or leaf-off from the
 * crowns' green, the sun and the photo's offset fitted on buildings'
 * shadows, then shade cell by cell on grass the trees can reach:
 *
 * Each photo is scored against the lidar's trees in leaf and bare (a
 * photo's season is read from its crowns, and the county's 2021 flight is
 * late spring, part-leafed), and the better fit is its season; then
 *
 *   model only   the lidar casts shade the photo does not show: a tree
 *                gone or thinner since the flight (or a leafier model)
 *   photo only   shade the lidar does not have: a tree grown or planted,
 *                a new building
 *
 * Counts only, by stop time: the repository is public.
 *
 *   DAY=2026-10-13 node tools/shade-field-photos.js   (workflow 35, photos: yes)
 */

import { loadVisits, tiles } from './shade-field-check.js';
import { checkLot } from './shade-check-imagery.js';
import { usable } from '../public/shade/truth.js';

const ZONE = 'America/New_York';
const hm = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' });
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');

/** A source's label without anything local: 'county 2021' or 'mapbox'. */
export function sourceKey(r) {
  return r.source === 'mapbox' ? 'mapbox' : `county ${r.year ?? '?'}`;
}

/** Sum photo-scoring tallies by source; skips counted by reason. */
export function addUp(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = sourceKey(r);
    const blank = () => ({ n: 0, photo: 0, model: 0, both: 0, modelOnly: 0, photoOnly: 0 });
    if (!by.has(k)) by.set(k, { full: blank(), bare: blank(), frames: 0, leaf: {}, skips: {} });
    const a = by.get(k);
    /* An error's first word only (an HTTP status, or the error's kind):
       the rest can hold the request's URL, which names the place. */
    if (r.skip || r.error) { const why = r.skip ? r.skip.replace(/[\d.]+x/, 'Nx') : `error ${String(r.error).split(/[\s:]/)[0]}`; a.skips[why] = (a.skips[why] || 0) + 1; continue; }
    if (!r.trees) continue;
    a.frames++;
    const read = r.leafRead || r.leaf;
    a.leaf[read] = (a.leaf[read] || 0) + 1;
    /* The photo was scored against one canopy (leafy unless it read
       leaf-off); the other came back as the other season. */
    const full = r.leaf === 'off' ? r.treesOtherSeason : r.trees, bare = r.leaf === 'off' ? r.trees : r.treesOtherSeason;
    for (const f of ['n', 'photo', 'model', 'both', 'modelOnly', 'photoOnly']) { a.full[f] += full[f]; a.bare[f] += bare[f]; }
  }
  return by;
}

export function sourceLine(k, a) {
  const leaf = Object.entries(a.leaf).map(([l, n]) => `${n} leaf-${l}`).join(', ');
  const skips = Object.entries(a.skips).map(([w, n]) => `${n} ${w}`).join('; ');
  if (!a.frames) return `    ${k}: not scored${skips ? ` (${skips})` : ''}`;
  const one = (name, t) => `${name}: model shade ${pct(t.model, t.n)}, agree ${pct(t.n - t.modelOnly - t.photoOnly, t.n)}, model only ${pct(t.modelOnly, t.n)}, photo only ${pct(t.photoOnly, t.n)}`;
  return `    ${k} (${a.frames} square${a.frames === 1 ? '' : 's'}, read as ${leaf}): grass the trees reach ${a.full.n} cells, shade in the photo ${pct(a.full.photo, a.full.n)}\n`
    + `      ${one('lidar trees in leaf', a.full)}\n      ${one('lidar trees bare', a.bare)}${skips ? `\n      skipped ${skips}` : ''}`;
}

export async function fieldPhotos(day) {
  const visits = await loadVisits(day);
  const out = [`Photos against the lidar, ${day}: ${visits.length} stops. Model shade at each photo's own sun (fitted on buildings), the trees as the lidar has them.`];
  const all = [];
  let done = 0;
  const most = Number(process.env.MAX_STOPS) || Infinity;
  for (const v of visits) {
    const u = usable(v);
    if (u.length < 20) continue;
    if (done++ >= most) break;
    const rows = [];
    for (const tile of tiles(u)) {
      try { rows.push(...await checkLot(tile.lng, tile.lat, { everyYear: true, mixed: true })); } catch (e) { rows.push({ source: 'all', error: e.message }); }
    }
    all.push(...rows);
    out.push(`\n${hm(v[0].t)}-${hm(v[v.length - 1].t)}:`);
    for (const [k, a] of addUp(rows)) out.push(sourceLine(k, a));
  }
  out.push('\nALL STOPS:');
  for (const [k, a] of addUp(all)) out.push(sourceLine(k, a));
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const day = process.env.DAY || new Date().toLocaleDateString('en-CA', { timeZone: ZONE });
  console.log(await fieldPhotos(day));
}
